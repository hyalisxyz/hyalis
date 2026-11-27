import type { DatabaseSync } from "node:sqlite";
import { erc20Abi, formatUnits, getAddress, parseEventLogs, type Hex, type PublicClient } from "viem";
import { z } from "zod";

/**
 * Project token utility: tiers by balance, and extra agent slots by burning.
 *
 * Everything is in token amounts, never in price. The token launches on a Pons bonding curve
 * and later graduates to a Uniswap v4 pool; a balance means the same thing before and after,
 * while a price would come from two different places and be easy to move. Until the token
 * exists (TOKEN_ADDRESS unset) every wallet is on the first tier.
 */

export const Tier = z.object({
  name: z.string(),
  /** Whole tokens held (not base units). */
  minTokens: z.number().min(0),
  agents: z.number().int().min(0),
  compilesPerDay: z.number().int().min(0),
  /** Mood rules that read posts on X (social_mood). Each reading costs money, so not on every tier. */
  social: z.boolean().default(false),
});
export type Tier = z.infer<typeof Tier>;

export const DEFAULT_TIERS: Tier[] = [
  { name: "Free", minTokens: 0, agents: 1, compilesPerDay: 10, social: false },
  { name: "Holder", minTokens: 1_000_000, agents: 3, compilesPerDay: 50, social: true },
  { name: "Whale", minTokens: 5_000_000, agents: 10, compilesPerDay: 150, social: true },
];

export function parseTiers(json: string | undefined): Tier[] {
  if (!json) return DEFAULT_TIERS;
  const tiers = z.array(Tier).min(1).parse(JSON.parse(json));
  if (tiers[0]!.minTokens !== 0) throw new Error("the first tier must start at 0 tokens");
  for (let i = 1; i < tiers.length; i++) if (tiers[i]!.minTokens <= tiers[i - 1]!.minTokens) throw new Error("tiers must be in increasing minTokens order");
  return tiers;
}

export function tierFor(tokens: number, tiers: Tier[]): { tier: Tier; next: (Tier & { needed: number }) | null } {
  let idx = 0;
  for (let i = 0; i < tiers.length; i++) if (tokens >= tiers[i]!.minTokens) idx = i;
  const next = tiers[idx + 1];
  return { tier: tiers[idx]!, next: next ? { ...next, needed: Math.max(0, next.minTokens - tokens) } : null };
}

export interface TokenConfig {
  address: `0x${string}` | null;
  tiers: Tier[];
  burnTokensPerSlot: number;
  burnSlotDays: number;
}

/** Reads balances from the token contract, with a short cache so a page refresh does not hit the RPC each time. */
export class TokenReader {
  private readonly client: PublicClient;
  readonly address: `0x${string}` | null;
  private meta: { decimals: number; symbol: string } | null = null;
  private readonly cache = new Map<string, { at: number; raw: bigint }>();
  private readonly ttlMs: number;

  constructor(client: PublicClient, address: `0x${string}` | null, ttlMs = 30_000) {
    this.client = client;
    this.address = address ? getAddress(address) : null;
    this.ttlMs = ttlMs;
  }

  async metadata(): Promise<{ decimals: number; symbol: string } | null> {
    if (!this.address) return null;
    if (!this.meta) {
      const [decimals, symbol] = await Promise.all([
        this.client.readContract({ address: this.address, abi: erc20Abi, functionName: "decimals" }),
        this.client.readContract({ address: this.address, abi: erc20Abi, functionName: "symbol" }),
      ]);
      this.meta = { decimals, symbol };
    }
    return this.meta;
  }

  /** Balances in base units. Addresses that fail to read are left out (callers treat them as 0). */
  async balances(addresses: string[], nowMs = Date.now()): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    if (!this.address || addresses.length === 0) return out;
    const want: string[] = [];
    for (const a of addresses.map((x) => getAddress(x))) {
      const hit = this.cache.get(a);
      if (hit && nowMs - hit.at < this.ttlMs) out.set(a, hit.raw);
      else want.push(a);
    }
    if (want.length) {
      // Plain reads: the production client batches them into one multicall by itself, and this
      // also works on chains without the Multicall3 contract.
      const res = await Promise.allSettled(
        want.map((a) => this.client.readContract({ address: this.address!, abi: erc20Abi, functionName: "balanceOf", args: [a as `0x${string}`] })),
      );
      res.forEach((r, i) => {
        if (r.status !== "fulfilled") return;
        out.set(want[i]!, r.value);
        this.cache.set(want[i]!, { at: nowMs, raw: r.value });
      });
      // A wallet whose balance could not be read must not silently drop to the free tier.
      if (res.every((r) => r.status === "rejected")) throw new Error("could not read token balances");
    }
    return out;
  }

  forget(address: string) {
    this.cache.delete(getAddress(address));
  }
}

export interface Entitlement {
  address: string;
  token: { launched: boolean; address: string | null; symbol: string | null };
  /** Whole tokens, as a decimal string to keep precision. */
  balance: string;
  tier: Tier;
  nextTier: (Tier & { needed: number }) | null;
  burnSlots: Array<{ slots: number; expiresAt: number; txHash: string }>;
  agentSlots: number;
  agentsActive: number;
  agentsPausedOverQuota: number;
  compilesToday: number;
  compilesPerDay: number;
}

export const utcDay = (unixSec: number) => Math.floor(unixSec / 86400);

export function activeBurnSlots(db: DatabaseSync, address: string, now: number) {
  return db
    .prepare("SELECT tx_hash, slots, expires_at FROM burns WHERE address = ? AND expires_at > ? ORDER BY expires_at")
    .all(getAddress(address), now)
    .map((r: any) => ({ slots: Number(r.slots), expiresAt: Number(r.expires_at), txHash: String(r.tx_hash) }));
}

export function compilesOn(db: DatabaseSync, address: string, day: number): number {
  const r = db.prepare("SELECT compiles FROM usage WHERE address = ? AND day = ?").get(getAddress(address), day) as { compiles: number } | undefined;
  return r?.compiles ?? 0;
}

/** Counts one brain call. Called before the call, so failed calls count too; they still cost money. */
export function countCompile(db: DatabaseSync, address: string, day: number) {
  db.prepare("INSERT INTO usage (address, day, compiles) VALUES (?, ?, 1) ON CONFLICT(address, day) DO UPDATE SET compiles = compiles + 1").run(getAddress(address), day);
}

export async function entitlement(db: DatabaseSync, reader: TokenReader, cfg: TokenConfig, address: string, now: number): Promise<Entitlement> {
  const addr = getAddress(address);
  const meta = await reader.metadata();
  const raw = meta ? ((await reader.balances([addr])).get(addr) ?? 0n) : 0n;
  const whole = meta ? formatUnits(raw, meta.decimals) : "0";
  const { tier, next } = tierFor(Number(whole), cfg.tiers);
  const burnSlots = activeBurnSlots(db, addr, now);
  const counts = db
    .prepare("SELECT SUM(status = 'active') AS active, SUM(status = 'paused' AND pause_reason = 'over_quota') AS over FROM agents WHERE owner = ?")
    .get(addr) as { active: number | null; over: number | null };
  return {
    address: addr,
    token: { launched: Boolean(cfg.address), address: cfg.address, symbol: meta?.symbol ?? null },
    balance: whole,
    tier,
    nextTier: next,
    burnSlots,
    agentSlots: tier.agents + burnSlots.reduce((a, b) => a + b.slots, 0),
    agentsActive: Number(counts.active ?? 0),
    agentsPausedOverQuota: Number(counts.over ?? 0),
    compilesToday: compilesOn(db, addr, utcDay(now)),
    compilesPerDay: tier.compilesPerDay,
  };
}

/** The two addresses a burn may go to. */
export const BURN_ADDRESSES = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD"].map((a) => getAddress(a)));

export type BurnClaim =
  | { ok: true; slots: number; amount: string; expiresAt: number; already: boolean }
  | { ok: false; reason: string };

/**
 * Credits agent slots for a burn transaction sent by `address`. Each Transfer of the project
 * token from that address to the zero or dead address in the transaction counts once; a
 * transaction can never be credited twice, and only the sender can claim it.
 */
export async function claimBurn(db: DatabaseSync, client: PublicClient, cfg: TokenConfig, address: string, txHash: Hex): Promise<BurnClaim> {
  if (!cfg.address) return { ok: false, reason: "the token has not launched yet" };
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: "not a transaction hash" };
  const addr = getAddress(address);
  const token = getAddress(cfg.address);

  const existing = db.prepare("SELECT address, SUM(slots) AS slots, MAX(expires_at) AS exp, SUM(CAST(amount AS REAL)) AS amt FROM burns WHERE tx_hash = ? GROUP BY address").get(txHash.toLowerCase()) as
    | { address: string; slots: number; exp: number; amt: number }
    | undefined;
  if (existing) {
    if (existing.address !== addr) return { ok: false, reason: "this burn was already claimed by another wallet" };
    return { ok: true, slots: Number(existing.slots), amount: String(existing.amt), expiresAt: Number(existing.exp), already: true };
  }

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return { ok: false, reason: "transaction not found (not mined yet, or wrong network)" };
  }
  if (receipt.status !== "success") return { ok: false, reason: "the transaction failed" };

  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs }).filter(
    (l) => getAddress(l.address) === token && getAddress(l.args.from) === addr && BURN_ADDRESSES.has(getAddress(l.args.to)),
  );
  if (transfers.length === 0) return { ok: false, reason: "no burn of the token from your wallet in this transaction" };

  const decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const burnedAt = Number(block.timestamp);
  const expiresAt = burnedAt + cfg.burnSlotDays * 86400;
  const perSlot = BigInt(Math.round(cfg.burnTokensPerSlot)) * 10n ** BigInt(decimals);
  const total = transfers.reduce((s, l) => s + l.args.value, 0n);
  const slots = Number(total / perSlot);
  if (slots === 0) return { ok: false, reason: `burned ${formatUnits(total, decimals)}, need at least ${cfg.burnTokensPerSlot} for one slot` };

  // Record every matching log, so a second claim of the same transaction is recognised.
  // Slots are attributed to the first log; amounts are kept per log.
  db.exec("BEGIN");
  try {
    transfers.forEach((l, i) =>
      db
        .prepare("INSERT INTO burns (tx_hash, log_index, address, amount, slots, burned_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(txHash.toLowerCase(), Number(l.logIndex), addr, formatUnits(l.args.value, decimals), i === 0 ? slots : 0, burnedAt, expiresAt),
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { ok: true, slots, amount: formatUnits(total, decimals), expiresAt, already: false };
}
