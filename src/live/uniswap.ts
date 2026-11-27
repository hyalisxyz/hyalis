import { encodeFunctionData, encodePacked, erc20Abi, getAddress, parseAbi, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem";

/**
 * Swaps on Uniswap V3, through the official SwapRouter02, priced by the official QuoterV2.
 * Robinhood Chain's addresses come from the Uniswap deployment list, checked on chain on
 * 2026-11-25: the router's factory() is this factory, its WETH9() is the WETH below. Other
 * chains pass their own addresses as a `Dex` (see src/chains.ts).
 *
 * Every swap: the best fee tier is chosen by quote (and, where the chain names a hub token,
 * the best two-pool route through it), the router is approved for exactly the amount being
 * sold (never more), the swap carries a minimum output and a deadline, and what was really
 * bought or sold is read from the wallet's balances before and after.
 */
export const UNISWAP = {
  factory: getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa"),
  quoter: getAddress("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"),
  router: getAddress("0xcaf681a66d020601342297493863e78c959e5cb2"),
} as const;
export const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
export const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
export const FEE_TIERS = [100, 500, 3000, 10000] as const;

/** One chain's Uniswap V3: where to quote and where to swap, and the token two-pool routes go through. */
export interface Dex {
  quoter: Address;
  router: Address;
  /** When set, a pair is also quoted through this token (two pools), and the better route is used. */
  hub?: Address;
}

/** Robinhood Chain: direct pools only, as every pair traded there has one. */
export const ROBINHOOD_DEX: Dex = { quoter: UNISWAP.quoter, router: UNISWAP.router };

export const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
export const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);
export const wethAbi = parseAbi(["function deposit() payable", "function withdraw(uint256 wad)"]);

export class SwapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapError";
  }
}

export interface Quote {
  /** Fee tier of the (first) pool. */
  fee: number;
  amountIn: bigint;
  amountOut: bigint;
  /** A two-pool route: through `mid`, the second pool at `fee2`. */
  via?: { mid: Address; fee2: number };
}

/** The fee tier of one pool that gives the most for `amountIn`; null when no pool can fill it. */
async function bestSingle(pub: PublicClient, dex: Dex, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Quote | null> {
  let best: Quote | null = null;
  for (const fee of FEE_TIERS) {
    try {
      const r = await pub.simulateContract({ address: dex.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] });
      const out = r.result[0];
      if (out > 0n && (!best || out > best.amountOut)) best = { fee, amountIn, amountOut: out };
    } catch {
      // No pool in this tier, or not enough liquidity: try the next one.
    }
  }
  return best;
}

/**
 * The route that gives the most for `amountIn`: the best single pool, or (where the Dex names a
 * hub) the best pool into the hub followed by the best pool out of it, whichever returns more.
 * Picking each leg's best in turn is the best two-pool route, since more of the hub always buys
 * more on the second leg. Null when nothing can fill it.
 */
export async function bestQuote(pub: PublicClient, tokenIn: Address, tokenOut: Address, amountIn: bigint, dex: Dex = ROBINHOOD_DEX): Promise<Quote | null> {
  const direct = await bestSingle(pub, dex, tokenIn, tokenOut, amountIn);
  const hub = dex.hub;
  if (!hub || getAddress(hub) === getAddress(tokenIn) || getAddress(hub) === getAddress(tokenOut)) return direct;
  const leg1 = await bestSingle(pub, dex, tokenIn, hub, amountIn);
  const leg2 = leg1 ? await bestSingle(pub, dex, hub, tokenOut, leg1.amountOut) : null;
  if (leg1 && leg2 && (!direct || leg2.amountOut > direct.amountOut)) return { fee: leg1.fee, amountIn, amountOut: leg2.amountOut, via: { mid: getAddress(hub), fee2: leg2.fee } };
  return direct;
}

/** Uniswap's packed path for a quote's route. */
export const pathOf = (tokenIn: Address, tokenOut: Address, q: Quote): Hex =>
  q.via ? encodePacked(["address", "uint24", "address", "uint24", "address"], [tokenIn, q.fee, q.via.mid, q.via.fee2, tokenOut]) : encodePacked(["address", "uint24", "address"], [tokenIn, q.fee, tokenOut]);

/** A readable route: "500" for one pool, "500>WETH>3000" style for two. */
export const routeLabel = (q: Pick<Quote, "fee" | "via">) => (q.via ? `${q.fee}>${q.via.mid}>${q.via.fee2}` : String(q.fee));

// ------------------------------------------------------------------ reads that see our own transactions
//
// A public RPC can answer from a node a block or two behind the one that mined our last
// transaction, and then a balance read right after a swap still shows the old balance. So each
// wallet remembers the block its last transaction was mined in, and every read for that wallet
// waits until the node has reached it and reads at that block. Transactions carry their own
// nonce and gas limit for the same reason. Both are kept per chain: the same address has its
// own blocks and nonces on each chain.

const seen = new Map<string, bigint>();
const nextNonce = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keyOf = (pub: PublicClient, who: Address) => `${pub.chain?.id ?? 0}:${who.toLowerCase()}`;

/** Records that `who`'s state changed in `block` on pub's chain (a vault, changed by its executor's transaction). */
export function markSeen(pub: PublicClient, who: Address, block: bigint) {
  const k = keyOf(pub, who);
  if (block > (seen.get(k) ?? 0n)) seen.set(k, block);
}

/** A block the node has reached that includes every transaction this wallet has had mined; undefined before the first. */
async function freshBlock(pub: PublicClient, who: Address): Promise<bigint | undefined> {
  const min = seen.get(keyOf(pub, who));
  if (min === undefined) return undefined;
  for (let i = 0; i < 60; i++) {
    const b = await pub.getBlockNumber({ cacheTime: 0 });
    if (b >= min) return b;
    await sleep(500);
  }
  throw new SwapError(`the RPC node is still behind block ${min}`);
}

/** Retries a read a few times: a node asked for a block it has not imported yet answers with an error. */
async function retry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(800);
    }
  }
}

export async function balanceOf(pub: PublicClient, token: Address, who: Address): Promise<bigint> {
  const blockNumber = await freshBlock(pub, who);
  return retry(() => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who], ...(blockNumber !== undefined ? { blockNumber } : {}) }));
}

export async function ethBalance(pub: PublicClient, who: Address): Promise<bigint> {
  const blockNumber = await freshBlock(pub, who);
  return retry(() => pub.getBalance({ address: who, ...(blockNumber !== undefined ? { blockNumber } : {}) }));
}

async function allowanceOf(pub: PublicClient, token: Address, who: Address, spender: Address): Promise<bigint> {
  const blockNumber = await freshBlock(pub, who);
  return retry(() => pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [who, spender], ...(blockNumber !== undefined ? { blockNumber } : {}) }));
}

export interface SwapResult {
  tx: Hex;
  fee: number;
  /** The second pool of a two-pool route. */
  via?: { mid: Address; fee2: number };
  /** What left the wallet and what arrived, from balances before and after. */
  spent: bigint;
  received: bigint;
  quotedOut: bigint;
  minOut: bigint;
  gasUsed: bigint;
}

/**
 * Sells exactly `amountIn` of tokenIn for tokenOut along the quote's route. `minOut` is checked
 * by the router; the caller decides it (quote less slippage, and not worse than its own
 * reference price).
 */
export async function swapExactIn(
  pub: PublicClient,
  wallet: WalletClient,
  account: LocalAccount,
  o: { tokenIn: Address; tokenOut: Address; amountIn: bigint; quote: Quote; minOut: bigint; deadlineSec: number; onSent?: (tx: Hex) => void },
  dex: Dex = ROBINHOOD_DEX,
): Promise<SwapResult> {
  const me = account.address;
  if (o.amountIn <= 0n) throw new SwapError("nothing to sell");
  const [inBefore, outBefore] = await Promise.all([balanceOf(pub, o.tokenIn, me), balanceOf(pub, o.tokenOut, me)]);
  if (inBefore < o.amountIn) throw new SwapError(`wallet holds ${inBefore} of ${o.tokenIn}, less than the ${o.amountIn} to sell`);

  // Approval for exactly this swap. A leftover allowance from an earlier failed swap is reset first.
  const allowance = await allowanceOf(pub, o.tokenIn, me, dex.router);
  if (allowance !== o.amountIn) {
    if (allowance > 0n) await send(pub, wallet, account, { to: o.tokenIn, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [dex.router, 0n] }) });
    await send(pub, wallet, account, { to: o.tokenIn, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [dex.router, o.amountIn] }) });
  }

  const call = o.quote.via
    ? encodeFunctionData({ abi: routerAbi, functionName: "exactInput", args: [{ path: pathOf(o.tokenIn, o.tokenOut, o.quote), recipient: me, amountIn: o.amountIn, amountOutMinimum: o.minOut }] })
    : encodeFunctionData({
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [{ tokenIn: o.tokenIn, tokenOut: o.tokenOut, fee: o.quote.fee, recipient: me, amountIn: o.amountIn, amountOutMinimum: o.minOut, sqrtPriceLimitX96: 0n }],
      });
  const data = encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [BigInt(o.deadlineSec), [call]] });
  const r = await send(pub, wallet, account, { to: dex.router, data, onSent: o.onSent });

  const [inAfter, outAfter] = await Promise.all([balanceOf(pub, o.tokenIn, me), balanceOf(pub, o.tokenOut, me)]);
  return { tx: r.hash, fee: o.quote.fee, ...(o.quote.via ? { via: o.quote.via } : {}), spent: inBefore - inAfter, received: outAfter - outBefore, quotedOut: o.quote.amountOut, minOut: o.minOut, gasUsed: r.gasUsed };
}

/** Simulates, sends and waits for one transaction; a revert or a timeout throws. */
export async function send(pub: PublicClient, wallet: WalletClient, account: LocalAccount, t: { to: Address; data: Hex; value?: bigint; onSent?: (tx: Hex) => void }) {
  const me = account.address;
  const key = keyOf(pub, me);
  if (wallet.chain && pub.chain && wallet.chain.id !== pub.chain.id) throw new SwapError(`wallet is on chain ${wallet.chain.id}, reads are on chain ${pub.chain.id}`);
  // Simulated and estimated on a block that already has this wallet's earlier transactions.
  const blockNumber = await freshBlock(pub, me);
  const at = blockNumber !== undefined ? { blockNumber } : {};
  try {
    await pub.call({ account: me, to: t.to, data: t.data, value: t.value, ...at });
  } catch (e) {
    throw new SwapError(`would revert: ${(e as Error).message.split("\n")[0]}`);
  }
  const gas = await retry(() => pub.estimateGas({ account: me, to: t.to, data: t.data, value: t.value, ...at }));
  const nonce = Math.max(await retry(() => pub.getTransactionCount({ address: me, blockTag: "pending" })), nextNonce.get(key) ?? 0);
  // Robinhood Chain and Arbitrum One have no priority auction: no tip, and a fee cap of twice
  // the base fee, so a small gas reserve is not tied up by a wallet's default fee estimate.
  const base = (await pub.getBlock()).baseFeePerGas ?? (await pub.getGasPrice());
  const hash = await wallet.sendTransaction({ account, chain: wallet.chain, to: t.to, data: t.data, value: t.value, gas: (gas * 3n) / 2n, nonce, maxFeePerGas: base * 2n, maxPriorityFeePerGas: 0n });
  nextNonce.set(key, nonce + 1);
  t.onSent?.(hash);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.blockNumber > (seen.get(key) ?? 0n)) seen.set(key, r.blockNumber);
  if (r.status !== "success") throw new SwapError(`transaction ${hash} reverted`);
  return { hash, gasUsed: r.gasUsed, blockNumber: r.blockNumber };
}
