import type { DatabaseSync } from "node:sqlite";
import { decodeEventLog, formatUnits, getAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import type { Market } from "../config.ts";
import { addReceipt, epochOf } from "../engine/epochs.ts";
import { UNISWAP, USDG, WETH } from "../live/uniswap.ts";

/**
 * Manual trades: swaps a user makes on the Trade page, signed in their own wallet and sent
 * straight to the official Uniswap V3 router. Hyalis never holds the funds. After the swap the
 * page sends the transaction hash; the server reads the transaction from the chain and records
 * only what the chain says: who sent it, that it went to the router and succeeded, and which of
 * the listed tokens left and reached the sender's wallet. Each recorded trade is sealed as a
 * "trade" receipt under the stream "wallet:<address>".
 */

const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const withdrawalAbi = parseAbi(["event Withdrawal(address indexed src, uint256 wad)"]);

export interface TradeToken {
  symbol: string;
  address: Address | "ETH";
  decimals: number;
}

/** The tokens the Trade page offers: ETH, USDG and every market with a token on Robinhood Chain. */
export function tradeTokens(markets: Market[]): TradeToken[] {
  const list: TradeToken[] = [
    { symbol: "ETH", address: "ETH", decimals: 18 },
    { symbol: "USDG", address: USDG, decimals: 6 },
  ];
  for (const m of markets) if (m.token && m.symbol !== "ETH") list.push({ symbol: m.symbol, address: getAddress(m.token), decimals: m.tokenDecimals ?? 18 });
  // WETH is listed for wallets that hold it already; ETH is what most people hold.
  list.push({ symbol: "WETH", address: WETH, decimals: 18 });
  return list;
}

export interface TradeRow {
  tx: string;
  wallet: string;
  sellSymbol: string;
  sellAmount: string;
  buySymbol: string;
  buyAmount: string;
  block: number;
  at: number;
  receipt: number | null;
}

export class TradeError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "TradeError";
    this.status = status;
  }
}

/** Reads a swap transaction from the chain and records it; recording the same one again returns it. */
export async function recordTrade(db: DatabaseSync, pub: PublicClient, markets: Market[], txHash: Hex, epochSec: number, now: number): Promise<TradeRow> {
  const known = tradeOf(db, txHash);
  if (known) return known;
  const [tx, r] = await Promise.all([pub.getTransaction({ hash: txHash }).catch(() => null), pub.getTransactionReceipt({ hash: txHash }).catch(() => null)]);
  if (!tx || !r) throw new TradeError("transaction not found yet; try again in a few seconds", 404);
  if (r.status !== "success") throw new TradeError("the transaction failed on chain");
  if (!tx.to || getAddress(tx.to) !== UNISWAP.router) throw new TradeError("not a swap through the Uniswap V3 router");
  const me = getAddress(tx.from);
  const tokens = tradeTokens(markets);
  const byAddr = new Map(tokens.filter((t) => t.address !== "ETH").map((t) => [(t.address as string).toLowerCase(), t]));

  let sell: { t: TradeToken; amount: bigint } | null = tx.value > 0n ? { t: tokens[0]!, amount: tx.value } : null;
  let buy: { t: TradeToken; amount: bigint } | null = null;
  let ethOut = 0n;
  for (const log of r.logs) {
    const t = byAddr.get(log.address.toLowerCase());
    try {
      const e = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics });
      if (!t) continue;
      if (getAddress(e.args.from) === me && !sell) sell = { t, amount: e.args.value };
      else if (getAddress(e.args.to) === me) {
        const prev = buy as { t: TradeToken; amount: bigint } | null;
        buy = { t, amount: (prev && prev.t === t ? prev.amount : 0n) + e.args.value };
      }
      continue;
    } catch {
      /* not a Transfer */
    }
    try {
      const e = decodeEventLog({ abi: withdrawalAbi, data: log.data, topics: log.topics });
      if (log.address.toLowerCase() === WETH.toLowerCase() && getAddress(e.args.src) === UNISWAP.router) ethOut += e.args.wad;
    } catch {
      /* not a Withdrawal */
    }
  }
  // Bought ETH: the router unwrapped WETH and sent the ETH on, so no token reached the wallet. The
  // amount is the WETH unwrapped by the router, or (for a WETH that logs no Withdrawal) the change
  // in the wallet's ETH across the block, with the gas paid added back.
  if (!buy && ethOut === 0n) {
    const [before, after] = await Promise.all([pub.getBalance({ address: me, blockNumber: r.blockNumber - 1n }), pub.getBalance({ address: me, blockNumber: r.blockNumber })]);
    const delta = after - before + r.gasUsed * r.effectiveGasPrice + tx.value;
    if (delta > 0n) ethOut = delta;
  }
  if (!buy && ethOut > 0n) buy = { t: tokens[0]!, amount: ethOut };
  if (!sell || !buy) throw new TradeError("could not read what this swap sold and bought");

  const block = await pub.getBlock({ blockNumber: r.blockNumber });
  const at = Number(block.timestamp);
  const row: TradeRow = {
    tx: txHash.toLowerCase(),
    wallet: me,
    sellSymbol: sell.t.symbol,
    sellAmount: formatUnits(sell.amount, sell.t.decimals),
    buySymbol: buy.t.symbol,
    buyAmount: formatUnits(buy.amount, buy.t.decimals),
    block: Number(r.blockNumber),
    at,
    receipt: null,
  };
  db.exec("BEGIN");
  try {
    const leaf = addReceipt(db, `wallet:${me}`, epochOf(now, epochSec), "trade", {
      at: now,
      wallet: me,
      tx: row.tx,
      block: row.block,
      minedAt: at,
      venue: "uniswap-v3",
      sell: { symbol: row.sellSymbol, amount: row.sellAmount },
      buy: { symbol: row.buySymbol, amount: row.buyAmount },
    }, now);
    const id = Number((db.prepare("SELECT id FROM receipts WHERE leaf = ?").get(leaf) as { id: number }).id);
    db.prepare("INSERT INTO user_trades (tx, wallet, sell_symbol, sell_amount, buy_symbol, buy_amount, block, at, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      row.tx, row.wallet, row.sellSymbol, row.sellAmount, row.buySymbol, row.buyAmount, row.block, row.at, id, now,
    );
    db.exec("COMMIT");
    row.receipt = id;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return row;
}

const toRow = (r: any): TradeRow => ({
  tx: r.tx, wallet: r.wallet, sellSymbol: r.sell_symbol, sellAmount: r.sell_amount, buySymbol: r.buy_symbol, buyAmount: r.buy_amount, block: Number(r.block), at: Number(r.at), receipt: r.receipt_id ?? null,
});

export const tradeOf = (db: DatabaseSync, tx: string) => {
  const r = db.prepare("SELECT * FROM user_trades WHERE tx = ?").get(tx.toLowerCase());
  return r ? toRow(r) : null;
};

export const tradesOf = (db: DatabaseSync, wallet: string, limit = 50) =>
  db.prepare("SELECT * FROM user_trades WHERE wallet = ? ORDER BY at DESC LIMIT ?").all(getAddress(wallet), limit).map(toRow);
