/**
 * Keys never reach logs or callers, and every response carries the security headers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import { errLine, redact } from "../src/util/redact.ts";
import { buildApi, sameSecret, SITE_CSP } from "../src/api/server.ts";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/store/db.ts";
import { DEFAULT_TIERS, TokenReader } from "../src/token/token.ts";
import { loadConfig } from "../src/config.ts";
import { MARKETS } from "./helpers.ts";
import { gunzipSync } from "node:zlib";
import { cacheFor } from "../src/api/static.ts";

const KEY = "alch_SECRETkey1234567890";

test("redact removes keys from URLs and text", () => {
  const cases: Array<[string, string]> = [
    [`URL: https://robinhood-mainnet.g.alchemy.com/v2/${KEY}`, "URL: https://robinhood-mainnet.g.alchemy.com/v2/<hidden>"],
    [`key ${KEY} in plain text`, "key alch_<hidden> in plain text"],
    ["https://eth-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUv123", "https://eth-mainnet.g.alchemy.com/v2/<hidden>"],
    ["auth failed for sk-ant-api03-XYZxyz_123-abc", "auth failed for sk-ant-<hidden>"],
    ["GET https://api.example.com/x?a=1&api_key=SeCrEt9&b=2", "GET https://api.example.com/x?a=1&api_key=<hidden>&b=2"],
    ["?x-cg-demo-api-key=CG-abc123", "?x-cg-demo-api-key=<hidden>"],
    ["Authorization: Bearer abcdef1234567890", "Authorization: Bearer <hidden>"],
    ["key pyth_abcDEF123 refused", "key pyth_<hidden> refused"],
  ];
  for (const [input, want] of cases) assert.equal(redact(input), want);
  // Transaction hashes and addresses are not secrets and stay readable.
  const tx = "0x" + "ab".repeat(32);
  assert.equal(redact(`tx ${tx} from 0xF42CAC7Cc20D1C970188e059A06b86159b10aA24`), `tx ${tx} from 0xF42CAC7Cc20D1C970188e059A06b86159b10aA24`);
});

test("a real RPC failure, logged through errLine, carries no key", async () => {
  // A dead local port with an Alchemy-style key in the path, as RPC_URL looks in production.
  const client = createPublicClient({ transport: http(`http://127.0.0.1:9/v2/${KEY}`, { retryCount: 0, timeout: 2000 }) }) as PublicClient;
  let err: unknown;
  try {
    await client.readContract({ address: "0x0000000000000000000000000000000000000001", abi: parseAbi(["function f() view returns (uint256)"]), functionName: "f" });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "the call failed");
  assert.ok(String((err as Error).message).includes(KEY), "viem's full message does contain the key (which is why errLine exists)");
  const line = errLine(err);
  assert.ok(!line.includes(KEY) && !line.includes("SECRETkey"), line);
  assert.ok(!line.includes("\n"));
});

function app() {
  const db = openDb(":memory:");
  const a = buildApi({
    db,
    config: loadConfig({ APP_DOMAIN: "agent.test" }),
    markets: MARKETS,
    lastTick: () => null,
    chain: {} as PublicClient,
    token: { reader: new TokenReader({} as PublicClient, null, 0), cfg: { address: null, tiers: DEFAULT_TIERS, burnTokensPerSlot: 1, burnSlotDays: 1 } },
  });
  a.get("/boom", () => {
    throw new Error(`HTTP request failed.\n\nURL: https://robinhood-mainnet.g.alchemy.com/v2/${KEY}`);
  });
  return a;
}

test("an uncaught error answers plainly and logs one safe line", async () => {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const r = await app().request("/boom");
    assert.equal(r.status, 500);
    const body = await r.text();
    assert.ok(!body.includes(KEY) && !body.includes("alchemy"), body);
    assert.match(body, /something went wrong on our side/);
  } finally {
    console.error = orig;
  }
  assert.equal(logged.length, 1);
  assert.ok(!logged[0]!.includes(KEY), logged[0]!);
  assert.match(logged[0]!, /\[api\] GET \/boom: HTTP request failed\./);
});

test("security headers on every response; a route's own CSP is kept", async () => {
  const a = app();
  for (const path of ["/health", "/v1/markets", "/v1/agents/nope", "/boom"]) {
    const orig = console.error;
    console.error = () => {};
    const r = await a.request(path);
    console.error = orig;
    assert.equal(r.headers.get("x-frame-options"), "DENY", path);
    assert.equal(r.headers.get("content-security-policy"), SITE_CSP, path);
    assert.equal(r.headers.get("cross-origin-resource-policy"), path.startsWith("/v1/") ? "cross-origin" : "same-origin", path);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(r.headers.get("referrer-policy"), "strict-origin-when-cross-origin", path);
    assert.match(r.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
    assert.match(r.headers.get("permissions-policy") ?? "", /camera=\(\)/);
  }
  // CORS still lets other apps read the public API.
  const cors = await a.request("/v1/markets", { headers: { origin: "https://someone-else.example" } });
  assert.equal(cors.headers.get("access-control-allow-origin"), "*");
});

test("API answers are gzipped for clients that ask, and keep every security header", async () => {
  const a = app();
  const zipped = await a.request("/v1/markets", { headers: { "accept-encoding": "gzip" } });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers.get("content-encoding"), "gzip");
  assert.equal(zipped.headers.get("content-security-policy"), SITE_CSP);
  assert.equal(zipped.headers.get("x-frame-options"), "DENY");
  const body = gunzipSync(Buffer.from(await zipped.arrayBuffer())).toString("utf8");
  const plain = await (await a.request("/v1/markets")).text();
  assert.equal(body, plain, "the gzipped body is the same JSON");
  // A client that does not ask gets plain JSON.
  const raw = await a.request("/v1/markets");
  assert.equal(raw.headers.get("content-encoding"), null);
});

test("website files: hashed assets cached a year, pages always rechecked", () => {
  assert.equal(cacheFor("web/dist/assets/index-C0ysBQDN.js.br"), "public, max-age=31536000, immutable");
  assert.equal(cacheFor(String.raw`web\dist\assets\Landing-x.css`), "public, max-age=31536000, immutable");
  assert.equal(cacheFor("web/dist/index.html"), "no-cache");
  assert.equal(cacheFor("web/dist/index.html.br"), "no-cache");
  assert.equal(cacheFor("web/dist/fonts/archivo-var.woff2"), "public, max-age=86400");
  assert.equal(cacheFor("web/dist/robots.txt"), "public, max-age=86400");
});

function exportApp(enabled: boolean) {
  const db = openDb(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS export_probe (v TEXT)");
  db.prepare("INSERT INTO export_probe (v) VALUES (?)").run("still here");
  const a = buildApi({
    db,
    config: loadConfig({ APP_DOMAIN: "agent.test", ADMIN_EXPORT_ENABLED: enabled ? "true" : "false" }),
    markets: MARKETS,
    lastTick: () => null,
    adminToken: "op-token-123",
    chain: {} as PublicClient,
    token: { reader: new TokenReader({} as PublicClient, null, 0), cfg: { address: null, tiers: DEFAULT_TIERS, burnTokensPerSlot: 1, burnSlotDays: 1 } },
  });
  return a;
}

test("database export: hidden unless switched on and asked for with the operator token", async () => {
  const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
  // Off: even the operator gets 404.
  assert.equal((await exportApp(false).request("/v1/admin/export", auth("op-token-123"))).status, 404);
  const on = exportApp(true);
  assert.equal((await on.request("/v1/admin/export")).status, 404, "no token");
  assert.equal((await on.request("/v1/admin/export", auth("op-token-12"))).status, 404, "a prefix of the token");
  assert.equal((await on.request("/v1/admin/export", auth("op-token-1234"))).status, 404, "a longer token");
  assert.equal((await on.request("/v1/admin/export", { method: "POST", ...auth("op-token-123") })).status, 404, "GET only");

  const r = await on.request("/v1/admin/export", { headers: { authorization: "Bearer op-token-123", "accept-encoding": "gzip" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/gzip");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("content-encoding"), null, "the file is gzip itself, not gzipped again");
  assert.match(r.headers.get("content-disposition") ?? "", /attachment; filename="hyalis-\d{4}-\d{2}-\d{2}T\d{6}Z\.db\.gz"/);
  const dir = mkdtempSync(join(tmpdir(), "export-test-"));
  try {
    const file = join(dir, "copy.db");
    writeFileSync(file, gunzipSync(Buffer.from(await r.arrayBuffer())));
    const copy = new DatabaseSync(file);
    assert.equal((copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    assert.equal((copy.prepare("SELECT v FROM export_probe").get() as { v: string }).v, "still here");
    assert.ok((copy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n > 5, "the whole schema came along");
    copy.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // No copy is left behind in the temp folder.
  assert.ok(!readdirSync(tmpdir()).some((f) => /^export-[0-9a-f-]{36}\.db$/.test(f)));
});

test("sameSecret matches only the exact secret", () => {
  assert.ok(sameSecret("abc", "abc"));
  assert.ok(!sameSecret("abc", "abd"));
  assert.ok(!sameSecret("ab", "abc"));
  assert.ok(!sameSecret("", "abc"));
});
