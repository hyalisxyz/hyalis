/**
 * Off-site backups and epoch bundles: the S3 signer against AWS's documented examples, bundles
 * that rebuild their roots (and against the registry contract on anvil), and backups and a full
 * restore through a stand-in S3 server that checks every request's signature over real HTTP.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { createPublicClient, createWalletClient, defineChain, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { openDb } from "../src/store/db.ts";
import { addReceipt, closeEpochs } from "../src/engine/epochs.ts";
import { Anchorer, REGISTRY_ABI, REGISTRY_BYTECODE } from "../src/chain/anchor.ts";
import { bundleBytes, epochBundle, verifyBundle, type EpochBundle } from "../src/archive/bundle.ts";
import { S3, signV4, uriEncode } from "../src/archive/s3.ts";
import { Backup, type SnapshotManifest } from "../src/archive/backup.ts";
import { buildApi } from "../src/api/server.ts";
import { DEFAULT_TIERS, TokenReader } from "../src/token/token.ts";
import { loadConfig } from "../src/config.ts";
import { MARKETS } from "./helpers.ts";

const H = 3600;

// ---------------------------------------------------------------------------- signer

test("SigV4: matches the worked examples in AWS's S3 documentation", () => {
  const base = { host: "examplebucket.s3.amazonaws.com", amzDate: "20130524T000000Z", region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const sig = (i: Parameters<typeof signV4>[0]) => signV4(i).authorization.split("Signature=")[1];
  assert.equal(sig({ ...base, method: "GET", path: "/test.txt", headers: { range: "bytes=0-9" }, payloadHash: empty }), "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(
    sig({ ...base, method: "PUT", path: "/test$file.text", headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" }, payloadHash: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072" }),
    "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
  );
  assert.equal(sig({ ...base, method: "GET", path: "/", query: { lifecycle: "" }, payloadHash: empty }), "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
  assert.equal(sig({ ...base, method: "GET", path: "/", query: { "max-keys": "2", prefix: "J" }, payloadHash: empty }), "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  assert.match(signV4({ ...base, method: "GET", path: "/x", payloadHash: empty }).authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
});

test("SigV4 URI encoding", () => {
  assert.equal(uriEncode("/epochs/1 2+3$é.json", true), "/epochs/1%202%2B3%24%C3%A9.json");
  assert.equal(uriEncode("a/b", false), "a%2Fb");
  assert.equal(uriEncode("AZaz09-._~", false), "AZaz09-._~");
});

// ---------------------------------------------------------------------------- bundles

/** A database with three sealed epochs, the first two marked anchored. */
function sealedDb(t0: number) {
  const db = openDb(":memory:");
  db.exec("INSERT INTO agents (id, name, prompt, strategy_json, strategy_hash, policy_json, status, created_at) VALUES ('a1', 'x', NULL, '{}', '0x', '{}', 'active', 0)");
  for (let e = 0; e < 3; e++) for (let i = 0; i < 3 + e; i++) addReceipt(db, "a1", Math.floor(t0 / H) + e, "decision", { at: t0 + e * H + i, n: i, price: 100.125 + i, note: "plain ascii and ünïcödé" }, t0 + e * H + i);
  closeEpochs(db, Math.floor(t0 / H) + 3, t0 + 3 * H);
  const epochs = (db.prepare("SELECT epoch FROM epochs ORDER BY epoch").all() as Array<{ epoch: number }>).map((r) => r.epoch);
  return { db, epochs };
}

test("bundles rebuild their roots; any change to a record, leaf or root is caught", async () => {
  const { db, epochs } = sealedDb(1_800_000_000 - (1_800_000_000 % H));
  assert.equal(epochs.length, 3);
  assert.equal(epochBundle(db, 12345), null, "not sealed: no bundle");
  const b = epochBundle(db, epochs[1]!)!;
  assert.equal(b.receipts.length, 4);
  assert.equal(b.prevRoot, (db.prepare("SELECT root FROM epochs WHERE epoch = ?").get(epochs[0]!) as any).root, "links to the epoch before");
  assert.equal(b.registry, null);
  assert.equal(b.anchor, null);
  assert.equal((await verifyBundle(b)).ok, true);
  // The published bytes parse back to a bundle that still verifies.
  assert.equal((await verifyBundle(JSON.parse(bundleBytes(b).toString("utf8")))).ok, true);

  const tamperedRecord: EpochBundle = structuredClone(b);
  tamperedRecord.receipts[0]!.record.price = 999;
  assert.deepEqual((await verifyBundle(tamperedRecord)).checks.map((c) => c.ok), [false, true], "the leaf no longer matches its record");
  const droppedReceipt: EpochBundle = { ...structuredClone(b), receipts: b.receipts.slice(1) };
  assert.equal((await verifyBundle(droppedReceipt)).checks.find((c) => c.name === "root")!.ok, false);
  const otherRoot: EpochBundle = { ...structuredClone(b), root: ("0x" + "12".repeat(32)) as Hex };
  assert.equal((await verifyBundle(otherRoot)).ok, false);

  // A database whose receipts no longer match the stored root never yields a bundle.
  db.prepare("UPDATE receipts SET record_json = replace(record_json, '100.125', '100.5') WHERE epoch = ?").run(epochs[0]!);
  assert.throws(() => epochBundle(db, epochs[0]!), /no longer hashes to its leaf/);
});

// ---------------------------------------------------------------------------- against the registry contract (anvil)

const hasAnvil = spawnSync("anvil", ["--version"], { shell: process.platform === "win32" }).status === 0;
const PORT = 24545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const anvil = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
let node: ChildProcess | null = null;
let pub: PublicClient;
before(async () => {
  if (!hasAnvil) return;
  node = spawn("anvil", ["--port", String(PORT), "--silent"], { shell: process.platform === "win32" });
  pub = createPublicClient({ chain: anvil, transport: http(RPC) }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
});
after(() => {
  if (!node) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(node.pid), "/T", "/F"]);
  else node.kill();
});

test("a bundle checks out against the root anchored on chain, and only that root", { skip: !hasAnvil && "anvil not installed", timeout: 60_000 }, async () => {
  const wallet = createWalletClient({ account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"), chain: anvil, transport: http(RPC) });
  const hash = await wallet.deployContract({ abi: REGISTRY_ABI, bytecode: REGISTRY_BYTECODE, args: [wallet.account.address, BigInt(H)] });
  const registry = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  const blockNow = Number((await pub.getBlock()).timestamp);
  const { db, epochs } = sealedDb(blockNow - (blockNow % H) - 6 * H);
  const anchorer = new Anchorer({ db, publicClient: pub, walletClient: wallet as any, registry, epochSec: H });
  const r = await anchorer.run();
  assert.equal(r.error, null);
  assert.equal(r.anchored.length, 3);

  const b = epochBundle(db, epochs[2]!)!;
  assert.ok(b.registry && b.anchor?.tx);
  const ok = await verifyBundle(b, pub);
  assert.equal(ok.ok, true, JSON.stringify(ok.checks));
  assert.match(ok.checks.find((c) => c.name === "chain")!.detail, /holds this root/);
  // Another epoch's root, or a broken link to the previous root, does not pass.
  assert.equal((await verifyBundle({ ...b, epoch: epochs[1]! }, pub)).ok, false);
  assert.equal((await verifyBundle({ ...b, prevRoot: ("0x" + "00".repeat(32)) as Hex }, pub)).ok, false);
  assert.equal((await verifyBundle({ ...b, registry: null }, pub)).ok, false);
});

// ---------------------------------------------------------------------------- backups through a stand-in S3 (real HTTP)

const KEY_ID = "test-key-id-1234";
const SECRET = "test-secret-key-abcdefgh";

/** Path-style S3 on localhost that refuses any request whose SigV4 signature does not check out. */
async function fakeS3() {
  const objects = new Map<string, Buffer>();
  const state = { fail: false, failNext: 0, hangNext: 0, requests: 0, puts: [] as string[] };
  const app = new Hono();
  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    const body = Buffer.from(await c.req.arrayBuffer());
    const hash = createHash("sha256").update(body).digest("hex");
    const sent = c.req.header("x-amz-content-sha256");
    const amzDate = c.req.header("x-amz-date") ?? "";
    const auth = c.req.header("authorization") ?? "";
    const signedNames = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(";") ?? [];
    const extra: Record<string, string> = {};
    for (const n of signedNames) if (!["host", "x-amz-date", "x-amz-content-sha256"].includes(n)) extra[n] = c.req.header(n) ?? "";
    const query = Object.fromEntries(url.searchParams.entries());
    const expected = signV4({ method: c.req.method, host: url.host, path: decodeURIComponent(url.pathname), query, headers: extra, payloadHash: hash, amzDate, region: "auto", accessKeyId: KEY_ID, secretAccessKey: SECRET });
    if (sent !== hash || auth !== expected.authorization) return c.text("<Error><Code>SignatureDoesNotMatch</Code></Error>", 403);
    state.requests++;
    if (state.hangNext > 0) {
      state.hangNext--;
      await new Promise((r) => setTimeout(r, 3000)); // longer than the client waits
    }
    if (state.fail || (state.failNext > 0 && state.failNext--)) return c.text("<Error><Code>InternalError</Code></Error>", 500);
    const [, bucket, ...rest] = decodeURIComponent(url.pathname).split("/");
    const key = rest.join("/");
    if (bucket !== "backups") return c.text("<Error><Code>NoSuchBucket</Code></Error>", 404);
    if (c.req.method === "PUT") {
      objects.set(key, body);
      state.puts.push(key);
      return c.body(null, 200);
    }
    if (c.req.method === "HEAD") return c.body(null, objects.has(key) ? 200 : 404);
    if (c.req.method === "DELETE") {
      objects.delete(key);
      return c.body(null, 204);
    }
    if (c.req.method === "GET" && query["list-type"] === "2") {
      // Pages of two, to exercise continuation.
      const all = [...objects.keys()].filter((k) => k.startsWith(query.prefix ?? "")).sort();
      const start = query["continuation-token"] ? Number(query["continuation-token"]) : 0;
      const page = all.slice(start, start + 2);
      const more = start + 2 < all.length;
      const items = page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><Size>${objects.get(k)!.length}</Size><LastModified>2026-11-24T00:00:00Z</LastModified></Contents>`).join("");
      return c.text(`<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}${items}</ListBucketResult>`, 200);
    }
    if (c.req.method === "GET") return objects.has(key) ? c.body(new Uint8Array(objects.get(key)!), 200) : c.text("<Error><Code>NoSuchKey</Code></Error>", 404);
    return c.text("no", 405);
  });
  const port = 25545 + Math.floor(Math.random() * 1000);
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const s3 = (secret = SECRET, o: { timeoutMs?: number } = {}) =>
    new S3({ endpoint: `http://127.0.0.1:${port}`, bucket: "backups", region: "auto", accessKeyId: KEY_ID, secretAccessKey: secret, style: "path", retryDelayMs: 0, timeoutMs: o.timeoutMs ?? 10_000 });
  return { objects, state, s3, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("S3 client: a passing failure is retried; a stalled or failing bucket stops in bounded time", async () => {
  const f = await fakeS3();
  try {
    f.state.failNext = 2; // two 500s, then it works
    await f.s3().put("db/x", Buffer.from("x"));
    assert.equal((await f.s3().get("db/x"))!.toString(), "x");
    f.state.requests = 0;
    f.state.fail = true;
    await assert.rejects(f.s3().put("db/y", Buffer.from("y")), /HTTP 500/);
    assert.equal(f.state.requests, 3, "three attempts, then it gives up");
    f.state.fail = false;
    f.state.hangNext = 3;
    const t0 = Date.now();
    await assert.rejects(f.s3(SECRET, { timeoutMs: 300 }).put("db/z", Buffer.from("z")), /after 3 attempts/);
    assert.ok(Date.now() - t0 < 2500, "a stalled bucket is given up on, not waited for");
  } finally {
    await f.close();
  }
});

test("S3 client: put, get, exists and paged list; a wrong secret is refused", async () => {
  const f = await fakeS3();
  try {
    const s3 = f.s3();
    await s3.put("db/a b+c.json", Buffer.from("hello"));
    assert.equal((await s3.get("db/a b+c.json"))!.toString(), "hello");
    assert.equal(await s3.get("db/missing"), null);
    assert.equal(await s3.exists("db/a b+c.json"), true);
    assert.equal(await s3.exists("nope"), false);
    await s3.delete("db/a b+c.json");
    assert.equal(await s3.exists("db/a b+c.json"), false);
    await s3.delete("db/a b+c.json"); // deleting what is gone is not an error
    for (const k of ["epochs/1.json", "epochs/2.json", "epochs/3.json", "epochs/4.json", "epochs/5.json"]) await s3.put(k, Buffer.from(k));
    assert.deepEqual((await s3.list("epochs/")).map((o) => o.key), ["epochs/1.json", "epochs/2.json", "epochs/3.json", "epochs/4.json", "epochs/5.json"]);
    await assert.rejects(f.s3("wrong-secret-xxxxxxxx").put("x", Buffer.from("y")), /HTTP 403/);
  } finally {
    await f.close();
  }
});

test("backups: anchored bundles once, rotating snapshots, manifest last, failures reported", async () => {
  const f = await fakeS3();
  const dir = mkdtempSync(join(tmpdir(), "au-backup-"));
  try {
    const t0 = 1_800_000_000 - (1_800_000_000 % H);
    const dbPath = join(dir, "live.db");
    const db = openDb(dbPath);
    db.exec("INSERT INTO agents (id, name, prompt, strategy_json, strategy_hash, policy_json, status, created_at) VALUES ('a1', 'x', NULL, '{}', '0x', '{}', 'active', 0)");
    for (let e = 0; e < 3; e++) addReceipt(db, "a1", Math.floor(t0 / H) + e, "decision", { at: t0 + e * H, e }, t0 + e * H);
    closeEpochs(db, Math.floor(t0 / H) + 3, t0 + 3 * H);
    const epochs = (db.prepare("SELECT epoch FROM epochs ORDER BY epoch").all() as Array<{ epoch: number }>).map((r) => r.epoch);
    db.prepare("UPDATE epochs SET anchor_tx = '0xaa', anchor_block = 7, anchor_registry = '0x8c4730f9fed980132eb6a8a681ceb558870de41a' WHERE epoch IN (?, ?)").run(epochs[0]!, epochs[1]!);

    const backup = new Backup(db, f.s3(), { dbPath, everySec: 6 * H });
    const now = Date.UTC(2026, 10, 24, 12) / 1000; // a Tuesday
    const r1 = await backup.run(now);
    assert.equal(r1.error, null);
    assert.equal(r1.bundles, 2, "only anchored epochs are final enough to archive");
    assert.equal(r1.pendingBundles, 0);
    assert.ok(r1.snapshot);
    assert.deepEqual([...f.objects.keys()].sort(), ["db/day-2.db.gz", "db/latest.db.gz", "db/latest.json", "db/month-2026-11.db.gz", `epochs/${epochs[0]}.json`, `epochs/${epochs[1]}.json`].sort());
    assert.equal(f.state.puts.at(-1), "db/latest.json", "the manifest is written after the snapshot it describes");
    const archived = JSON.parse(f.objects.get(`epochs/${epochs[0]}.json`)!.toString());
    assert.equal((await verifyBundle(archived)).ok, true, "an archived bundle checks out on its own");
    const manifest = JSON.parse(f.objects.get("db/latest.json")!.toString()) as SnapshotManifest;
    assert.equal(manifest.sha256, createHash("sha256").update(f.objects.get("db/latest.db.gz")!).digest("hex"));
    assert.equal(manifest.receipts, 3);
    assert.ok(!existsSync(join(dir, "backup-tmp", `snapshot-${now}.db`)), "the temporary copy is removed");

    // Soon after: nothing new to upload, no snapshot yet. A newly anchored epoch goes up alone.
    f.state.puts.length = 0;
    db.prepare("UPDATE epochs SET anchor_tx = '0xbb' WHERE epoch = ?").run(epochs[2]!);
    const r2 = await backup.run(now + H);
    assert.equal(r2.snapshot, null);
    assert.deepEqual(f.state.puts, [`epochs/${epochs[2]}.json`]);

    // Six hours later a new snapshot; the month's first one is kept as it was.
    const monthly = f.objects.get("db/month-2026-11.db.gz")!;
    addReceipt(db, "a1", Math.floor((now + 7 * H) / H), "decision", { later: true }, now + 7 * H);
    const r3 = await backup.run(now + 7 * H);
    assert.ok(r3.snapshot);
    assert.equal(f.objects.get("db/month-2026-11.db.gz"), monthly);
    assert.equal((JSON.parse(f.objects.get("db/latest.json")!.toString()) as SnapshotManifest).receipts, 4);

    // A failing bucket is reported, and the snapshot is tried again next round.
    f.state.fail = true;
    const r4 = await backup.run(now + 14 * H);
    assert.match(r4.error ?? "", /HTTP 500/);
    f.state.fail = false;
    assert.ok((await backup.run(now + 14 * H + 60)).snapshot, "retried after the failure");
    db.close();
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backups: a database moved to a new bucket uploads everything there again", async () => {
  const oldBucket = await fakeS3();
  let newBucket = await fakeS3();
  while (newBucket.port === oldBucket.port) {
    await newBucket.close();
    newBucket = await fakeS3();
  }
  const dir = mkdtempSync(join(tmpdir(), "au-backup-move-"));
  try {
    const t0 = 1_800_000_000 - (1_800_000_000 % H);
    const dbPath = join(dir, "live.db");
    const db = openDb(dbPath);
    db.exec("INSERT INTO agents (id, name, prompt, strategy_json, strategy_hash, policy_json, status, created_at) VALUES ('a1', 'x', NULL, '{}', '0x', '{}', 'active', 0)");
    for (let e = 0; e < 2; e++) addReceipt(db, "a1", Math.floor(t0 / H) + e, "decision", { at: t0 + e * H, e }, t0 + e * H);
    closeEpochs(db, Math.floor(t0 / H) + 2, t0 + 2 * H);
    db.exec("UPDATE epochs SET anchor_tx = '0xaa', anchor_block = 7, anchor_registry = '0x8c4730f9fed980132eb6a8a681ceb558870de41a'");
    const now = Date.UTC(2026, 10, 24, 12) / 1000;

    const r1 = await new Backup(db, oldBucket.s3(), { dbPath }).run(now);
    assert.equal(r1.bundles, 2);
    assert.ok(r1.snapshot);

    // Same bucket again (a restart): nothing is forgotten, nothing goes up twice.
    oldBucket.state.puts.length = 0;
    const again = await new Backup(db, oldBucket.s3(), { dbPath }).run(now + 60);
    assert.equal(again.bundles, 0);
    assert.equal(again.snapshot, null);
    assert.deepEqual(oldBucket.state.puts, []);

    // The same database now writes to another bucket: everything goes there, snapshot included.
    const moved = new Backup(db, newBucket.s3(), { dbPath });
    assert.equal(moved.status().bundlesArchived, 0);
    assert.equal(moved.status().bundlesPending, 2);
    const r2 = await moved.run(now + 120);
    assert.equal(r2.error, null);
    assert.equal(r2.bundles, 2);
    assert.ok(r2.snapshot, "a snapshot right away, not six hours after the old bucket's last one");
    assert.ok(newBucket.objects.has("db/latest.db.gz"));
    assert.equal([...newBucket.objects.keys()].filter((k) => k.startsWith("epochs/")).length, 2);

    // A prefix is part of the destination too.
    const prefixed = new Backup(db, newBucket.s3(), { dbPath, prefix: "staging/" });
    assert.equal(prefixed.status().bundlesPending, 2);
    db.close();
  } finally {
    await oldBucket.close();
    await newBucket.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore: the script downloads, checks and writes the database, and refuses to overwrite", async () => {
  const f = await fakeS3();
  const dir = mkdtempSync(join(tmpdir(), "au-restore-"));
  try {
    const t0 = 1_800_000_000 - (1_800_000_000 % H);
    const dbPath = join(dir, "live.db");
    const db = openDb(dbPath);
    db.exec("INSERT INTO agents (id, name, prompt, strategy_json, strategy_hash, policy_json, status, created_at) VALUES ('a1', 'x', NULL, '{}', '0x', '{}', 'active', 0)");
    for (let e = 0; e < 4; e++) addReceipt(db, "a1", Math.floor(t0 / H) + e, "decision", { e }, t0 + e * H);
    closeEpochs(db, Math.floor(t0 / H) + 4, t0 + 4 * H);
    await new Backup(db, f.s3(), { dbPath }).snapshot(t0 + 5 * H);
    const roots = db.prepare("SELECT epoch, root FROM epochs ORDER BY epoch").all();

    const env = { ...process.env, BACKUP_S3_ENDPOINT: `http://127.0.0.1:${f.port}`, BACKUP_S3_BUCKET: "backups", BACKUP_S3_ACCESS_KEY_ID: KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY: SECRET, BACKUP_S3_URL_STYLE: "path", BACKUP_S3_REGION: "auto" };
    const run = (...args: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const p = spawn(process.execPath, ["scripts/restore-backup.ts", ...args], { env });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (out += d));
        p.on("close", (code) => resolve({ code: code ?? 1, out }));
      });
    const out = join(dir, "restored.db");
    const r = await run("--out", out);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /4 sealed epochs rebuild their roots, 4 receipts/);
    const restored = new DatabaseSync(out);
    assert.deepEqual(restored.prepare("SELECT epoch, root FROM epochs ORDER BY epoch").all(), roots);
    restored.close();
    const again = await run("--out", out);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /exists; pass --force/);
    assert.equal((await run("--out", out, "--force")).code, 0);
    const listed = await run("--list");
    assert.match(listed.out, /db\/latest\.db\.gz/);

    // A snapshot that does not match its manifest is refused.
    f.objects.set("db/latest.db.gz", Buffer.from(gunzipSync(f.objects.get("db/latest.db.gz")!)));
    const bad = await run("--out", join(dir, "bad.db"));
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /does not match the manifest/);
    assert.ok(!existsSync(join(dir, "bad.db")));
    db.close();
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API serves a sealed epoch's bundle; final ones are cached for good", async () => {
  const { db, epochs } = sealedDb(1_800_000_000 - (1_800_000_000 % H));
  db.prepare("UPDATE epochs SET anchor_tx = '0xaa', anchor_registry = '0x8c4730f9fed980132eb6a8a681ceb558870de41a' WHERE epoch = ?").run(epochs[0]!);
  const app = buildApi({
    db, config: loadConfig({ APP_DOMAIN: "agent.test" }), markets: MARKETS, lastTick: () => null, chain: {} as PublicClient,
    token: { reader: new TokenReader({} as PublicClient, null, 0), cfg: { address: null, tiers: DEFAULT_TIERS, burnTokensPerSlot: 1, burnSlotDays: 1 } },
  });
  const anchored = await app.request(`/v1/epochs/${epochs[0]}/bundle.json`);
  assert.equal(anchored.status, 200);
  assert.match(anchored.headers.get("cache-control") ?? "", /immutable/);
  const body = await anchored.text();
  assert.equal(body, bundleBytes(epochBundle(db, epochs[0]!)!).toString("utf8"), "the exact canonical bytes");
  assert.equal((await verifyBundle(JSON.parse(body))).ok, true);
  assert.equal((await app.request(`/v1/epochs/${epochs[1]}/bundle.json`)).headers.get("cache-control"), "no-store");
  assert.equal((await app.request(`/v1/epochs/1/bundle.json`)).status, 404);
  assert.equal((await app.request(`/v1/epochs/abc/bundle.json`)).status, 400);
});
