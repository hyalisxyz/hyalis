/**
 * Read-only client for Plankton's public API (perps on small-cap stock tokens).
 * Used as a second price source and for halt / catalyst context. It never sends orders.
 */

export interface PlanktonMark {
  symbol: string;
  price: number | null;
  status: string;
  fresh: boolean;
  breaker: boolean;
  /** Unix seconds. */
  observedAt: number;
  confidenceBps: number;
}

export class PlanktonClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  // The public API is on a host that can take tens of seconds to wake up.
  constructor(baseUrl: string, timeoutMs = 45_000) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`plankton ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async marks(): Promise<PlanktonMark[]> {
    const body = await this.get<{ markets: Array<Record<string, unknown>> }>("/v1/feed");
    return body.markets.map((m) => ({
      symbol: String(m.symbol),
      price: m.price === null || m.price === undefined ? null : Number(m.price),
      status: String(m.status ?? "unknown"),
      fresh: Boolean(m.fresh),
      breaker: Boolean(m.breaker),
      observedAt: Number(m.observedAt ?? 0),
      confidenceBps: Number(m.confidenceBps ?? 0),
    }));
  }

  /** Symbols Plankton reports as halted. Empty on any error, so callers treat it as advisory. */
  async halts(): Promise<Set<string>> {
    try {
      const body = await this.get<unknown>("/v1/halts");
      const list = Array.isArray(body) ? body : ((body as { halts?: unknown[] })?.halts ?? []);
      return new Set(list.map((h) => String((h as { symbol?: string }).symbol ?? "")).filter(Boolean));
    } catch {
      return new Set();
    }
  }
}
