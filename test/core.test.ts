import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../src/receipts/canonical.ts";
import { buildTree, leafOf, proofFor, verifyLeaf } from "../src/receipts/merkle.ts";
import { hourlyCloses, rsi, sma } from "../src/strategy/series.ts";
import { decide, evalCondition } from "../src/strategy/evaluate.ts";
import { checkBounds, type Strategy } from "../src/strategy/schema.ts";
import { checkOrder, Policy } from "../src/guard/policy.ts";
import { gate } from "../src/guard/gate.ts";
import { closePosition, equity, liquidatable, openPosition } from "../src/paper/broker.ts";

test("canonical JSON sorts keys and rejects ambiguous values", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(canonicalJson({ z: { y: 2, x: 1 } }), canonicalJson({ z: { x: 1, y: 2 } }));
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson({ a: NaN }));
  assert.throws(() => canonicalJson({ a: 1n }));
});

test("merkle proofs verify for every leaf and fail when tampered", () => {
  for (const n of [1, 2, 3, 5, 8, 13]) {
    const records = Array.from({ length: n }, (_, i) => ({ i, msg: `r${i}` }));
    const leaves = records.map(leafOf);
    const tree = buildTree(leaves);
    for (const l of leaves) assert.ok(verifyLeaf(tree.root, l, proofFor(tree, l)), `n=${n}`);
    const forged = leafOf({ i: 0, msg: "changed" });
    assert.equal(verifyLeaf(tree.root, forged, proofFor(tree, leaves[0]!)), false);
  }
  // Order of insertion does not change the root.
  const ls = [1, 2, 3, 4].map((i) => leafOf({ i }));
  assert.equal(buildTree(ls).root, buildTree([...ls].reverse()).root);
});

test("hourly closes take the last round at or before each hour end", () => {
  const H = 3600;
  const now = 10 * H + 100;
  const rounds = [
    { roundId: "1", price: 100, updatedAt: 6 * H + 10 },
    { roundId: "2", price: 101, updatedAt: 7 * H + 5 },
    { roundId: "3", price: 99, updatedAt: 9 * H + 30 },
  ];
  const c = hourlyCloses(rounds, now, 4);
  assert.deepEqual(c.map((x) => [x.hourEnd / H, x.price, x.roundId]), [[8, 101, "2"], [9, 101, "2"], [10, 99, "3"], [11, 99, "3"]]);
});

test("indicators", () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(sma([1], 2), null);
  assert.equal(rsi([1, 2, 3, 4, 5], 4), 100);
  assert.equal(rsi([5, 4, 3, 2, 1], 4), 0);
  assert.equal(rsi([1, 1, 1], 2), 50);
});

const closes = (prices: number[]) => prices.map((price, i) => ({ hourEnd: (i + 1) * 3600, price, roundId: String(i + 1) }));

const dipBuyer: Strategy = {
  name: "dip",
  summary: "buy a 5% daily drop",
  symbols: ["NVDA", "AAPL"],
  side: "long",
  entry: [{ type: "change_pct", description: "down 5% in 24h", lookbackHours: 24, op: "lt", value: -5 }],
  exitConditions: [],
  stopLossPct: 8,
  takeProfitPct: 10,
  maxHoldHours: 0,
  positionPct: 10,
  maxOpenPositions: 3,
  leverage: 1,
  notes: [],
};

test("conditions need enough history and measure correctly", () => {
  const c = dipBuyer.entry[0]!;
  assert.equal(evalCondition(c, closes([100, 90])).pass, false); // not enough history
  const drop = closes([100, ...Array(23).fill(98), 94]);
  const r = evalCondition(c, drop);
  assert.equal(r.pass, true);
  assert.equal(r.value, -6);
});

test("decide opens on entry and closes on stop loss / take profit", () => {
  const drop = closes([100, ...Array(23).fill(98), 94]);
  const flat = closes(Array(25).fill(200));
  const sigs = decide(dipBuyer, new Map([["NVDA", drop], ["AAPL", flat]]), [], 30 * 3600);
  assert.deepEqual(sigs.map((s) => [s.kind, s.symbol]), [["open", "NVDA"]]);

  const held = [{ symbol: "AAPL", side: "long" as const, entryPrice: 220, openedAt: 0 }];
  const stop = decide(dipBuyer, new Map([["AAPL", flat]]), held, 30 * 3600);
  assert.equal(stop[0]?.kind, "close");
  assert.match(stop[0]!.reason, /stop loss/);

  const win = [{ symbol: "AAPL", side: "long" as const, entryPrice: 180, openedAt: 0 }];
  assert.match(decide(dipBuyer, new Map([["AAPL", flat]]), win, 30 * 3600)[0]!.reason, /take profit/);

  const short = [{ symbol: "AAPL", side: "short" as const, entryPrice: 180, openedAt: 0 }];
  assert.match(decide(dipBuyer, new Map([["AAPL", flat]]), short, 30 * 3600)[0]!.reason, /stop loss/);
});

test("bounds catch unknown symbols and bad windows", () => {
  const bad = { ...dipBuyer, symbols: ["NOPE"], leverage: 50 };
  const errs = checkBounds(bad, new Set(["NVDA"]));
  assert.ok(errs.some((e) => e.includes("unknown symbol")));
  assert.ok(errs.some((e) => e.includes("leverage")));
  assert.deepEqual(checkBounds(dipBuyer, new Set(["NVDA", "AAPL"])), []);
});

test("policy refuses orders outside the limits", () => {
  const p = Policy.parse({ maxLeverage: 2, maxPositionPct: 20, dailyLossPct: 5, allowShort: false });
  const acct = { equity: 10_000, dayStartEquity: 10_000, openPositions: 0 };
  assert.deepEqual(checkOrder(p, { symbol: "NVDA", side: "long", leverage: 1, positionPct: 10 }, acct), { ok: true });
  assert.equal(checkOrder(p, { symbol: "NVDA", side: "short", leverage: 1, positionPct: 10 }, acct).ok, false);
  assert.equal(checkOrder(p, { symbol: "NVDA", side: "long", leverage: 3, positionPct: 10 }, acct).ok, false);
  assert.equal(checkOrder(p, { symbol: "NVDA", side: "long", leverage: 1, positionPct: 30 }, acct).ok, false);
  assert.equal(checkOrder(p, { symbol: "NVDA", side: "long", leverage: 1, positionPct: 10 }, { ...acct, equity: 9_400 }).ok, false);
  assert.throws(() => Policy.parse({ maxLeverage: 5 }), "platform cap is 3x");
});

test("gate fails closed", () => {
  const base = { chainlinkPrice: 100, chainlinkUpdatedAt: 1000, heartbeatSec: 86400, secondPrice: null, halted: false, marketOpen: true, now: 2000 };
  assert.equal(gate(base).ok, true);
  assert.equal(gate({ ...base, halted: true }).ok, false);
  assert.equal(gate({ ...base, chainlinkPrice: null }).ok, false);
  assert.equal(gate({ ...base, chainlinkPrice: 0 }).ok, false);
  assert.equal(gate({ ...base, now: 1000 + 86400 * 2 }).ok, false);
  assert.equal(gate({ ...base, secondPrice: 101 }).ok, true);
  const v = gate({ ...base, secondPrice: 103 });
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.reason, "sources_disagree");
});

test("broker: isolated margin, fees and liquidation", () => {
  let a = { cash: 10_000, positions: [] as any[] };
  const o = openPosition(a, { symbol: "NVDA", side: "short", leverage: 2, positionPct: 20, price: 100, now: 0 }, 10_000);
  assert.ok(!("error" in o));
  a = o.account;
  assert.equal(o.fill.venue, "perp");
  assert.equal(o.fill.notional, 2000);
  assert.equal(a.positions[0].margin, 1000);
  assert.ok(Math.abs(a.cash - (10_000 - 1000 - 1.6)) < 1e-9);

  // Price up 46%: a 2x short has lost 920 of its 1000 margin, past the 90% line.
  const prices = new Map([["NVDA", 146]]);
  assert.deepEqual(liquidatable(a, prices), ["NVDA"]);
  // Loss is capped at the margin even far beyond it.
  assert.ok(equity(a, new Map([["NVDA", 500]])) >= a.cash - 1e-9);

  const c = closePosition(a, "NVDA", 90, 3600);
  assert.ok(!("error" in c));
  assert.ok(c.fill.pnl > 190 && c.fill.pnl < 200); // +200 gross minus fees
  assert.equal(c.account.positions.length, 0);

  const tooBig = openPosition({ cash: 100, positions: [] }, { symbol: "X", side: "long", leverage: 1, positionPct: 100, price: 1, now: 0 }, 10_000);
  assert.ok("error" in tooBig);
});
