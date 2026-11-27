import { test } from "node:test";
import assert from "node:assert/strict";
import { hourWasOpen, marketState } from "../src/market/calendar.ts";
import { openHourEnds } from "../src/strategy/series.ts";
import { decide } from "../src/strategy/evaluate.ts";
import { openDb } from "../src/store/db.ts";
import { runTick } from "../src/engine/tick.ts";
import { createAgent, getAccount, setStatus } from "../src/engine/agents.ts";
import { Policy } from "../src/guard/policy.ts";
import { ALWAYS_OPEN, et, fakeChain, FEED, H, MARKETS, strategy } from "./helpers.ts";

// ---------------------------------------------------------------- calendar

const at = (iso: string, off: number) => marketState(et(iso, off));

test("calendar: 24/5 week with sessions (EST)", () => {
  assert.equal(at("2026-11-21T12:00:00", -5).reason, "weekend"); // Saturday
  assert.equal(at("2026-11-22T19:59:00", -5).open, false); // Sunday before reopen
  assert.equal(at("2026-11-22T20:00:00", -5).session, "overnight"); // Sunday 20:00 reopen
  assert.equal(at("2026-11-23T02:00:00", -5).session, "overnight");
  assert.equal(at("2026-11-23T05:00:00", -5).session, "pre");
  assert.equal(at("2026-11-23T09:29:00", -5).session, "pre");
  assert.equal(at("2026-11-23T09:30:00", -5).session, "regular");
  assert.equal(at("2026-11-23T16:00:00", -5).session, "after");
  assert.equal(at("2026-11-20T19:59:00", -5).session, "after"); // Friday last minute
  assert.equal(at("2026-11-20T20:00:00", -5).open, false); // Friday 20:00 close
});

test("calendar: daylight saving time (EDT)", () => {
  assert.equal(at("2026-07-06T09:29:00", -4).session, "pre");
  assert.equal(at("2026-07-06T09:30:00", -4).session, "regular");
});

test("calendar: holidays close the day and the overnight session before it", () => {
  assert.equal(at("2026-11-25T20:30:00", -5).open, false); // into Thanksgiving
  assert.match(at("2026-11-26T12:00:00", -5).reason!, /holiday 2026-11-26/);
  assert.equal(at("2026-11-26T20:30:00", -5).session, "overnight"); // reopens for Friday
  assert.equal(at("2026-11-27T12:59:00", -5).session, "regular");
  assert.match(at("2026-11-27T13:00:00", -5).reason!, /early close/); // 13:00 close
  assert.equal(at("2026-07-02T20:30:00", -4).open, false); // into July 3 (observed)
  assert.equal(at("2026-07-03T10:00:00", -4).open, false);
});

test("calendar: years without a table are closed, not guessed", () => {
  assert.match(at("2028-01-03T10:00:00", -5).reason!, /no exchange calendar/);
  assert.match(at("2027-12-31T20:30:00", -5).reason!, /no exchange calendar for 2028/);
});

test("market-hour bars skip the weekend", () => {
  const monday = et("2026-11-23T10:30:00", -5);
  const ends = openHourEnds(monday, 30, hourWasOpen);
  assert.equal(ends.length, 30);
  for (const e of ends) assert.ok(hourWasOpen(e));
  // 30 trading hours back from Monday 10:30 reaches into Friday, past a closed weekend.
  assert.ok(monday - ends[0]! > 60 * H, "window should span the weekend");
  const saturday = ends.filter((e) => marketState(e - 1800).reason === "weekend");
  assert.equal(saturday.length, 0);
});

// ---------------------------------------------------------------- engine fixes

test("decide: no re-entry for symbols in cooldown", () => {
  const closes = [100, ...Array(23).fill(98), 94].map((price, i) => ({ hourEnd: (i + 1) * H, price, roundId: String(i) }));
  const s = strategy();
  assert.equal(decide(s, new Map([["NVDA", closes]]), [], 30 * H).length, 1);
  assert.equal(decide(s, new Map([["NVDA", closes]]), [], 30 * H, new Set(["NVDA"])).length, 0);
});

/** 30 flat hours at 100 and then a drop to 90: the entry fires and keeps firing. */
function dropScenario() {
  const t0 = 1_800_000_000 - (1_800_000_000 % H);
  const rounds: Array<[number, number]> = [];
  for (let h = 0; h < 30; h++) rounds.push([t0 + h * H + 60, 100]);
  rounds.push([t0 + 30 * H + 60, 90]);
  return { t0, rounds };
}

test("stop loss is not followed by an immediate re-buy (cooldown)", async () => {
  const { t0, rounds } = dropScenario();
  let now = t0 + 30 * H + 120;
  const db = openDb(":memory:");
  const ctx = { db, chain: fakeChain({ [FEED]: rounds }, () => now), markets: MARKETS, plankton: null, epochSec: H, ...ALWAYS_OPEN };
  const a = createAgent(db, { name: "dip", prompt: null, strategy: strategy({ stopLossPct: 3 }), policy: Policy.parse({ reentryCooldownHours: 6 }) }, now);

  assert.equal((await runTick(ctx, now)).fills, 1); // buys at 90
  rounds.push([t0 + 31 * H + 60, 86]); // -4.4%: stop loss
  now = t0 + 31 * H + 120;
  assert.equal((await runTick(ctx, now)).fills, 1);
  assert.equal(getAccount(db, a.id).account.positions.length, 0);

  // Entry condition still true (86 is far below 24h ago), but the cooldown holds.
  for (let h = 1; h <= 5; h++) {
    now = t0 + (31 + h) * H + 120;
    assert.equal((await runTick(ctx, now)).fills, 0, `hour ${h}`);
  }
  now = t0 + 37 * H + 180; // 6h after the exit
  assert.equal((await runTick(ctx, now)).fills, 1);
});

test("a blocked decision is recorded once per epoch, not once per tick", async () => {
  const { t0, rounds } = dropScenario();
  // The price drops, then the feed goes silent for 27 hours, past the 26.4h staleness limit
  // (heartbeat x 1.1). The entry still holds over a 48h window, so the gate blocks it.
  let now = t0 + 30 * H + 60 + 27 * H;
  const db = openDb(":memory:");
  const ctx = { db, chain: fakeChain({ [FEED]: rounds }, () => now), markets: MARKETS, plankton: null, epochSec: H, ...ALWAYS_OPEN };
  createAgent(db, { name: "dip", prompt: null, strategy: strategy({ entry: [{ type: "below_high_pct", description: "5% below high", lookbackHours: 48, value: 5 }] }), policy: Policy.parse({}) }, now);
  for (let i = 0; i < 6; i++) {
    await runTick(ctx, now);
    now += 300; // six ticks, five minutes apart, same hour
  }
  const n = (db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE kind = 'decision'").get() as { n: number }).n;
  assert.equal(n, 1);
  const r = db.prepare("SELECT record_json FROM receipts WHERE kind = 'decision'").get() as { record_json: string };
  assert.equal(JSON.parse(r.record_json).why, "gate:stale_price");
});

test("closed market: no decisions and no receipts except the snapshot", async () => {
  const { t0, rounds } = dropScenario();
  const now = t0 + 30 * H + 120;
  const db = openDb(":memory:");
  const closed = { market: () => ({ open: false, session: "closed" as const, reason: "weekend" }), hourOpen: () => true };
  const ctx = { db, chain: fakeChain({ [FEED]: rounds }, () => now), markets: MARKETS, plankton: null, epochSec: H, ...closed };
  createAgent(db, { name: "dip", prompt: null, strategy: strategy(), policy: Policy.parse({}) }, now);
  const s = await runTick(ctx, now);
  assert.equal(s.fills, 0);
  assert.equal(s.blocked, 0);
  const kinds = db.prepare("SELECT kind FROM receipts").all().map((r: any) => r.kind);
  assert.deepEqual(kinds, ["snapshot"]);
});

test("a paused agent is still liquidated", async () => {
  const { t0, rounds } = dropScenario();
  let now = t0 + 30 * H + 120;
  const db = openDb(":memory:");
  const ctx = { db, chain: fakeChain({ [FEED]: rounds }, () => now), markets: MARKETS, plankton: null, epochSec: H, ...ALWAYS_OPEN };
  // 3x short with a wide stop: only liquidation can close it.
  const a = createAgent(db, { name: "short", prompt: null, strategy: strategy({ side: "short", leverage: 3, stopLossPct: 50 }), policy: Policy.parse({ maxLeverage: 3 }) }, now);
  assert.equal((await runTick(ctx, now)).fills, 1); // short at 90
  setStatus(db, a.id, "paused");
  rounds.push([t0 + 31 * H + 60, 120]); // +33%: a 3x short has lost its margin
  now = t0 + 31 * H + 120;
  assert.equal((await runTick(ctx, now)).fills, 1);
  assert.equal(getAccount(db, a.id).account.positions.length, 0);
  const liq = db.prepare("SELECT record_json FROM receipts WHERE kind = 'fill'").get() as { record_json: string };
  assert.equal(JSON.parse(liq.record_json).fill.action, "liquidate");
});

test("ingest: a dropped connection leaves no hole in history", async () => {
  const { t0, rounds } = dropScenario();
  let now = t0 + 30 * H + 120;
  let fail = false;
  const db = openDb(":memory:");
  const chain = fakeChain({ [FEED]: rounds }, () => now, { failRoundReads: () => fail });
  const ctx = { db, chain, markets: MARKETS, plankton: null, epochSec: H, ...ALWAYS_OPEN };
  await runTick(ctx, now); // full history
  for (let h = 31; h < 41; h++) rounds.push([t0 + h * H + 60, 90 + h - 30]);
  now = t0 + 40 * H + 120;
  fail = true;
  const s = await runTick(ctx, now);
  assert.deepEqual(s.feedsFailed, ["NVDA"]);
  // Nothing from the failed walk was written, not even the newest round.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM rounds").get() as { n: number }).n, 31);
  fail = false;
  await runTick(ctx, now);
  const ids = db.prepare("SELECT round_id FROM rounds ORDER BY updated_at").all().map((r: any) => BigInt(r.round_id));
  assert.equal(ids.length, 41);
  for (let i = 1; i < ids.length; i++) assert.equal(ids[i]! - ids[i - 1]!, 1n, "round ids must be contiguous");
});
