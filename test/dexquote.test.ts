import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/store/db.ts";
import { runTick } from "../src/engine/tick.ts";
import { createAgent, getAccount } from "../src/engine/agents.ts";
import { Policy } from "../src/guard/policy.ts";
import type { Market } from "../src/config.ts";
import { ALWAYS_OPEN, fakeChain, FEED, H, strategy } from "./helpers.ts";

const TOKEN = "0x00000000000000000000000000000000000000dd";
const MARKETS: Market[] = [{ symbol: "NVDA", assetClass: "equity", source: "chainlink", feed: FEED, decimals: 8, heartbeatSec: 86400, deviationPct: 0.5, token: TOKEN, tokenDecimals: 18 }];
const t0 = 1_800_000_000 - (1_800_000_000 % H);

/** 30h flat at 100, then a drop to 90 (entry for a "down 5% in 24h" strategy). */
function rounds(): Array<[number, number]> {
  const r: Array<[number, number]> = [];
  for (let h = 0; h < 30; h++) r.push([t0 + h * H + 60, 100]);
  r.push([t0 + 30 * H + 60, 90]);
  return r;
}

function fakeDex(quote: { ask: number; bid: number } | (() => never)) {
  const calls = { n: 0 };
  return {
    calls,
    async spread() {
      calls.n++;
      if (typeof quote === "function") quote();
      const q = quote as { ask: number; bid: number };
      return { ask: q.ask, bid: q.bid, venues: ["Uniswap V3"], quotedAt: t0 + 30 * H + 100 };
    },
  };
}

async function run(dex: ReturnType<typeof fakeDex> | null, s = strategy()) {
  const now = t0 + 30 * H + 120;
  const db = openDb(":memory:");
  const ctx = { db, chain: fakeChain({ [FEED]: rounds() }, () => now), markets: MARKETS, plankton: null, dex, epochSec: H, ...ALWAYS_OPEN };
  const a = createAgent(db, { name: "x", prompt: null, strategy: s, policy: Policy.parse({ maxLeverage: 2 }) }, now);
  const summary = await runTick(ctx, now);
  const rec = JSON.parse(((db.prepare("SELECT record_json FROM receipts WHERE kind = 'decision'").get() as any) ?? { record_json: "null" }).record_json);
  return { db, a, summary, rec, ctx, now };
}

test("spot buys fill at the DEX ask, with no extra fee on top", async () => {
  const { db, a, summary, rec } = await run(fakeDex({ ask: 90.5, bid: 89.7 }));
  assert.equal(summary.dexOk, true);
  assert.equal(summary.fills, 1);
  const pos = getAccount(db, a.id).account.positions[0]!;
  assert.equal(pos.entryPrice, 90.5);
  assert.equal(rec.fill.fee, 0); // the ask already includes venue fees and impact
  assert.equal(rec.execution.source, "dex-quote");
  assert.deepEqual(rec.execution.venues, ["Uniswap V3"]);
  assert.equal(rec.gate.secondSource, "dex-quote");
  assert.equal(rec.gate.gapBps, 12); // mid 90.1 vs Chainlink 90
});

test("a DEX price too far from Chainlink blocks the trade", async () => {
  const { summary, rec } = await run(fakeDex({ ask: 93.0, bid: 92.6 })); // ~305 bps above
  assert.equal(summary.fills, 0);
  assert.equal(rec.why, "gate:sources_disagree");
});

test("without DEX quotes the agent still trades, at the oracle price with the modelled fee", async () => {
  const down = fakeDex(() => {
    throw new Error("node HTTP 503");
  });
  const { db, a, summary, rec } = await run(down);
  assert.equal(summary.dexOk, false);
  assert.equal(summary.fills, 1);
  assert.equal(getAccount(db, a.id).account.positions[0]!.entryPrice, 90);
  assert.ok(rec.fill.fee > 0);
  assert.equal(rec.execution, undefined);
});

test("perps (shorts) do not use spot quotes", async () => {
  const short = strategy({ side: "short", entry: [{ type: "change_pct", description: "down 5%", lookbackHours: 24, op: "lt", value: -5 }] });
  const { db, a, rec } = await run(fakeDex({ ask: 90.5, bid: 89.7 }), short);
  const pos = getAccount(db, a.id).account.positions[0]!;
  assert.equal(pos.venue, "perp");
  assert.equal(pos.entryPrice, 90);
  assert.equal(rec.execution, undefined);
});

test("quotes are cached between ticks to stay inside the rate limit", async () => {
  const dex = fakeDex({ ask: 90.5, bid: 89.7 });
  const { ctx, now } = await run(dex);
  assert.equal(dex.calls.n, 1);
  await runTick(ctx, now + 60); // a minute later: reuses the quote
  assert.equal(dex.calls.n, 1);
  await runTick(ctx, now + 400); // past the refresh age: asks again
  assert.equal(dex.calls.n, 2);
});

test("the DEX quote client prices both sides from Uniswap's quoter, at the best fee tier", async () => {
  const { DexQuoteClient } = await import("../src/sources/dexquote.ts");
  // A stand-in quoter: 0.3% pool, so 1000 USDG buys 1000/100 * 0.997 tokens, and selling them returns 0.997 of their value.
  const pub = {
    simulateContract: async ({ args }: any) => {
      const [{ tokenIn, amountIn, fee }] = args;
      if (fee !== 3000) throw new Error("no pool");
      const usdgIn = tokenIn.toLowerCase() === "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
      const out = usdgIn ? (amountIn * 10n ** 12n * 997n) / 1000n / 100n : (amountIn * 100n * 997n) / 1000n / 10n ** 12n;
      return { result: [out, 0n, 0, 0n] };
    },
  } as any;
  const s = await new DexQuoteClient(pub).spread("0x00000000000000000000000000000000000000dd", 18, 100);
  assert.ok(Math.abs(s.ask - 100 / 0.997) < 1e-6, String(s.ask));
  assert.ok(Math.abs(s.bid - 99.7) < 1e-6, String(s.bid));
  assert.deepEqual(s.venues, ["Uniswap V3"]);
});
