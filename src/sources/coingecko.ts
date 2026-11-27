/**
 * CoinGecko public API: price source for data-feed crypto markets, and a second source for
 * the Chainlink crypto feeds. No key is needed; an optional demo key raises the rate limit.
 * The free tier allows only a handful of calls per minute, so callers batch prices into one
 * request and spread history backfills over several ticks.
 */

export interface CgPrice {
  usd: number;
  /** Unix seconds of CoinGecko's last update for this coin. */
  updatedAt: number;
}

export class CoinGeckoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly maxRetryWaitMs: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: { apiKey?: string | null; baseUrl?: string; timeoutMs?: number; maxRetryWaitMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.apiKey = opts.apiKey ?? null;
    this.baseUrl = (opts.baseUrl ?? "https://api.coingecko.com/api/v3").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 8_000;
    this.fetchImpl = opts.fetchImpl;
  }

  /**
   * The public API limits requests per IP, and a host shares its IP with others, so a 429 is
   * tried again (twice) after the wait the server asks for, capped so a tick is never held long.
   */
  private async get<T>(path: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await (this.fetchImpl ?? fetch)(`${this.baseUrl}${path}`, {
        headers: { accept: "application/json", ...(this.apiKey ? { "x-cg-demo-api-key": this.apiKey } : {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 429) {
        await res.body?.cancel().catch(() => {});
        if (attempt >= 3) throw new Error("coingecko rate limit (429)");
        const asked = Number(res.headers.get("retry-after"));
        await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(asked) && asked > 0 ? asked * 1000 : 2000 * attempt, this.maxRetryWaitMs)));
        continue;
      }
      if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`);
      return (await res.json()) as T;
    }
  }

  /** Latest USD price for many coins in one request. Coins without a price are left out. */
  async prices(ids: string[]): Promise<Map<string, CgPrice>> {
    const out = new Map<string, CgPrice>();
    if (ids.length === 0) return out;
    const body = await this.get<Record<string, { usd?: number; last_updated_at?: number }>>(
      `/simple/price?ids=${ids.map(encodeURIComponent).join(",")}&vs_currencies=usd&include_last_updated_at=true`,
    );
    for (const [id, v] of Object.entries(body)) {
      if (typeof v.usd === "number" && v.usd > 0 && typeof v.last_updated_at === "number") out.set(id, { usd: v.usd, updatedAt: v.last_updated_at });
    }
    return out;
  }

  /** Hourly USD prices for the last `days` days (CoinGecko returns hourly points for 2–90 days). */
  async hourly(id: string, days: number): Promise<Array<[number, number]>> {
    const d = Math.min(90, Math.max(2, Math.ceil(days)));
    const body = await this.get<{ prices?: Array<[number, number]> }>(`/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${d}`);
    return (body.prices ?? []).filter(([t, p]) => Number.isFinite(t) && p > 0).map(([t, p]) => [Math.floor(t / 1000), p]);
  }
}
