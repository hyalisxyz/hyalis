/**
 * For every Robinhood stock token without a Chainlink feed, finds its Uniswap v4 pools
 * (USDG or ETH quote, standard fee tiers, no hook) and estimates their depth, to see which
 * tokens have an on-chain price that is good enough to trade on.
 *
 *   node scripts/scan-stock-pools.ts [minDepthUsd]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { encodeAbiParameters, erc20Abi, getAddress, hexToBigInt, keccak256, toHex, type Hex } from "viem";
import { chainClient, readLatestRounds, roundPrice } from "../src/sources/chainlink.ts";
import { loadMarkets } from "../src/config.ts";

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Hex;
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const TIERS = [[100, 1], [500, 10], [3000, 60], [10000, 200]] as const;
const ABI = [{ type: "function", name: "extsload", stateMutability: "view", inputs: [{ name: "slot", type: "bytes32" }], outputs: [{ type: "bytes32" }] }] as const;

const minDepth = Number(process.argv[2] ?? 20_000);
const c = chainClient();
const markets = loadMarkets();
const withFeed = new Set(markets.map((m) => m.symbol));
const cl = new Map((await readLatestRounds(c, markets)).map((r) => [r.symbol, roundPrice(r)]));
const ethUsd = cl.get("ETH")!;
const usdgDec = await c.readContract({ address: USDG, abi: erc20Abi, functionName: "decimals" });

const tokens = readFileSync("data/stock-token-candidates.txt", "utf8")
  .trim()
  .split("\n")
  .map((l) => l.trim().split(/\s+/) as [string, string])
  .filter(([sym]) => !withFeed.has(sym));

interface Pool { quote: "USDG" | "ETH"; fee: number; tickSpacing: number; priceUsd: number; depthUsd: number; poolId: Hex }
const found: Record<string, { token: string; pools: Pool[] }> = {};

for (const [sym, addr] of tokens) {
  const token = getAddress(addr);
  const dec = await c.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  const pools: Pool[] = [];
  const probes = [];
  for (const [quote, q, qdec, qusd] of [["USDG", USDG, usdgDec, 1], ["ETH", ZERO, 18, ethUsd]] as const) {
    for (const [fee, ts] of TIERS) {
      const [c0, c1] = BigInt(token) < BigInt(q) ? [token, getAddress(q)] : [getAddress(q), token];
      const poolId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [c0, c1, fee, ts, ZERO]));
      const base = hexToBigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n])));
      probes.push(
        Promise.all([0n, 3n].map((k) => c.readContract({ address: PM, abi: ABI, functionName: "extsload", args: [toHex(base + k, { size: 32 })] }))).then(([s0, liq]) => {
          const sqrt = hexToBigInt(s0 as Hex) & ((1n << 160n) - 1n);
          if (sqrt === 0n) return;
          const L = Number(hexToBigInt(liq as Hex) & ((1n << 128n) - 1n));
          const sq = Number(sqrt) / 2 ** 96;
          const tokenIs0 = c0 === token;
          const priceUsd = (tokenIs0 ? sq * sq : 1 / (sq * sq)) * 10 ** (dec - qdec) * qusd;
          const depthUsd = ((tokenIs0 ? L * sq : L / sq) / 10 ** qdec) * qusd;
          pools.push({ quote, fee, tickSpacing: ts, priceUsd, depthUsd, poolId });
        }),
      );
    }
  }
  await Promise.all(probes);
  found[sym] = { token, pools: pools.sort((a, b) => b.depthUsd - a.depthUsd) };
}

const liquid = Object.entries(found).filter(([, v]) => (v.pools[0]?.depthUsd ?? 0) >= minDepth);
const thin = Object.entries(found).filter(([, v]) => (v.pools[0]?.depthUsd ?? 0) < minDepth);
writeFileSync("data/stock-pools-scan.json", JSON.stringify({ scannedAt: new Date().toISOString(), minDepth, found }, null, 2) + "\n");
console.log(`scanned ${tokens.length} tokens without Chainlink; depth >= $${minDepth}: ${liquid.length}`);
for (const [sym, v] of liquid) {
  const p = v.pools[0]!;
  console.log(`  ${sym.padEnd(5)} $${p.priceUsd.toFixed(2).padStart(9)}  depth ~$${Math.round(p.depthUsd).toLocaleString()}  (${p.quote} fee ${p.fee})`);
}
console.log(`thin or no pool (${thin.length}): ${thin.map(([s]) => s).join(" ")}`);
