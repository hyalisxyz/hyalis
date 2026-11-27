/**
 * Stage 2: honest backtest numbers, and choosing among several versions without fooling
 * ourselves (chosen on the first 70% of the history, checked on the rest, deflated for trials).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { deflatedSharpe, expectedMaxSharpe, metricsOf, normCdf, normInv, probabilisticSharpe } from "../src/engine/metrics.ts";
import { openDb } from "../src/store/db.ts";
import { buildApi } from "../src/api/server.ts";
import { DEFAULT_TIERS, TokenReader } from "../src/token/token.ts";
import { loadConfig } from "../src/config.ts";
import { runBacktest } from "../src/engine/backtest.ts";
import { Policy } from "../src/guard/policy.ts";
import { ALWAYS_OPEN, H, MARKETS, strategy } from "./helpers.ts";

test("the normal distribution and its inverse agree", () => {
  for (const p of [0.001, 0.025, 0.2, 0.5, 0.8, 0.975, 0.999]) assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-6, String(p));
  assert.ok(Math.abs(normInv(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-9);
});

test("probabilistic Sharpe grows with the evidence, and the best of many trials needs a higher bar", () => {
  assert.ok(probabilisticSharpe(0.05, 1000, 0, 3) > probabilisticSharpe(0.05, 100, 0, 3));
  assert.ok(probabilisticSharpe(0.05, 1000, 0, 3) > 0.9);
  assert.ok(Math.abs(probabilisticSharpe(0, 500, 0, 3) - 0.5) < 1e-9);
  // Fat tails and negative skew make the same Sharpe less convincing.
  assert.ok(probabilisticSharpe(0.05, 500, -1, 10) < probabilisticSharpe(0.05, 500, 0, 3));
  assert.equal(expectedMaxSharpe(1, 0.01), 0);
  assert.ok(expectedMaxSharpe(10, 0.01) > expectedMaxSharpe(3, 0.01));
  // Deflating for 4 widely spread trials lowers the confidence in the winner.
  const raw = { sr: 0.06, n: 700, skew: 0, kurt: 3 };
  assert.ok(deflatedSharpe(raw, [0.06, -0.04, 0.01, -0.02]) < probabilisticSharpe(raw.sr, raw.n, 0, 3));
});

test("metrics from an equity curve: a steady climb beats a bumpy one, and profit factor counts trades", () => {
  const steady = Array.from({ length: 200 }, (_, i) => [i * H, 10_000 * (1 + 0.0005 * i + (i % 2 ? 0.0002 : 0))] as [number, number]);
  const bumpy = Array.from({ length: 200 }, (_, i) => [i * H, 10_000 * (1 + 0.0005 * i + (i % 2 ? 0.02 : -0.02))] as [number, number]);
  const a = metricsOf(steady, [{ pnl: 30 }, { pnl: -10 }], 0.5, 8760);
  const b = metricsOf(bumpy, [], 5, 8760);
  assert.ok(a.sharpe! > b.sharpe!, `${a.sharpe} vs ${b.sharpe}`);
  assert.equal(a.profitFactor, 3);
  assert.ok(a.probabilisticSharpe! > 0.99);
  assert.equal(metricsOf(steady.slice(0, 10), [], 0, 8760).sharpe, null); // too few hours to say
});

test("a backtest carries its metrics and the 70/30 split", () => {
  const from = 1_800_000_000 - (1_800_000_000 % H);
  const pts = Array.from({ length: 24 * 12 }, (_, i) => ({ roundId: String(i + 1), price: 100 + Math.sin(i / 6) * 4 + i * 0.02, updatedAt: from - 48 * H + i * H }));
  const bt = runBacktest({ strategy: strategy({ entry: [{ type: "change_pct", description: "dip", lookbackHours: 6, op: "lt", value: -2 }], takeProfitPct: 3 }), policy: Policy.parse({}), rounds: new Map([["NVDA", pts]]), heartbeatSec: new Map([["NVDA", 86400]]), from, to: from + 9 * 24 * H, ...ALWAYS_OPEN });
  assert.ok(bt.split, "split");
  assert.ok(bt.split!.cutAt > bt.from && bt.split!.cutAt < bt.to);
  assert.ok("sharpe" in bt.metrics && "probabilisticSharpe" in bt.metrics);
});

test("versions: the brain's versions are all backtested, one is chosen on the first 70%, and the choice is deflated", async () => {
  const db = openDb(":memory:");
  const chain = {} as PublicClient;
  const v = (over: Parameters<typeof strategy>[0]) => ({ strategy: strategy(over), errors: [] as string[] });
  let calls = 0;
  const app = buildApi({
    db, config: loadConfig({ ADMIN_TOKEN: "admin", APP_DOMAIN: "agent.test" }), markets: MARKETS, lastTick: () => null, chain,
    token: { reader: new TokenReader(chain, null, 0), cfg: { address: null, tiers: DEFAULT_TIERS, burnTokensPerSlot: 1, burnSlotDays: 1 } },
    adminToken: "admin", rateLimitPerMinute: 1000,
    compileVersions: async () => {
      calls++;
      return { model: "stub", versions: [v({ name: "literal" }), v({ name: "wider stop", stopLossPct: 10 }), v({ name: "bad", leverage: 99 })] };
    },
  });
  const res = await app.request("/v1/agents", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer admin" }, body: JSON.stringify({ prompt: "buy nvidia dips please", dryRun: true, versions: true }) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(calls, 1);
  assert.equal(body.versions.length, 2); // the one over the limits is left out
  assert.equal(body.versions.filter((x: any) => x.chosen).length, 1);
  assert.equal(body.selection.trials, 2);
  assert.equal(body.strategy.name, body.versions.find((x: any) => x.chosen).strategy.name);
  assert.equal("raw" in body.backtest, false); // internal numbers stay on the server
});
