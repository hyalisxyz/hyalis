/**
 * Avatars paid with x402: the payment client against a stand-in image service that checks
 * every signature like a real facilitator would, the ledger and budget, and the avatar job.
 * test/fork/x402.fork.ts checks the same signatures against the real USDG contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { getAddress, verifyTypedData, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { openDb } from "../src/store/db.ts";
import { createAgent, getAgent } from "../src/engine/agents.ts";
import { Policy } from "../src/guard/policy.ts";
import { buildApi } from "../src/api/server.ts";
import { DEFAULT_TIERS, TokenReader } from "../src/token/token.ts";
import { loadConfig } from "../src/config.ts";
import { authorizationTypedData, choosePayment, decodeB64Json, encodeB64Json, PaymentRefused, type PaymentRequired, type PayPolicy } from "../src/pay/x402.ts";
import { sniffImage, spentToday, ImageService, ImageServiceError, USDG, USDG_DOMAIN } from "../src/media/images.ts";
import { avatarOf, avatarPrompt, avatarQueue, makeAvatars, remakeAvatars } from "../src/media/avatars.ts";
import { MARKETS, strategy } from "./helpers.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
/** The service's payment contract (any fixed address works against the stand-in). */
const PAY_TO = getAddress("0x00000000000000000000000000000000000c0fFE");
const PRICE = 735n; // 0.000735 USDG: a 512x512 image, as quoted on 2026-11-24
const TX = ("0x" + "ab".repeat(32)) as Hex;

type Mode = "slow" | "fast" | "reject" | "failed" | "not-image";

/**
 * A stand-in for the service's /outputs: answers 402 with a price, then accepts a payment only if it is
 * a valid EIP-3009 authorization (signature recovered, amounts, recipient, window, nonce once).
 */
function fakeService(o: { mode?: Mode; offer?: Partial<PaymentRequired["accepts"][number]>; version?: number; now: () => number } = { now: () => Math.floor(Date.now() / 1000) }) {
  const app = new Hono();
  const seen = { signatures: 0, nonces: new Set<string>(), polls: 0, lastPrompt: "" };
  const offer = { scheme: "exact", network: "eip155:4663", amount: PRICE.toString(), asset: USDG, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: "Global Dollar", version: "1" }, ...o.offer };
  const required: PaymentRequired = { x402Version: o.version ?? 2, resource: { url: "https://images.test/api/v1/outputs", description: "One output" }, accepts: [offer] };
  const outputs = new Map<string, { status: string; polls: number }>();

  app.post("/api/v1/outputs", async (c) => {
    const body = await c.req.json();
    seen.lastPrompt = body.prompt;
    const sig = c.req.header("payment-signature");
    if (!sig) return c.json({ error: { message: "pay" } }, 402, { "PAYMENT-REQUIRED": encodeB64Json(required) });
    seen.signatures++;
    const p = decodeB64Json<any>(sig);
    const a = p.payload.authorization;
    const ok =
      p.x402Version === 2 &&
      JSON.stringify(p.accepted) === JSON.stringify(offer) &&
      getAddress(a.to) === getAddress(offer.payTo) &&
      a.value === offer.amount &&
      BigInt(a.validAfter) <= BigInt(o.now()) &&
      BigInt(a.validBefore) > BigInt(o.now()) &&
      !seen.nonces.has(a.nonce) &&
      (await verifyTypedData({
        address: a.from,
        ...authorizationTypedData({ chainId: 4663, asset: USDG, domain: USDG_DOMAIN }, { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce }),
        signature: p.payload.signature,
      }));
    if (!ok || o.mode === "reject") return c.json({ error: { message: "payment invalid" } }, 402, { "PAYMENT-REQUIRED": encodeB64Json(required) });
    seen.nonces.add(a.nonce);
    const id = `out-${seen.nonces.size}`;
    const settled = { "PAYMENT-RESPONSE": encodeB64Json({ success: true, transaction: TX, network: "eip155:4663", payer: a.from }) };
    if (o.mode === "fast") return c.json({ output: { id, status: "ready", kind: "image", mimeType: "image/png", base64: Buffer.from(PNG).toString("base64") } }, 200, settled);
    outputs.set(id, { status: "making", polls: 0 });
    return c.json({ id, status: "making" }, 202, settled);
  });
  app.get("/api/v1/outputs/:id", (c) => {
    const out = outputs.get(c.req.param("id"));
    if (!out) return c.json({ error: { message: "Sign in with your wallet first" } }, 401);
    seen.polls++;
    out.polls++;
    if (out.polls >= 2) out.status = o.mode === "failed" ? "failed" : "ready";
    // The real shape: the status on the answer, the image in a nested "output" with no status.
    return c.json({ id: c.req.param("id"), status: out.status, kind: "image", output: { kind: "image", id: c.req.param("id"), mimeType: "image/png", base64: Buffer.from(PNG).toString("base64") } });
  });
  app.get("/api/v1/outputs/:id/file", (c) => {
    if (o.mode === "not-image") return c.text("<html>surprise</html>");
    return c.body(PNG, 200, { "content-type": "image/png" });
  });
  return { fetch: ((u: string, i?: RequestInit) => app.request(u, i)) as unknown as typeof fetch, seen };
}

const payer = privateKeyToAccount(generatePrivateKey());
const serviceFor = (db: ReturnType<typeof openDb>, f: ReturnType<typeof fakeService>, o: { daily?: bigint; perCall?: bigint; maxWaitMs?: number } = {}) =>
  new ImageService(db, { api: "https://images.test/api/v1", payTo: PAY_TO, account: payer, model: "image-model", maxPerCall: o.perCall ?? 10_000n, dailyBudget: o.daily ?? 250_000n, fetchImpl: f.fetch, sleep: async () => {}, pollEveryMs: 0, maxWaitMs: o.maxWaitMs });
const nowSec = () => Math.floor(Date.now() / 1000);
const req = { prompt: "an emblem", width: 512, height: 512, purpose: "avatar", agentId: null };

// ---------------------------------------------------------------------------- policy

test("x402: nothing is signed unless network, token, domain, recipient and price fit the policy", async () => {
  const policy: PayPolicy = { network: "eip155:4663", chainId: 4663, asset: USDG, domain: USDG_DOMAIN, payTo: PAY_TO, maxPerCall: 10_000n, remaining: () => 1_000_000n };
  const base = { scheme: "exact", network: "eip155:4663", amount: "735", asset: USDG, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: "Global Dollar", version: "1" } };
  const reqd = (o: object, v = 2): PaymentRequired => ({ x402Version: v, resource: { url: "x" }, accepts: [{ ...base, ...o }] });
  assert.deepEqual(choosePayment(reqd({}), policy), base);
  const refused: Array<[object, RegExp, number?]> = [
    [{ payTo: "0x000000000000000000000000000000000000dEaD" }, /recipient/],
    [{ asset: "0x0000000000000000000000000000000000000001" }, /token 0x/],
    [{ network: "eip155:1" }, /network/],
    [{ scheme: "upto" }, /scheme/],
    [{ extra: { name: "USD Coin", version: "2" } }, /token domain/],
    [{ extra: { name: "Global Dollar", version: "1", assetTransferMethod: "permit2" } }, /transfer method/],
    [{ amount: "10001" }, /per-call ceiling/],
    [{ amount: "0" }, /amount 0/],
    [{ amount: "1e9" }, /amount 1e9/],
    [{ amount: "-5" }, /amount -5/],
    [{ maxTimeoutSeconds: 0 }, /timeout/],
    [{}, /version/, 1],
  ];
  for (const [o, re, v] of refused) assert.throws(() => choosePayment(reqd(o, v), policy), (e: Error) => e instanceof PaymentRefused && re.test(e.message), JSON.stringify(o));
  assert.throws(() => choosePayment(reqd({}), { ...policy, remaining: () => 700n }), /budget/);
  assert.throws(() => choosePayment({ x402Version: 2, resource: { url: "x" }, accepts: [] }, policy), /no way to pay/);
  // With several offers, the first one that fits is used.
  assert.equal(choosePayment({ x402Version: 2, resource: { url: "x" }, accepts: [{ ...base, network: "eip155:1" }, base] }, policy), base);
});

test("Image service: a server asking for the wrong recipient gets no signature and no spend", async () => {
  const db = openDb(":memory:");
  const f = fakeService({ offer: { payTo: "0x000000000000000000000000000000000000dEaD" }, now: nowSec });
  await assert.rejects(serviceFor(db, f).makeImage(req, nowSec), PaymentRefused);
  assert.equal(f.seen.signatures, 0);
  assert.equal(spentToday(db, nowSec()), 0n);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payments").get()!.n, 0);
});

// ---------------------------------------------------------------------------- paying and fetching

test("Image service: pays once, polls a slow output, downloads the file, books the spend", async () => {
  const db = openDb(":memory:");
  const f = fakeService({ mode: "slow", now: nowSec });
  const r = await serviceFor(db, f).makeImage(req, nowSec);
  assert.deepEqual([...r.bytes], [...PNG]);
  assert.equal(r.mime, "image/png");
  assert.equal(r.tx, TX);
  assert.equal(r.amount, "735");
  assert.equal(f.seen.signatures, 1, "the stand-in accepted exactly one valid signature");
  assert.ok(f.seen.polls >= 2);
  const p = db.prepare("SELECT * FROM payments").get() as any;
  assert.deepEqual([p.status, p.amount, p.tx, p.output_id, getAddress(p.pay_to)], ["settled", "735", TX, "out-1", PAY_TO]);
  assert.equal(spentToday(db, nowSec()), 735n);
});

test("Image service: a fast output comes back in the same answer", async () => {
  const db = openDb(":memory:");
  const r = await serviceFor(db, fakeService({ mode: "fast", now: nowSec })).makeImage(req, nowSec);
  assert.deepEqual([...r.bytes], [...PNG]);
});

test("Image service: a payment the server rejects is not counted; a failed output is", async () => {
  const db = openDb(":memory:");
  await assert.rejects(serviceFor(db, fakeService({ mode: "reject", now: nowSec })).makeImage(req, nowSec), ImageServiceError);
  assert.equal((db.prepare("SELECT status FROM payments").get() as any).status, "rejected");
  assert.equal(spentToday(db, nowSec()), 0n);
  // The output failed after the payment settled: its credits went back to the wallet on ImageService, not here.
  await assert.rejects(serviceFor(db, fakeService({ mode: "failed", now: nowSec })).makeImage(req, nowSec), /could not make the output/);
  assert.equal(spentToday(db, nowSec()), 735n);
});

test("Image service: a file that is not an image is refused", async () => {
  const db = openDb(":memory:");
  await assert.rejects(serviceFor(db, fakeService({ mode: "not-image", now: nowSec })).makeImage(req, nowSec), /not a PNG, JPEG or WebP/);
  assert.equal(sniffImage(new TextEncoder().encode("GIF89a........")), null);
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))!.mime, "image/jpeg");
  assert.equal(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))!.mime, "image/webp");
});

test("Image service: an empty wallet stops before signing; avatars wait instead of using up attempts", async () => {
  const db = openDb(":memory:");
  const f = fakeService({ mode: "fast", now: nowSec });
  let balance = 0n;
  const t = new ImageService(db, { ...serviceFor(db, f).cfg, usdgBalance: async () => balance });
  await assert.rejects(t.makeImage(req, nowSec), /holds 0\.000000 USDG, less than the 0\.000735 asked/);
  assert.equal(f.seen.signatures, 0);
  const unreadable = new ImageService(db, { ...serviceFor(db, f).cfg, usdgBalance: async () => { throw new Error("rpc down"); } });
  await assert.rejects(unreadable.makeImage(req, nowSec), PaymentRefused);

  const a = createAgent(db, { name: "Waits", prompt: null, strategy: strategy(), policy: Policy.parse({}), owner: null }, 1);
  const opts = { dir: mkdtempSync(join(tmpdir(), "au-media-")), assetOf, agentOf: (id: string) => getAgent(db, id), epochSec: 3600, now: nowSec };
  for (let i = 0; i < 5; i++) assert.match((await makeAvatars(db, t, opts)).stopped ?? "", /holds 0/);
  assert.equal(avatarOf(db, a.id), null, "no attempt was used up");
  balance = 1_000_000n; // funded with 1 USDG
  assert.equal((await makeAvatars(db, t, opts)).made.length, 1);
  assert.equal(f.seen.signatures, 1);
});

test("Image service: the daily budget stops payments before anything is signed", async () => {
  const db = openDb(":memory:");
  const f = fakeService({ mode: "fast", now: nowSec });
  const t = serviceFor(db, f, { daily: 1500n }); // room for two images at 735
  await t.makeImage(req, nowSec);
  await t.makeImage(req, nowSec);
  await assert.rejects(t.makeImage(req, nowSec), /budget/);
  assert.equal(f.seen.signatures, 2);
  // A new UTC day starts a new budget.
  const tomorrow = () => nowSec() + 86400;
  assert.equal(spentToday(db, tomorrow()), 0n);
});

// ---------------------------------------------------------------------------- avatars

const assetOf = (s: string) => (s === "BTC" || s === "ETH" ? "crypto" : "equity") as "equity" | "crypto";

test("avatar prompt comes from the rules only, never from what a user typed", () => {
  const db = openDb(":memory:");
  const a = createAgent(db, { name: "Draw a famous logo and some text", prompt: "secret: draw a celebrity", strategy: strategy(), policy: Policy.parse({}), owner: null }, 1);
  const p = avatarPrompt(a, assetOf);
  assert.ok(!/logo and|celebrity|secret|Draw a famous/i.test(p.replace("no logos", "")), p);
  assert.match(p, /skyline of glass towers/);
  assert.match(p, /ascending/);
  assert.match(p, /No text/);
  assert.equal(avatarPrompt(a, assetOf), p, "deterministic");
  const short = { ...a, strategy: strategy({ side: "short", symbols: ["BTC", "ETH"] }) };
  assert.match(avatarPrompt(short, assetOf), /hexagons.*descending/);
  assert.match(avatarPrompt({ ...a, strategy: strategy({ symbols: ["BTC", "NVDA"] }) }, assetOf), /orbiting rings/);
});

test("avatars: made, stored, sealed with their payment, served, and used as the ERC-8004 image", async () => {
  const db = openDb(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "au-media-"));
  const a = createAgent(db, { name: "Avatar Agent", prompt: null, strategy: strategy(), policy: Policy.parse({}), owner: null }, 1);
  const b = createAgent(db, { name: "Second", prompt: null, strategy: strategy(), policy: Policy.parse({}), owner: null }, 2);
  const f = fakeService({ mode: "slow", now: nowSec });
  const opts = { dir, assetOf, agentOf: (id: string) => getAgent(db, id), epochSec: 3600, now: nowSec };

  const r1 = await makeAvatars(db, serviceFor(db, f), opts);
  assert.deepEqual(r1.made.map((m) => m.agentId), [a.id], "one per round, oldest agent first");
  const m = avatarOf(db, a.id)!;
  assert.equal(m.status, "ready");
  const onDisk = readFileSync(join(dir, m.file!));
  assert.deepEqual([...onDisk], [...PNG]);
  assert.equal(m.sha256, createHash("sha256").update(onDisk).digest("hex"));
  assert.equal(f.seen.lastPrompt, avatarPrompt(a, assetOf));
  const rec = JSON.parse((db.prepare("SELECT record_json FROM receipts WHERE agent_id = ? AND kind = 'media'").get(a.id) as any).record_json);
  assert.equal(rec.sha256, m.sha256);
  assert.deepEqual(rec.payment, { protocol: "x402", network: "eip155:4663", asset: "USDG", amount: "0.000735", tx: TX, payer: payer.address });

  await makeAvatars(db, serviceFor(db, f), opts);
  assert.equal(avatarOf(db, b.id)!.status, "ready");
  assert.deepEqual(avatarQueue(db, nowSec(), 10), [], "nothing left to make");

  // Served by the API, and used as the image of the registration file.
  const app = buildApi({
    db, config: loadConfig({ APP_DOMAIN: "agent.test" }), markets: MARKETS, lastTick: () => null, chain: {} as PublicClient,
    token: { reader: new TokenReader({} as PublicClient, null, 0), cfg: { address: null, tiers: DEFAULT_TIERS, burnTokensPerSlot: 1, burnSlotDays: 1 } },
    identity: { registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", publicUrl: "https://agent.test", legacyUrls: [], houseOwner: null, receiptRegistry: null, brand: "Hyalis", epochSec: 3600 },
    mediaDir: dir,
  });
  const img = await app.request(`/v1/agents/${a.id}/avatar`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal(img.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual([...new Uint8Array(await img.arrayBuffer())], [...PNG]);
  assert.equal(((await (await app.request(`/v1/agents/${a.id}`)).json()) as any).agent.avatar, `/v1/agents/${a.id}/avatar`);
  assert.equal(((await (await app.request(`/v1/agents/${a.id}/registration.json`)).json()) as any).image, `https://agent.test/v1/agents/${a.id}/avatar`);
  assert.equal((await app.request(`/v1/agents/nope/avatar`)).status, 404);
  assert.equal((await app.request(`/v1/agents/..%2F..%2Fetc%2Fpasswd/avatar`)).status, 404);
});

test("avatars: failures retry three times an hour apart; a budget stop is not an attempt", async () => {
  const db = openDb(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "au-media-"));
  const a = createAgent(db, { name: "Unlucky", prompt: null, strategy: strategy(), policy: Policy.parse({}), owner: null }, 1);
  let clock = 1_900_000_000;
  const opts = { dir, assetOf, agentOf: (id: string) => getAgent(db, id), epochSec: 3600, now: () => clock };
  const failing = fakeService({ mode: "failed", now: () => clock });

  // Over budget: stopped before signing, no attempt counted.
  const broke = await makeAvatars(db, serviceFor(db, failing, { daily: 100n }), opts);
  assert.match(broke.stopped ?? "", /budget/);
  assert.equal(avatarOf(db, a.id), null);

  for (let i = 1; i <= 3; i++) {
    const r = await makeAvatars(db, serviceFor(db, failing), opts);
    assert.equal(r.failed.length, 1, `attempt ${i}`);
    assert.equal(avatarOf(db, a.id)!.attempts, i);
    assert.equal((await makeAvatars(db, serviceFor(db, failing), opts)).failed.length, 0, "not retried within the hour");
    clock += 3601;
  }
  assert.deepEqual(avatarQueue(db, clock + 86400, 10), [], "given up after three attempts");
  assert.equal(avatarOf(db, a.id)!.status, "failed");
});

test("avatars: an image paid for but not stored in time is collected later without paying again", async () => {
  const db = openDb(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "au-media-"));
  const a = createAgent(db, { name: "Slow One", prompt: null, strategy: strategy(), policy: Policy.parse({}), owner: null }, 1);
  const f = fakeService({ mode: "slow", now: nowSec });
  let clock = nowSec();
  const opts = { dir, assetOf, agentOf: (id: string) => getAgent(db, id), epochSec: 3600, now: () => clock };

  // The output is not ready before the wait runs out: the payment has settled, no avatar yet.
  const first = await makeAvatars(db, serviceFor(db, f, { maxWaitMs: -1 }), opts);
  assert.equal(first.failed.length, 1);
  assert.match(first.failed[0]!.error, /not ready in time/);
  assert.equal(f.seen.signatures, 1);
  assert.equal((db.prepare("SELECT status FROM payments").get() as { status: string }).status, "settled");

  // The next attempt collects that same output: no new signature, no new payment.
  clock += 3601;
  const second = await makeAvatars(db, serviceFor(db, f), opts);
  assert.deepEqual(second.made.map((m) => m.agentId), [a.id]);
  assert.equal(f.seen.signatures, 1, "paid once");
  assert.equal((db.prepare("SELECT count(*) AS n FROM payments").get() as { n: number }).n, 1);
  const m = avatarOf(db, a.id)!;
  assert.equal(m.status, "ready");
  assert.equal(m.payment_id, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM receipts WHERE kind = 'media'").get() as { n: number }).n, 1, "sealed once, with the original payment");
  const paidPrompt = (db.prepare("SELECT prompt FROM payments").get() as { prompt: string }).prompt;
  assert.equal(paidPrompt, avatarPrompt(a, assetOf), "the prompt is kept with the payment");
  const sealed = JSON.parse((db.prepare("SELECT record_json FROM receipts WHERE kind = 'media'").get() as { record_json: string }).record_json);
  assert.equal(sealed.prompt, paidPrompt, "the receipt records the prompt the image was made from");
});

test("avatars: a remade avatar is bought afresh, never taken from the image it replaces", async () => {
  const db = openDb(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "au-media-"));
  const a = createAgent(db, { name: "Restyled", prompt: null, strategy: strategy(), policy: Policy.parse({}), owner: null }, 1);
  const f = fakeService({ mode: "slow", now: nowSec });
  const opts = { dir, assetOf, agentOf: (id: string) => getAgent(db, id), epochSec: 3600, now: nowSec };

  assert.equal((await makeAvatars(db, serviceFor(db, f), opts)).made.length, 1);
  assert.equal(f.seen.signatures, 1);
  assert.deepEqual(remakeAvatars(db, [a.id, "not-an-agent"]), [a.id], "only agents with a ready avatar are marked");
  assert.deepEqual(avatarQueue(db, nowSec(), 10), [a.id]);

  const again = await makeAvatars(db, serviceFor(db, f), opts);
  assert.equal(again.made.length, 1);
  assert.equal(f.seen.signatures, 2, "a new image was paid for");
  const m = avatarOf(db, a.id)!;
  assert.equal(m.status, "ready");
  assert.equal(m.payment_id, 2);
  assert.equal((db.prepare("SELECT count(*) AS n FROM receipts WHERE kind = 'media'").get() as { n: number }).n, 2, "the old receipt stays, the new one is added");
});
