import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIERS, parseTiers, tierFor } from "../src/token/token.ts";
import { openDb } from "../src/store/db.ts";
import { createAgent } from "../src/engine/agents.ts";
import { enforceSlots } from "../src/token/quota.ts";
import { Policy } from "../src/guard/policy.ts";
import { strategy } from "./helpers.ts";

test("tiers follow the token amount, with what is needed for the next one", () => {
  assert.equal(tierFor(0, DEFAULT_TIERS).tier.name, "Free");
  assert.equal(tierFor(999_999.99, DEFAULT_TIERS).tier.name, "Free");
  assert.equal(tierFor(999_999.99, DEFAULT_TIERS).next!.needed, 0.010000000009313226); // float, shown rounded by the UI
  assert.equal(tierFor(1_000_000, DEFAULT_TIERS).tier.name, "Holder");
  assert.equal(tierFor(1_000_000, DEFAULT_TIERS).next!.needed, 4_000_000);
  assert.equal(tierFor(50_000_000, DEFAULT_TIERS).tier.name, "Whale");
  assert.equal(tierFor(50_000_000, DEFAULT_TIERS).next, null);
});

test("tier config is validated", () => {
  assert.deepEqual(parseTiers(undefined), DEFAULT_TIERS);
  assert.throws(() => parseTiers('[{"name":"A","minTokens":5,"agents":1,"compilesPerDay":1}]'), /start at 0/);
  assert.throws(() => parseTiers('[{"name":"A","minTokens":0,"agents":1,"compilesPerDay":1},{"name":"B","minTokens":0,"agents":2,"compilesPerDay":1}]'), /increasing/);
  assert.equal(parseTiers('[{"name":"Only","minTokens":0,"agents":2,"compilesPerDay":3}]')[0]!.agents, 2);
});

test("a wallet whose slots cannot be read is left alone (an RPC outage pauses no one)", async () => {
  const db = openDb(":memory:");
  const owner = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  for (let i = 0; i < 3; i++) createAgent(db, { name: `a${i}`, prompt: null, strategy: strategy(), policy: Policy.parse({}), owner }, 1000);
  const q = await enforceSlots(db, async () => {
    throw new Error("rpc down");
  });
  assert.deepEqual(q.skipped, [owner]);
  assert.equal(q.paused.length, 0);
});

test("house agents (no owner) are never paused by quotas", async () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 3; i++) createAgent(db, { name: `h${i}`, prompt: null, strategy: strategy(), policy: Policy.parse({}) }, 1000);
  const q = await enforceSlots(db, async () => 0);
  assert.equal(q.paused.length, 0);
});
