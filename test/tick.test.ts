import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { openDb } from "../src/store/db.ts";
import { runTick } from "../src/engine/tick.ts";
import { createAgent, getAccount } from "../src/engine/agents.ts";
import { receiptWithProof } from "../src/engine/epochs.ts";
import { leafOf, verifyLeaf } from "../src/receipts/merkle.ts";
import { Policy } from "../src/guard/policy.ts";
import type { Market } from "../src/config.ts";
import type { Strategy } from "../src/strategy/schema.ts";

/**
 * A fake chain: one feed whose rounds are given as [updatedAt, price]. Round ids use phase 1,
 * like real Chainlink proxies, so the backfill walk is exercised.
 */
function fakeChain(feeds: Record<string, Array<[number, number]>>, latestAt: () => number): PublicClient {
  const PH = 1n << 64n;
  const visible = (addr: string) => feeds[addr.toLowerCase()]!.filter(([t]) => t <= latestAt());
  const asRound = (i: number, [t, p]: [number, number]) => [PH + BigInt(i + 1), BigInt(Math.round(p * 1e8)), BigInt(t), BigInt(t), PH + BigInt(i + 1)] as const;
  return {
    async multicall({ contracts }: any) {
      return contracts.map((c: any) => {
        const rs = visible(c.address);
        if (c.functionName === "latestRoundData") return { status: "success", result: asRound(rs.length - 1, rs.at(-1)!) };
        const idx = Number(c.args[0] - PH) - 1;
        return idx >= 0 && idx < rs.length ? { status: "success", result: asRound(idx, rs[idx]!) } : { status: "failure", error: new Error("no round") };
      });
    },
  } as unknown as PublicClient;
}

test("a tick ingests history, trades through gate and policy, and seals receipts", async () => {
  const H = 3600;
  const t0 = 1_800_000_000 - (1_800_000_000 % H);
  const feed = "0x00000000000000000000000000000000000000aa";
  // 30 hours flat at 100, then a drop to 93.
  const rounds: Array<[number, number]> = [];
  for (let h = 0; h < 30; h++) rounds.push([t0 + h * H + 60, 100]);
  rounds.push([t0 + 30 * H + 60, 93]);
  let now = t0 + 30 * H + 120;
  const chain = fakeChain({ [feed]: rounds }, () => now);
  const markets: Market[] = [{ symbol: "NVDA", assetClass: "equity", source: "chainlink", feed, decimals: 8, heartbeatSec: 86400, deviationPct: 0.5 }];
  const db = openDb(":memory:");

  const strategy: Strategy = {
    name: "dip",
    summary: "buy a 5% daily drop",
    symbols: ["NVDA"],
    side: "long",
    entry: [{ type: "change_pct", description: "down 5% in 24h", lookbackHours: 24, op: "lt", value: -5 }],
    exitConditions: [],
    stopLossPct: 8,
    takeProfitPct: 5,
    maxHoldHours: 0,
    positionPct: 10,
    maxOpenPositions: 1,
    leverage: 1,
    notes: [],
  };
  const agent = createAgent(db, { name: "dip", prompt: null, strategy, policy: Policy.parse({}) }, now - 10);
  const alwaysOpen = { market: () => ({ open: true, session: "regular" as const, reason: null }), hourOpen: () => true };
  const ctx = { db, chain, markets, plankton: null, epochSec: H, ...alwaysOpen };

  const s1 = await runTick(ctx, now);
  assert.equal(s1.roundsAdded, 31);
  assert.equal(s1.fills, 1);
  const acct = getAccount(db, agent.id);
  assert.equal(acct.account.positions.length, 1);
  assert.equal(acct.account.positions[0]!.entryPrice, 93);

  // Next hour the price recovers past take profit; the earlier epoch gets sealed.
  rounds.push([t0 + 31 * H + 60, 98]);
  now = t0 + 31 * H + 120;
  const s2 = await runTick(ctx, now);
  assert.equal(s2.fills, 1);
  assert.deepEqual(s2.sealedEpochs, [Math.floor((t0 + 30 * H) / H)]);
  assert.ok(getAccount(db, agent.id).equity > 10_000);

  // The opening decision is provable: leaf = hash(record), and it sits under the sealed root.
  const row = db.prepare("SELECT id FROM receipts WHERE kind = 'decision' ORDER BY id LIMIT 1").get() as { id: number };
  const r = receiptWithProof(db, row.id)!;
  assert.equal(r.sealed, true);
  assert.equal(leafOf(r.record), r.leaf);
  assert.ok(verifyLeaf(r.root!, r.leaf, r.proof));
  assert.equal((r.record as any).input.roundId, ((1n << 64n) + 31n).toString());
  assert.equal((r.record as any).outcome, "filled");

  // Editing the record breaks the proof.
  const forged = { ...r.record, outcome: "blocked" };
  assert.equal(verifyLeaf(r.root!, leafOf(forged), r.proof), false);
});
