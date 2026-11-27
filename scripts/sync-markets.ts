/**
 * Builds data/markets.json.
 *
 * Verified markets (price from a Chainlink feed on Robinhood Chain, checkable on chain):
 *  - equities: the stock and ETF feeds that follow US market hours (24/5)
 *  - crypto: BTC, ETH, LINK, ENA (24/7), with Pyth and CoinGecko ids as second sources
 * Data-feed markets (price from CoinGecko, recorded but not checkable on chain, paper only):
 *  - a curated list of major crypto assets. Stablecoins, wrapped duplicates, exchange and
 *    real-world-asset tokens are left out on purpose.
 *
 *   npm run sync-markets
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { getAddress } from "viem";

const DIRECTORY = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";
const PYTH_META = "https://hermes.pyth.network/v2/price_feeds?asset_type=crypto";
const COINGECKO = "https://api.coingecko.com/api/v3/simple/price";

/** Crypto with a Chainlink feed on Robinhood Chain: symbol -> CoinGecko id. */
const CHAINLINK_CRYPTO: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum", LINK: "chainlink", ENA: "ethena" };

/** Major crypto without a Chainlink feed there, priced from CoinGecko: symbol -> CoinGecko id. */
const DATA_FEED_CRYPTO: Record<string, string> = {
  SOL: "solana",
  BNB: "binancecoin",
  XRP: "ripple",
  DOGE: "dogecoin",
  ADA: "cardano",
  TRX: "tron",
  AVAX: "avalanche-2",
  LTC: "litecoin",
  BCH: "bitcoin-cash",
  DOT: "polkadot",
  NEAR: "near",
  SUI: "sui",
  HBAR: "hedera-hashgraph",
  TAO: "bittensor",
  UNI: "uniswap",
  XLM: "stellar",
  SHIB: "shiba-inu",
  HYPE: "hyperliquid",
  ATOM: "cosmos",
  APT: "aptos",
  ARB: "arbitrum",
  OP: "optimism",
  AAVE: "aave",
  PEPE: "pepe",
  TON: "the-open-network",
  ETC: "ethereum-classic",
  FIL: "filecoin",
  INJ: "injective-protocol",
};

/** CoinGecko prices refresh every few minutes; older than this is treated as stale by the gate. */
const DATA_FEED_HEARTBEAT_SEC = 900;

interface DirectoryFeed {
  name: string;
  proxyAddress: string | null;
  decimals: number;
  heartbeat: number;
  threshold: number;
  docs?: { baseAsset?: string; marketHours?: string };
}

const res = await fetch(DIRECTORY);
if (!res.ok) throw new Error(`directory returned HTTP ${res.status}`);
const feeds = (await res.json()) as DirectoryFeed[];

// Pyth metadata needs no API key; only prices do.
const pyth = (await (await fetch(PYTH_META)).json()) as Array<{ id: string; attributes: { symbol: string } }>;
const pythId = (sym: string) => pyth.find((f) => f.attributes.symbol === `Crypto.${sym}/USD`)?.id;

// Every CoinGecko id must resolve to a live price, or the build stops.
const allIds = [...Object.values(CHAINLINK_CRYPTO), ...Object.values(DATA_FEED_CRYPTO)];
const cg = (await (await fetch(`${COINGECKO}?ids=${allIds.join(",")}&vs_currencies=usd`)).json()) as Record<string, { usd?: number }>;
const badIds = allIds.filter((id) => !(cg[id]?.usd! > 0));
if (badIds.length) throw new Error(`CoinGecko ids without a price: ${badIds.join(", ")}`);

const markets = new Map<string, Record<string, unknown>>();
for (const f of feeds) {
  if (!f.proxyAddress) continue;
  const base = { source: "chainlink", feed: getAddress(f.proxyAddress), decimals: f.decimals, heartbeatSec: f.heartbeat, deviationPct: f.threshold };

  if (f.name.startsWith("Robinhood ") && f.docs?.marketHours === "us_equities_24/5") {
    // "Robinhood AAPL / USD" or "Robinhood DELL-USD"
    const m = /^Robinhood ([A-Z.]+)\s*[-/]\s*USD$/.exec(f.name.trim());
    if (m && !markets.has(m[1]!)) markets.set(m[1]!, { symbol: m[1]!, assetClass: "equity", ...base });
    continue;
  }

  const m = /^([A-Z]+) \/ USD$/.exec(f.name.trim());
  if (m && CHAINLINK_CRYPTO[m[1]!] && f.docs?.marketHours === "Crypto" && !markets.has(m[1]!)) {
    const id = pythId(m[1]!);
    markets.set(m[1]!, { symbol: m[1]!, assetClass: "crypto", ...base, coingeckoId: CHAINLINK_CRYPTO[m[1]!], ...(id ? { pythId: id } : {}) });
  }
}

const missing = Object.keys(CHAINLINK_CRYPTO).filter((s) => !markets.has(s));
if (missing.length) throw new Error(`Chainlink crypto feeds not found in the directory: ${missing.join(", ")}`);

for (const [symbol, id] of Object.entries(DATA_FEED_CRYPTO)) {
  if (markets.has(symbol)) throw new Error(`${symbol} is listed twice`);
  markets.set(symbol, {
    symbol,
    assetClass: "crypto",
    source: "coingecko",
    feed: `coingecko:${id}`,
    coingeckoId: id,
    decimals: 8,
    heartbeatSec: DATA_FEED_HEARTBEAT_SEC,
    deviationPct: 0,
  });
}

// Tradable tokens on Robinhood Chain: the stock token list was checked on chain (symbol and
// contract) in data/stock-token-candidates.txt; ETH trades as WETH. Decimals are 18 for both.
const stockTokens = Object.fromEntries(
  readFileSync("data/stock-token-candidates.txt", "utf8").trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/) as [string, string]),
);
for (const m of markets.values()) {
  if (m.assetClass === "equity" && stockTokens[String(m.symbol)]) Object.assign(m, { token: getAddress(stockTokens[String(m.symbol)]!), tokenDecimals: 18 });
}
const eth = markets.get("ETH");
if (eth) Object.assign(eth, { token: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"), tokenDecimals: 18 });

const order = (m: Record<string, unknown>) => (m.source === "chainlink" ? 0 : 1) * 10 + (m.assetClass === "crypto" ? 0 : 1);
const sorted = [...markets.values()].sort((a, b) => order(a) - order(b) || String(a.symbol).localeCompare(String(b.symbol)));
mkdirSync("data", { recursive: true });
writeFileSync(
  "data/markets.json",
  JSON.stringify({ chainId: 4663, source: DIRECTORY, syncedAt: new Date().toISOString(), markets: sorted }, null, 2) + "\n",
);
const count = (fn: (m: Record<string, unknown>) => boolean) => sorted.filter(fn).length;
console.log(
  `wrote ${sorted.length} markets: verified ${count((m) => m.source === "chainlink")} ` +
    `(${count((m) => m.source === "chainlink" && m.assetClass === "equity")} equity, ${count((m) => m.source === "chainlink" && m.assetClass === "crypto")} crypto), ` +
    `data feed ${count((m) => m.source === "coingecko")} crypto`,
);
