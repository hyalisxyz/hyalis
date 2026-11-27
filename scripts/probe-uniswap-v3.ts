/**
 * Uniswap V3 on Robinhood Chain: for each market token, the USDG pools in every fee tier, their
 * liquidity, and what $2.50 would buy and sell for through the official QuoterV2.
 *
 *   node --env-file-if-exists=.env scripts/probe-uniswap-v3.ts [SYMBOL ...]
 */
import { erc20Abi, formatUnits, getAddress, parseAbi, type Address } from "viem";
import { loadMarkets } from "../src/config.ts";
import { chainClient } from "../src/sources/chainlink.ts";

// Official deployment (developers.uniswap.org, v3-robinhood-chain-deployments).
const FACTORY = getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa");
const QUOTER = getAddress("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
const ROUTER = getAddress("0xcaf681a66d020601342297493863e78c959e5cb2");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const FEES = [100, 500, 3000, 10000] as const;

const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const poolAbi = parseAbi(["function liquidity() view returns (uint128)", "function factory() view returns (address)", "function fee() view returns (uint24)"]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const routerAbi = parseAbi(["function factory() view returns (address)", "function WETH9() view returns (address)"]);

const c = chainClient(process.env.RPC_URL || undefined);
const want = process.argv.slice(2);
const markets = loadMarkets().filter((m) => m.token && (want.length ? want.includes(m.symbol) : ["ETH", "AAPL", "GOOGL", "AMZN", "NVDA", "MSFT", "META"].includes(m.symbol)));

for (const [name, a] of [["factory", FACTORY], ["quoter", QUOTER], ["router", ROUTER]] as const) {
  const code = await c.getCode({ address: a });
  console.log(`${name.padEnd(8)} ${a} code ${code ? (code.length - 2) / 2 : 0} bytes`);
}
const [rf, weth] = await Promise.all([c.readContract({ address: ROUTER, abi: routerAbi, functionName: "factory" }), c.readContract({ address: ROUTER, abi: routerAbi, functionName: "WETH9" })]);
console.log(`router.factory ${rf} ${getAddress(rf) === FACTORY ? "(matches)" : "(MISMATCH)"}; WETH9 ${weth}\n`);

const usd = 2_500_000n; // 2.50 USDG
for (const m of markets) {
  const token = getAddress(m.token!);
  const dec = await c.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  const lines: string[] = [];
  for (const fee of FEES) {
    const pool = (await c.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getPool", args: [USDG, token, fee] })) as Address;
    if (/^0x0+$/.test(pool)) continue;
    const liq = await c.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" });
    let buy = "-", sell = "-";
    try {
      const b = await c.simulateContract({ address: QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: USDG, tokenOut: token, amountIn: usd, fee, sqrtPriceLimitX96: 0n }] });
      const got = b.result[0];
      buy = `${formatUnits(got, dec)} for $2.50 (ask ${(2.5 / Number(formatUnits(got, dec))).toFixed(2)})`;
      const s = await c.simulateContract({ address: QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: token, tokenOut: USDG, amountIn: got, fee, sqrtPriceLimitX96: 0n }] });
      sell = `back to $${formatUnits(s.result[0], 6)}`;
    } catch (e) {
      buy = `no quote (${(e as Error).message.split("\n")[0]!.slice(0, 60)})`;
    }
    lines.push(`  fee ${String(fee).padStart(5)} pool ${pool} liquidity ${liq}  ${buy}  ${sell}`);
  }
  console.log(`${m.symbol} ${token}`);
  console.log(lines.length ? lines.join("\n") : "  no USDG pool on Uniswap V3");
}
