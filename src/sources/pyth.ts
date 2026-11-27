/**
 * Pyth prices, used as the second, independent source for crypto.
 *
 * Entitlement is per feed: measured on 2026-11-21, the key returns prices for BTC and ETH
 * and 403 for LINK, ENA and every equity feed. So each feed is requested on its own, a
 * refused feed does not fail the others, and refused feeds are not asked again for a while.
 * A symbol without a Pyth price simply runs on Chainlink alone, like the stocks.
 */

export interface PythPrice {
  id: string;
  price: number;
  conf: number;
  /** Unix seconds. */
  publishTime: number;
}

export interface PythResult {
  prices: Map<string, PythPrice>;
  /** Feeds the key is not entitled to. */
  denied: string[];
  /** Feeds that failed for any other reason (network, 5xx). */
  failed: string[];
}

const norm = (id: string) => id.replace(/^0x/, "").toLowerCase();

export class PythClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly deniedUntil = new Map<string, number>();
  private readonly denyRetryMs: number;

  constructor(apiKey: string, baseUrl = "https://hermes.pyth.network", timeoutMs = 10_000, denyRetryMs = 6 * 3600_000) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
    this.denyRetryMs = denyRetryMs;
  }

  private async one(id: string): Promise<PythPrice | "denied"> {
    const res = await fetch(`${this.baseUrl}/v2/updates/price/latest?parsed=true&ids[]=${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 403) return "denied";
    if (!res.ok) throw new Error(`pyth HTTP ${res.status}`);
    const body = (await res.json()) as { parsed?: Array<{ id: string; price: { price: string; conf: string; expo: number; publish_time: number } }> };
    const p = body.parsed?.[0];
    if (!p || norm(p.id) !== id) throw new Error("pyth returned no price for the feed");
    const scale = 10 ** p.price.expo;
    return { id, price: Number(p.price.price) * scale, conf: Number(p.price.conf) * scale, publishTime: p.price.publish_time };
  }

  async latest(ids: string[], nowMs = Date.now()): Promise<PythResult> {
    const out: PythResult = { prices: new Map(), denied: [], failed: [] };
    const wanted = [...new Set(ids.map(norm))];
    const ask = wanted.filter((id) => (this.deniedUntil.get(id) ?? 0) <= nowMs);
    for (const id of wanted) if (!ask.includes(id)) out.denied.push(id);

    const settled = await Promise.allSettled(ask.map((id) => this.one(id)));
    settled.forEach((r, k) => {
      const id = ask[k]!;
      if (r.status === "rejected") out.failed.push(id);
      else if (r.value === "denied") {
        this.deniedUntil.set(id, nowMs + this.denyRetryMs);
        out.denied.push(id);
      } else out.prices.set(id, r.value);
    });
    return out;
  }
}
