import type { DatabaseSync } from "node:sqlite";
import type { Market } from "../config.ts";
import { roundPrice } from "../sources/chainlink.ts";
import { closesAt, HOUR, openHourEnds } from "../strategy/series.ts";
import { maxLookback } from "../strategy/schema.ts";
import { evalCondition } from "../strategy/evaluate.ts";
import { hourWasOpen, marketStateFor } from "../market/calendar.ts";
import { equity, unrealized } from "../paper/broker.ts";
import { moodAsOf } from "../signals/social.ts";
import { markOf, openOrders } from "../live/live.ts";
import { endAt } from "./end.ts";
import { getAccount, type AgentRow } from "./agents.ts";
import { latestStored, loadRounds } from "./ingest.ts";

/**
 * What an agent sees right now: for every symbol it trades, the latest price and each of its
 * rules measured on the same hourly closes the engine uses, so a visitor can watch how close it
 * is to buying or selling; for every position, its profit or loss at the latest price. The
 * account is marked at the latest prices too, so the return moves between ticks.
 */
export function agentNow(
  db: DatabaseSync,
  agent: AgentRow,
  markets: Market[],
  now: number,
  /** Equity calendar; replaceable in tests. Crypto is always open. */
  cal: { market?: (t: number) => { open: boolean; reason: string | null }; hourOpen?: (hourEnd: number) => boolean } = {},
) {
  const s = agent.strategy;
  const row = getAccount(db, agent.id);
  const assetOf = (sym: string) => markets.find((m) => m.symbol === sym)?.assetClass ?? "equity";
  const prices = new Map<string, number>();
  const symbols = [...new Set([...s.symbols, ...row.account.positions.map((p) => p.symbol)])];

  const rows = symbols.map((sym) => {
    const latest = latestStored(db, sym);
    const price = latest ? roundPrice(latest) : null;
    if (price !== null) prices.set(sym, price);
    const hourOpen = assetOf(sym) === "crypto" ? () => true : (cal.hourOpen ?? hourWasOpen);
    const ends = openHourEnds(now, maxLookback(s) + 2, hourOpen);
    const closes = closesAt(loadRounds(db, sym, (ends[0] ?? now) - HOUR), ends, now);
    const mood = moodAsOf(db, sym, now);
    const market = assetOf(sym) === "equity" && cal.market ? cal.market(now) : marketStateFor(assetOf(sym), now);
    const pos = row.account.positions.find((p) => p.symbol === sym) ?? null;
    const checks = (pos ? s.exitConditions : s.entry).map((c) => {
      const r = evalCondition(c, closes, c.type === "social_mood" ? mood : null);
      return { description: c.description, pass: r.pass, value: r.value, detail: r.detail };
    });
    const position = pos
      ? {
          side: pos.side,
          qty: pos.qty,
          entryPrice: pos.entryPrice,
          openedAt: pos.openedAt,
          price,
          pnl: price !== null ? Math.round(unrealized(pos, price) * 100) / 100 : null,
          pnlPct: price !== null ? Math.round(((price - pos.entryPrice) / pos.entryPrice) * 100 * (pos.side === "long" ? 1 : -1) * 100) / 100 : null,
          stopAt: pos.entryPrice * (1 - (s.stopLossPct / 100) * (pos.side === "long" ? 1 : -1)),
          takeProfitAt: s.takeProfitPct > 0 ? pos.entryPrice * (1 + (s.takeProfitPct / 100) * (pos.side === "long" ? 1 : -1)) : null,
          closesBy: s.maxHoldHours > 0 ? pos.openedAt + s.maxHoldHours * 3600 : null,
        }
      : null;
    const met = checks.filter((c) => c.pass).length;
    const state = pos
      ? "holding"
      : !market.open
        ? "market-closed"
        : checks.length && met === checks.length
          ? "signal"
          : "waiting";
    // How the market moved since the agent started, to compare with what its money did.
    const first = loadRounds(db, sym, agent.createdAt)[0];
    const sinceStartPct = first && price !== null ? Math.round(((price - first.price) / first.price) * 10_000) / 100 : null;
    return { symbol: sym, price, priceAt: latest?.updatedAt ?? null, sinceStartPct, market: { open: market.open, reason: market.reason }, state, rules: pos ? "exit" : "entry", met, of: checks.length, checks, position };
  });

  // Money agents: the trader's mark at executable prices when it is fresh, else oracle prices.
  const mark = agent.liveIndex !== null || agent.vault !== null ? markOf(db, agent.id) : null;
  const eq = agent.stopState === "returned" ? row.equity : mark && now - mark.at <= 90 && row.account.positions.length ? mark.equity : equity(row.account, prices);
  return {
    at: now,
    status: agent.status,
    money: agent.liveIndex === null && agent.vault === null ? "paper" : "real",
    endAt: endAt(agent),
    endedAt: agent.endedAt,
    endedReason: agent.endedReason,
    stopState: agent.stopState,
    ends: { afterMinutes: agent.strategy.endAfterMinutes ?? null, profitPct: agent.strategy.endAtProfitPct ?? null, lossPct: agent.strategy.endAtLossPct ?? null },
    cash: Math.round(row.account.cash * 100) / 100,
    equity: Math.round(eq * 100) / 100,
    startEquity: row.startEquity,
    returnPct: row.startEquity > 0 ? Math.round(((eq - row.startEquity) / row.startEquity) * 10_000) / 100 : 0,
    positions: row.account.positions.length,
    maxPositions: s.maxOpenPositions,
    symbols: rows,
    orders: agent.liveIndex === null && agent.vault === null ? [] : openOrders(db, agent.id).map((o) => ({ id: o.id, symbol: o.symbol, action: o.action, status: o.status, tx: o.tx, at: o.created_at })),
  };
}
