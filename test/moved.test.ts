/**
 * The old host after a move: everything redirects to the new one; only the operator can still
 * take the database out, and only while that is switched on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { buildMovedApp } from "../src/moved.ts";
import { loadConfig } from "../src/config.ts";

function withDb(fn: (dbPath: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "moved-test-"));
    const dbPath = join(dir, "old.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE receipts (id INTEGER PRIMARY KEY, body TEXT)");
    db.prepare("INSERT INTO receipts (body) VALUES (?)").run("sealed");
    db.close();
    try {
      await fn(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("every path and query goes to the same place on the new host, method kept", withDb(async (dbPath) => {
  const app = buildMovedApp({ movedTo: "https://new.example/", dbPath, exportEnabled: false });
  for (const [path, want] of [
    ["/", "https://new.example/"],
    ["/app/agents/abc?tab=journal", "https://new.example/app/agents/abc?tab=journal"],
    ["/v1/agents/50503bfe-3b7f-45b0-8d7f-0a56338ff100/registration.json", "https://new.example/v1/agents/50503bfe-3b7f-45b0-8d7f-0a56338ff100/registration.json"],
    ["//evil.example/x", "https://new.example//evil.example/x"],
  ] as const) {
    const r = await app.request(path);
    assert.equal(r.status, 308, path);
    assert.equal(r.headers.get("location"), want, path);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.match(r.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
  }
  const post = await app.request("/v1/agents", { method: "POST", body: "{}" });
  assert.equal(post.status, 308);
  const h = await (await app.request("/health")).json();
  assert.deepEqual(h, { ok: true, movedTo: "https://new.example" });
}));

test("the export: off, wrong token or no token all look like nothing is there", withDb(async (dbPath) => {
  const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
  const off = buildMovedApp({ movedTo: "https://new.example", dbPath, exportEnabled: false, adminToken: "op-secret" });
  assert.equal((await off.request("/v1/admin/export", auth("op-secret"))).status, 404);
  const on = buildMovedApp({ movedTo: "https://new.example", dbPath, exportEnabled: true, adminToken: "op-secret" });
  assert.equal((await on.request("/v1/admin/export")).status, 404);
  assert.equal((await on.request("/v1/admin/export", auth("op-secre"))).status, 404);
  const noToken = buildMovedApp({ movedTo: "https://new.example", dbPath, exportEnabled: true });
  assert.equal((await noToken.request("/v1/admin/export", auth(""))).status, 404, "no operator token configured");

  const r = await on.request("/v1/admin/export", auth("op-secret"));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const dir = mkdtempSync(join(tmpdir(), "moved-copy-"));
  try {
    const file = join(dir, "copy.db");
    writeFileSync(file, gunzipSync(Buffer.from(await r.arrayBuffer())));
    const copy = new DatabaseSync(file, { readOnly: true });
    assert.equal((copy.prepare("SELECT body FROM receipts").get() as { body: string }).body, "sealed");
    copy.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The old database was only read.
  const old = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal((old.prepare("SELECT count(*) AS n FROM receipts").get() as { n: number }).n, 1);
  old.close();
}));

test("MOVED_TO must be an https URL", () => {
  assert.equal(loadConfig({ APP_DOMAIN: "a.test", MOVED_TO: "https://new.example" }).MOVED_TO, "https://new.example");
  assert.equal(loadConfig({ APP_DOMAIN: "a.test" }).MOVED_TO, undefined);
  assert.throws(() => loadConfig({ APP_DOMAIN: "a.test", MOVED_TO: "http://new.example" }));
  assert.throws(() => loadConfig({ APP_DOMAIN: "a.test", MOVED_TO: "not a url" }));
});
