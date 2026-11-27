/**
 * ERC-8004 identity (Agent Passport): registration file, image, and linking an on-chain identity
 * to an agent through the HTTP API, against a local registry on anvil.
 *
 * The local registry (contracts/test/MockIdentityRegistry.sol) behaves like the deployed one
 * where we depend on it; test/fork/identity.fork.ts runs the same flow against the real one.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildApi } from "../src/api/server.ts";
import { openDb } from "../src/store/db.ts";
import { createAgent, getAgent } from "../src/engine/agents.ts";
import { Policy } from "../src/guard/policy.ts";
import { DEFAULT_TIERS, TokenReader, type TokenConfig } from "../src/token/token.ts";
import { legacyUrls, loadConfig, publicUrl } from "../src/config.ts";
import { agentImage, recheckIdentities, registrationFile, type IdentityConfig } from "../src/identity/identity.ts";
import { isNonexistent, registrationUri } from "../src/chain/identity.ts";
import registryArtifact from "./fixtures/MockIdentityRegistry.json" with { type: "json" };
import { MARKETS, strategy } from "./helpers.ts";

const hasAnvil = spawnSync("anvil", ["--version"], { shell: process.platform === "win32" }).status === 0;
const PORT = 20545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
// anvil's public test accounts; never used anywhere real.
const OPERATOR = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const ALICE = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const BOB = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const anvil = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const ABI = registryArtifact.abi as any;
const BASE = "https://agent.test";
const OLD_BASE = "https://old.agent.test";

let node: ChildProcess | null = null;
let pub: PublicClient;
const wallet = (acct: typeof ALICE) => createWalletClient({ account: acct, chain: anvil, transport: http(RPC) });

before(async () => {
  if (!hasAnvil) return;
  node = spawn("anvil", ["--port", String(PORT), "--silent"], { shell: process.platform === "win32" });
  pub = createPublicClient({ chain: anvil, transport: http(RPC) }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
});
after(() => {
  if (!node) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(node.pid), "/T", "/F"]);
  else node.kill();
});

const cfgFor = (registry: `0x${string}`, over: Partial<IdentityConfig> = {}): IdentityConfig => ({
  registry,
  publicUrl: BASE,
  legacyUrls: [OLD_BASE],
  houseOwner: OPERATOR.address,
  receiptRegistry: "0x8c4730f9fed980132eb6a8a681ceb558870de41a",
  brand: "Hyalis",
  epochSec: 3600,
  ...over,
});

function setup(chain: PublicClient, identity: IdentityConfig | undefined) {
  const db = openDb(":memory:");
  const config = loadConfig({ APP_DOMAIN: "agent.test" });
  const tokenCfg: TokenConfig = { address: null, tiers: DEFAULT_TIERS, burnTokensPerSlot: 500_000, burnSlotDays: 30 };
  const app = buildApi({ db, config, markets: MARKETS, lastTick: () => null, chain, token: { reader: new TokenReader(chain, null, 0), cfg: tokenCfg }, rateLimitPerMinute: 10_000, identity });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON (the image) */
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  return { db, call };
}

const newAgent = (db: ReturnType<typeof openDb>, owner: string | null, name = "Dip Buyer", prompt: string | null = "secret prompt: buy NVDA dips") =>
  createAgent(db, { name, prompt, strategy: strategy(), policy: Policy.parse({}), owner }, 1_800_000_000);

async function deployRegistry(): Promise<`0x${string}`> {
  const hash = await wallet(OPERATOR).deployContract({ abi: ABI, bytecode: registryArtifact.bytecode as Hex });
  return getAddress((await pub.waitForTransactionReceipt({ hash })).contractAddress!);
}

/** Registers `uri` from `acct`; returns the tx hash and the new token id. */
async function register(registry: `0x${string}`, acct: typeof ALICE, uri: string): Promise<{ tx: Hex; tokenId: string }> {
  const { request, result } = await pub.simulateContract({ account: acct, address: registry, abi: ABI, functionName: "register", args: [uri] });
  const tx = await wallet(acct).writeContract(request as any);
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  assert.equal(r.status, "success");
  return { tx, tokenId: (result as bigint).toString() };
}

async function write(registry: `0x${string}`, acct: typeof ALICE, functionName: string, args: unknown[]) {
  const hash = await wallet(acct).writeContract({ address: registry, abi: ABI, functionName, args, chain: anvil } as any);
  assert.equal((await pub.waitForTransactionReceipt({ hash })).status, "success");
}

// ---------------------------------------------------------------------------- no chain needed

test("config: public URL and legacy URLs are origins", () => {
  assert.equal(publicUrl({ PUBLIC_URL: "https://x.example/some/path/", APP_DOMAIN: "a.b", PORT: 1 }), "https://x.example");
  assert.equal(publicUrl({ PUBLIC_URL: undefined, APP_DOMAIN: "app.example", PORT: 1 }), "https://app.example");
  assert.equal(publicUrl({ PUBLIC_URL: undefined, APP_DOMAIN: "localhost", PORT: 8787 }), "http://localhost:8787");
  assert.deepEqual(legacyUrls({ LEGACY_PUBLIC_URLS: " https://a.example/ , ,https://b.example/x " }), ["https://a.example", "https://b.example"]);
  assert.deepEqual(legacyUrls({ LEGACY_PUBLIC_URLS: undefined }), []);
  assert.equal(registrationUri("https://a.example/", "id-1"), "https://a.example/v1/agents/id-1/registration.json");
});

test("registration file: standard shape, public data only, registrations only while verified", () => {
  const db = openDb(":memory:");
  const a = newAgent(db, ALICE.address);
  const cfg = cfgFor("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
  const track = { startEquity: 10_000, equity: 10_123.456, returnPct: 1.23456 };
  const f = registrationFile(cfg, a, track, null, true, 1_800_000_100);
  assert.equal(f.type, "https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
  assert.equal(f.name, "Dip Buyer");
  assert.equal(f.image, `${BASE}/v1/agents/${a.id}/image.svg`);
  assert.deepEqual(f.services.map((s) => s.name), ["web", "receipts"]);
  assert.equal(f.services[0]!.endpoint, `${BASE}/app/agents/${a.id}`);
  assert.equal(f.active, true);
  assert.equal(f.x402Support, false);
  assert.deepEqual(f.registrations, []);
  assert.equal(f.agentUtility.performance.equity, 10_123.46);
  assert.equal(f.agentUtility.performance.returnPct, 1.23);
  assert.equal(f.agentUtility.proofs.receiptRegistry, `eip155:4663:${getAddress("0x8c4730f9fed980132eb6a8a681ceb558870de41a")}`);
  assert.match(f.description, /paper trading NVDA with simulated funds/);
  assert.ok(!JSON.stringify(f).includes("secret prompt"), "the written prompt must never be published");

  const identity = { agentRegistry: "eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", agentId: "17", owner: ALICE.address, agentURI: "x", status: "ok" as const, verified: true, linkedAt: 1, checkedAt: 1, explorer: "x" };
  assert.deepEqual(registrationFile(cfg, a, track, identity, true, 1).registrations, [{ agentId: 17, agentRegistry: "eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }]);
  // A transferred identity is not advertised as this agent's.
  assert.deepEqual(registrationFile(cfg, a, track, { ...identity, status: "owner-changed", verified: false }, true, 1).registrations, []);
  // Ids beyond 2^53 stay exact as strings.
  assert.deepEqual(registrationFile(cfg, a, track, { ...identity, agentId: "123456789012345678901234567890" }, true, 1).registrations[0]!.agentId, "123456789012345678901234567890");
  assert.equal(registrationFile(cfg, { ...a, status: "paused" }, track, null, true, 1).active, false);
});

test("image: deterministic, and user text cannot inject markup", () => {
  const evil = { id: "a1", name: `<script>alert(1)</script> "x" & y` };
  const svg = agentImage(evil);
  assert.ok(svg.startsWith("<svg "));
  assert.ok(!/<script|alert|&(?!amp;)/.test(svg.replace(/&amp;/g, "")), svg);
  assert.match(svg, />SX</, "initials are the first letter or digit of each word");
  assert.equal(agentImage(evil), svg);
  assert.notEqual(agentImage({ id: "a2", name: evil.name }), svg);
  assert.match(agentImage({ id: "a3", name: "!!! ???" }), />A</);
});

test("a network error is not mistaken for a missing identity", () => {
  assert.equal(isNonexistent(new Error("fetch failed")), false);
  assert.equal(isNonexistent(null), false);
});

test("identity routes are off without an identity config", async () => {
  const { db, call } = setup({} as PublicClient, undefined);
  const a = newAgent(db, ALICE.address);
  assert.equal((await call("GET", `/v1/agents/${a.id}/registration.json`)).status, 404);
  assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, { agentId: 1 })).status, 404);
  assert.equal((await call("GET", `/v1/agents/${a.id}`)).body.agent.identity, null);
});

// ---------------------------------------------------------------------------- on anvil

test("linking: verified on chain, idempotent, sealed as a receipt", { skip: !hasAnvil && "anvil not installed", timeout: 60_000 }, async () => {
  const registry = await deployRegistry();
  const cfg = cfgFor(registry);
  const { db, call } = setup(pub, cfg);
  const a = newAgent(db, ALICE.address);

  const info = await call("GET", `/v1/agents/${a.id}/identity`);
  assert.equal(info.status, 200);
  assert.equal(info.body.agentURI, `${BASE}/v1/agents/${a.id}/registration.json`);
  assert.equal(info.body.expectedOwner, ALICE.address);
  assert.equal(info.body.registry, registry);
  assert.equal(info.body.identity, null);

  const { tx, tokenId } = await register(registry, ALICE, info.body.agentURI);
  assert.equal(tokenId, "0", "the registry counts from 0");
  const linked = await call("POST", `/v1/agents/${a.id}/identity`, { txHash: tx });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  assert.equal(linked.body.identity.agentId, "0");
  assert.equal(linked.body.identity.verified, true);
  assert.equal(linked.body.identity.owner, ALICE.address);
  assert.equal(linked.body.identity.agentRegistry, `eip155:4663:${registry}`);

  // The same identity again, by tx or by id: no change, no second receipt.
  assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, { txHash: tx })).status, 200);
  const again = await call("POST", `/v1/agents/${a.id}/identity`, { agentId: 0 });
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true);
  const receipts = db.prepare("SELECT record_json FROM receipts WHERE agent_id = ? AND kind = 'identity'").all(a.id) as any[];
  assert.equal(receipts.length, 1);
  const rec = JSON.parse(receipts[0].record_json);
  assert.equal(rec.erc8004AgentId, "0");
  assert.equal(rec.owner, ALICE.address);
  assert.equal(rec.agentURI, info.body.agentURI);

  // It shows on the agent and in its registration file.
  assert.equal((await call("GET", `/v1/agents/${a.id}`)).body.agent.identity.agentId, "0");
  const file = await call("GET", `/v1/agents/${a.id}/registration.json`);
  assert.equal(file.status, 200);
  assert.deepEqual(file.body.registrations, [{ agentId: 0, agentRegistry: `eip155:4663:${registry}` }]);
  assert.equal(file.headers.get("access-control-allow-origin"), "*", "other apps must be able to read it");

  const img = await call("GET", `/v1/agents/${a.id}/image.svg`);
  assert.equal(img.status, 200);
  assert.match(img.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  assert.match(img.headers.get("content-security-policy") ?? "", /default-src 'none'/);
});

test("linking refuses what the chain does not support", { skip: !hasAnvil && "anvil not installed", timeout: 60_000 }, async () => {
  const registry = await deployRegistry();
  const cfg = cfgFor(registry);
  const { db, call } = setup(pub, cfg);
  const a = newAgent(db, ALICE.address);
  const other = newAgent(db, ALICE.address, "Other");
  const uri = registrationUri(BASE, a.id);

  // Bad input.
  const overUint256 = (2n ** 256n).toString(); // 78 digits, one past the largest token id
  for (const body of [{}, { agentId: "-1" }, { agentId: "1.5" }, { agentId: "01" }, { agentId: "abc" }, { agentId: overUint256 }, { txHash: "0x1234" }, { agentId: 1, txHash: "0x" + "00".repeat(32) }]) {
    assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call("POST", `/v1/agents/nope/identity`, { agentId: 0 })).status, 404);

  // No such token; no such transaction.
  assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, { agentId: "999" })).status, 404);
  assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, { txHash: "0x" + "ab".repeat(32) })).status, 404);

  // Someone else owns a token pointing at this agent's file.
  const bobs = await register(registry, BOB, uri);
  const r1 = await call("POST", `/v1/agents/${a.id}/identity`, { agentId: bobs.tokenId });
  assert.equal(r1.status, 403);
  assert.match(r1.body.error, new RegExp(BOB.address));
  assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, { txHash: bobs.tx })).status, 403);

  // The owner's token points somewhere else: another agent's file, or a look-alike URL.
  const wrong = await register(registry, ALICE, registrationUri(BASE, other.id));
  assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, { agentId: wrong.tokenId })).status, 422);
  assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, { txHash: wrong.tx })).status, 422);
  const lookalike = await register(registry, ALICE, uri + "?x=1");
  assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, { agentId: lookalike.tokenId })).status, 422);
  const http_ = await register(registry, ALICE, uri.replace("https://", "http://"));
  assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, { agentId: http_.tokenId })).status, 422);

  // A transaction that is not a registration at all.
  const plain = await wallet(ALICE).sendTransaction({ to: BOB.address, value: 1n });
  await pub.waitForTransactionReceipt({ hash: plain });
  assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, { txHash: plain })).status, 422);

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM identities").get()!.n, 0, "nothing was linked");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE kind = 'identity'").get()!.n, 0);
});

test("house agents belong to the house wallet; legacy URLs still count", { skip: !hasAnvil && "anvil not installed", timeout: 60_000 }, async () => {
  const registry = await deployRegistry();
  const { db, call } = setup(pub, cfgFor(registry));
  const house = newAgent(db, null, "House Trend", null);
  assert.equal((await call("GET", `/v1/agents/${house.id}/identity`)).body.expectedOwner, OPERATOR.address);

  const byAlice = await register(registry, ALICE, registrationUri(BASE, house.id));
  assert.equal((await call("POST", `/v1/agents/${house.id}/identity`, { agentId: byAlice.tokenId })).status, 403);
  const byHouse = await register(registry, OPERATOR, registrationUri(OLD_BASE, house.id));
  const ok = await call("POST", `/v1/agents/${house.id}/identity`, { txHash: byHouse.tx });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.identity.agentURI, registrationUri(OLD_BASE, house.id));

  // Without a house wallet, house identities are off.
  const off = setup(pub, cfgFor(registry, { houseOwner: null }));
  const h2 = newAgent(off.db, null, "House 2", null);
  assert.equal((await off.call("GET", `/v1/agents/${h2.id}/identity`)).body.expectedOwner, null);
  assert.equal((await off.call("POST", `/v1/agents/${h2.id}/identity`, { agentId: byHouse.tokenId })).status, 422);
});

test("one identity per agent; a second is refused while the first verifies", { skip: !hasAnvil && "anvil not installed", timeout: 60_000 }, async () => {
  const registry = await deployRegistry();
  const cfg = cfgFor(registry);
  const { db, call } = setup(pub, cfg);
  const a = newAgent(db, ALICE.address);
  const uri = registrationUri(BASE, a.id);
  const first = await register(registry, ALICE, uri);
  const second = await register(registry, ALICE, uri);

  // Both at once: exactly one wins.
  const both = await Promise.all([call("POST", `/v1/agents/${a.id}/identity`, { agentId: first.tokenId }), call("POST", `/v1/agents/${a.id}/identity`, { agentId: second.tokenId })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409], JSON.stringify(both.map((r) => r.body)));
  const winner = both.find((r) => r.status === 201)!.body.identity.agentId as string;
  const loser = winner === first.tokenId ? second.tokenId : first.tokenId;
  assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, { agentId: loser })).status, 409);

  // Once the linked one is given away, the other can take its place.
  await write(registry, ALICE, "transferFrom", [ALICE.address, BOB.address, BigInt(winner)]);
  const swap = await call("POST", `/v1/agents/${a.id}/identity`, { agentId: loser });
  assert.equal(swap.status, 201, JSON.stringify(swap.body));
  assert.equal(swap.body.identity.agentId, loser);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE agent_id = ? AND kind = 'identity'").get(a.id)!.n, 2, "each link is sealed");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM identities").get()!.n, 1);
});

test("re-checks follow the chain: transfer, URI change, and back", { skip: !hasAnvil && "anvil not installed", timeout: 60_000 }, async () => {
  const registry = await deployRegistry();
  const cfg = cfgFor(registry);
  const { db, call } = setup(pub, cfg);
  const a = newAgent(db, ALICE.address);
  const house = newAgent(db, null, "House", null);
  const ta = await register(registry, ALICE, registrationUri(BASE, a.id));
  const th = await register(registry, OPERATOR, registrationUri(BASE, house.id));
  assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, { agentId: ta.tokenId })).status, 201);
  assert.equal((await call("POST", `/v1/agents/${house.id}/identity`, { agentId: th.tokenId })).status, 201);
  const agentOf = (id: string) => getAgent(db, id);
  const t0 = Math.floor(Date.now() / 1000);

  // Fresh links are not re-read before maxAge.
  assert.equal((await recheckIdentities(db, pub, cfg, agentOf, t0, { maxAgeSec: 3600 })).checked, 0);

  await write(registry, ALICE, "transferFrom", [ALICE.address, BOB.address, BigInt(ta.tokenId)]);
  await write(registry, OPERATOR, "setAgentURI", [BigInt(th.tokenId), "https://elsewhere.example/agent.json"]);
  const r = await recheckIdentities(db, pub, cfg, agentOf, t0 + 10, { maxAgeSec: 0 });
  assert.equal(r.checked, 2);
  assert.deepEqual(r.changed.map((x) => `${x.agentId === a.id ? "user" : "house"}:${x.to}`).sort(), ["house:uri-changed", "user:owner-changed"]);
  const ua = (await call("GET", `/v1/agents/${a.id}`)).body.agent.identity;
  assert.equal(ua.verified, false);
  assert.equal(ua.owner, BOB.address, "the current on-chain owner is shown");
  assert.deepEqual((await call("GET", `/v1/agents/${a.id}/registration.json`)).body.registrations, []);

  // Linking the same token again reports the problem and keeps it unverified.
  const refused = await call("POST", `/v1/agents/${house.id}/identity`, { agentId: th.tokenId });
  assert.equal(refused.status, 422);
  assert.equal((await call("GET", `/v1/agents/${house.id}`)).body.agent.identity.status, "uri-changed");

  // The house puts the URI back: the next check restores it.
  await write(registry, OPERATOR, "setAgentURI", [BigInt(th.tokenId), registrationUri(BASE, house.id)]);
  const back = await call("POST", `/v1/agents/${house.id}/identity`, { agentId: th.tokenId });
  assert.equal(back.status, 200);
  assert.equal(back.body.identity.verified, true);
});

test("a lagging RPC node is a retry, not a missing identity", { skip: !hasAnvil && "anvil not installed", timeout: 60_000 }, async () => {
  const registry = await deployRegistry();
  const cfg = cfgFor(registry);
  // Seen on production: the receipt came from one node, the reads from another a block behind.
  let lagTo: bigint | null = null;
  const lagging = new Proxy(pub, {
    get(target, prop) {
      if (prop === "readContract") return (args: any) => target.readContract(lagTo === null ? args : { ...args, blockNumber: lagTo });
      return (target as any)[prop];
    },
  }) as PublicClient;
  const { db, call } = setup(lagging, cfg);
  const a = newAgent(db, ALICE.address);
  const { tx, tokenId } = await register(registry, ALICE, registrationUri(BASE, a.id));
  lagTo = (await pub.getTransactionReceipt({ hash: tx })).blockNumber - 1n;

  const byTx = await call("POST", `/v1/agents/${a.id}/identity`, { txHash: tx });
  assert.equal(byTx.status, 503, JSON.stringify(byTx.body));
  assert.match(byTx.body.error, /not caught up/);
  // Without a receipt nothing proves the token exists, so a bare id stays a 404.
  assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, { agentId: tokenId })).status, 404);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM identities").get()!.n, 0);

  // Once the node has caught up, the same request links.
  lagTo = null;
  assert.equal((await call("POST", `/v1/agents/${a.id}/identity`, { txHash: tx })).status, 201);
});

test("a broken connection changes nothing and is reported as a retry", { skip: !hasAnvil && "anvil not installed", timeout: 60_000 }, async () => {
  const registry = await deployRegistry();
  const cfg = cfgFor(registry);
  const good = setup(pub, cfg);
  const a = newAgent(good.db, ALICE.address);
  const t = await register(registry, ALICE, registrationUri(BASE, a.id));
  assert.equal((await good.call("POST", `/v1/agents/${a.id}/identity`, { agentId: t.tokenId })).status, 201);

  const down = {
    readContract: async () => {
      throw new Error("fetch failed");
    },
    getTransactionReceipt: async () => {
      throw new Error("fetch failed");
    },
  } as unknown as PublicClient;
  const r = await recheckIdentities(good.db, down, cfg, (id) => getAgent(good.db, id), Math.floor(Date.now() / 1000) + 10, { maxAgeSec: 0 });
  assert.deepEqual({ checked: r.checked, failed: r.failed }, { checked: 0, failed: 1 });
  assert.equal(good.db.prepare("SELECT status FROM identities").get()!.status, "ok");

  const bad = setup(down, cfg);
  const b = newAgent(bad.db, ALICE.address);
  assert.equal((await bad.call("POST", `/v1/agents/${b.id}/identity`, { agentId: 0 })).status, 503);
  assert.equal((await bad.call("POST", `/v1/agents/${b.id}/identity`, { txHash: t.tx })).status, 503);
});
