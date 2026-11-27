import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { marketStateFor } from "../src/market/calendar.ts";
import { openDb } from "../src/store/db.ts";
import { runTick } from "../src/engine/tick.ts";
import { runBacktest } from "../src/engine/backtest.ts";
import { createAgent, getAccount } from "../src/engine/agents.ts";
import { checkOrder, Policy, strategyPolicyErrors } from "../src/guard/policy.ts";
import type { Market } from "../src/config.ts";
import type { PythClient } from "../src/sources/pyth.ts";
import { et, fakeChain, H, strategy } from "./helpers.ts";

const NVDA_FEED = "0x00000000000000000000000000000000000000aa";
const BTC_FEED = "0x00000000000000000000000000000000000000bb";
const BTC_PYTH = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const MARKETS: Market[] = [
  { symbol: "NVDA", assetClass: "equity", source: "chainlink", feed: NVDA_FEED, decimals: 8, heartbeatSec: 86400, deviationPct: 0.5 },
  { symbol: "BTC", assetClass: "crypto", source: "chainlink", feed: BTC_FEED, decimals: 8, heartbeatSec: 86400, deviationPct: 0.5, pythId: BTC_PYTH },
];

// Saturday 2026-11-21 12:00 New York (EST): stocks closed, crypto open.
const SATURDAY = et("2026-11-21T12:00:00", -5);

/**
 * Both assets flat for two days, then both drop 8% in the last hour. For BTC the drop is
 * published on Saturday; NVDA's last round is Friday afternoon, before the close.
 */
function weekendScenario() {
  const nvda: Array<[number, number]> = [];
  const btc: Array<[number, number]> = [];
  for (let h = 60; h >= 1; h--) btc.push([SATURDAY - h * H, 100_000]);
  btc.push([SATURDAY - 600, 92_000]);
  const friday = et("2026-11-20T15:00:00", -5);
  for (let h = 60; h >= 1; h--) nvda.push([friday - h * H, 200]);
  nvda.push([friday, 184]);
  return { nvda, btc };
}

const dropBoth = strategy({ symbols: ["NVDA", "BTC"], maxOpenPositions: 2, positionPct: 10 });
const fakePyth = (price: number | (() => never)): PythClient =>
  ({
    latest: async () => {
      if (typeof price === "function") price();
      return { prices: new Map([[BTC_PYTH, { id: BTC_PYTH, price: price as number, conf: 10, publishTime: SATURDAY - 5 }]]), denied: [], failed: [] };
    },
  }) as unknown as PythClient;

test("markets list: verified Chainlink markets and CoinGecko data-feed crypto", () => {
  const m = JSON.parse(readFileSync("data/markets.json", "utf8")).markets as Market[];
  const verifiedCrypto = m.filter((x) => x.assetClass === "crypto" && x.source === "chainlink");
  assert.deepEqual(verifiedCrypto.map((x) => x.symbol).sort(), ["BTC", "ENA", "ETH", "LINK"]);
  for (const c of verifiedCrypto) {
    assert.match(c.pythId!, /^[0-9a-f]{64}$/);
    assert.ok(c.coingeckoId, `${c.symbol} needs a CoinGecko id as second source`);
  }
  // Stocks stay on verified Chainlink feeds only.
  const equity = m.filter((x) => x.assetClass === "equity");
  assert.equal(equity.length, 35);
  assert.ok(equity.every((x) => x.source === "chainlink"));
  const dataFeed = m.filter((x) => x.source === "coingecko");
  assert.ok(dataFeed.length >= 20, `expected a broad crypto list, got ${dataFeed.length}`);
  for (const d of dataFeed) {
    assert.equal(d.assetClass, "crypto");
    assert.equal(d.feed, `coingecko:${d.coingeckoId}`);
  }
  assert.equal(new Set(m.map((x) => x.symbol)).size, m.length, "symbols must be unique");
});

test("crypto is open on a Saturday, stocks are not", () => {
  assert.equal(marketStateFor("crypto", SATURDAY).open, true);
  assert.equal(marketStateFor("equity", SATURDAY).open, false);
});

test("on a Saturday a mixed agent trades BTC and leaves NVDA alone", async () => {
  const { nvda, btc } = weekendScenario();
  const db = openDb(":memory:");
  const chain = fakeChain({ [NVDA_FEED]: nvda, [BTC_FEED]: btc }, () => SATURDAY);
  const ctx = { db, chain, markets: MARKETS, plankton: null, pyth: fakePyth(92_050), epochSec: H };
  const a = createAgent(db, { name: "mix", prompt: null, strategy: dropBoth, policy: Policy.parse({}) }, SATURDAY);
  const s = await runTick(ctx, SATURDAY);
  assert.equal(s.market.open, false); // the equity market
  assert.equal(s.pythOk, true);
  assert.equal(s.fills, 1);
  assert.equal(s.blocked, 0); // a closed stock market is not a blocked decision
  const pos = getAccount(db, a.id).account.positions;
  assert.deepEqual(pos.map((p) => p.symbol), ["BTC"]);
  const syms = db.prepare("SELECT json_extract(record_json, '$.decision.symbol') AS s FROM receipts WHERE kind = 'decision'").all().map((r: any) => r.s);
  assert.deepEqual(syms, ["BTC"]);
  const rec = JSON.parse((db.prepare("SELECT record_json FROM receipts WHERE kind = 'decision'").get() as any).record_json);
  assert.equal(rec.session, "always");
  assert.ok(rec.gate.gapBps !== null, "Pyth was used as the second source");
});

test("Pyth disagreeing with Chainlink blocks a crypto order", async () => {
  const { nvda, btc } = weekendScenario();
  const db = openDb(":memory:");
  const chain = fakeChain({ [NVDA_FEED]: nvda, [BTC_FEED]: btc }, () => SATURDAY);
  const ctx = { db, chain, markets: MARKETS, plankton: null, pyth: fakePyth(97_000), epochSec: H }; // ~5.4% apart
  createAgent(db, { name: "mix", prompt: null, strategy: dropBoth, policy: Policy.parse({}) }, SATURDAY);
  const s = await runTick(ctx, SATURDAY);
  assert.equal(s.fills, 0);
  assert.equal(s.blocked, 1);
  const rec = JSON.parse((db.prepare("SELECT record_json FROM receipts WHERE kind = 'decision'").get() as any).record_json);
  assert.equal(rec.why, "gate:sources_disagree");
});

test("Pyth being down does not stop crypto trading", async () => {
  const { nvda, btc } = weekendScenario();
  const db = openDb(":memory:");
  const chain = fakeChain({ [NVDA_FEED]: nvda, [BTC_FEED]: btc }, () => SATURDAY);
  const down = fakePyth(() => {
    throw new Error("pyth HTTP 503");
  });
  const ctx = { db, chain, markets: MARKETS, plankton: null, pyth: down, epochSec: H };
  createAgent(db, { name: "mix", prompt: null, strategy: dropBoth, policy: Policy.parse({}) }, SATURDAY);
  const s = await runTick(ctx, SATURDAY);
  assert.equal(s.pythOk, false);
  assert.equal(s.fills, 1);
});

test("crypto has its own lower leverage cap", () => {
  const p = Policy.parse({ maxLeverage: 3, maxLeverageCrypto: 1.5 });
  const acct = { equity: 10_000, dayStartEquity: 10_000, openPositions: 0 };
  assert.equal(checkOrder(p, { symbol: "NVDA", side: "long", leverage: 2, positionPct: 10, assetClass: "equity" }, acct).ok, true);
  assert.equal(checkOrder(p, { symbol: "BTC", side: "long", leverage: 2, positionPct: 10, assetClass: "crypto" }, acct).ok, false);
  const assetOf = (s: string) => (s === "BTC" ? "crypto" : "equity") as "crypto" | "equity";
  assert.deepEqual(strategyPolicyErrors({ symbols: ["NVDA"], side: "long", leverage: 2, positionPct: 10, maxOpenPositions: 1 }, p, assetOf), []);
  assert.match(strategyPolicyErrors({ symbols: ["NVDA", "BTC"], side: "long", leverage: 2, positionPct: 10, maxOpenPositions: 1 }, p, assetOf)[0]!, /crypto limit/);
});

test("backtest replays crypto through the weekend and stocks only in market hours", () => {
  const from = et("2026-11-20T10:00:00", -5); // Friday
  const to = et("2026-11-23T10:00:00", -5); // Monday
  const flat = (t0: number) => [{ roundId: "1", price: 100, updatedAt: t0 - H }];
  const res = runBacktest({
    strategy: strategy({ symbols: ["NVDA", "BTC"] }),
    policy: Policy.parse({}),
    rounds: new Map([["NVDA", flat(from)], ["BTC", flat(from)]]),
    heartbeatSec: new Map([["NVDA", 86400], ["BTC", 86400]]),
    assetClass: new Map([["NVDA", "equity"], ["BTC", "crypto"]]),
    from,
    to,
  });
  assert.equal(res.hours, 72); // every hour, because BTC is always open

  const stocksOnly = runBacktest({
    strategy: strategy({ symbols: ["NVDA"] }),
    policy: Policy.parse({}),
    rounds: new Map([["NVDA", flat(from)]]),
    heartbeatSec: new Map([["NVDA", 86400]]),
    assetClass: new Map([["NVDA", "equity"]]),
    from,
    to,
  });
  assert.equal(stocksOnly.hours, 24);
});

test("Pyth client: a refused feed does not fail the others and is not asked again", async () => {
  const { PythClient } = await import("../src/sources/pyth.ts");
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const id = decodeURIComponent(String(url).split("ids[]=")[1]!);
    calls.push(id);
    if (id === "bb") return new Response("Not entitled", { status: 403 });
    if (id === "cc") return new Response("oops", { status: 503 });
    return new Response(JSON.stringify({ parsed: [{ id, price: { price: "6500000000000", conf: "100000000", expo: -8, publish_time: 1 } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const c = new PythClient("key-for-test-only");
    const r = await c.latest(["0xAA", "bb", "cc"], 1_000);
    assert.equal(r.prices.get("aa")!.price, 65_000);
    assert.deepEqual(r.denied, ["bb"]);
    assert.deepEqual(r.failed, ["cc"]);
    calls.length = 0;
    await c.latest(["aa", "bb"], 2_000); // bb is remembered as refused
    assert.deepEqual(calls, ["aa"]);
    calls.length = 0;
    await c.latest(["bb"], 1_000 + 6 * 3600_000 + 1); // and asked again after the retry window
    assert.deepEqual(calls, ["bb"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
