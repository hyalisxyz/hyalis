/**
 * Paper broker. Isolated margin: a position can lose at most its own margin.
 * Spot is a long position at 1x. Shorts and anything above 1x are perps.
 * Funding is not simulated yet; that is listed as a known gap in the README.
 */

export type Venue = "spot" | "perp";

export interface Position {
  symbol: string;
  side: "long" | "short";
  venue: Venue;
  qty: number;
  entryPrice: number;
  leverage: number;
  margin: number;
  /** Unix seconds. */
  openedAt: number;
}

export interface Account {
  cash: number;
  positions: Position[];
  /** Unix seconds of the last exit per symbol, for the re-entry cooldown. */
  lastExit?: Record<string, number>;
  /** Highest equity seen, for the drawdown limit. */
  peak?: number;
}

export const FEE_BPS: Record<Venue, number> = { spot: 10, perp: 8 };
/** A perp is liquidated once its loss reaches this share of its margin. */
export const LIQUIDATION_AT = 0.9;

export const venueFor = (side: "long" | "short", leverage: number): Venue => (side === "short" || leverage > 1 ? "perp" : "spot");

export function unrealized(p: Position, price: number): number {
  return (price - p.entryPrice) * p.qty * (p.side === "long" ? 1 : -1);
}

export function equity(a: Account, prices: ReadonlyMap<string, number>): number {
  let e = a.cash;
  for (const p of a.positions) {
    const px = prices.get(p.symbol) ?? p.entryPrice;
    e += p.margin + Math.max(unrealized(p, px), -p.margin);
  }
  return e;
}

export interface Fill {
  action: "open" | "close" | "liquidate";
  symbol: string;
  side: "long" | "short";
  venue: Venue;
  price: number;
  qty: number;
  notional: number;
  fee: number;
  /** Realized PnL after fees; 0 on open. */
  pnl: number;
}

export function openPosition(
  a: Account,
  o: { symbol: string; side: "long" | "short"; leverage: number; positionPct: number; price: number; now: number; feeBps?: number },
  equityNow: number,
): { account: Account; fill: Fill } | { error: string } {
  const venue = venueFor(o.side, o.leverage);
  const notional = (equityNow * o.positionPct) / 100;
  const margin = notional / o.leverage;
  // feeBps 0 when the price is an executable quote that already includes every fee.
  const fee = (notional * (o.feeBps ?? FEE_BPS[venue])) / 10_000;
  if (notional <= 0) return { error: "position size is zero" };
  if (margin + fee > a.cash + 1e-9) return { error: `not enough cash: need ${(margin + fee).toFixed(2)}, have ${a.cash.toFixed(2)}` };
  const qty = notional / o.price;
  const pos: Position = { symbol: o.symbol, side: o.side, venue, qty, entryPrice: o.price, leverage: o.leverage, margin, openedAt: o.now };
  return {
    account: { ...a, cash: a.cash - margin - fee, positions: [...a.positions, pos] },
    fill: { action: "open", symbol: o.symbol, side: o.side, venue, price: o.price, qty, notional, fee, pnl: 0 },
  };
}

export function closePosition(
  a: Account,
  symbol: string,
  price: number,
  now: number,
  action: "close" | "liquidate" = "close",
  feeBps?: number,
): { account: Account; fill: Fill } | { error: string } {
  const p = a.positions.find((x) => x.symbol === symbol);
  if (!p) return { error: `no open position in ${symbol}` };
  const notional = p.qty * price;
  const fee = (notional * (feeBps ?? FEE_BPS[p.venue])) / 10_000;
  const gross = Math.max(unrealized(p, price), -p.margin);
  const back = Math.max(0, p.margin + gross - fee);
  return {
    account: { cash: a.cash + back, positions: a.positions.filter((x) => x !== p), lastExit: { ...a.lastExit, [symbol]: now } },
    fill: { action, symbol, side: p.side, venue: p.venue, price, qty: p.qty, notional, fee, pnl: back - p.margin },
  };
}

/** Symbols whose perp has lost enough margin to be liquidated at these prices. */
export function liquidatable(a: Account, prices: ReadonlyMap<string, number>): string[] {
  return a.positions
    .filter((p) => p.venue === "perp")
    .filter((p) => {
      const px = prices.get(p.symbol);
      return px !== undefined && unrealized(p, px) <= -p.margin * LIQUIDATION_AT;
    })
    .map((p) => p.symbol);
}
