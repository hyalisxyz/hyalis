import type { DatabaseSync } from "node:sqlite";
import { errLine } from "../util/redact.ts";
import type { PublicClient } from "viem";
import type { Market } from "../config.ts";
import { AGGREGATOR_ABI, readLatestRounds, roundPrice, type FeedRound } from "../sources/chainlink.ts";
import type { RoundPoint } from "../strategy/series.ts";
import { tx } from "../store/db.ts";

const PHASE_SHIFT = 64n;
const BATCH = 60;

function insertRound(db: DatabaseSync, r: FeedRound) {
  db.prepare(
    "INSERT OR IGNORE INTO rounds (feed, round_id, symbol, answer, decimals, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(r.feed, r.roundId, r.symbol, r.answer, r.decimals, r.updatedAt);
}

function hasRound(db: DatabaseSync, feed: string, roundId: string) {
  return db.prepare("SELECT 1 FROM rounds WHERE feed = ? AND round_id = ?").get(feed, roundId) !== undefined;
}

/**
 * Walks back from `fromId` (exclusive) through earlier rounds of one feed until it reaches a
 * stored round, a round older than `cutoff`, the start of the phase, or `limit` rounds.
 * Returns the rounds found, newest first. Nothing is written here.
 */
async function walkBack(db: DatabaseSync, client: PublicClient, m: Market, fromId: bigint, cutoff: number, limit: number): Promise<FeedRound[]> {
  const phase = fromId >> PHASE_SHIFT;
  let agg = fromId & ((1n << PHASE_SHIFT) - 1n);
  const found: FeedRound[] = [];
  while (agg > 1n && found.length < limit) {
    const ids: bigint[] = [];
    for (let k = 1n; k <= BigInt(BATCH) && agg - k >= 1n; k++) ids.push((phase << PHASE_SHIFT) | (agg - k));
    const res = await client.multicall({
      allowFailure: true,
      contracts: ids.map((rid) => ({ address: m.feed as `0x${string}`, abi: AGGREGATOR_ABI, functionName: "getRoundData" as const, args: [rid] as const })),
    });
    for (const r of res) {
      if (r.status !== "success") return found;
      const [rid, answer, , updatedAt] = r.result;
      if (updatedAt === 0n || Number(updatedAt) < cutoff) return found;
      if (hasRound(db, m.feed, rid.toString())) return found;
      found.push({ symbol: m.symbol, feed: m.feed, roundId: rid.toString(), answer: answer.toString(), decimals: m.decimals, updatedAt: Number(updatedAt) });
    }
    agg -= BigInt(ids.length);
  }
  return found;
}

function insertAll(db: DatabaseSync, rounds: FeedRound[]): number {
  if (rounds.length === 0) return 0;
  return tx(db, () => {
    for (const r of rounds) insertRound(db, r);
    return rounds.length;
  });
}

/**
 * Stores the latest round of every market and fills history back to `backfillSec`.
 *
 * Stored history per feed is always one unbroken run of rounds:
 *  - new rounds since the last run are fetched down to the newest stored round and written
 *    together with the latest round in one transaction, so a crash leaves no hole;
 *  - older history is extended from the oldest stored round downwards, in steps.
 * Rounds on these feeds change on a 0.5% move or the daily heartbeat.
 */
export async function syncRounds(
  db: DatabaseSync,
  client: PublicClient,
  markets: Market[],
  now: number,
  backfillSec = 10 * 86400,
  maxRoundsPerStep = 400,
  concurrency = 6,
): Promise<{ latest: Map<string, FeedRound>; added: number; failed: string[] }> {
  markets = markets.filter((m) => m.source === "chainlink");
  const latest = new Map<string, FeedRound>();
  for (const r of await readLatestRounds(client, markets)) latest.set(r.symbol, r);
  const cutoff = now - backfillSec;
  let added = 0;
  const failed: string[] = [];

  const syncOne = async (m: Market) => {
    const top = latest.get(m.symbol);
    if (!top) {
      failed.push(m.symbol);
      return;
    }
    if (!hasRound(db, m.feed, top.roundId)) {
      // No count limit here: the gap is bounded by the cutoff, and a partial write would
      // leave a hole between the new rounds and the stored ones.
      const gap = await walkBack(db, client, m, BigInt(top.roundId), cutoff, Number.MAX_SAFE_INTEGER);
      added += insertAll(db, [top, ...gap]);
    }
    const oldest = db.prepare("SELECT round_id, updated_at FROM rounds WHERE feed = ? ORDER BY updated_at ASC LIMIT 1").get(m.feed) as
      | { round_id: string; updated_at: number }
      | undefined;
    if (oldest && oldest.updated_at > cutoff) {
      added += insertAll(db, await walkBack(db, client, m, BigInt(oldest.round_id), cutoff, maxRoundsPerStep));
    }
  };

  const queue = [...markets];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        try {
          await syncOne(m);
        } catch (e) {
          failed.push(m.symbol);
          console.warn(`[ingest] ${m.symbol}: ${errLine(e)}`);
        }
      }
    }),
  );
  return { latest, added, failed };
}

/** Scale used to store data-feed prices as integers, like Chainlink answers. */
const DATA_FEED_DECIMALS = 8;

const toRound = (m: Market, updatedAt: number, usd: number): FeedRound => ({
  symbol: m.symbol,
  feed: m.feed,
  // The update time doubles as the round id: one stored price per CoinGecko update.
  roundId: String(updatedAt),
  answer: BigInt(Math.round(usd * 10 ** DATA_FEED_DECIMALS)).toString(),
  decimals: DATA_FEED_DECIMALS,
  updatedAt,
});

export interface DataFeedSync {
  /** Latest stored price of each data-feed market. */
  latest: Map<string, FeedRound>;
  /** CoinGecko price of every market with a coingeckoId, used as a second source for Chainlink crypto. */
  quotes: Map<string, { usd: number; updatedAt: number }>;
  added: number;
  backfilled: string[];
  error: string | null;
}

/**
 * Prices for data-feed markets (CoinGecko). One batched request per tick for all latest prices;
 * history is backfilled a few coins per tick, because the free API allows only a few calls a
 * minute. Data-feed prices are stored in the same table as Chainlink rounds so indicators and
 * backtests treat them the same way; their feed id starts with "coingecko:".
 */
export async function syncDataFeeds(
  db: DatabaseSync,
  cg: { prices(ids: string[]): Promise<Map<string, { usd: number; updatedAt: number }>>; hourly(id: string, days: number): Promise<Array<[number, number]>> },
  markets: Market[],
  now: number,
  backfillSec = 30 * 86400,
  maxBackfillsPerTick = 2,
): Promise<DataFeedSync> {
  const out: DataFeedSync = { latest: new Map(), quotes: new Map(), added: 0, backfilled: [], error: null };
  const withId = markets.filter((m) => m.coingeckoId);
  if (withId.length === 0) return out;

  try {
    const prices = await cg.prices([...new Set(withId.map((m) => m.coingeckoId!))]);
    for (const m of withId) {
      const p = prices.get(m.coingeckoId!);
      if (!p) continue;
      out.quotes.set(m.symbol, p);
      if (m.source !== "coingecko") continue;
      const r = toRound(m, p.updatedAt, p.usd);
      if (!hasRound(db, r.feed, r.roundId)) {
        insertRound(db, r);
        out.added++;
      }
    }
  } catch (e) {
    out.error = (e as Error).message;
  }

  // Backfill the data-feed markets whose stored history is shortest, a few per tick.
  const dataFeeds = withId.filter((m) => m.source === "coingecko");
  const cutoff = now - backfillSec;
  const needs = dataFeeds
    .map((m) => ({ m, oldest: (db.prepare("SELECT MIN(updated_at) AS t FROM rounds WHERE feed = ?").get(m.feed) as { t: number | null }).t }))
    // History counts as complete when it reaches within two hours of the cutoff. A coin younger
    // than the window never gets there, so a feed backfilled in the last day is not asked again.
    .filter((x) => x.oldest === null || x.oldest > cutoff + 2 * 3600)
    .filter((x) => {
      const meta = db.prepare("SELECT backfilled_at FROM feed_meta WHERE feed = ?").get(x.m.feed) as { backfilled_at: number | null } | undefined;
      return !meta?.backfilled_at || now - meta.backfilled_at > 86400;
    })
    .sort((a, b) => (a.oldest ?? 0) - (b.oldest ?? 0))
    .slice(0, out.error ? 0 : maxBackfillsPerTick);
  for (const { m } of needs) {
    try {
      const points = await cg.hourly(m.coingeckoId!, backfillSec / 86400);
      const rows = points.filter(([t]) => t >= cutoff && t <= now).map(([t, p]) => toRound(m, t, p));
      out.added += tx(db, () => {
        let n = 0;
        for (const r of rows) if (!hasRound(db, r.feed, r.roundId)) (insertRound(db, r), n++);
        db.prepare("INSERT INTO feed_meta (feed, backfilled_at) VALUES (?, ?) ON CONFLICT(feed) DO UPDATE SET backfilled_at = excluded.backfilled_at").run(m.feed, now);
        return n;
      });
      out.backfilled.push(m.symbol);
    } catch (e) {
      out.error = (e as Error).message;
      break; // most likely the rate limit; try again next tick
    }
  }

  for (const m of dataFeeds) {
    const r = latestStored(db, m.symbol);
    if (r) out.latest.set(m.symbol, r);
  }
  return out;
}

export function loadRounds(db: DatabaseSync, symbol: string, since: number): RoundPoint[] {
  // One round just before `since` is included, so the first hour has a close.
  const before = db
    .prepare("SELECT round_id, answer, decimals, updated_at FROM rounds WHERE symbol = ? AND updated_at < ? ORDER BY updated_at DESC LIMIT 1")
    .all(symbol, since);
  const after = db
    .prepare("SELECT round_id, answer, decimals, updated_at FROM rounds WHERE symbol = ? AND updated_at >= ? ORDER BY updated_at ASC")
    .all(symbol, since);
  return [...before, ...after].map((r: any) => ({
    roundId: String(r.round_id),
    price: roundPrice({ answer: String(r.answer), decimals: Number(r.decimals) } as FeedRound),
    updatedAt: Number(r.updated_at),
  }));
}

export function latestStored(db: DatabaseSync, symbol: string): FeedRound | null {
  const r = db.prepare("SELECT * FROM rounds WHERE symbol = ? ORDER BY updated_at DESC LIMIT 1").get(symbol) as any;
  if (!r) return null;
  return { symbol, feed: r.feed, roundId: String(r.round_id), answer: String(r.answer), decimals: Number(r.decimals), updatedAt: Number(r.updated_at) };
}
