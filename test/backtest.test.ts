import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest } from "../src/engine/backtest.ts";
import { openDb } from "../src/store/db.ts";
import { runTick } from "../src/engine/tick.ts";
import { createAgent, getAccount } from "../src/engine/agents.ts";
import { Policy } from "../src/guard/policy.ts";
import { hourWasOpen, marketState } from "../src/market/calendar.ts";
import type { RoundPoint } from "../src/strategy/series.ts";
import { ALWAYS_OPEN, et, fakeChain, FEED, H, MARKETS, strategy } from "./helpers.ts";

const t0 = 1_800_000_000 - (1_800_000_000 % H);

/** 30h flat at 100, a drop to 90, then a recovery of +1 per hour up to 100. */
function scenario(): Array<[number, number]> {
  const r: Array<[number, number]> = [];
  for (let h = 0; h < 30; h++) r.push([t0 + h * H + 60, 100]);
  r.push([t0 + 30 * H + 60, 90]);
  for (let k = 1; k <= 10; k++) r.push([t0 + (30 + k) * H + 60, 90 + k]);
  return r;
}

const toPoints = (r: Array<[number, number]>): RoundPoint[] => r.map(([t, p], i) => ({ roundId: String(i + 1), price: p, updatedAt: t }));
const heartbeat = new Map([["NVDA", 86400]]);

test("backtest: buys the drop, takes profit, reports stats", () => {
  const res = runBacktest({
    strategy: strategy({ takeProfitPct: 8 }),
    policy: Policy.parse({}),
    rounds: new Map([["NVDA", toPoints(scenario())]]),
    heartbeatSec: heartbeat,
    from: t0,
    to: t0 + 41 * H,
    ...ALWAYS_OPEN,
  });
  assert.equal(res.trades.length, 1);
  const tr = res.trades[0]!;
  assert.equal(tr.entry, 90);
  assert.equal(tr.exit, 98); // first close at or above +8%: 97.2
  assert.match(tr.reason, /take profit/);
  assert.equal(res.winRatePct, 100);
  assert.ok(res.returnPct > 0.8 && res.returnPct < 0.9, `return ${res.returnPct}`); // 10% of equity x +8.9% minus fees
  assert.equal(res.benchmarkReturnPct, 0); // 100 -> 100
  assert.ok(res.maxDrawdownPct >= 0);
  assert.ok(res.fees > 0);
});

test("backtest: no look-ahead, a decision only sees rounds published before it", () => {
  const res = runBacktest({
    strategy: strategy({ takeProfitPct: 8 }),
    policy: Policy.parse({}),
    rounds: new Map([["NVDA", toPoints(scenario())]]),
    heartbeatSec: heartbeat,
    from: t0,
    to: t0 + 41 * H,
    ...ALWAYS_OPEN,
  });
  // The drop is published at t0 + 30h + 60s; the earliest possible buy is in that hour.
  assert.ok(res.trades[0]!.openedAt >= t0 + 30 * H + 60);
});

test("backtest and live agent give the same fills on the same data", async () => {
  const rounds = scenario();
  const strat = strategy({ takeProfitPct: 8 });
  const policy = Policy.parse({});
  const bt = runBacktest({ strategy: strat, policy, rounds: new Map([["NVDA", toPoints(rounds)]]), heartbeatSec: heartbeat, from: t0, to: t0 + 41 * H, ...ALWAYS_OPEN });

  // Live: tick at the same instants the backtest decides (last minute of each hour).
  let now = t0;
  const db = openDb(":memory:");
  const ctx = { db, chain: fakeChain({ [FEED]: rounds }, () => now), markets: MARKETS, plankton: null, epochSec: H, ...ALWAYS_OPEN };
  const a = createAgent(db, { name: "x", prompt: null, strategy: strat, policy }, t0);
  for (let end = t0 + H; end <= t0 + 41 * H; end += H) {
    now = end - 60;
    await runTick(ctx, now);
  }
  const fills = db
    .prepare("SELECT json_extract(record_json, '$.fill.action') AS action, json_extract(record_json, '$.fill.price') AS price FROM receipts WHERE json_extract(record_json, '$.fill') IS NOT NULL ORDER BY id")
    .all()
    .map((r: any) => `${r.action}@${r.price}`);
  assert.deepEqual(fills, bt.trades.flatMap((tr) => [`open@${tr.entry}`, `close@${tr.exit}`]));
  assert.equal(Math.round(getAccount(db, a.id).equity * 100) / 100, bt.endEquity);
});

test("backtest: closed hours are skipped with the real calendar", () => {
  // Friday 2026-11-20 10:00 ET to Monday 2026-11-23 10:00 ET.
  const from = et("2026-11-20T10:00:00", -5);
  const to = et("2026-11-23T10:00:00", -5);
  const res = runBacktest({
    strategy: strategy(),
    policy: Policy.parse({}),
    rounds: new Map([["NVDA", [{ roundId: "1", price: 100, updatedAt: from - H }]]]),
    heartbeatSec: heartbeat,
    from,
    to,
    market: marketState,
    hourOpen: hourWasOpen,
  });
  // Open hours: Fri 10:00-20:00 (10) + Sun 20:00-24:00 (4) + Mon 00:00-10:00 (10) = 24.
  assert.equal(res.hours, 24);
  for (const [end] of res.equityCurve) assert.notEqual(marketState(end - 60).reason, "weekend");
});
