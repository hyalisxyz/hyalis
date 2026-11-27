/**
 * Deploys the AgentVault factory and the Uniswap V3 adapter on Arbitrum One.
 *
 *   node --env-file=.env scripts/deploy-vault-arbitrum.ts          (dry run: checks everything, sends nothing)
 *   node --env-file=.env scripts/deploy-vault-arbitrum.ts --send
 *
 * Same contracts as on Robinhood Chain: the cash token is USDC, every tradable token has its
 * Chainlink feed on Arbitrum One (src/chains.ts), and the adapter routes through Arbitrum's
 * SwapRouter02. The deployer and factory admin is the house wallet (ANCHOR_PRIVATE_KEY), which
 * needs a little ETH on Arbitrum One. The key is never printed.
 */
import { createPublicClient, createWalletClient, fallback, formatEther, http, type Hex } from "viem";
import { arbitrum } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ARBITRUM } from "../src/chains.ts";
import factoryArt from "../src/chain/AgentVaultFactory.json" with { type: "json" };
import adapterArt from "../src/chain/UniswapV3Adapter.json" with { type: "json" };

const SEND = process.argv.includes("--send");
const KEY = process.env.ANCHOR_PRIVATE_KEY as Hex | undefined;
if (!KEY) throw new Error("ANCHOR_PRIVATE_KEY is not set");
const account = privateKeyToAccount(KEY);
const urls = [...(process.env.ARB_RPC_URL ? [process.env.ARB_RPC_URL] : []), ...ARBITRUM.rpcs];
const transport = fallback(urls.map((u) => http(u, { timeout: 60_000 })));
const pub = createPublicClient({ chain: arbitrum, transport });
const wallet = createWalletClient({ account, chain: arbitrum, transport });

if ((await pub.getChainId()) !== ARBITRUM.id) throw new Error("the RPC is not Arbitrum One");
const entries = Object.entries(ARBITRUM.tokens);
const tokens = [ARBITRUM.base.address, ...entries.map(([, t]) => t.token)];
const feeds = [{ feed: ARBITRUM.base.feed, maxAge: 86400 + 3600 }, ...entries.map(([, t]) => ({ feed: t.feed, maxAge: t.maxAge }))];

console.log(`deployer/admin ${account.address}, balance ${formatEther(await pub.getBalance({ address: account.address }))} ETH on Arbitrum One`);
console.log(`feeds for ${tokens.length} tokens: ${ARBITRUM.base.symbol}, ${entries.map(([s]) => s).join(", ")}`);
// Every feed must answer now with a fresh price, or the factory would list a dead one.
const aggAbi = [{ type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] }] as const;
const now = Math.floor(Date.now() / 1000);
for (const [i, f] of feeds.entries()) {
  const r = await pub.readContract({ address: f.feed, abi: aggAbi, functionName: "latestRoundData" });
  if (r[1] <= 0n) throw new Error(`feed ${f.feed} for ${tokens[i]} has no price`);
  if (now - Number(r[3]) > f.maxAge) throw new Error(`feed ${f.feed} for ${tokens[i]} is stale`);
}
// The router must be Uniswap's, on this factory and this WETH.
const routerAbi = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "WETH9", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const [rf, rw] = await Promise.all([pub.readContract({ address: ARBITRUM.uniswap.router, abi: routerAbi, functionName: "factory" }), pub.readContract({ address: ARBITRUM.uniswap.router, abi: routerAbi, functionName: "WETH9" })]);
if (rf.toLowerCase() !== ARBITRUM.uniswap.factory.toLowerCase() || rw.toLowerCase() !== ARBITRUM.weth.toLowerCase()) throw new Error("the router does not match Uniswap's factory and WETH");
console.log("feeds fresh, router checked");
if (!SEND) {
  console.log("dry run: add --send to deploy");
  process.exit(0);
}

const f = await wallet.deployContract({ abi: factoryArt.abi as any, bytecode: factoryArt.bytecode as Hex, args: [account.address, ARBITRUM.base.address, ARBITRUM.weth, tokens, feeds] });
const fr = await pub.waitForTransactionReceipt({ hash: f, timeout: 180_000 });
if (fr.status !== "success" || !fr.contractAddress) throw new Error(`factory deploy failed: ${f}`);
console.log(`AgentVaultFactory ${fr.contractAddress} (tx ${f})`);
const a = await wallet.deployContract({ abi: adapterArt.abi as any, bytecode: adapterArt.bytecode as Hex, args: [ARBITRUM.uniswap.router] });
const ar = await pub.waitForTransactionReceipt({ hash: a, timeout: 180_000 });
if (ar.status !== "success" || !ar.contractAddress) throw new Error(`adapter deploy failed: ${a}`);
console.log(`UniswapV3Adapter ${ar.contractAddress} (tx ${a})`);
console.log(`\nSet on the server: VAULT_ARB_FACTORY=${fr.contractAddress} VAULT_ARB_ADAPTER=${ar.contractAddress}`);
