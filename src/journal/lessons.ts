import type { DatabaseSync } from "node:sqlite";
import { recordHash } from "../receipts/merkle.ts";
import { addReceipt } from "../engine/epochs.ts";

/**
 * The agent's journal: lessons learned from its own sealed record.
 *
 * Everything here is computed from receipts, never written by a model, so a lesson can only say
 * what the record shows. Each lesson names the receipts behind it (the receipt that opened each
 * trade and the one that closed it), and each of those can be checked against the root anchored
 * on Robinhood Chain. The journal itself is sealed as a receipt whenever its lessons change, so
 * an improved strategy can point at the exact journal it learned from.
 *
 * Lessons are patterns in a small sample, and they say so: each carries its trade count and a
 * confidence that grows with it. They describe the past; they do not promise anything.
 */

export interface Trade {
  symbol: string;
  side: "long" | "short";
  openReceipt: number;
  closeReceipt: number;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  /** Size of the position when opened, in USD. */
  notional: number;
  /** Net of the opening and closing fees, in USD. */
  pnl: number;
  /** pnl as a percent of notional. */
  returnPct: number;
  fees: number;
  exit: "stop" | "take-profit" | "max-hold" | "exit-rule" | "liquidation" | "other";
  /** Market session when it was opened ("regular", "pre", "after", "overnight", or "always" for crypto). */
  session: string;
}

export type Confidence = "low" | "medium" | "high";

export interface Lesson {
  /** Stable id: the same pattern keeps its id as evidence grows. */
  id: string;
  kind: "weakness" | "strength" | "risk";
  title: string;
  detail: string;
  stats: { trades: number; wins: number; netPnl: number; avgReturnPct: number };
  confidence: Confidence;
  /** Receipt ids: for each trade the receipt that opened it and the one that closed it. */
  evidence: number[];
}

export interface Journal {
  agentId: string;
  asOf: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  netPnl: number;
  fees: number;
  lessons: Lesson[];
  /** Hash of the lessons (ids, stats and evidence); a new journal receipt is sealed when it changes. */
  digest: `0x${string}`;
}

/** Fewer trades than this in a group say nothing. */
export const MIN_TRADES = 3;
export const confidenceOf = (n: number): Confidence => (n >= 10 ? "high" : n >= 5 ? "medium" : "low");

const round2 = (x: number) => Math.round(x * 100) / 100;
// Text uses the same rounded figures as the stats, so a lesson never says -6.38% beside -6.37%.
const usd = (x: number) => {
  const r = round2(x);
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toFixed(2)}`;
};
const pct = (x: number) => {
  const r = round2(x);
  return `${r > 0 ? "+" : ""}${r.toFixed(2)}%`;
};

function exitOf(kind: string, reason: string): Trade["exit"] {
  if (kind === "liquidate") return "liquidation";
  if (reason.startsWith("stop loss")) return "stop";
  if (reason.startsWith("take profit")) return "take-profit";
  if (/^held \d+h/.test(reason)) return "max-hold";
  if (reason.startsWith("exit rule")) return "exit-rule";
  return "other";
}

/**
 * Pairs each filled open with the next filled close or liquidation of the same symbol, in receipt
 * order. An agent holds at most one position per symbol, so the pairing is exact; a position
 * still open has no closing receipt and is counted as open, not as a trade.
 */
export function tradesOf(db: DatabaseSync, agentId: string): { trades: Trade[]; open: number } {
  const rows = db
    .prepare("SELECT id, kind, record_json FROM receipts WHERE agent_id = ? AND kind IN ('decision', 'fill') ORDER BY id")
    .all(agentId) as Array<{ id: number; kind: string; record_json: string }>;
  const opened = new Map<string, { id: number; at: number; fill: any; session: string }>();
  const trades: Trade[] = [];
  for (const r of rows) {
    const rec = JSON.parse(r.record_json);
    const fill = rec.fill;
    if (!fill || (r.kind === "decision" && rec.outcome !== "filled")) continue;
    if (fill.action === "open") {
      opened.set(fill.symbol, { id: r.id, at: Number(rec.at), fill, session: String(rec.session ?? "") });
      continue;
    }
    if (fill.action !== "close" && fill.action !== "liquidate") continue;
    const o = opened.get(fill.symbol);
    if (!o) continue; // a close without its open in this record (should not happen); ignored
    opened.delete(fill.symbol);
    const fees = Number(o.fill.fee) + Number(fill.fee);
    const pnl = Number(fill.pnl) - Number(o.fill.fee);
    const notional = Number(o.fill.notional);
    trades.push({
      symbol: fill.symbol,
      side: o.fill.side,
      openReceipt: o.id,
      closeReceipt: r.id,
      openedAt: o.at,
      closedAt: Number(rec.at),
      entryPrice: Number(o.fill.price),
      exitPrice: Number(fill.price),
      notional,
      pnl,
      returnPct: notional > 0 ? (pnl / notional) * 100 : 0,
      fees,
      exit: exitOf(fill.action, String(rec.decision?.reason ?? rec.reason ?? "")),
      session: o.session,
    });
  }
  return { trades, open: opened.size };
}

interface Group {
  trades: Trade[];
  wins: number;
  netPnl: number;
  avgReturnPct: number;
}
const group = (ts: Trade[]): Group => ({
  trades: ts,
  wins: ts.filter((t) => t.pnl > 0).length,
  netPnl: ts.reduce((a, t) => a + t.pnl, 0),
  avgReturnPct: ts.length ? ts.reduce((a, t) => a + t.returnPct, 0) / ts.length : 0,
});
const evidenceOf = (ts: Trade[]) => ts.flatMap((t) => [t.openReceipt, t.closeReceipt]).sort((a, b) => a - b);
const statsOf = (g: Group) => ({ trades: g.trades.length, wins: g.wins, netPnl: round2(g.netPnl), avgReturnPct: round2(g.avgReturnPct) });
const by = <K extends string>(ts: Trade[], key: (t: Trade) => K) => {
  const m = new Map<K, Trade[]>();
  for (const t of ts) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
  return m;
};

const SESSION_NAME: Record<string, string> = {
  regular: "regular market hours",
  pre: "the pre-market session",
  after: "the after-hours session",
  overnight: "the overnight session",
};

/** All lessons the record supports, strongest evidence first. */
export function lessonsFrom(trades: Trade[]): Lesson[] {
  const out: Lesson[] = [];
  const add = (l: Omit<Lesson, "confidence"> & { confidence?: Confidence }) => out.push({ ...l, confidence: l.confidence ?? confidenceOf(l.stats.trades) });
  const all = group(trades);

  // 1. Liquidations: always worth saying, even once.
  const liq = trades.filter((t) => t.exit === "liquidation");
  if (liq.length) {
    const g = group(liq);
    add({
      id: "risk:liquidation",
      kind: "risk",
      title: `Liquidated ${liq.length === 1 ? "once" : `${liq.length} times`}`,
      detail: `${liq.length} position(s) lost their whole margin (${liq.map((t) => t.symbol).join(", ")}). Lower leverage or a tighter stop loss keeps a position from reaching liquidation.`,
      stats: statsOf(g),
      confidence: "high",
      evidence: evidenceOf(liq),
    });
  }

  // 2. Exits: how trades usually end.
  if (trades.length >= MIN_TRADES) {
    const stops = trades.filter((t) => t.exit === "stop");
    if (stops.length >= MIN_TRADES && stops.length / trades.length >= 0.5) {
      const g = group(stops);
      add({
        id: "weakness:stops",
        kind: "weakness",
        title: `${stops.length} of ${trades.length} trades ended at the stop loss`,
        detail: `Most trades went the wrong way far enough to hit the stop (average ${pct(g.avgReturnPct)}, ${usd(g.netPnl)} in total). Entries may be early; a confirming condition or a wider stop is worth testing in a backtest.`,
        stats: statsOf(g),
        evidence: evidenceOf(stops),
      });
    }
    const timed = trades.filter((t) => t.exit === "max-hold");
    if (timed.length >= MIN_TRADES && timed.length / trades.length >= 0.4) {
      const g = group(timed);
      add({
        id: "weakness:max-hold",
        kind: "weakness",
        title: `${timed.length} trades were closed by the time limit`,
        detail: `They neither hit the take profit nor an exit rule before the maximum hold ran out (average ${pct(g.avgReturnPct)}). The move the entry expects may take longer, or not come.`,
        stats: statsOf(g),
        evidence: evidenceOf(timed),
      });
    }
    const takes = trades.filter((t) => t.exit === "take-profit");
    if (takes.length >= MIN_TRADES && takes.length / trades.length >= 0.5) {
      const g = group(takes);
      add({
        id: "strength:take-profit",
        kind: "strength",
        title: `${takes.length} of ${trades.length} trades reached the take profit`,
        detail: `The entry often catches the move it is built for (average ${pct(g.avgReturnPct)}, ${usd(g.netPnl)} in total).`,
        stats: statsOf(g),
        evidence: evidenceOf(takes),
      });
    }
  }

  // 3. Symbols: where it works and where it does not (only when it trades more than one).
  const symbols = by(trades, (t) => t.symbol);
  for (const [sym, ts] of symbols) {
    if (ts.length < MIN_TRADES || symbols.size < 2) continue;
    const g = group(ts);
    const winRate = g.wins / ts.length;
    if (g.netPnl < 0 && winRate <= 1 / 3)
      add({
        id: `weakness:symbol:${sym}`,
        kind: "weakness",
        title: `${sym} keeps losing: ${g.wins} win(s) in ${ts.length} trades`,
        detail: `${usd(g.netPnl)} net on ${sym} (average ${pct(g.avgReturnPct)} a trade). The rules may not suit how ${sym} moves; leaving it out is worth a backtest.`,
        stats: statsOf(g),
        evidence: evidenceOf(ts),
      });
    else if (g.netPnl > 0 && winRate >= 2 / 3)
      add({
        id: `strength:symbol:${sym}`,
        kind: "strength",
        title: `${sym} works: ${g.wins} win(s) in ${ts.length} trades`,
        detail: `${usd(g.netPnl)} net on ${sym} (average ${pct(g.avgReturnPct)} a trade).`,
        stats: statsOf(g),
        evidence: evidenceOf(ts),
      });
  }

  // 4. Sessions (stocks only: crypto is one continuous session).
  const sessions = by(
    trades.filter((t) => t.session in SESSION_NAME),
    (t) => t.session,
  );
  if (sessions.size >= 2)
    for (const [s, ts] of sessions) {
      if (ts.length < MIN_TRADES) continue;
      const g = group(ts);
      const others = group(trades.filter((t) => t.session in SESSION_NAME && t.session !== s));
      if (g.netPnl < 0 && g.avgReturnPct < others.avgReturnPct - 0.5)
        add({
          id: `weakness:session:${s}`,
          kind: "weakness",
          title: `Entries in ${SESSION_NAME[s]} do worse`,
          detail: `${ts.length} trades opened in ${SESSION_NAME[s]} averaged ${pct(g.avgReturnPct)}, against ${pct(others.avgReturnPct)} for the others. Thinner trading outside regular hours can move prices against an entry.`,
          stats: statsOf(g),
          evidence: evidenceOf(ts),
        });
    }

  // 5. Fees: an edge that the costs eat.
  const gross = trades.reduce((a, t) => a + t.pnl + t.fees, 0);
  const fees = trades.reduce((a, t) => a + t.fees, 0);
  if (trades.length >= MIN_TRADES && gross > 0 && fees >= gross * 0.5)
    add({
      id: "weakness:fees",
      kind: "weakness",
      title: `Fees took ${Math.round((fees / gross) * 100)}% of the gross profit`,
      detail: `${usd(fees)} in fees against ${usd(gross)} gross. Fewer, larger moves (a higher take profit, or fewer entries) keep more of it.`,
      stats: statsOf(all),
      evidence: evidenceOf(trades),
    });

  const rank = { risk: 0, weakness: 1, strength: 2 } as const;
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || b.stats.trades - a.stats.trades || a.id.localeCompare(b.id));
}

export function journalOf(db: DatabaseSync, agentId: string, now: number): Journal {
  const { trades, open } = tradesOf(db, agentId);
  const lessons = lessonsFrom(trades);
  const all = group(trades);
  return {
    agentId,
    asOf: now,
    closedTrades: trades.length,
    openTrades: open,
    wins: all.wins,
    netPnl: round2(all.netPnl),
    fees: round2(trades.reduce((a, t) => a + t.fees, 0)),
    lessons,
    digest: recordHash(lessons.map((l) => ({ id: l.id, stats: l.stats, evidence: l.evidence }))),
  };
}

/** The newest sealed journal receipt of an agent, if any. */
export function lastJournalReceipt(db: DatabaseSync, agentId: string): { id: number; leaf: string; digest: string } | null {
  const r = db.prepare("SELECT id, leaf, record_json FROM receipts WHERE agent_id = ? AND kind = 'journal' ORDER BY id DESC LIMIT 1").get(agentId) as
    | { id: number; leaf: string; record_json: string }
    | undefined;
  return r ? { id: r.id, leaf: r.leaf, digest: JSON.parse(r.record_json).digest } : null;
}

/**
 * Seals the journal as a receipt when its lessons changed since the last one. Nothing is sealed
 * before there is a first lesson. Returns the new journal, or null when nothing changed.
 */
export function sealJournal(db: DatabaseSync, agentId: string, epoch: number, now: number): Journal | null {
  const j = journalOf(db, agentId, now);
  const last = lastJournalReceipt(db, agentId);
  if (last ? last.digest === j.digest : j.lessons.length === 0) return null;
  addReceipt(db, agentId, epoch, "journal", {
    at: now,
    closedTrades: j.closedTrades,
    wins: j.wins,
    netPnl: j.netPnl,
    digest: j.digest,
    lessons: j.lessons.map((l) => ({ id: l.id, kind: l.kind, title: l.title, confidence: l.confidence, stats: l.stats, evidence: l.evidence })),
  }, now);
  return j;
}

/**
 * The lessons as text for the brain: facts from the record and the receipts behind them, framed
 * as evidence to weigh, not as orders. Only figures and our own wording go in, no user text.
 */
export function lessonsBrief(j: Journal): string {
  if (!j.lessons.length) return `The earlier agent has ${j.closedTrades} closed trade(s) on record and no pattern strong enough to be a lesson yet.`;
  const lines = j.lessons.map(
    (l, i) =>
      `${i + 1}. [${l.kind}, ${l.confidence} confidence, ${l.stats.trades} trades] ${l.title}. ${l.detail} (receipts ${l.evidence.slice(0, 12).join(", ")}${l.evidence.length > 12 ? ", …" : ""})`,
  );
  return [`Lessons from the sealed record of the earlier agent (${j.closedTrades} closed trades, ${j.wins} wins, net ${usd(j.netPnl)}):`, ...lines].join("\n");
}
