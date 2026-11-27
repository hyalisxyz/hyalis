/**
 * Social mood: the reader against a stand-in for the service, the daily budget, sealing, the
 * rule in the evaluator and the backtest (never a reading from the future), and who may use it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMessage, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { openDb } from "../src/store/db.ts";
import { createAgent } from "../src/engine/agents.ts";
import { Policy } from "../src/guard/policy.ts";
import { buildApi } from "../src/api/server.ts";
import { DEFAULT_TIERS, TokenReader, type TokenConfig } from "../src/token/token.ts";
import { loadConfig } from "../src/config.ts";
import { checkBounds, usesSocial, type Condition } from "../src/strategy/schema.ts";
import { decide, evalCondition, type MoodReading } from "../src/strategy/evaluate.ts";
import { receiptWithProof } from "../src/engine/epochs.ts";
import { MOOD_MAX_AGE_SEC, moodAsOf, moodDue, moodSpentToday, moodWanted, SocialReader, SOCIAL_STREAM } from "../src/signals/social.ts";
import { H, MARKETS, strategy } from "./helpers.ts";

const T0 = 1_790_000_000;
const MOOD: Condition = { type: "social_mood", description: "crowd is upbeat", op: "gt", value: 0.3 };

/** A stand-in for the Responses API with live search: answers in the real shape, with its cost. */
function fakeReader(o: { score?: number; posts?: number; text?: string; status?: number; ticks?: number } = {}) {
  const seen = { calls: 0, auth: "", bodies: [] as any[] };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.calls++;
    seen.auth = String((init.headers as Record<string, string>).authorization);
    seen.bodies.push(JSON.parse(String(init.body)));
    assert.match(url, /\/responses$/);
    if (o.status && o.status >= 400) return new Response(JSON.stringify({ error: "vendor-specific text" }), { status: o.status });
    const text = o.text ?? "```json\n" + JSON.stringify({ score: o.score ?? 0.42, posts: o.posts ?? 12, summary: "Upbeat on the new chip,\n  some profit-taking." }) + "\n```";
    return new Response(
      JSON.stringify({
        output: [
          { type: "custom_tool_call", name: "x_search" },
          { type: "message", content: [{ type: "output_text", text, annotations: [{ type: "url_citation", url: "https://x.com/a/status/1" }, { type: "url_citation", url: "https://evil.example/x" }] }] },
        ],
        citations: ["https://x.com/b/status/2", "https://x.com/a/status/1"],
        usage: { cost_in_usd_ticks: o.ticks ?? 958_820_000, server_side_tool_usage_details: { x_posts_fetched: 15 } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const reader = (db: ReturnType<typeof openDb>, f: typeof fetch, over: Partial<ConstructorParameters<typeof SocialReader>[1]> = {}) =>
  new SocialReader(db, { api: "https://reader.test/v1/", apiKey: "k".repeat(32), model: "model-x", dailyUsd: 2, refreshSec: 6 * H, perRound: 2, epochSec: 3600, assetOf: () => "equity", fetchImpl: f, ...over });

const moodAgent = (db: ReturnType<typeof openDb>, symbols = ["NVDA"]) =>
  createAgent(db, { name: "mood", prompt: null, strategy: strategy({ symbols, entry: [MOOD] }), policy: Policy.parse({}), owner: null, basedOn: null }, T0 - H);

test("social_mood: bounds, and which strategies use it", () => {
  assert.equal(usesSocial(strategy()), false);
  assert.equal(usesSocial(strategy({ exitConditions: [MOOD] })), true);
  assert.deepEqual(checkBounds(strategy({ entry: [MOOD] }), new Set(["NVDA"])), []);
  assert.match(checkBounds(strategy({ entry: [{ ...MOOD, value: 3 }] }), new Set(["NVDA"]))[0]!, /social_mood value/);
});

test("social_mood rule: passes on a fresh reading, never without one or on too few posts", () => {
  const r: MoodReading = { id: 7, leaf: "0xabc", score: 0.5, posts: 12, at: T0 };
  assert.equal(evalCondition(MOOD, [], null).pass, false);
  const ok = evalCondition(MOOD, [], r);
  assert.equal(ok.pass, true);
  assert.equal(ok.value, 0.5);
  assert.deepEqual(ok.reading, { id: 7, leaf: "0xabc", at: T0 });
  assert.equal(evalCondition(MOOD, [], { ...r, score: 0.1 }).pass, false);
  assert.equal(evalCondition(MOOD, [], { ...r, posts: 2 }).pass, false);
  assert.equal(evalCondition({ ...MOOD, op: "lt", value: -0.3 }, [], { ...r, score: -0.6 }).pass, true);

  // decide() opens on it and the decision names the reading; without readings it does nothing.
  const s = strategy({ entry: [MOOD] });
  const closes = new Map([["NVDA", [{ t: T0, price: 100, roundId: "1" }]]]);
  assert.equal(decide(s, closes as any, [], T0).length, 0);
  const sig = decide(s, closes as any, [], T0, new Set(), (sym) => (sym === "NVDA" ? r : null));
  assert.equal(sig.length, 1);
  assert.equal(sig[0]!.checks[0]!.reading?.id, 7);
});

test("reader: reads, cleans and seals a reading; shared, refreshed on time; never a future one", async () => {
  const db = openDb(":memory:");
  moodAgent(db, ["NVDA", "AAPL"]);
  createAgent(db, { name: "plain", prompt: null, strategy: strategy({ symbols: ["TSLA"] }), policy: Policy.parse({}), owner: null, basedOn: null }, T0 - H);
  assert.deepEqual(moodWanted(db), ["AAPL", "NVDA"]); // only symbols of agents with a mood rule

  const { seen, fetchImpl } = fakeReader();
  let now = T0;
  const r = await reader(db, fetchImpl).refresh(() => now);
  assert.deepEqual(r.read.map((x) => x.symbol), ["AAPL", "NVDA"]);
  assert.equal(seen.calls, 2);
  assert.equal(seen.auth, `Bearer ${"k".repeat(32)}`);
  const body = seen.bodies[0];
  assert.equal(body.model, "model-x");
  assert.equal(body.tools[0].type, "x_search");
  assert.equal(body.tools[0].from_date, new Date((T0 - 24 * H) * 1000).toISOString().slice(0, 10));
  assert.match(body.input[1].content, /\$AAPL/);

  const m = moodAsOf(db, "NVDA", now)!;
  assert.equal(m.score, 0.42);
  assert.equal(m.posts, 12); // what the model said, within what was fetched (15)
  // Cost from the service's own figure: 958,820,000 ticks = $0.095882 per reading.
  assert.ok(Math.abs(moodSpentToday(db, now) - 2 * 0.095882) < 1e-9);

  // Sealed before use, under the signal stream; only links to posts on X are kept.
  const proof = receiptWithProof(db, Number((db.prepare("SELECT id FROM receipts WHERE leaf = ?").get(m.leaf) as any).id))!;
  assert.equal(proof.record.kind, "signal");
  assert.equal(proof.record.agentId, SOCIAL_STREAM);
  assert.equal(proof.record.symbol, "NVDA");
  assert.equal(proof.record.summary, "Upbeat on the new chip, some profit-taking.");
  assert.deepEqual(proof.record.sources, ["https://x.com/b/status/2", "https://x.com/a/status/1"]);
  assert.equal(JSON.stringify(proof.record).includes("model-x"), false); // the model is not on the receipt

  // Not read again within the refresh period; due again after it.
  now += 5 * H;
  assert.deepEqual(moodDue(db, moodWanted(db), now, 6 * H), []);
  now += 2 * H;
  assert.deepEqual(moodDue(db, moodWanted(db), now, 6 * H), ["AAPL", "NVDA"]);

  // As of a time: none before the first reading (a backtest never sees its future), none once too old.
  assert.equal(moodAsOf(db, "NVDA", T0 - 1), null);
  assert.equal(moodAsOf(db, "NVDA", T0 + MOOD_MAX_AGE_SEC)?.id, m.id);
  assert.equal(moodAsOf(db, "NVDA", T0 + MOOD_MAX_AGE_SEC + 1), null);
});

test("reader: the daily budget stops it before any call; a failure is recorded and retried after an hour", async () => {
  const db = openDb(":memory:");
  moodAgent(db, ["NVDA"]);

  // $0.30 a day leaves no room for the reserve kept before each call.
  const tight = fakeReader();
  const r0 = await reader(db, tight.fetchImpl, { dailyUsd: 0.3 }).refresh(() => T0);
  assert.equal(tight.seen.calls, 0);
  assert.match(r0.stopped!, /daily budget/);

  // The service fails: nothing sealed, the cost it reported still counts, and the error text
  // (which may name the vendor) is not kept.
  const bad = fakeReader({ status: 500, ticks: 0 });
  const r1 = await reader(db, bad.fetchImpl).refresh(() => T0);
  assert.equal(r1.failed[0]!.error, "the social reader answered 500");
  assert.equal(moodAsOf(db, "NVDA", T0), null);
  assert.deepEqual(moodDue(db, ["NVDA"], T0 + 30 * 60, 6 * H), []);
  assert.deepEqual(moodDue(db, ["NVDA"], T0 + H, 6 * H), ["NVDA"]);

  // An answer that is not the JSON asked for is a failure, and a score out of range is clamped.
  const junk = fakeReader({ text: "I think it's bullish!" });
  assert.match((await reader(db, junk.fetchImpl).refresh(() => T0 + H)).failed[0]!.error, /not the expected JSON/);
  const loud = fakeReader({ score: 9, posts: 400 });
  await reader(db, loud.fetchImpl).refresh(() => T0 + 3 * H);
  const m = moodAsOf(db, "NVDA", T0 + 3 * H)!;
  assert.equal(m.score, 1);
  assert.equal(m.posts, 15); // capped at the posts actually fetched

  // Spending stops at the cap across rounds: each reading costs ~$0.096 here.
  const db2 = openDb(":memory:");
  moodAgent(db2, ["A", "B", "C", "D", "E", "F"]);
  const many = fakeReader();
  const rd = reader(db2, many.fetchImpl, { dailyUsd: 0.7, perRound: 10 });
  const r2 = await rd.refresh(() => T0);
  assert.equal(r2.read.length, 4); // 3 x 0.096 = 0.288 + 0.40 reserve fits; after 4 (0.384) it does not
  assert.match(r2.stopped!, /daily budget/);
  assert.ok(moodSpentToday(db2, T0) <= 0.7);
});

test("API: mood rules only with the reader on, and for users only on tiers that include them", async () => {
  const user = privateKeyToAccount(generatePrivateKey());
  const chain = { verifyMessage: (a: any) => verifyMessage(a) } as unknown as PublicClient;
  const tokenCfg: TokenConfig = { address: null, tiers: DEFAULT_TIERS, burnTokensPerSlot: 500_000, burnSlotDays: 30 };
  const config = loadConfig({ ADMIN_TOKEN: "admin", APP_DOMAIN: "agent.test" });
  const s = strategy({ entry: [MOOD] });
  const mk = (socialOn: boolean) => {
    const db = openDb(":memory:");
    const app = buildApi({ db, config, markets: MARKETS, lastTick: () => null, chain, token: { reader: new TokenReader(chain, null, 0), cfg: tokenCfg }, adminToken: "admin", rateLimitPerMinute: 10_000, socialOn });
    const call = async (method: string, path: string, body?: unknown, auth?: string) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: (await res.json()) as any };
    };
    return { db, call };
  };

  // Reader off: nobody, not even the operator.
  const off = mk(false);
  const r0 = await off.call("POST", "/v1/agents", { strategy: s }, "admin");
  assert.equal(r0.status, 403);
  assert.match(r0.body.error, /not available/);

  // Reader on: house agents may; a Free wallet may not and is told which tier it needs.
  const on = mk(true);
  assert.equal((await on.call("POST", "/v1/agents", { strategy: s }, "admin")).status, 201);
  const n = await on.call("POST", "/v1/auth/nonce", { address: user.address });
  const v = await on.call("POST", "/v1/auth/verify", { address: user.address, nonce: n.body.nonce, signature: await user.signMessage({ message: n.body.message }) });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const r1 = await on.call("POST", "/v1/agents", { strategy: s, dryRun: true }, v.body.token);
  assert.equal(r1.status, 403);
  assert.match(r1.body.error, /Holder tier/);
  assert.equal(r1.body.tier, "Free");
  // Plain rules still work for them.
  assert.equal((await on.call("POST", "/v1/agents", { strategy: strategy(), dryRun: true }, v.body.token)).status, 200);

  // The public board lists sealed readings, without cost or model.
  const board = await on.call("GET", "/v1/signals/social");
  assert.deepEqual(board.body, { on: true, readings: [] });
});
