/**
 * Full check of a deployed backend, from the outside: the service, prices, agents, sealing and
 * anchoring (re-read from Robinhood Chain), backups, ERC-8004 identities, user flows and the
 * website. Prints PASS / WARN / FAIL per check with the reason, and exits 1 if anything failed.
 *
 *   node --env-file=.env scripts/audit-prod.ts https://<domain>
 *
 * Read-only, except two harmless steps: an AI dry run with the admin token (no agent is
 * created) and a sign-in with a throwaway wallet that is signed out again at once.
 */
import { spawnSync } from "node:child_process";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainClient } from "../src/sources/chainlink.ts";
import { REGISTRY_ABI } from "../src/chain/anchor.ts";
import { IDENTITY_ABI, IDENTITY_REGISTRY } from "../src/chain/identity.ts";
import { verifyBundle, type EpochBundle } from "../src/archive/bundle.ts";
import { S3 } from "../src/archive/s3.ts";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!base.startsWith("https://")) {
  console.error("usage: node --env-file=.env scripts/audit-prod.ts https://<domain>");
  process.exit(2);
}
const env = process.env;
const chain = chainClient(env.RPC_URL || undefined);
const H = 3600;
const now = () => Math.floor(Date.now() / 1000);
const age = (t: number | null | undefined) => (t ? now() - Number(t) : Infinity);
const mins = (s: number) => (Number.isFinite(s) ? `${Math.round(s / 60)} min` : "never");

type Level = "PASS" | "WARN" | "FAIL";
const results: Array<{ level: Level; area: string; name: string; detail: string }> = [];
const report = (level: Level, area: string, name: string, detail: string) => {
  results.push({ level, area, name, detail });
  console.log(`${level === "PASS" ? "PASS" : level === "WARN" ? "WARN" : "FAIL"}  [${area}] ${name}: ${detail}`);
};
const check = async (area: string, name: string, fn: () => Promise<[Level, string]>) => {
  try {
    const [l, d] = await fn();
    report(l, area, name, d);
  } catch (e) {
    report("FAIL", area, name, `error: ${(e as Error).message.split("\n")[0]}`);
  }
};
async function get(path: string): Promise<any> {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
  return r.json();
}

// ------------------------------------------------------------------ service
const health = await get("/health");
const tick = health.lastTick;
const tickSec = Number(env.TICK_SEC || 300);
await check("service", "tick loop", async () => [age(tick?.at) <= 2 * tickSec + 60 ? "PASS" : "FAIL", `last tick ${mins(age(tick?.at))} ago, ${tick?.agents} agents, market ${tick?.market?.session}`]);
await check("service", "price feeds", async () => [tick?.feedsFailed?.length ? "WARN" : "PASS", tick?.feedsFailed?.length ? `failed this tick: ${tick.feedsFailed.join(", ")}` : "every Chainlink feed answered"]);
await check("service", "second sources", async () => {
  const down = ["planktonOk", "pythOk", "coingeckoOk", "dexOk"].filter((k) => tick?.[k] === false);
  return [down.length ? "WARN" : "PASS", down.length ? `down or partial: ${down.join(", ")}` : "Pyth, CoinGecko, DEX quotes, Plankton all answered"];
});

// ------------------------------------------------------------------ prices
const markets = (await get("/v1/markets")) as any[];
await check("prices", "every market priced", async () => {
  const missing = markets.filter((m) => m.price === null).map((m) => m.symbol);
  return [missing.length ? "FAIL" : "PASS", missing.length ? `no price: ${missing.join(", ")}` : `${markets.length} markets have a price`];
});
await check("prices", "freshness", async () => {
  // Crypto never closes: its latest round must be recent. Stocks only while the market is open.
  const stale = markets
    .filter((m) => m.hours === "24/7" || tick?.market?.open)
    .filter((m) => age(m.updatedAt) > (m.tier === "verified" ? 26 * H : 3 * H))
    .map((m) => `${m.symbol} (${mins(age(m.updatedAt))})`);
  return [stale.length ? "WARN" : "PASS", stale.length ? `older than expected: ${stale.join(", ")}` : "latest rounds are within their expected age"];
});

// ------------------------------------------------------------------ agents
const agents = (await get("/v1/agents")) as any[];
await check("agents", "house agents running", async () => {
  const house = agents.filter((a) => a.house);
  const paused = house.filter((a) => a.status !== "active").map((a) => a.name);
  return [house.length >= 4 && !paused.length ? "PASS" : "FAIL", `${house.length} house agents${paused.length ? `, paused: ${paused.join(", ")}` : ", all active"}`];
});
for (const a of agents.filter((x) => x.status === "active")) {
  await check("agents", `${a.name} trades every hour`, async () => {
    const rs = (await get(`/v1/agents/${a.id}/receipts?limit=40`)) as any[];
    const snap = rs.find((r) => r.kind === "snapshot");
    return [age(snap?.createdAt) <= 2 * H ? "PASS" : "FAIL", `latest hourly snapshot ${mins(age(snap?.createdAt))} ago`];
  });
}

// ------------------------------------------------------------------ sealing and anchoring
const epochs = (await get("/v1/epochs")) as any[]; // newest first, up to 100
const current = Math.floor(now() / H);
await check("sealing", "epochs sealed on time", async () => {
  const newest = epochs[0]?.epoch;
  return [newest >= current - 2 ? "PASS" : "FAIL", `newest sealed epoch ${newest}, current ${current} (${current - newest} behind)`];
});
const anchored = epochs.filter((e) => e.anchorTx);
const newestAnchored = anchored[0];
await check("anchoring", "roots published", async () => {
  const lag = current - (newestAnchored?.epoch ?? 0);
  const halted = health.anchor?.halted;
  return [halted ? "FAIL" : lag <= 3 ? "PASS" : "FAIL", halted ? `HALTED: ${halted}` : `newest anchored epoch ${newestAnchored?.epoch} (${lag} behind current), ${anchored.length}/${epochs.length} of the listed epochs anchored`];
});
await check("anchoring", "history is one unbroken chain", async () => {
  const sorted = [...epochs].sort((x, y) => x.epoch - y.epoch);
  const breaks = sorted.slice(1).filter((e, i) => e.prevRoot !== sorted[i]!.root).map((e) => e.epoch);
  return [breaks.length ? "FAIL" : "PASS", breaks.length ? `prevRoot does not match the epoch before at ${breaks.join(", ")}` : `${sorted.length} epochs each link to the one before`];
});
const registry = getAddress(newestAnchored.registry) as `0x${string}`;
await check("anchoring", "chain agrees with the server", async () => {
  const [lastEpoch, lastRoot] = await Promise.all([
    chain.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "lastEpoch" }) as Promise<bigint>,
    chain.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "lastRoot" }) as Promise<Hex>,
  ]);
  const ok = Number(lastEpoch) === newestAnchored.epoch && lastRoot.toLowerCase() === newestAnchored.root.toLowerCase();
  return [ok ? "PASS" : "FAIL", `registry's last epoch ${lastEpoch}, server's newest anchored ${newestAnchored.epoch}; roots ${ok ? "match" : "DIFFER"}`];
});
await check("anchoring", "newest epoch verifies from its bundle", async () => {
  const b = (await get(`/v1/epochs/${newestAnchored.epoch}/bundle.json`)) as EpochBundle;
  const r = await verifyBundle(b, chain);
  return [r.ok ? "PASS" : "FAIL", r.checks.map((c) => `${c.name} ${c.ok ? "ok" : "FAILED"}`).join(", ") + ` (${b.receipts.length} receipts)`];
});
await check("receipts", "a recent trade verifies down to its Chainlink round", async () => {
  const activity = (await get("/v1/activity?limit=50")) as any[];
  const pick = activity.find((r) => r.anchored && r.record?.input?.feed?.startsWith?.("0x"));
  if (!pick) return ["WARN", "no anchored trade with a Chainlink input in the latest 50"];
  const out = spawnSync(process.execPath, ["src/cli/verify.ts", String(pick.id), "--api", base], { encoding: "utf8", env });
  // The CLI prints one line per check, starting with OK or FAIL; all four must be OK.
  const lines = out.stdout.split("\n").map((l) => l.trim());
  const passes = lines.filter((l) => l.startsWith("OK ")).length;
  const fails = lines.filter((l) => l.startsWith("FAIL")).length;
  return [out.status === 0 && fails === 0 && passes === 4 ? "PASS" : "FAIL", `receipt #${pick.id}: ${passes} of 4 checks OK (record hash, Merkle proof, registry on chain, Chainlink round)${fails ? `, ${fails} failed` : ""}`];
});
await check("anchoring", "anchor wallet has gas", async () => {
  const tx = await chain.getTransactionReceipt({ hash: newestAnchored.anchorTx as Hex });
  const tr = await chain.getTransaction({ hash: newestAnchored.anchorTx as Hex });
  const per = tx.gasUsed * (tx.effectiveGasPrice ?? 0n);
  const bal = await chain.getBalance({ address: tr.from });
  const days = per > 0n ? Number(bal / per) / 24 : Infinity;
  return [days > 30 ? "PASS" : days > 7 ? "WARN" : "FAIL", `${(Number(bal) / 1e18).toFixed(6)} ETH, about ${Math.floor(days)} days of hourly anchors at the last one's cost`];
});

// ------------------------------------------------------------------ backups
await check("backup", "service backups", async () => {
  const b = health.backup;
  if (!b || b.status === "off") return ["FAIL", "backups are off"];
  const err = b.last?.error;
  const snapAge = age(b.lastSnapshotAt);
  return [err ? "FAIL" : snapAge <= 7 * H && b.bundlesPending <= 1 ? "PASS" : "WARN", err ? `last round failed: ${err}` : `last snapshot ${mins(snapAge)} ago, ${b.bundlesArchived} bundles archived, ${b.bundlesPending} pending`];
});
if (env.BACKUP_S3_ENDPOINT && env.BACKUP_S3_SECRET_ACCESS_KEY) {
  const s3 = new S3({ endpoint: env.BACKUP_S3_ENDPOINT, bucket: env.BACKUP_S3_BUCKET!, region: env.BACKUP_S3_REGION || "auto", accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID!, secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY, style: env.BACKUP_S3_URL_STYLE === "path" ? "path" : "virtual" });
  await check("backup", "bucket holds the newest anchored epoch", async () => {
    const has = await s3.exists(`epochs/${newestAnchored.epoch}.json`);
    const m = JSON.parse((await s3.get("db/latest.json"))?.toString() ?? "null");
    return [has && m ? "PASS" : "WARN", `epochs/${newestAnchored.epoch}.json ${has ? "present" : "not yet uploaded"}; latest snapshot has ${m?.receipts} receipts, ${m?.epochs} epochs`];
  });
} else report("WARN", "backup", "bucket", "BACKUP_S3_* not in .env; bucket contents not checked");

// ------------------------------------------------------------------ identities
for (const a of agents.filter((x) => x.house)) {
  await check("identity", `${a.name} ERC-8004`, async () => {
    const id = a.identity;
    if (!id?.verified) return ["FAIL", id ? `status ${id.status}` : "not linked"];
    const info = await get(`/v1/agents/${a.id}/identity`);
    const [owner, uri] = await Promise.all([
      chain.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "ownerOf", args: [BigInt(id.agentId)] }) as Promise<string>,
      chain.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "tokenURI", args: [BigInt(id.agentId)] }) as Promise<string>,
    ]);
    const file = await get(`/v1/agents/${a.id}/registration.json`);
    const listed = file.registrations?.some((r: any) => String(r.agentId) === id.agentId);
    const ok = getAddress(owner) === getAddress(info.expectedOwner) && uri === info.agentURI && listed;
    return [ok ? (age(id.checkedAt) <= 7 * H ? "PASS" : "WARN") : "FAIL", `#${id.agentId}: chain owner ${ok ? "and URI match" : "or URI DIFFERS"}, file lists it: ${listed}, re-checked ${mins(age(id.checkedAt))} ago`];
  });
}

// ------------------------------------------------------------------ public reads
for (const p of ["/v1/stats", "/v1/leaderboard", "/v1/activity?limit=5", "/v1/token", `/v1/agents/${agents[0].id}/journal`, `/v1/agents/${agents[0].id}/image.svg`])
  await check("api", `GET ${p.split("?")[0]}`, async () => {
    const r = await fetch(base + p);
    return [r.ok ? "PASS" : "FAIL", `HTTP ${r.status}`];
  });
await check("api", "wallet view (no sign-in)", async () => {
  const w = await get(`/v1/wallets/${privateKeyToAccount(generatePrivateKey()).address}`);
  return [w.tier?.name && w.agentSlots >= 1 ? "PASS" : "FAIL", `tier ${w.tier?.name}, ${w.agentSlots} slot(s), ${w.compilesPerDay} AI builds a day`];
});
await check("api", "backtest", async () => {
  const strategy = { name: "audit", summary: "audit", symbols: ["BTC"], side: "long", entry: [{ type: "change_pct", description: "down 3% in 24h", lookbackHours: 24, op: "lt", value: -3 }], exitConditions: [], stopLossPct: 5, takeProfitPct: 5, maxHoldHours: 0, positionPct: 10, maxOpenPositions: 1, leverage: 1, notes: [] };
  const r = await fetch(base + "/v1/backtest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ strategy, days: 7 }) });
  const b = (await r.json()) as any;
  return [r.ok && Number.isFinite(b.returnPct) ? "PASS" : "FAIL", r.ok ? `7 days on BTC: ${b.returnPct}% in ${b.trades.length} trades over ${b.hours} hours` : `HTTP ${r.status}`];
});

// ------------------------------------------------------------------ user flows
await check("users", "wallet sign-in, session, sign-out", async () => {
  const acct = privateKeyToAccount(generatePrivateKey()); // throwaway
  const post = (p: string, body: unknown, token?: string) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const n = (await (await post("/v1/auth/nonce", { address: acct.address })).json()) as any;
  const signature = await acct.signMessage({ message: n.message });
  const v = (await (await post("/v1/auth/verify", { address: acct.address, nonce: n.nonce, signature })).json()) as any;
  if (!v.token) return ["FAIL", `sign-in refused: ${JSON.stringify(v).slice(0, 120)}`];
  const me = await fetch(base + "/v1/me", { headers: { authorization: `Bearer ${v.token}` } });
  const replay = await post("/v1/auth/verify", { address: acct.address, nonce: n.nonce, signature });
  await post("/v1/auth/logout", {}, v.token);
  const after = await fetch(base + "/v1/me", { headers: { authorization: `Bearer ${v.token}` } });
  const ok = me.status === 200 && replay.status === 401 && after.status === 401;
  return [ok ? "PASS" : "FAIL", `signed in (/v1/me ${me.status}), same signature again ${replay.status}, after sign-out ${after.status}`];
});
const admin = env.ADMIN_TOKEN;
if (admin)
  await check("users", "AI builds rules (dry run, nothing created)", async () => {
    const t0 = Date.now();
    const r = await fetch(base + "/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
      body: JSON.stringify({ prompt: "Buy NVDA when it is 3% below its 24-hour average, stop loss 5%, take profit 6%.", dryRun: true, backtestDays: 7 }),
    });
    const b = (await r.json()) as any;
    if (r.status !== 200) return ["FAIL", `HTTP ${r.status}: ${JSON.stringify(b).slice(0, 150)}`];
    const leak = /claude|anthropic|openai|gpt/i.test(JSON.stringify(b.strategy));
    return [leak ? "FAIL" : "PASS", `${((Date.now() - t0) / 1000).toFixed(1)}s: ${b.strategy.symbols.join(",")}, stop ${b.strategy.stopLossPct}%, ${leak ? "VENDOR NAME LEAKED" : "no vendor name in the output"}`];
  });
else report("WARN", "users", "AI dry run", "ADMIN_TOKEN not in .env; skipped");

// ------------------------------------------------------------------ website
await check("web", "pages and assets", async () => {
  const pages = ["/", "/app", `/app/agents/${agents[0].id}`, "/app/proofs"];
  const statuses = await Promise.all(pages.map(async (p) => (await fetch(base + p)).status));
  const html = await (await fetch(base + "/")).text();
  const js = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  const asset = js ? await fetch(base + js) : null;
  const ok = statuses.every((s) => s === 200) && asset?.ok && /javascript/.test(asset.headers.get("content-type") ?? "");
  return [ok ? "PASS" : "FAIL", `${pages.map((p, i) => `${p.length > 14 ? p.slice(0, 14) + "…" : p} ${statuses[i]}`).join(", ")}; main script ${asset?.status ?? "missing"}`];
});

// ------------------------------------------------------------------ summary
const count = (l: Level) => results.filter((r) => r.level === l).length;
console.log(`\n${count("PASS")} passed, ${count("WARN")} warnings, ${count("FAIL")} failed`);
process.exit(count("FAIL") ? 1 : 0);
