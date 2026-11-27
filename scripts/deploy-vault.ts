/**
 * Deploys the AgentVault factory and the Uniswap V3 adapter on Robinhood Chain.
 *
 *   node --env-file=.env scripts/deploy-vault.ts          (dry run: shows what it would deploy)
 *   node --env-file=.env scripts/deploy-vault.ts --send
 *
 * The deployer and factory admin is the house wallet (ANCHOR_PRIVATE_KEY); the admin can only
 * propose feed changes, which take effect 24 hours later. Feeds: every market with a Chainlink
 * feed and a token on Robinhood Chain, plus USDG; an answer older than the feed's heartbeat plus
 * an hour counts as stale, so stock trading stops when the market closes. The key is never printed.
 */
import { createWalletClient, fallback, formatEther, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadMarkets } from "../src/config.ts";
import { chainClient, PUBLIC_RPCS, robinhoodChain } from "../src/sources/chainlink.ts";
import { UNISWAP, USDG, WETH } from "../src/live/uniswap.ts";
import factoryArt from "../src/chain/AgentVaultFactory.json" with { type: "json" };
import adapterArt from "../src/chain/UniswapV3Adapter.json" with { type: "json" };

const SEND = process.argv.includes("--send");
const KEY = process.env.ANCHOR_PRIVATE_KEY as Hex | undefined;
if (!KEY) throw new Error("ANCHOR_PRIVATE_KEY is not set");
const account = privateKeyToAccount(KEY);
const pub = chainClient(process.env.RPC_URL || undefined);
const urls = [...(process.env.RPC_URL ? [process.env.RPC_URL] : []), ...PUBLIC_RPCS];
const wallet = createWalletClient({ account, chain: robinhoodChain, transport: fallback(urls.map((u) => http(u, { timeout: 60_000 }))) });

// USDG/USD on Robinhood Chain (checked on chain before use below).
const USDG_FEED = getAddress("0x61B7e5650328764B076A108EFF5fa7282a1B9aD2");
const markets = loadMarkets().filter((m) => m.source === "chainlink" && m.token);
const tokens = [USDG, ...markets.map((m) => getAddress(m.token!))];
const feeds = [{ feed: USDG_FEED, maxAge: 86400 + 3600 }, ...markets.map((m) => ({ feed: getAddress(m.feed as string), maxAge: m.heartbeatSec + 3600 }))];

console.log(`deployer/admin ${account.address}, balance ${formatEther(await pub.getBalance({ address: account.address }))} ETH`);
console.log(`feeds for ${tokens.length} tokens: USDG, ${markets.map((m) => m.symbol).join(", ")}`);
// Every feed must answer now, or the factory would list a dead price.
const aggAbi = [{ type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] }] as const;
for (const [i, f] of feeds.entries()) {
  const r = await pub.readContract({ address: f.feed, abi: aggAbi, functionName: "latestRoundData" });
  if (r[1] <= 0n) throw new Error(`feed ${f.feed} for ${tokens[i]} has no price`);
}
if (!SEND) {
  console.log("dry run: add --send to deploy");
  process.exit(0);
}

const f = await wallet.deployContract({ abi: factoryArt.abi as any, bytecode: factoryArt.bytecode as Hex, args: [account.address, USDG, WETH, tokens, feeds] });
const fr = await pub.waitForTransactionReceipt({ hash: f, timeout: 180_000 });
if (fr.status !== "success" || !fr.contractAddress) throw new Error(`factory deploy failed: ${f}`);
console.log(`AgentVaultFactory ${fr.contractAddress} (tx ${f})`);
const a = await wallet.deployContract({ abi: adapterArt.abi as any, bytecode: adapterArt.bytecode as Hex, args: [UNISWAP.router] });
const ar = await pub.waitForTransactionReceipt({ hash: a, timeout: 180_000 });
if (ar.status !== "success" || !ar.contractAddress) throw new Error(`adapter deploy failed: ${a}`);
console.log(`UniswapV3Adapter ${ar.contractAddress} (tx ${a})`);
console.log(`\nSet on the server: VAULT_FACTORY=${fr.contractAddress} VAULT_ADAPTER=${ar.contractAddress}`);
