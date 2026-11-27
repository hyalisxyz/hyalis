import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/store/db.ts";
import { syncDataFeeds } from "../src/engine/ingest.ts";
import { runTick } from "../src/engine/tick.ts";
import { createAgent, getAccount } from "../src/engine/agents.ts";
import { Policy } from "../src/guard/policy.ts";
import type { Market } from "../src/config.ts";
import { et, fakeChain, H, strategy } from "./helpers.ts";

const SATURDAY = et("2026-11-21T12:00:00", -5);
const LINK_FEED = "0x00000000000000000000000000000000000000cc";
const MARKETS: Market[] = [
  { symbol: "LINK", assetClass: "crypto", source: "chainlink", feed: LINK_FEED, coingeckoId: "chainlink", decimals: 8, heartbeatSec: 86400, deviationPct: 0.5 },
  { symbol: "SOL", assetClass: "crypto", source: "coingecko", feed: "coingecko:solana", coingeckoId: "solana", decimals: 8, heartbeatSec: 900, deviationPct: 0 },
  { symbol: "DOGE", assetClass: "crypto", source: "coingecko", feed: "coingecko:dogecoin", coingeckoId: "dogecoin", decimals: 8, heartbeatSec: 900, deviationPct: 0 },
  { symbol: "ADA", assetClass: "crypto", source: "coingecko", feed: "coingecko:cardano", coingeckoId: "cardano", decimals: 8, heartbeatSec: 900, deviationPct: 0 },
];

/** A fake CoinGecko: hourly history that ends in a 10% drop, and live quotes. */
function fakeCg(opts: { quotes: Record<string, number>; quoteAge?: number; fail?: "prices" | "hourly" }) {
  const calls = { prices: 0, hourly: [] as string[] };
  return {
    calls,
    async prices(ids: string[]) {
      calls.prices++;
      if (opts.fail === "prices") throw new Error("coingecko rate limit (429)");
      return new Map(ids.filter((id) => opts.quotes[id]).map((id) => [id, { usd: opts.quotes[id]!, updatedAt: SATURDAY - (opts.quoteAge ?? 30) }]));
    },
    async hourly(id: string) {
      calls.hourly.push(id);
      if (opts.fail === "hourly") throw new Error("coingecko rate limit (429)");
      const pts: Array<[number, number]> = [];
      for (let h = 72; h >= 2; h--) pts.push([SATURDAY - h * H, 100]);
      pts.push([SATURDAY - H, 90]);
      return pts;
    },
  };
}

test("data feeds: one batched price call per tick, history backfilled a few coins at a time", async () => {
  const db = openDb(":memory:");
  const cg = fakeCg({ quotes: { solana: 90, dogecoin: 0.2, cardano: 0.5, chainlink: 12 } });
  const r1 = await syncDataFeeds(db, cg, MARKETS, SATURDAY, 30 * 86400, 2);
  assert.equal(cg.calls.prices, 1);
  assert.equal(cg.calls.hourly.length, 2); // limited per tick
  assert.equal(r1.error, null);
  assert.deepEqual([...r1.latest.keys()].sort(), ["ADA", "DOGE", "SOL"]); // the Chainlink market is not stored here
  assert.equal(r1.quotes.get("LINK")!.usd, 12); // but its quote is kept as a second source
  const r2 = await syncDataFeeds(db, cg, MARKETS, SATURDAY, 30 * 86400, 2);
  assert.equal(cg.calls.hourly.length, 3); // only the third coin on the next tick
  assert.equal(r2.backfilled.length, 1);
  assert.ok(!r1.backfilled.includes(r2.backfilled[0]!));
  // These fake coins have only 3 days of history, short of the 30-day window. They must not be
  // fetched again on every tick (that would burn the rate limit), only after a day.
  await syncDataFeeds(db, cg, MARKETS, SATURDAY + 300, 30 * 86400, 2);
  assert.equal(cg.calls.hourly.length, 3);
  await syncDataFeeds(db, cg, MARKETS, SATURDAY + 86400 + 1, 30 * 86400, 2);
  assert.equal(cg.calls.hourly.length, 5);
  const stored = (db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE feed = 'coingecko:solana'").get() as { n: number }).n;
  assert.ok(stored >= 70);
});

test("data feeds: a rate-limited price call stops the backfill and is reported", async () => {
  const db = openDb(":memory:");
  const cg = fakeCg({ quotes: {}, fail: "prices" });
  const r = await syncDataFeeds(db, cg, MARKETS, SATURDAY);
  assert.match(r.error!, /429/);
  assert.equal(cg.calls.hourly.length, 0);
});

test("a data-feed crypto agent trades on a Saturday, and its receipt says where the price came from", async () => {
  const db = openDb(":memory:");
  const cg = fakeCg({ quotes: { solana: 90, dogecoin: 0.2, cardano: 0.5 } });
  const chain = fakeChain({ [LINK_FEED]: [[SATURDAY - 2 * H, 12]] }, () => SATURDAY);
  const ctx = { db, chain, markets: MARKETS, plankton: null, coingecko: cg, epochSec: H };
  // First tick backfills SOL history; the drop to 90 is already in it.
  const a = createAgent(db, { name: "sol", prompt: null, strategy: strategy({ symbols: ["SOL"] }), policy: Policy.parse({}) }, SATURDAY);
  const s = await runTick(ctx, SATURDAY);
  assert.equal(s.coingeckoOk, true);
  assert.equal(s.fills, 1);
  assert.deepEqual(getAccount(db, a.id).account.positions.map((p) => p.symbol), ["SOL"]);
  const rec = JSON.parse((db.prepare("SELECT record_json FROM receipts WHERE kind = 'decision'").get() as any).record_json);
  assert.equal(rec.input.feed, "coingecko:solana");
  assert.equal(rec.session, "always");
});

test("a stale data-feed price is blocked by the gate", async () => {
  const db = openDb(":memory:");
  const cg = fakeCg({ quotes: { solana: 90, dogecoin: 0.2, cardano: 0.5 }, quoteAge: 3600 }); // an hour old
  const chain = fakeChain({ [LINK_FEED]: [[SATURDAY - 2 * H, 12]] }, () => SATURDAY);
  const ctx = { db, chain, markets: MARKETS, plankton: null, coingecko: cg, epochSec: H };
  createAgent(db, { name: "sol", prompt: null, strategy: strategy({ symbols: ["SOL"], entry: [{ type: "below_high_pct", description: "5% below high", lookbackHours: 24, value: 5 }] }), policy: Policy.parse({}) }, SATURDAY);
  const s = await runTick(ctx, SATURDAY);
  assert.equal(s.fills, 0);
  const rec = JSON.parse((db.prepare("SELECT record_json FROM receipts WHERE kind = 'decision'").get() as any).record_json);
  assert.equal(rec.why, "gate:stale_price");
});

test("CoinGecko is the second source for Chainlink crypto Pyth does not cover", async () => {
  const link: Array<[number, number]> = [];
  for (let h = 40; h >= 2; h--) link.push([SATURDAY - h * H, 13]);
  link.push([SATURDAY - 600, 11.9]); // -8.5%
  const run = async (cgLink: number) => {
    const db = openDb(":memory:");
    const cg = fakeCg({ quotes: { chainlink: cgLink, solana: 90, dogecoin: 0.2, cardano: 0.5 } });
    const ctx = { db, chain: fakeChain({ [LINK_FEED]: link }, () => SATURDAY), markets: MARKETS, plankton: null, coingecko: cg, epochSec: H };
    createAgent(db, { name: "link", prompt: null, strategy: strategy({ symbols: ["LINK"] }), policy: Policy.parse({}) }, SATURDAY);
    const s = await runTick(ctx, SATURDAY);
    const rec = JSON.parse((db.prepare("SELECT record_json FROM receipts WHERE kind = 'decision'").get() as any).record_json);
    return { s, rec };
  };
  const agree = await run(11.95);
  assert.equal(agree.s.fills, 1);
  assert.ok(agree.rec.gate.gapBps !== null);
  const disagree = await run(13.5);
  assert.equal(disagree.s.fills, 0);
  assert.equal(disagree.rec.why, "gate:sources_disagree");
});

test("CoinGecko: a rate limit is retried after the wait it asks for, within a cap", async () => {
  const { CoinGeckoClient } = await import("../src/sources/coingecko.ts");
  let calls = 0;
  const waits: number[] = [];
  let last = Date.now();
  const reply = (status: number, retryAfter?: string) => {
    calls++;
    const nowMs = Date.now();
    waits.push(nowMs - last);
    last = nowMs;
    return new Response(status === 200 ? JSON.stringify({ bitcoin: { usd: 90000, last_updated_at: 1_800_000_000 } }) : "{}", { status, headers: retryAfter ? { "retry-after": retryAfter } : {} });
  };
  let script: Array<() => Response> = [() => reply(429, "0.05"), () => reply(429), () => reply(200)];
  const cg = new CoinGeckoClient({ maxRetryWaitMs: 100, fetchImpl: (async () => script.shift()!()) as unknown as typeof fetch });
  const p = await cg.prices(["bitcoin"]);
  assert.equal(p.get("bitcoin")!.usd, 90000);
  assert.equal(calls, 3);
  assert.ok(waits[1]! >= 40 && waits[2]! >= 90 && waits[2]! < 1000, `waits ${waits.join(",")}: Retry-After honoured, then capped`);
  calls = 0;
  script = [() => reply(429), () => reply(429), () => reply(429), () => reply(200)];
  await assert.rejects(cg.prices(["bitcoin"]), /rate limit \(429\)/);
  assert.equal(calls, 3, "gives up after three tries");
});
