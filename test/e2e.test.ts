/**
 * The whole user flow on a local chain (anvil), through the HTTP API:
 *
 *   before launch: wallet view (free tier) → sign in → AI dry run with backtest → create agent
 *   → slot limit → token launch → balance moves the tier → more agents → agents trade
 *   → tokens leave the wallet → extra agents pause → burn for a slot → agent resumes
 *   → AI quota → ownership checks → epoch sealed → root anchored on chain → receipt verified
 *   by the registry contract.
 *
 * Prices come from a fake Chainlink feed; everything on chain (sign-in, token, burns, registry)
 * runs on anvil. Skipped when Foundry's anvil is not installed.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildApi } from "../src/api/server.ts";
import { openDb } from "../src/store/db.ts";
import { runTick } from "../src/engine/tick.ts";
import { Anchorer, REGISTRY_ABI, REGISTRY_BYTECODE } from "../src/chain/anchor.ts";
import { recordHash } from "../src/receipts/merkle.ts";
import { DEFAULT_TIERS, entitlement, TokenReader, type TokenConfig } from "../src/token/token.ts";
import { enforceSlots } from "../src/token/quota.ts";
import { loadConfig, type Market } from "../src/config.ts";
import type { compileStrategy } from "../src/brain/compile.ts";
import mockToken from "./fixtures/MockToken.json" with { type: "json" };
import { ALWAYS_OPEN, fakeChain, FEED, H, strategy } from "./helpers.ts";

const hasAnvil = spawnSync("anvil", ["--version"], { shell: process.platform === "win32" }).status === 0;
const PORT = 19545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
// anvil's public test accounts; never used anywhere real.
const OPERATOR = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const ALICE = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const BOB = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const anvil = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const TOKEN_ABI = mockToken.abi as any;
const DEAD = "0x000000000000000000000000000000000000dEaD";

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

async function send(hash: Promise<Hex>) {
  const r = await pub.waitForTransactionReceipt({ hash: await hash });
  assert.equal(r.status, "success");
  return r;
}

test("end-to-end: wallet, tiers, agents, burns, trading, sealing and on-chain proof", { skip: !hasAnvil && "anvil not installed", timeout: 120_000 }, async () => {
  // ------------------------------------------------------------ setup
  const db = openDb(":memory:");
  const markets: Market[] = [{ symbol: "NVDA", assetClass: "equity", source: "chainlink", feed: FEED, decimals: 8, heartbeatSec: 86400, deviationPct: 0.5 }];
  const blockNow = Number((await pub.getBlock()).timestamp);
  const t0 = blockNow - (blockNow % H) - 6 * H; // ticks happen in the recent past, so their epochs have ended on chain

  // Price history: flat at 100, then a drop to 90 that makes every agent's entry fire.
  const rounds: Array<[number, number]> = [];
  for (let h = 40; h >= 1; h--) rounds.push([t0 - h * H, 100]);
  rounds.push([t0 + 60, 90]);
  let tickNow = t0 + 120;
  const priceChain = fakeChain({ [FEED]: rounds }, () => tickNow);

  // The brain is replaced by a stub here: no API calls, no cost, same output shape.
  let compiles = 0;
  const compile: typeof compileStrategy = async (prompt) => {
    compiles++;
    return { strategy: strategy({ name: `agent: ${prompt.slice(0, 20)}` }), model: "stub", errors: [] };
  };

  const config = loadConfig({ ADMIN_TOKEN: "x", APP_DOMAIN: "agent.test" });
  const tiers = [{ ...DEFAULT_TIERS[0]!, compilesPerDay: 6 }, DEFAULT_TIERS[1]!, DEFAULT_TIERS[2]!];
  const tokenCfg: TokenConfig = { address: null, tiers, burnTokensPerSlot: 500_000, burnSlotDays: 30 };
  let reader = new TokenReader(pub, null, 0);
  const app = () =>
    buildApi({ db, config, markets, lastTick: () => null, chain: pub, token: { reader, cfg: tokenCfg }, compile, adminToken: "admin-secret", rateLimitPerMinute: 1000 });
  let api = app();
  const call = async (method: string, path: string, body?: unknown, auth?: string) => {
    const res = await api.request(path, {
      method,
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const signIn = async (acct: typeof ALICE) => {
    const n = await call("POST", "/v1/auth/nonce", { address: acct.address });
    const signature = await acct.signMessage({ message: n.body.message });
    const v = await call("POST", "/v1/auth/verify", { address: acct.address, nonce: n.body.nonce, signature });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    return { session: v.body.token as string, nonce: n.body.nonce as string, signature };
  };
  const slotsFor = async (owner: string) => (await entitlement(db, reader, tokenCfg, owner, Math.floor(Date.now() / 1000))).agentSlots;

  // ------------------------------------------------------------ before launch
  let w = await call("GET", `/v1/wallets/${ALICE.address}`);
  assert.equal(w.status, 200);
  assert.equal(w.body.token.launched, false);
  assert.equal(w.body.balance, "0");
  assert.equal(w.body.tier.name, "Free");
  assert.equal(w.body.agentSlots, 1);

  // Sign in. A nonce works once; a signature from another key is refused.
  const alice = await signIn(ALICE);
  const replay = await call("POST", "/v1/auth/verify", { address: ALICE.address, nonce: alice.nonce, signature: alice.signature });
  assert.equal(replay.status, 401);
  const n2 = await call("POST", "/v1/auth/nonce", { address: ALICE.address });
  const forged = await call("POST", "/v1/auth/verify", { address: ALICE.address, nonce: n2.body.nonce, signature: await BOB.signMessage({ message: n2.body.message }) });
  assert.equal(forged.status, 401);
  assert.equal((await call("POST", "/v1/agents", { prompt: "buy the dip in nvidia please" })).status, 401); // not signed in

  // AI dry run: strategy + backtest, nothing created.
  const dry = await call("POST", "/v1/agents", { prompt: "buy nvidia when it drops five percent", dryRun: true }, alice.session);
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.ok(dry.body.backtest && dry.body.strategy);
  assert.equal((await call("GET", "/v1/me", undefined, alice.session)).body.agents.length, 0);

  // Create the one free agent; a second does not fit.
  const a1 = await call("POST", "/v1/agents", { prompt: "first agent buys nvidia dips" }, alice.session);
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  assert.equal(a1.body.agent.owner, ALICE.address);
  const full = await call("POST", "/v1/agents", { prompt: "second agent buys nvidia dips" }, alice.session);
  assert.equal(full.status, 403);
  assert.equal(full.body.error, "no free agent slot");
  assert.equal(compiles, 2); // the refused one never reached the brain

  // ------------------------------------------------------------ launch (TOKEN_ADDRESS set, restart)
  const deployed = await send(wallet(OPERATOR).deployContract({ abi: TOKEN_ABI, bytecode: mockToken.bytecode as Hex }));
  const token = deployed.contractAddress!;
  tokenCfg.address = token;
  reader = new TokenReader(pub, token, 0);
  api = app();
  await send(wallet(OPERATOR).writeContract({ address: token, abi: TOKEN_ABI, functionName: "mint", args: [ALICE.address, parseUnits("1200000", 18)] }));

  w = await call("GET", `/v1/wallets/${ALICE.address}`);
  assert.equal(w.body.token.launched, true);
  assert.equal(w.body.token.symbol, "TEST");
  assert.equal(w.body.balance, "1200000");
  assert.equal(w.body.tier.name, "Holder");
  assert.equal(w.body.agentSlots, 3);
  assert.equal(w.body.nextTier.name, "Whale");
  assert.equal(w.body.nextTier.needed, 3_800_000);

  const a2 = await call("POST", "/v1/agents", { prompt: "second agent buys nvidia dips" }, alice.session);
  const a3 = await call("POST", "/v1/agents", { prompt: "third agent buys nvidia dips" }, alice.session);
  assert.equal(a2.status, 201);
  assert.equal(a3.status, 201);
  assert.equal((await call("POST", "/v1/agents", { prompt: "fourth agent buys nvidia dips" }, alice.session)).status, 403);

  // Prompts are private: public listings carry the rules and the prompt's hash, not the text.
  const pubList = await call("GET", "/v1/agents");
  assert.equal(pubList.body.length, 3);
  assert.ok(pubList.body.every((x: any) => x.prompt === undefined));
  assert.equal((await call("GET", "/v1/me", undefined, alice.session)).body.agents[0].prompt, "first agent buys nvidia dips");

  // ------------------------------------------------------------ the agents trade
  const ctx = { db, chain: priceChain, markets, plankton: null, epochSec: H, ...ALWAYS_OPEN };
  const s1 = await runTick(ctx, tickNow);
  assert.equal(s1.agents, 3);
  assert.equal(s1.fills, 3);

  // ------------------------------------------------------------ tokens leave the wallet
  await send(wallet(ALICE).writeContract({ address: token, abi: TOKEN_ABI, functionName: "transfer", args: [BOB.address, parseUnits("1000000", 18)] }));
  let q = await enforceSlots(db, slotsFor);
  assert.deepEqual(q.paused.sort(), [a2.body.agent.id, a3.body.agent.id].sort()); // newest two
  let me = (await call("GET", "/v1/me", undefined, alice.session)).body;
  assert.equal(me.tier.name, "Free");
  assert.equal(me.agentsActive, 1);
  assert.equal(me.agentsPausedOverQuota, 2);
  // A paused-for-quota agent cannot be resumed by hand while there is no slot.
  assert.equal((await call("POST", `/v1/agents/${a2.body.agent.id}/resume`, {}, alice.session)).status, 403);

  // ------------------------------------------------------------ burn for a slot
  await send(wallet(OPERATOR).writeContract({ address: token, abi: TOKEN_ABI, functionName: "mint", args: [ALICE.address, parseUnits("500000", 18)] }));
  const burnTx = await send(wallet(ALICE).writeContract({ address: token, abi: TOKEN_ABI, functionName: "transfer", args: [DEAD, parseUnits("500000", 18)] }));
  const bob = await signIn(BOB);
  const stolen = await call("POST", "/v1/burns", { txHash: burnTx.transactionHash }, bob.session);
  assert.equal(stolen.status, 400); // only the sender can claim it
  const claim = await call("POST", "/v1/burns", { txHash: burnTx.transactionHash }, alice.session);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.slots, 1);
  assert.equal(claim.body.wallet.agentSlots, 2);
  const again = await call("POST", "/v1/burns", { txHash: burnTx.transactionHash }, alice.session);
  assert.equal(again.body.already, true); // counted once
  assert.equal(again.body.slots, 1);
  const notABurn = await send(wallet(ALICE).writeContract({ address: token, abi: TOKEN_ABI, functionName: "transfer", args: [BOB.address, 1n] }));
  assert.equal((await call("POST", "/v1/burns", { txHash: notABurn.transactionHash }, alice.session)).status, 400);
  q = await enforceSlots(db, slotsFor);
  assert.deepEqual(q.resumed, [a2.body.agent.id]); // the older one comes back first

  // ------------------------------------------------------------ AI quota and ownership
  me = (await call("GET", "/v1/me", undefined, alice.session)).body;
  assert.equal(me.compilesPerDay, 6);
  for (let i = me.compilesToday; i < 6; i++) assert.equal((await call("POST", "/v1/agents", { prompt: "another dry run idea", dryRun: true }, alice.session)).status, 200);
  const over = await call("POST", "/v1/agents", { prompt: "one dry run too many", dryRun: true }, alice.session);
  assert.equal(over.status, 429);
  assert.equal((await call("POST", "/v1/agents", { strategy: strategy(), dryRun: true }, alice.session)).status, 200); // rules without the brain are not limited

  assert.equal((await call("POST", `/v1/agents/${a1.body.agent.id}/pause`, {}, bob.session)).status, 403); // not Bob's
  assert.equal((await call("POST", `/v1/agents/${a1.body.agent.id}/pause`, {}, alice.session)).body.status, "paused");
  q = await enforceSlots(db, slotsFor);
  assert.deepEqual(q.resumed, [a3.body.agent.id]); // a freed slot goes to the agent waiting for one
  assert.equal((await call("POST", `/v1/agents/${a1.body.agent.id}/resume`, {}, alice.session)).status, 403); // now full again

  // ------------------------------------------------------------ seal, anchor, verify on chain
  tickNow = t0 + H + 120; // next epoch: the first one is sealed
  const s2 = await runTick(ctx, tickNow);
  assert.equal(s2.sealedEpochs.length, 1);
  const regDeploy = await send(wallet(OPERATOR).deployContract({ abi: REGISTRY_ABI, bytecode: REGISTRY_BYTECODE, args: [OPERATOR.address, BigInt(H)] }));
  const anchorer = new Anchorer({ db, publicClient: pub, walletClient: wallet(OPERATOR) as any, registry: regDeploy.contractAddress!, epochSec: H });
  await anchorer.check();
  const rep = await anchorer.run();
  assert.equal(rep.error, null);
  assert.equal(rep.anchored.length, 1);

  const fillId = (db.prepare("SELECT id FROM receipts WHERE kind = 'decision' ORDER BY id LIMIT 1").get() as { id: number }).id;
  const receipt = (await call("GET", `/v1/receipts/${fillId}`)).body;
  assert.equal(receipt.sealed, true);
  assert.equal(receipt.anchor.registry.toLowerCase(), regDeploy.contractAddress!.toLowerCase());
  const onchain = await pub.readContract({
    address: regDeploy.contractAddress!,
    abi: REGISTRY_ABI,
    functionName: "verifyRecord",
    args: [BigInt(receipt.epoch), recordHash(receipt.record), receipt.proof],
  });
  assert.equal(onchain, true);
  assert.equal(receipt.record.decision.symbol, "NVDA");
  assert.equal(receipt.record.input.roundId, ((1n << 64n) + 41n).toString()); // the round the agent saw
});
