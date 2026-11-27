/**
 * Quick checks against a deployed backend. Reads ADMIN_TOKEN from .env without printing it.
 *
 *   node scripts/smoke-prod.ts https://<your-domain>
 */
import { readFileSync } from "node:fs";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base.startsWith("https://")) throw new Error("usage: node scripts/smoke-prod.ts https://<domain>");
const admin = /^ADMIN_TOKEN=(.+)$/m.exec(readFileSync(".env", "utf8"))?.[1]?.trim();
if (!admin) throw new Error("ADMIN_TOKEN missing in .env");

const get = async (p: string) => (await fetch(base + p)).json() as Promise<any>;

const token = await get("/v1/token");
console.log(`token: launched=${token.launched}, tiers ${token.tiers.map((t: any) => `${t.name}>=${t.minTokens}`).join(" ")}`);

const w = await get("/v1/wallets/0x000000000000000000000000000000000000dEaD");
console.log(`wallet view: tier=${w.tier?.name}, slots=${w.agentSlots}, next=${w.nextTier?.name} (needs ${w.nextTier?.needed})`);

const t0 = Date.now();
const res = await fetch(base + "/v1/agents", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
  body: JSON.stringify({ prompt: "Buy BTC and ETH when they drop more than 4% in 24 hours, stop loss 5%, take profit 6%.", dryRun: true, backtestDays: 14 }),
});
const body = (await res.json()) as any;
if (res.status !== 200) {
  console.log(`AI dry run FAILED: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  process.exit(1);
}
const s = body.strategy;
const b = body.backtest;
console.log(`AI dry run OK in ${((Date.now() - t0) / 1000).toFixed(1)}s: "${s.name}" ${s.symbols.join(",")} | entry: ${s.entry.map((c: any) => c.description).join(" & ")}`);
console.log(`backtest 14d: return ${b.returnPct}% vs hold ${b.benchmarkReturnPct}%, trades ${b.trades.length}, max DD ${b.maxDrawdownPct}%, hours ${b.hours}`);
const leak = /claude|anthropic|openai|gpt/i.test(JSON.stringify(s));
console.log(`identity check: ${leak ? "LEAK: model or vendor name in output" : "no model or vendor name in output"}`);
