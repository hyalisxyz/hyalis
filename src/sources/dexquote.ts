import { getAddress, type PublicClient } from "viem";
import { bestQuote, USDG } from "../live/uniswap.ts";

/**
 * Executable quotes on Robinhood Chain, read straight from Uniswap V3 (the official QuoterV2,
 * best fee tier), with no third party in between. Used as:
 *  - a second price for the gate (what a trade would really get, not an oracle), and
 *  - the fill price of paper trades, with real spread, pool fees and price impact.
 */

export const USDG_DECIMALS = 6;

export interface DexSpread {
  /** USDG paid per token bought, at this size. */
  ask: number;
  /** USDG received per token sold, at this size. */
  bid: number;
  venues: string[];
  /** Unix seconds. */
  quotedAt: number;
}

export class DexQuoteClient {
  private readonly pub: PublicClient;
  constructor(pub: PublicClient) {
    this.pub = pub;
  }

  /**
   * What buying and selling about `usd` of a token would really cost, in USD per token. Both
   * include the pool fee and the price impact at that size.
   */
  async spread(token: string, decimals: number, refPriceUsd: number, usd = 1000): Promise<DexSpread> {
    const t = getAddress(token);
    const usdIn = BigInt(Math.round(usd * 10 ** USDG_DECIMALS));
    const buy = await bestQuote(this.pub, USDG, t, usdIn);
    if (!buy) throw new Error("no Uniswap pool can fill this buy");
    const ask = usd / (Number(buy.amountOut) / 10 ** decimals);
    // Sell the same dollar size, sized from the reference price so the two legs match.
    const tokIn = BigInt(Math.round((usd / refPriceUsd) * 10 ** Math.min(decimals, 12))) * 10n ** BigInt(Math.max(0, decimals - 12));
    const sell = await bestQuote(this.pub, t, USDG, tokIn);
    if (!sell) throw new Error("no Uniswap pool can fill this sell");
    const bid = Number(sell.amountOut) / 10 ** USDG_DECIMALS / (Number(tokIn) / 10 ** decimals);
    return { ask, bid, venues: ["Uniswap V3"], quotedAt: Math.floor(Date.now() / 1000) };
  }
}
