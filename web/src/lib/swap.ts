import { concat, encodeFunctionData, erc20Abi, numberToHex, parseAbi, type Address, type Hex } from "viem";
import { publicClient } from "./chain";

/**
 * Swaps for the Trade page, straight on the official Uniswap V3 router on Robinhood Chain,
 * signed in the user's own wallet. Quotes come from the official QuoterV2. A pair that has no
 * direct pool goes through USDG in one transaction.
 */
export const ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2" as Address;
export const QUOTER = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7" as Address;
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const FEES = [100, 500, 3000, 10000] as const;
/** SwapRouter02's stand-in for "the router itself", used when it unwraps WETH into ETH. */
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address;

const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);

export interface TradeToken {
  symbol: string;
  address: Address | "ETH";
  decimals: number;
}

/** The ERC-20 a token trades as in the pools: ETH trades as WETH. */
export const poolToken = (t: TradeToken): Address => (t.address === "ETH" ? WETH : t.address);

export interface Route {
  /** One pool: its fee tier. Two pools: through USDG, a fee tier per pool. */
  fees: number[];
  amountIn: bigint;
  amountOut: bigint;
}

async function single(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<{ fee: number; out: bigint } | null> {
  const got = await Promise.all(
    FEES.map((fee) =>
      publicClient
        .simulateContract({ address: QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] })
        .then((r) => ({ fee, out: r.result[0] }))
        .catch(() => null),
    ),
  );
  return got.reduce<{ fee: number; out: bigint } | null>((best, x) => (x && x.out > 0n && (!best || x.out > best.out) ? x : best), null);
}

const path = (a: Address, f1: number, mid: Address, f2: number, b: Address): Hex => concat([a, numberToHex(f1, { size: 3 }), mid, numberToHex(f2, { size: 3 }), b]);

/** The best route for selling `amountIn` of `from` for `to`: the best direct pool, or through USDG. */
export async function quote(from: TradeToken, to: TradeToken, amountIn: bigint): Promise<Route | null> {
  const a = poolToken(from);
  const b = poolToken(to);
  if (a === b) return null;
  const direct = await single(a, b, amountIn);
  let best: Route | null = direct ? { fees: [direct.fee], amountIn, amountOut: direct.out } : null;
  if (a !== USDG && b !== USDG) {
    const leg1 = await single(a, USDG, amountIn);
    if (leg1) {
      const leg2 = await single(USDG, b, leg1.out);
      if (leg2) {
        // The two legs priced together, as the router will run them.
        const both = await publicClient
          .simulateContract({ address: QUOTER, abi: quoterAbi, functionName: "quoteExactInput", args: [path(a, leg1.fee, USDG, leg2.fee, b), amountIn] })
          .then((r) => r.result[0])
          .catch(() => 0n);
        if (both > 0n && (!best || both > best.amountOut)) best = { fees: [leg1.fee, leg2.fee], amountIn, amountOut: both };
      }
    }
  }
  return best;
}

/** The router call for a route: value is the ETH sent along when selling ETH. */
export function swapCall(from: TradeToken, to: TradeToken, r: Route, minOut: bigint, me: Address, deadlineSec: number): { to: Address; data: Hex; value: bigint } {
  const a = poolToken(from);
  const b = poolToken(to);
  const ethOut = to.address === "ETH";
  const recipient = ethOut ? ADDRESS_THIS : me;
  const swap =
    r.fees.length === 1
      ? encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{ tokenIn: a, tokenOut: b, fee: r.fees[0]!, recipient, amountIn: r.amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] })
      : encodeFunctionData({ abi: routerAbi, functionName: "exactInput", args: [{ path: path(a, r.fees[0]!, USDG, r.fees[1]!, b), recipient, amountIn: r.amountIn, amountOutMinimum: minOut }] });
  const calls = ethOut ? [swap, encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [minOut, me] })] : [swap];
  return { to: ROUTER, data: encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [BigInt(deadlineSec), calls] }), value: from.address === "ETH" ? r.amountIn : 0n };
}

export async function balanceOf(t: TradeToken, me: Address): Promise<bigint> {
  if (t.address === "ETH") return publicClient.getBalance({ address: me });
  return publicClient.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [me] });
}

export const allowanceOf = (token: Address, me: Address) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [me, ROUTER] });
export const approveCall = (token: Address, amount: bigint) => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, amount] }) });
