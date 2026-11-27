import type { DatabaseSync } from "node:sqlite";
import { errLine } from "../util/redact.ts";
import type { PublicClient } from "viem";
import type { Market } from "../config.ts";
import { roundPrice, type FeedRound } from "../sources/chainlink.ts";
import type { PlanktonClient } from "../sources/plankton.ts";
import type { PythClient } from "../sources/pyth.ts";
import { step } from "./step.ts";
import { closesAt, openHourEnds, HOUR, type HourClose } from "../strategy/series.ts";
import { maxLookback } from "../strategy/schema.ts";
import { gate, type GateVerdict } from "../guard/gate.ts";
import { hourWasOpen, marketState, type MarketState } from "../market/calendar.ts";
import type { AssetClass } from "../config.ts";
import { getAccount, listAgents, saveAccount, type AgentRow } from "./agents.ts";
import { addReceipt, closeEpochs, epochOf, hasReceipt } from "./epochs.ts";
import { sealJournal } from "../journal/lessons.ts";
import { loadRounds, syncDataFeeds, syncRounds } from "./ingest.ts";
import type { CoinGeckoClient } from "../sources/coingecko.ts";
import type { DexQuoteClient } from "../sources/dexquote.ts";
import { tx } from "../store/db.ts";
import { moodAsOf } from "../signals/social.ts";
import { liveMayDecide, queueCloses, queueOrder } from "../live/live.ts";
import { closePosition, equity as equityOf } from "../paper/broker.ts";
import { endReason, hasEnd, markEnded } from "./end.ts";

export interface TickContext {
  db: DatabaseSync;
  chain: PublicClient;
  markets: Market[];
  plankton: PlanktonClient | null;
  /** Second source for crypto. */
  pyth?: PythClient | null;
  /** Prices for data-feed crypto, and a second source for Chainlink crypto. */
  coingecko?: Pick<CoinGeckoClient, "prices" | "hourly"> | null;
  /** Executable quotes on Robinhood Chain (Uniswap): second price for stocks, and spot fill prices. */
  dex?: Pick<DexQuoteClient, "spread"> | null;
  /** Quotes kept between ticks, so each symbol is quoted a few minutes apart. */
  dexCache?: Map<string, DexQuoteCached>;
  epochSec: number;
  /** History kept for indicators and backtests. */
  backfillSec?: number;
  /** Equity trading calendar; replaceable in tests. Crypto is always open. */
  market?: (t: number) => MarketState;
  hourOpen?: (hourEnd: number) => boolean;
  /** Real-money agents decide only while live trading is on (LIVE_TRADING and a wallet key). */
  liveOn?: boolean;
}

export interface TickSummary {
  at: number;
  /** Equity market state; crypto is always open. */
  market: MarketState;
  roundsAdded: number;
  feedsFailed: string[];
  agents: number;
  fills: number;
  blocked: number;
  sealedEpochs: number[];
  planktonOk: boolean | null;
  pythOk: boolean | null;
  coingeckoOk: boolean | null;
  dexOk: boolean | null;
  dataFeedRounds: number;
}

const ALWAYS: MarketState = { open: true, session: "always", reason: null };
/** Max age of a Pyth price to count as a second source. */
const PYTH_MAX_AGE_SEC = 120;
/** Max age of a CoinGecko quote to count as a second source for a Chainlink crypto feed. */
const COINGECKO_MAX_AGE_SEC = 600;
/** A quote is refreshed after this long, and not used at all once older than the max age. */
const DEX_REFRESH_SEC = 240;
const DEX_MAX_AGE_SEC = 600;
/** Tokenized stocks trade at a small premium or discount to the oracle; allow for it. */
const DEX_MAX_GAP_BPS = 250;

export interface DexQuoteCached {
  ask: number;
  bid: number;
  venues: string[];
  quotedAt: number;
}

/** Per-tick view the agents share: prices, second sources and market state per symbol. */
interface TickView {
  now: number;
  epoch: number;
  latest: Map<string, FeedRound>;
  prices: Map<string, number>;
  /** Fresh second-source price per symbol (Plankton for equities, Pyth for crypto). */
  second: Map<string, number>;
  /** Which source gave the second price, per symbol. */
  secondSource: Map<string, string>;
  /** Fresh executable quotes per symbol. */
  exec: Map<string, DexQuoteCached>;
  halts: Set<string>;
  assetOf: (symbol: string) => AssetClass;
  marketFor: (symbol: string) => MarketState;
  hourOpenFor: (symbol: string) => (hourEnd: number) => boolean;
}

/** What the agent saw for one symbol, recorded so the inputs can be checked on chain. */
function inputRef(feed: FeedRound | undefined, closes: readonly HourClose[]) {
  if (!feed) return null;
  return {
    feed: feed.feed,
    roundId: feed.roundId,
    answer: feed.answer,
    decimals: feed.decimals,
    updatedAt: feed.updatedAt,
    closes: { hours: closes.length, firstRoundId: closes[0]?.roundId ?? null, lastRoundId: closes.at(-1)?.roundId ?? null },
  };
}

export async function runTick(ctx: TickContext, now = Math.floor(Date.now() / 1000)): Promise<TickSummary> {
  const { db, markets } = ctx;
  const equityMarket = (ctx.market ?? marketState)(now);
  const bySymbol = new Map(markets.map((m) => [m.symbol, m]));
  const assetOf = (sym: string): AssetClass => bySymbol.get(sym)?.assetClass ?? "equity";
  const equityHourOpen = ctx.hourOpen ?? hourWasOpen;
  const { latest, added, failed } = await syncRounds(db, ctx.chain, markets, now, ctx.backfillSec);

  // Data-feed crypto (CoinGecko): its prices join the same view as the Chainlink rounds.
  let coingeckoOk: boolean | null = null;
  let dataFeedRounds = 0;
  let cgQuotes = new Map<string, { usd: number; updatedAt: number }>();
  if (ctx.coingecko) {
    const d = await syncDataFeeds(db, ctx.coingecko, markets, now, ctx.backfillSec);
    for (const [sym, r] of d.latest) latest.set(sym, r);
    cgQuotes = d.quotes;
    dataFeedRounds = d.added;
    coingeckoOk = d.error === null;
    if (d.error) console.warn(`[coingecko] ${d.error}`);
  }

  const second = new Map<string, number>();
  let halts = new Set<string>();

  // Plankton: second price and halts for equities, only while their market is open.
  let planktonOk: boolean | null = null;
  if (ctx.plankton && equityMarket.open) {
    try {
      for (const m of await ctx.plankton.marks()) if (m.fresh && !m.breaker && m.price !== null && assetOf(m.symbol) === "equity") second.set(m.symbol, m.price);
      halts = await ctx.plankton.halts();
      planktonOk = true;
    } catch (e) {
      // A second source only. Without it the gate runs on Chainlink alone.
      planktonOk = false;
      console.warn(`[plankton] ${(e as Error).name}: ${errLine(e)}`);
    }
  }

  // Pyth: second price for crypto, which trades around the clock.
  let pythOk: boolean | null = null;
  const pythMarkets = markets.filter((m) => m.assetClass === "crypto" && m.pythId);
  if (ctx.pyth && pythMarkets.length) {
    try {
      const got = await ctx.pyth.latest(pythMarkets.map((m) => m.pythId!));
      for (const m of pythMarkets) {
        const p = got.prices.get(m.pythId!.replace(/^0x/, "").toLowerCase());
        if (p && now - p.publishTime <= PYTH_MAX_AGE_SEC && p.price > 0) second.set(m.symbol, p.price);
      }
      // Feeds the key is not entitled to are expected and run on Chainlink alone; only real
      // failures count as Pyth being down.
      pythOk = got.failed.length === 0;
      if (got.failed.length) console.warn(`[pyth] failed for ${got.failed.length} feed(s)`);
    } catch (e) {
      pythOk = false;
      console.warn(`[pyth] ${errLine(e)}`);
    }
  }

  // CoinGecko as the fallback second source for Chainlink crypto that Pyth does not cover.
  for (const m of markets) {
    if (m.source !== "chainlink" || m.assetClass !== "crypto" || second.has(m.symbol)) continue;
    const q = cgQuotes.get(m.symbol);
    if (q && now - q.updatedAt <= COINGECKO_MAX_AGE_SEC) second.set(m.symbol, q.usd);
  }

  const prices = new Map<string, number>();
  for (const [sym, r] of latest) prices.set(sym, roundPrice(r));
  const marketFor = (sym: string) => (assetOf(sym) === "crypto" ? ALWAYS : equityMarket);
  const secondSource = new Map<string, string>([...second.keys()].map((k) => [k, assetOf(k) === "crypto" ? "pyth-or-coingecko" : "plankton"]));

  // Executable quotes for the symbols agents actually trade, refreshed a few minutes apart.
  const exec = new Map<string, DexQuoteCached>();
  let dexOk: boolean | null = null;
  if (ctx.dex) {
    const cache = (ctx.dexCache ??= new Map());
    const wanted = new Set<string>();
    for (const a of listAgents(db)) {
      for (const sym of a.strategy.symbols) wanted.add(sym);
      for (const pos of getAccount(db, a.id).account.positions) wanted.add(pos.symbol);
    }
    const targets = markets.filter((m) => wanted.has(m.symbol) && m.token && prices.has(m.symbol) && marketFor(m.symbol).open);
    for (const m of targets) {
      const c = cache.get(m.symbol);
      if (c && now - c.quotedAt < DEX_REFRESH_SEC) continue;
      try {
        const q = await ctx.dex.spread(m.token!, m.tokenDecimals ?? 18, prices.get(m.symbol)!);
        cache.set(m.symbol, { ask: q.ask, bid: q.bid, venues: q.venues, quotedAt: Math.min(q.quotedAt, now) });
        dexOk = dexOk ?? true;
      } catch (e) {
        dexOk = false;
        // No pool for a symbol is normal; a rate limit from the node means stop asking for this tick.
        if (/429/.test((e as Error).message)) break;
      }
    }
    for (const m of targets) {
      const c = cache.get(m.symbol);
      if (!c || now - c.quotedAt > DEX_MAX_AGE_SEC || !(c.ask > 0 && c.bid > 0)) continue;
      exec.set(m.symbol, c);
      // For stocks the executable price is the better second source; crypto keeps its oracle second source.
      if (m.assetClass === "equity" || !second.has(m.symbol)) {
        second.set(m.symbol, (c.ask + c.bid) / 2);
        secondSource.set(m.symbol, "dex-quote");
      }
    }
  }

  const epoch = epochOf(now, ctx.epochSec);
  const view: TickView = {
    now,
    epoch,
    latest,
    prices,
    second,
    secondSource,
    exec,
    halts,
    assetOf,
    marketFor,
    hourOpenFor: (sym) => (assetOf(sym) === "crypto" ? () => true : equityHourOpen),
  };
  const agents = listAgents(db);
  let fills = 0;
  let blocked = 0;
  for (const agent of agents) {
    const r = runAgent(ctx, agent, view);
    fills += r.fills;
    blocked += r.blocked;
  }

  const sealedEpochs = closeEpochs(db, epoch, now);
  return { at: now, market: equityMarket, roundsAdded: added, feedsFailed: failed, agents: agents.length, fills, blocked, sealedEpochs, planktonOk, pythOk, coingeckoOk, dexOk, dataFeedRounds };
}

/** True if an equivalent non-filled outcome was already recorded this epoch, to avoid one receipt per tick. */
function alreadyRecorded(db: DatabaseSync, agentId: string, epoch: number, symbol: string, kind: string, outcome: string, why: string) {
  return (
    db
      .prepare(
        `SELECT 1 FROM receipts WHERE agent_id = ? AND epoch = ? AND kind = 'decision'
           AND json_extract(record_json, '$.decision.symbol') = ?
           AND json_extract(record_json, '$.decision.kind') = ?
           AND json_extract(record_json, '$.outcome') = ?
           AND json_extract(record_json, '$.why') = ? LIMIT 1`,
      )
      .get(agentId, epoch, symbol, kind, outcome, why) !== undefined
  );
}

/** Gate for one symbol from the live feeds. */
export function liveGate(symbol: string, v: TickView, heartbeatSec: number): GateVerdict {
  const feed = v.latest.get(symbol);
  const market = v.marketFor(symbol);
  return gate({
    chainlinkPrice: feed ? roundPrice(feed) : null,
    chainlinkUpdatedAt: feed?.updatedAt ?? null,
    heartbeatSec,
    secondPrice: v.second.get(symbol) ?? null,
    secondSource: v.secondSource.get(symbol),
    maxGapBps: v.secondSource.get(symbol) === "dex-quote" ? DEX_MAX_GAP_BPS : undefined,
    halted: v.halts.has(symbol),
    marketOpen: market.open,
    marketReason: market.reason,
    now: v.now,
  });
}

function runAgent(ctx: TickContext, agent: AgentRow, t: TickView) {
  const { db } = ctx;
  const s = agent.strategy;
  const bySymbol = new Map(ctx.markets.map((m) => [m.symbol, m]));

  // A run whose money went back to its owner is finished: its record stays as it ended.
  if (agent.stopState === "returned") return { fills: 0, blocked: 0 };
  return tx(db, () => {
    const row = getAccount(db, agent.id);

    // Each symbol gets bars from its own calendar: market hours for stocks, every hour for crypto.
    const symbols = new Set([...s.symbols, ...row.account.positions.map((p) => p.symbol)]);
    const closes = new Map<string, HourClose[]>();
    for (const sym of symbols) {
      const ends = openHourEnds(t.now, maxLookback(s) + 2, t.hourOpenFor(sym));
      const since = (ends[0] ?? t.now) - HOUR;
      closes.set(sym, closesAt(loadRounds(db, sym, since), ends, t.now));
    }

    // A real-money agent decides only with live trading on, nothing in flight and no fresh failure;
    // its decisions become orders for the live trader, and its account changes only when a swap settles.
    const live = agent.liveIndex !== null || agent.vault !== null;

    // The end of a run (time, profit target, loss limit): paper closes here at the latest prices;
    // real money closes through the trader, which also watches ends between ticks.
    if (agent.status === "active" && agent.endedAt === null && hasEnd(s)) {
      const eq0 = equityOf(row.account, t.prices);
      const why = endReason(agent, row.startEquity > 0 ? ((eq0 - row.startEquity) / row.startEquity) * 100 : 0, t.now);
      if (why && markEnded(db, agent, why, eq0, ctx.epochSec, t.now)) {
        if (live) queueCloses(db, agent.id, t.now);
        else {
          let account = row.account;
          for (const p of [...account.positions]) {
            const px = t.prices.get(p.symbol) ?? p.entryPrice;
            const res = closePosition(account, p.symbol, px, t.now, "close");
            if ("error" in res) continue;
            account = res.account;
            addReceipt(db, agent.id, t.epoch, "fill", { agentId: agent.id, strategyHash: agent.strategyHash, at: t.now, symbol: p.symbol, reason: `run ended: ${why}`, input: inputRef(t.latest.get(p.symbol), []), fill: res.fill }, t.now);
          }
          saveAccount(db, agent.id, { ...row, account, equity: equityOf(account, t.prices) }, t.now);
        }
        return { fills: 0, blocked: 0 };
      }
    }
    const active = agent.status === "active" && (!live || (ctx.liveOn === true && liveMayDecide(db, agent.id, t.now)));
    const r = step(
      { account: row.account, day: row.day, dayStartEquity: row.dayStartEquity },
      {
        now: t.now,
        marketFor: t.marketFor,
        assetClassOf: t.assetOf,
        strategy: s,
        policy: agent.policy,
        active,
        closes,
        prices: t.prices,
        gateFor: (sym) => liveGate(sym, t, bySymbol.get(sym)?.heartbeatSec ?? 86400),
        execPrice: (sym, side) => {
          const q = t.exec.get(sym);
          return q ? { price: side === "buy" ? q.ask : q.bid, source: "dex-quote", venues: q.venues, quotedAt: q.quotedAt } : null;
        },
        moodOf: (sym) => moodAsOf(db, sym, t.now),
      },
    );

    const base = { agentId: agent.id, strategyHash: agent.strategyHash, at: t.now };
    let fills = 0;
    let blocked = 0;
    for (const e of r.events) {
      const input = inputRef(t.latest.get(e.symbol), closes.get(e.symbol) ?? []);
      const session = t.marketFor(e.symbol).session;
      if (e.type === "liquidation") {
        fills++;
        addReceipt(db, agent.id, t.epoch, "fill", { ...base, session, symbol: e.symbol, reason: "margin exhausted", input, gate: e.gate, fill: e.fill }, t.now);
        continue;
      }
      if (live && e.outcome === "filled" && e.fill) {
        // Not filled yet: an order for the live trader. The receipt says so and names the order.
        const leaf = addReceipt(
          db,
          agent.id,
          t.epoch,
          "decision",
          { ...base, session, money: "real", decision: JSON.parse(JSON.stringify(e.decision)), input, gate: e.gate, policy: e.policy, outcome: "submitted", why: "live:order", fill: null },
          t.now,
        );
        queueOrder(db, { agentId: agent.id, symbol: e.symbol, action: e.decision.kind, usdIn: e.decision.kind === "open" ? e.fill.notional : null, decisionLeaf: leaf }, t.now);
        continue;
      }
      if (e.outcome === "filled") fills++;
      else blocked++;
      // Repeated non-fills (the gate saying no every five minutes) are recorded once per epoch.
      if (e.outcome !== "filled" && alreadyRecorded(db, agent.id, t.epoch, e.symbol, e.decision.kind, e.outcome, e.why)) continue;
      addReceipt(
        db,
        agent.id,
        t.epoch,
        "decision",
        { ...base, session, decision: JSON.parse(JSON.stringify(e.decision)), input, gate: e.gate, policy: e.policy, outcome: e.outcome, why: e.why, fill: e.fill, ...(e.execution ? { execution: e.execution } : {}), ...(e.error ? { error: e.error } : {}) },
        t.now,
      );
    }

    // One snapshot per epoch: the sealed equity curve behind the leaderboard.
    // A live agent's account is what its swaps did, not what the step simulated.
    const account = live ? { ...row.account, peak: r.state.account.peak } : r.state.account;
    const eqNow = live ? equityOf(account, t.prices) : r.equity;
    if (!hasReceipt(db, agent.id, t.epoch, "snapshot")) {
      addReceipt(
        db,
        agent.id,
        t.epoch,
        "snapshot",
        {
          ...base,
          status: agent.status,
          equity: Math.round(eqNow * 100) / 100,
          cash: Math.round(account.cash * 100) / 100,
          positions: account.positions.map((p) => ({ symbol: p.symbol, side: p.side, venue: p.venue, qty: p.qty, entryPrice: p.entryPrice, leverage: p.leverage })),
          marks: Object.fromEntries(account.positions.map((p) => [p.symbol, t.latest.get(p.symbol)?.roundId ?? null])),
        },
        t.now,
      );
    }

    saveAccount(db, agent.id, { ...row, account, day: r.state.day, dayStartEquity: r.state.dayStartEquity, equity: eqNow }, t.now);
    // A closed trade can change what the record teaches; the journal is re-read and sealed if it did.
    if (!live && r.events.some((e) => e.fill && e.fill.action !== "open" && (e.type === "liquidation" || e.outcome === "filled"))) sealJournal(db, agent.id, t.epoch, t.now);
    return { fills, blocked };
  });
}
