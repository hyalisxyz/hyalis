import { encodeAbiParameters, keccak256, getAddress, hexToBigInt, erc20Abi, toHex, type Hex } from "viem";
import { chainClient, roundPrice, readLatestRounds } from "../src/sources/chainlink.ts";
import { loadMarkets } from "../src/config.ts";

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Hex;
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const c = chainClient();
const ABI = [{ type: "function", name: "extsload", stateMutability: "view", inputs: [{ name: "slot", type: "bytes32" }], outputs: [{ type: "bytes32" }] }] as const;
const markets = loadMarkets();
const usdgDec = await c.readContract({ address: USDG, abi: erc20Abi, functionName: "decimals" });
const cl = new Map((await readLatestRounds(c, markets)).map((r) => [r.symbol, roundPrice(r)]));
const ethUsd = cl.get("ETH")!;

async function probe(sym: string, tokenAddr: string) {
  const token = getAddress(tokenAddr);
  const dec = await c.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  const out: string[] = [];
  for (const [qn, q, qdec, qusd] of [["USDG", USDG, usdgDec, 1], ["ETH", ZERO, 18, ethUsd]] as const) {
    for (const [fee, ts] of [[100, 1], [500, 10], [3000, 60], [10000, 200]] as const) {
      const [c0, c1] = BigInt(token) < BigInt(q) ? [token, getAddress(q)] : [getAddress(q), token];
      const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [c0, c1, fee, ts, ZERO]));
      const base = hexToBigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n])));
      const [s0, liq] = await Promise.all([0n, 3n].map((k) => c.readContract({ address: PM, abi: ABI, functionName: "extsload", args: [toHex(base + k, { size: 32 })] })));
      const sqrt = hexToBigInt(s0 as Hex) & ((1n << 160n) - 1n);
      if (sqrt === 0n) continue;
      const L = Number(hexToBigInt(liq as Hex) & ((1n << 128n) - 1n));
      const sq = Number(sqrt) / 2 ** 96;
      const tokenIs0 = c0 === token;
      const raw = tokenIs0 ? sq * sq : 1 / (sq * sq);
      const usd = raw * 10 ** (dec - qdec) * qusd;
      const quoteRaw = tokenIs0 ? L * sq : L / sq;
      const depthUsd = (quoteRaw / 10 ** qdec) * qusd;
      out.push(`${qn} ${fee}: $${usd.toFixed(2)} depth~$${depthUsd.toFixed(0)}`);
    }
  }
  console.log(sym.padEnd(5), "chainlink", cl.get(sym)?.toFixed(2) ?? "-", "|", out.join(" | ") || "no pools");
}

const pairs = process.argv.slice(2);
for (let i = 0; i < pairs.length; i += 2) await probe(pairs[i]!, pairs[i + 1]!);
