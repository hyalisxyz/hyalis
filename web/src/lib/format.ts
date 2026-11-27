export const short = (s: string | null | undefined, a = 6, b = 4) => (s ? (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s) : "");

export function money(n: number | null | undefined, digits?: number) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  // Digits by size, so a loss of $255 is not shown with eight decimals; the sign goes before the $.
  const a = Math.abs(n);
  const d = digits ?? (a >= 1 || a === 0 ? 2 : a >= 0.01 ? 4 : 8);
  const s = `$${a.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  return n < 0 && Number(a.toFixed(d)) !== 0 ? `-${s}` : s;
}

export const pct = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? "–" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;

export const int = (n: number | null | undefined) => (n === null || n === undefined ? "–" : n.toLocaleString("en-US"));

export function ago(unixSec: number | null | undefined) {
  if (!unixSec) return "–";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const date = (unixSec: number) =>
  new Date(unixSec * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export const tokens = (s: string | number) => Number(s).toLocaleString("en-US", { maximumFractionDigits: 0 });

/** One plain sentence for a receipt's decision, for feeds and receipts. */
export function decisionLine(r: any): { verb: string; side: "long" | "short" | null; symbol: string; price: number | null } {
  if (r?.fill?.action === "liquidate") return { verb: "Liquidated", side: r.fill.side, symbol: r.symbol ?? r.fill.symbol, price: r.fill.price };
  const d = r?.decision ?? {};
  const side = d.side ?? r?.fill?.side ?? null;
  const closing = d.kind === "close" || r?.fill?.action === "close";
  const verb = closing ? (side === "short" ? "Cover" : "Sell") : side === "short" ? "Short" : "Buy";
  return { verb, side, symbol: d.symbol ?? r?.symbol ?? r?.fill?.symbol ?? "", price: r?.fill?.price ?? null };
}

/** Older receipts wrote comparisons as code ("lt", "gt"); read them as words. */
export const plain = (t: string) => t.replace(/\blt\b/g, "below").replace(/\bgt\b/g, "above");

/** The hour a receipt was sealed in, as people read it: "Nov 25, 17:00–18:00 UTC". */
export function sealedHour(epoch: number, epochSec = 3600): string {
  const a = new Date(epoch * epochSec * 1000);
  const b = new Date((epoch + 1) * epochSec * 1000);
  const day = a.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${day}, ${a.toISOString().slice(11, 16)}–${b.toISOString().slice(11, 16)} UTC`;
}

/** Price sources as people know them; older receipts carry their internal labels. */
const SOURCES: Record<string, string> = { "pyth-or-coingecko": "Pyth / CoinGecko", pyth: "Pyth", coingecko: "CoinGecko", plankton: "Second market feed", "dex-quote": "Live DEX quote" };
export const sourceName = (s: string) => SOURCES[s] ?? "Live DEX quote";
