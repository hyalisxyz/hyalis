/**
 * Real-money agents in the engine: a decision becomes an order for the live trader (not a paper
 * fill), the account waits for the swap, nothing is decided while an order is in flight or live
 * trading is off, and the API shows the agent's money and wallet. The swaps themselves are tested
 * against the real contracts in test/fork/live.fork.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { english, generateMnemonic } from "viem/accounts";
import type { PublicClient } from "viem";
import { openDb } from "../src/store/db.ts";
import { runTick } from "../src/engine/tick.ts";
import { createAgent, getAccount, setStatus } from "../src/engine/agents.ts";
import { Policy } from "../src/guard/policy.ts";
import { liveMayDecide, openOrders, RETRY_AFTER_SEC, walletAt } from "../src/live/live.ts";
import { buildApi } from "../src/api/server.ts";
import { DEFAULT_TIERS, TokenReader } from "../src/token/token.ts";
import { loadConfig } from "../src/config.ts";
import { ALWAYS_OPEN, fakeChain, FEED, H, MARKETS, strategy } from "./helpers.ts";

function setup(liveOn: boolean) {
  const t0 = 1_800_000_000 - (1_800_000_000 % H);
  const rounds: Array<[number, number]> = [];
  for (let h = 0; h < 30; h++) rounds.push([t0 + h * H + 60, 100]);
  rounds.push([t0 + 30 * H + 60, 90]); // a 10% drop: the dip rule fires
  const clock = { now: t0 + 30 * H + 120 };
  const db = openDb(":memory:");
  const ctx = { db, chain: fakeChain({ [FEED]: rounds }, () => clock.now), markets: MARKETS, plankton: null, epochSec: H, ...ALWAYS_OPEN, liveOn };
  const paper = createAgent(db, { name: "paper", prompt: null, strategy: strategy(), policy: Policy.parse({}) }, clock.now);
  const live = createAgent(db, { name: "real", prompt: null, strategy: strategy({ positionPct: 50 }), policy: Policy.parse({ maxPositionPct: 50 }), owner: null, liveIndex: 0 }, clock.now);
  // Funded with $5, as the funding script would.
  db.prepare("UPDATE accounts SET account_json = ?, start_equity = 5, day_start_equity = 5, equity = 5 WHERE agent_id = ?").run(JSON.stringify({ cash: 5, positions: [] }), live.id);
  setStatus(db, live.id, "active");
  return { db, ctx, clock, paper, live };
}

test("a live agent's decision becomes an order; its account waits for the swap", async () => {
  const { db, ctx, clock, paper, live } = setup(true);
  const s = await runTick(ctx, clock.now);
  assert.equal(s.fills, 1); // the paper agent filled; the live one only ordered

  assert.equal(getAccount(db, paper.id).account.positions.length, 1);
  const acc = getAccount(db, live.id);
  assert.equal(acc.account.positions.length, 0);
  assert.equal(acc.account.cash, 5);

  const [o] = openOrders(db, live.id);
  assert.equal(o!.symbol, "NVDA");
  assert.equal(o!.action, "open");
  assert.equal(o!.usd_in, 2.5); // 50% of $5
  const rec = JSON.parse((db.prepare("SELECT record_json FROM receipts WHERE leaf = ?").get(o!.decision_leaf) as any).record_json);
  assert.equal(rec.outcome, "submitted");
  assert.equal(rec.money, "real");
  assert.equal(rec.fill, null);

  // While the order is in flight, the agent decides nothing more.
  clock.now += 300;
  await runTick(ctx, clock.now);
  assert.equal(openOrders(db, live.id).length, 1);

  // After a failure it waits before deciding again.
  db.prepare("UPDATE live_orders SET status = 'failed', updated_at = ? WHERE id = ?").run(clock.now, o!.id);
  assert.equal(liveMayDecide(db, live.id, clock.now + 60), false);
  assert.equal(liveMayDecide(db, live.id, clock.now + RETRY_AFTER_SEC), true);
});

test("with live trading off, a live agent decides nothing; paper agents are unaffected", async () => {
  const { db, ctx, clock, paper, live } = setup(false);
  await runTick(ctx, clock.now);
  assert.equal(openOrders(db).length, 0);
  assert.equal(getAccount(db, paper.id).account.positions.length, 1);
  assert.equal(getAccount(db, live.id).account.cash, 5);
});

test("a new live agent starts paused and empty; the API shows its money and wallet", async () => {
  const db = openDb(":memory:");
  const mnemonic = generateMnemonic(english);
  const a = createAgent(db, { name: "real", prompt: null, strategy: strategy(), policy: Policy.parse({}), owner: null, liveIndex: 1 }, 1_800_000_000);
  assert.equal(a.status, "paused");
  assert.equal(a.liveIndex, 1);
  assert.equal(getAccount(db, a.id).startEquity, 0);
  const p = createAgent(db, { name: "paper", prompt: null, strategy: strategy(), policy: Policy.parse({}) }, 1_800_000_000);

  const chain = {} as PublicClient;
  const app = buildApi({
    db, config: loadConfig({ APP_DOMAIN: "agent.test" }), markets: MARKETS, lastTick: () => null, chain,
    token: { reader: new TokenReader(chain, null, 0), cfg: { address: null, tiers: DEFAULT_TIERS, burnTokensPerSlot: 1, burnSlotDays: 1 } },
    rateLimitPerMinute: 1000, liveWallet: (i) => walletAt(mnemonic, i).address,
  });
  const list = (await (await app.request("/v1/agents")).json()) as any[];
  const real = list.find((x) => x.id === a.id);
  assert.equal(real.money, "real");
  assert.equal(real.wallet, walletAt(mnemonic, 1).address);
  const paper = list.find((x) => x.id === p.id);
  assert.equal(paper.money, "paper");
  assert.equal(paper.wallet, null);
});

test("an agent's live view: each rule against the latest closes, and the return marked at the latest price", async () => {
  const { agentNow } = await import("../src/engine/now.ts");
  const { db, ctx, clock, paper } = setup(false);
  // Before trading (agent paused for one tick, so prices are stored but nothing fills): the dip rule is met.
  setStatus(db, paper.id, "paused");
  await runTick(ctx, clock.now);
  const before = agentNow(db, (await import("../src/engine/agents.ts")).getAgent(db, paper.id)!, MARKETS, clock.now, ALWAYS_OPEN);
  const nvda = before.symbols.find((s) => s.symbol === "NVDA")!;
  assert.equal(nvda.rules, "entry");
  assert.equal(nvda.state, "signal");
  assert.equal(nvda.met, nvda.of);
  assert.equal(nvda.price, 90);
  // After the paper fill: holding, with its profit or loss at the latest price.
  setStatus(db, paper.id, "active");
  clock.now += 300;
  await runTick(ctx, clock.now);
  const after = agentNow(db, (await import("../src/engine/agents.ts")).getAgent(db, paper.id)!, MARKETS, clock.now, ALWAYS_OPEN);
  const held = after.symbols.find((s) => s.symbol === "NVDA")!;
  assert.equal(held.state, "holding");
  assert.equal(held.rules, "exit");
  assert.ok(held.position && held.position.entryPrice > 0 && held.position.pnlPct !== null);
  assert.ok(Math.abs(after.returnPct) < 1);
});
