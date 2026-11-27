import type { DatabaseSync } from "node:sqlite";
import { getAddress, isHex, keccak256, toBytes, type Hex, type PublicClient } from "viem";
import { CHAIN_ID } from "../config.ts";
import { addReceipt, epochOf } from "../engine/epochs.ts";
import type { AgentRow } from "../engine/agents.ts";
import { agentRegistryId, readIdentity, registrationsIn, registrationUri, TOKEN_ID } from "../chain/identity.ts";

/**
 * Agent Passport on ERC-8004.
 *
 * An agent gets a public, portable identity by owning a token in the ERC-8004 Identity Registry
 * whose agentURI is this agent's registration file on our API. The owner registers it from
 * their own wallet (they pay the gas and own the token); house agents are registered by the
 * operator wallet.
 *
 * The link is never taken on anyone's word. It is stored only after the chain shows that:
 *   1. the token exists,
 *   2. it is owned by the agent's owner (or, for a house agent, by the house wallet),
 *   3. its agentURI is exactly this agent's registration file.
 * Because the URI names one agent, a token can only ever match one agent. Linking needs no
 * sign-in for the same reason: the chain is the proof, so anyone may ask for the check.
 *
 * Links are re-checked over time. If the token is transferred or its URI is changed, the link
 * is kept for the record but stops counting as verified. A failed RPC call never changes a
 * status: only an answer from the registry does.
 */

export interface IdentityConfig {
  /** ERC-8004 Identity Registry on Robinhood Chain. */
  registry: `0x${string}`;
  /** Public base URL of this API, e.g. https://example.com. Used to build agentURIs. */
  publicUrl: string;
  /** Earlier public base URLs whose agentURIs still count (after a domain move). */
  legacyUrls: string[];
  /** Wallet that owns the identities of house agents; null disables them. */
  houseOwner: `0x${string}` | null;
  /** ReceiptRegistry where receipt roots are anchored, for the registration file. */
  receiptRegistry: `0x${string}` | null;
  brand: string;
  epochSec: number;
}

export type IdentityStatus = "ok" | "owner-changed" | "uri-changed" | "missing";

export interface IdentityView {
  /** `eip155:4663:<registry>` */
  agentRegistry: string;
  /** ERC-8004 agent id (the token id), as a decimal string. */
  agentId: string;
  owner: string;
  agentURI: string;
  status: IdentityStatus;
  verified: boolean;
  linkedAt: number;
  checkedAt: number;
  explorer: string;
}

/**
 * The RPC node answered from a block before the registration: the token exists on chain but this
 * node has not seen it yet. Retryable; never reported as "no such agent".
 */
export class RegistryLagError extends Error {
  constructor(tokenId: bigint, block: bigint) {
    super(`ERC-8004 agent #${tokenId} was registered in block ${block}, but the RPC node has not caught up to it yet`);
    this.name = "RegistryLagError";
  }
}

export type LinkResult =
  | { ok: true; identity: IdentityView; already: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409 | 422; reason: string };

const EXPLORER = "https://robinhoodchain.blockscout.com";

export const canonicalUri = (cfg: IdentityConfig, agentId: string) => registrationUri(cfg.publicUrl, agentId);
const acceptedUris = (cfg: IdentityConfig, agentId: string) => new Set([cfg.publicUrl, ...cfg.legacyUrls].map((b) => registrationUri(b, agentId)));

/** Who must own the identity: the agent's wallet, or the house wallet for a house agent. */
export const expectedOwner = (cfg: IdentityConfig, agent: Pick<AgentRow, "owner">): `0x${string}` | null =>
  agent.owner ? getAddress(agent.owner) : cfg.houseOwner ? getAddress(cfg.houseOwner) : null;

interface Row {
  agent_id: string;
  registry: string;
  token_id: string;
  owner: string;
  agent_uri: string;
  status: IdentityStatus;
  linked_at: number;
  checked_at: number;
}

const toView = (r: Row): IdentityView => ({
  agentRegistry: agentRegistryId(r.registry),
  agentId: r.token_id,
  owner: r.owner,
  agentURI: r.agent_uri,
  status: r.status,
  verified: r.status === "ok",
  linkedAt: Number(r.linked_at),
  checkedAt: Number(r.checked_at),
  explorer: `${EXPLORER}/token/${getAddress(r.registry)}/instance/${r.token_id}`,
});

const rowOf = (db: DatabaseSync, agentId: string) => (db.prepare("SELECT * FROM identities WHERE agent_id = ?").get(agentId) as Row | undefined) ?? null;

export function getIdentity(db: DatabaseSync, agentId: string): IdentityView | null {
  const r = rowOf(db, agentId);
  return r ? toView(r) : null;
}

/** What the chain says about a token, judged against this agent. */
function judge(cfg: IdentityConfig, agent: AgentRow, chain: Awaited<ReturnType<typeof readIdentity>>): IdentityStatus {
  if (!chain.exists) return "missing";
  const want = expectedOwner(cfg, agent);
  if (!want || chain.owner !== want) return "owner-changed";
  if (!acceptedUris(cfg, agent.id).has(chain.uri)) return "uri-changed";
  return "ok";
}

/**
 * Links `agent` to ERC-8004 token `tokenId` after checking it on chain. Network failures throw
 * (the caller answers "try again"); every other outcome is a result.
 */
export async function linkIdentity(
  db: DatabaseSync,
  client: PublicClient,
  cfg: IdentityConfig,
  agent: AgentRow,
  tokenIdText: string,
  now: number,
  /** Block in which the token is known to have been minted (from its registration receipt). */
  registeredIn?: bigint,
): Promise<LinkResult> {
  if (!TOKEN_ID.test(tokenIdText) || BigInt(tokenIdText) >= 2n ** 256n) return { ok: false, status: 400, reason: "agentId must be a whole number (uint256)" };
  const tokenId = BigInt(tokenIdText);
  const want = expectedOwner(cfg, agent);
  if (!want) return { ok: false, status: 422, reason: "house agent identities are not enabled on this server" };
  const registry = getAddress(cfg.registry);

  // An agent keeps one identity. A different, still-valid one is not replaced silently.
  const before = rowOf(db, agent.id);
  if (before && before.token_id !== tokenId.toString() && before.status === "ok") {
    const current = judge(cfg, agent, await readIdentity(client, registry, BigInt(before.token_id)));
    db.prepare("UPDATE identities SET status = ?, checked_at = ? WHERE agent_id = ?").run(current, now, agent.id);
    if (current === "ok") return { ok: false, status: 409, reason: `this agent is already linked to ERC-8004 agent #${before.token_id}` };
  }

  const chain = await readIdentity(client, registry, tokenId);
  if (!chain.exists) {
    // The registration receipt proves the token was minted; a node that says otherwise is behind.
    if (registeredIn !== undefined) throw new RegistryLagError(tokenId, registeredIn);
    return { ok: false, status: 404, reason: `there is no ERC-8004 agent #${tokenId} in the registry` };
  }
  const status = judge(cfg, agent, chain);
  const canonical = canonicalUri(cfg, agent.id);

  // Everything below is synchronous, so two requests cannot interleave between check and write.
  const row = rowOf(db, agent.id);
  const sameToken = row?.token_id === tokenId.toString();
  if (sameToken) db.prepare("UPDATE identities SET owner = ?, agent_uri = ?, status = ?, checked_at = ? WHERE agent_id = ?").run(chain.owner, chain.uri, status, now, agent.id);
  if (status === "owner-changed") return { ok: false, status: 403, reason: `ERC-8004 agent #${tokenId} is owned by ${chain.owner}, not by ${want}, who owns this agent` };
  if (status === "uri-changed") return { ok: false, status: 422, reason: `ERC-8004 agent #${tokenId} points to ${chain.uri}, not to this agent's registration file ${canonical}` };
  if (sameToken) return { ok: true, identity: toView(rowOf(db, agent.id)!), already: true };
  // A different token that still verifies stays linked: either it was re-checked above and is
  // valid, or another request linked it while this one was reading the chain.
  if (row && row.status === "ok") return { ok: false, status: 409, reason: `this agent is already linked to ERC-8004 agent #${row.token_id}` };

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM identities WHERE agent_id = ?").run(agent.id);
    db.prepare("INSERT INTO identities (agent_id, registry, token_id, owner, agent_uri, status, linked_at, checked_at) VALUES (?, ?, ?, ?, ?, 'ok', ?, ?)").run(
      agent.id, registry, tokenId.toString(), chain.owner, chain.uri, now, now,
    );
    // The link is sealed with the agent's other receipts, so its passport is part of its record.
    addReceipt(db, agent.id, epochOf(now, cfg.epochSec), "identity", {
      at: now,
      agentRegistry: agentRegistryId(registry),
      erc8004AgentId: tokenId.toString(),
      owner: chain.owner,
      agentURI: chain.uri,
    }, now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { ok: true, identity: toView(rowOf(db, agent.id)!), already: false };
}

/**
 * Links by the transaction that registered the identity: finds the `Registered` event for this
 * agent's registration file in that transaction and links its token.
 */
export async function linkIdentityByTx(db: DatabaseSync, client: PublicClient, cfg: IdentityConfig, agent: AgentRow, txHash: string, now: number): Promise<LinkResult> {
  if (!isHex(txHash) || txHash.length !== 66) return { ok: false, status: 400, reason: "txHash must be a 32-byte hex transaction hash" };
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
  } catch (e) {
    if ((e as Error).name === "TransactionReceiptNotFoundError") return { ok: false, status: 404, reason: "that transaction is not on chain yet; wait until it is confirmed and try again" };
    throw e;
  }
  if (receipt.status !== "success") return { ok: false, status: 422, reason: "that transaction failed on chain" };
  const accepted = acceptedUris(cfg, agent.id);
  const mine = registrationsIn(receipt, getAddress(cfg.registry)).filter((r) => accepted.has(r.uri));
  if (mine.length === 0) return { ok: false, status: 422, reason: "that transaction did not register this agent's registration file in the ERC-8004 registry" };
  // One transaction could register the same file twice; the first one is used.
  return linkIdentity(db, client, cfg, agent, mine[0]!.tokenId.toString(), now, receipt.blockNumber);
}

/**
 * Re-reads linked identities that were last checked more than `maxAgeSec` ago, oldest first.
 * Network failures leave the row as it was and are counted as `failed`.
 */
export async function recheckIdentities(
  db: DatabaseSync,
  client: PublicClient,
  cfg: IdentityConfig,
  agentOf: (id: string) => AgentRow | null,
  now: number,
  o: { limit?: number; maxAgeSec?: number } = {},
): Promise<{ checked: number; changed: Array<{ agentId: string; from: IdentityStatus; to: IdentityStatus }>; failed: number }> {
  const rows = db.prepare("SELECT * FROM identities WHERE checked_at <= ? ORDER BY checked_at LIMIT ?").all(now - (o.maxAgeSec ?? 6 * 3600), o.limit ?? 10) as unknown as Row[];
  const out = { checked: 0, changed: [] as Array<{ agentId: string; from: IdentityStatus; to: IdentityStatus }>, failed: 0 };
  for (const r of rows) {
    const agent = agentOf(r.agent_id);
    if (!agent) continue;
    let chain;
    try {
      chain = await readIdentity(client, getAddress(r.registry), BigInt(r.token_id));
    } catch {
      out.failed++;
      continue;
    }
    const status = judge(cfg, agent, chain);
    db.prepare("UPDATE identities SET owner = ?, agent_uri = ?, status = ?, checked_at = ? WHERE agent_id = ?").run(
      chain.exists ? chain.owner : r.owner, chain.exists ? chain.uri : r.agent_uri, status, now, r.agent_id,
    );
    out.checked++;
    if (status !== r.status) out.changed.push({ agentId: r.agent_id, from: r.status, to: status });
  }
  return out;
}

// ------------------------------------------------------------------ registration file

export interface Track {
  startEquity: number;
  equity: number;
  returnPct: number;
}

/**
 * The ERC-8004 registration file for an agent (type registration-v1). Public data only: the
 * written prompt is never included. `registrations` lists the identity only while it verifies.
 */
export function registrationFile(
  cfg: IdentityConfig,
  agent: AgentRow,
  track: Track,
  identity: IdentityView | null,
  verifiedMarkets: boolean,
  now: number,
  /** The agent's generated avatar, when it has one; otherwise its seal image. */
  avatarUrl?: string | null,
) {
  const base = cfg.publicUrl.replace(/\/+$/, "");
  const symbols = agent.strategy.symbols;
  const tokenId = identity?.verified ? identity.agentId : null;
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: agent.name,
    description:
      `${agent.strategy.summary.trim().replace(/\.?$/, ".")} ` +
      `A ${agent.strategy.side} trading agent on ${cfg.brand}, paper trading ${symbols.join(", ")} with simulated funds. ` +
      `Every decision it makes is a receipt sealed under an hourly Merkle root` +
      (cfg.receiptRegistry ? ` anchored on Robinhood Chain, so its record can be checked by anyone.` : `, so its record can be checked.`),
    image: avatarUrl ?? `${base}/v1/agents/${agent.id}/image.svg`,
    services: [
      { name: "web", endpoint: `${base}/app/agents/${agent.id}` },
      { name: "receipts", endpoint: `${base}/v1/agents/${agent.id}/receipts`, version: "v1" },
    ],
    x402Support: false,
    active: agent.status === "active",
    registrations: tokenId === null ? [] : [{ agentId: Number.isSafeInteger(Number(tokenId)) ? Number(tokenId) : tokenId, agentRegistry: agentRegistryId(cfg.registry) }],
    agentUtility: {
      id: agent.id,
      house: agent.owner === null,
      owner: agent.owner,
      markets: verifiedMarkets ? "verified" : "includes-data-feed",
      symbols,
      side: agent.strategy.side,
      strategyHash: agent.strategyHash,
      createdAt: agent.createdAt,
      paperTrading: true,
      performance: { startEquity: track.startEquity, equity: Math.round(track.equity * 100) / 100, returnPct: Math.round(track.returnPct * 100) / 100, asOf: now },
      proofs: {
        receiptRegistry: cfg.receiptRegistry ? agentRegistryId(cfg.receiptRegistry, CHAIN_ID) : null,
        receipts: `${base}/v1/agents/${agent.id}/receipts`,
        epochs: `${base}/v1/epochs`,
      },
    },
  };
}

// ------------------------------------------------------------------ image

/** Hyalis inks: cobalt, thermal black, thermal red, green, deep cobalt. */
const PALETTE = ["#2533e6", "#17171b", "#cf2236", "#0b8457", "#1a25b8"];
const PAPER = "#f2f3ee";

/**
 * A stamp for the agent's registration file: condensed initials inside an ink ring, on one of the
 * Hyalis inks, over a 5x5 grid drawn from the hash of its id (so no two agents look alike).
 * Only letters and digits of the name are used, so nothing in the SVG comes from user text
 * unescaped.
 */
export function agentImage(agent: Pick<AgentRow, "id" | "name">): string {
  const h = toBytes(keccak256(toBytes(agent.id)));
  const initials =
    agent.name
      .split(/\s+/)
      .map((w) => w.replace(/[^A-Za-z0-9]/g, "")[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase() || "A";
  const ink = PALETTE[h[0]! % PALETTE.length]!;
  const cells: string[] = [];
  for (let i = 0; i < 25; i++) {
    if (((h[2 + (i >> 3)]! >> (i & 7)) & 1) === 0) continue;
    const x = 136 + (i % 5) * 60;
    const y = 136 + Math.floor(i / 5) * 60;
    cells.push(`<rect x="${x}" y="${y}" width="40" height="40"/>`);
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">` +
    `<rect width="512" height="512" fill="${ink}"/>` +
    `<g fill="${PAPER}" opacity="0.12">${cells.join("")}</g>` +
    `<circle cx="256" cy="256" r="200" fill="none" stroke="${PAPER}" stroke-width="14"/>` +
    `<circle cx="256" cy="256" r="172" fill="none" stroke="${PAPER}" stroke-width="3" stroke-dasharray="6 10" opacity="0.75"/>` +
    `<text transform="translate(256 248) scale(0.74 1)" dy="0.35em" text-anchor="middle" font-family="'Arial Narrow', 'Roboto Condensed', Arial, Helvetica, sans-serif" font-weight="900" font-size="200" fill="${PAPER}">${initials}</text>` +
    `<text x="256" y="388" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="24" letter-spacing="8" fill="${PAPER}" opacity="0.85">HYALIS</text>` +
    `</svg>`
  );
}
