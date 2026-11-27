/**
 * ERC-8004 identity against the real Identity Registry, on a local fork of Robinhood Chain
 * mainnet. Proves the calls, the event decoding and the "no such token" detection work on the
 * deployed contract, not only on our test registry. Nothing touches the real chain.
 *
 *   npm run test:fork
 *
 * Fork source: FORK_RPC, else RPC_URL, else drpc.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildApi } from "../../src/api/server.ts";
import { openDb } from "../../src/store/db.ts";
import { createAgent, getAgent } from "../../src/engine/agents.ts";
import { Policy } from "../../src/guard/policy.ts";
import { DEFAULT_TIERS, TokenReader } from "../../src/token/token.ts";
import { loadConfig } from "../../src/config.ts";
import { recheckIdentities, type IdentityConfig } from "../../src/identity/identity.ts";
import { IDENTITY_ABI, IDENTITY_REGISTRY, readIdentity, registrationsIn, registrationUri } from "../../src/chain/identity.ts";
import { MARKETS, strategy } from "../helpers.ts";

const RPC_SRC = process.env.FORK_RPC ?? process.env.RPC_URL ?? "https://robinhood.drpc.org";
const PORT = 21545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 4663, name: "rh-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
// Fresh keys, funded on the fork only. anvil's well-known test accounts cannot be used here:
// on mainnet they carry EIP-7702 delegations, so the registry's safe mint to them reverts.
const ALICE = privateKeyToAccount(generatePrivateKey());
const BOB = privateKeyToAccount(generatePrivateKey());
const HOUSE = privateKeyToAccount(generatePrivateKey());
const ERC721 = parseAbi(["function transferFrom(address from, address to, uint256 tokenId)"]);

let node: ChildProcess | null = null;
let pub: PublicClient;
const wallet = (a: typeof ALICE) => createWalletClient({ account: a, chain, transport: http(RPC, { timeout: 240_000 }) });
const hasAnvil = spawnSync("anvil", ["--version"], { shell: process.platform === "win32" }).status === 0;

before(async () => {
  if (!hasAnvil) return;
  node = spawn("anvil", ["--fork-url", RPC_SRC, "--port", String(PORT), "--silent", "--chain-id", "4663"], { shell: process.platform === "win32" });
  pub = createPublicClient({ chain, transport: http(RPC, { timeout: 240_000 }), pollingInterval: 250 }) as PublicClient;
  for (let i = 0; i < 300; i++) {
    try {
      await pub.getBlockNumber();
      for (const a of [ALICE, BOB, HOUSE]) await pub.request({ method: "anvil_setBalance" as any, params: [a.address, "0x56BC75E2D63100000"] as any });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("anvil fork did not start");
});
after(() => {
  if (!node) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(node.pid), "/T", "/F"]);
  else node.kill();
});

async function register(acct: typeof ALICE, uri: string): Promise<{ tx: Hex; tokenId: bigint }> {
  const { request, result } = await pub.simulateContract({ account: acct, address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "register", args: [uri] });
  const tx = await wallet(acct).writeContract(request as any);
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  assert.equal(r.status, "success");
  // The event agrees with the return value.
  const ev = registrationsIn(r, IDENTITY_REGISTRY);
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.tokenId, result);
  assert.equal(ev[0]!.uri, uri);
  assert.equal(ev[0]!.owner, acct.address);
  return { tx, tokenId: result as bigint };
}

test("the real ERC-8004 registry: register, link, detect transfer", { skip: !hasAnvil && "anvil not installed", timeout: 600_000 }, async () => {
  assert.equal(await pub.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "getVersion" }), "2.0.0");

  // A token id far beyond the last one: the registry's own "does not exist" answer.
  assert.deepEqual(await readIdentity(pub, IDENTITY_REGISTRY, 10n ** 15n), { exists: false });

  const db = openDb(":memory:");
  const base = "https://agent.test";
  const cfg: IdentityConfig = { registry: IDENTITY_REGISTRY, publicUrl: base, legacyUrls: [], houseOwner: HOUSE.address, receiptRegistry: null, brand: "Hyalis", epochSec: 3600 };
  const app = buildApi({
    db,
    config: loadConfig({ APP_DOMAIN: "agent.test" }),
    markets: MARKETS,
    lastTick: () => null,
    chain: pub,
    token: { reader: new TokenReader(pub, null, 0), cfg: { address: null, tiers: DEFAULT_TIERS, burnTokensPerSlot: 500_000, burnSlotDays: 30 } },
    rateLimitPerMinute: 10_000,
    identity: cfg,
  });
  const call = async (path: string, body: unknown) => {
    const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const mk = (owner: string | null) => createAgent(db, { name: "Fork Agent", prompt: null, strategy: strategy(), policy: Policy.parse({}), owner }, 1_800_000_000);

  // User agent, registered from the user's wallet and linked by transaction.
  const a = mk(ALICE.address);
  const ra = await register(ALICE, registrationUri(base, a.id));
  const la = await call(`/v1/agents/${a.id}/identity`, { txHash: ra.tx });
  assert.equal(la.status, 201, JSON.stringify(la.body));
  assert.equal(la.body.identity.agentId, ra.tokenId.toString());
  assert.equal(la.body.identity.verified, true);

  // House agent, registered by the house wallet and linked by id.
  const h = mk(null);
  const rh = await register(HOUSE, registrationUri(base, h.id));
  assert.equal((await call(`/v1/agents/${h.id}/identity`, { agentId: rh.tokenId.toString() })).status, 201);

  // A token someone else owns is refused, even when it points at the agent's own file.
  const c = mk(ALICE.address);
  const rb = await register(BOB, registrationUri(base, c.id));
  assert.equal((await call(`/v1/agents/${c.id}/identity`, { agentId: rb.tokenId.toString() })).status, 403);
  // An agent that already has a verified identity keeps it.
  assert.equal((await call(`/v1/agents/${a.id}/identity`, { agentId: rb.tokenId.toString() })).status, 409);

  // A transfer on the real registry is picked up by the re-check.
  const hash = await wallet(ALICE).writeContract({ address: IDENTITY_REGISTRY, abi: ERC721, functionName: "transferFrom", args: [ALICE.address, BOB.address, ra.tokenId] });
  assert.equal((await pub.waitForTransactionReceipt({ hash })).status, "success");
  const r = await recheckIdentities(db, pub, cfg, (id) => getAgent(db, id), Math.floor(Date.now() / 1000) + 60, { maxAgeSec: 0 });
  assert.equal(r.failed, 0);
  assert.deepEqual(r.changed, [{ agentId: a.id, from: "ok", to: "owner-changed" }]);
});
