/**
 * Deploys ReceiptRegistry to Robinhood Chain with the anchor wallet as publisher, then
 * writes REGISTRY_ADDRESS to .env.
 *
 *   npm run anchor:deploy             estimate only
 *   npm run anchor:deploy -- --yes    deploy
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createWalletClient, encodeDeployData, fallback, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.ts";
import { chainClient, PUBLIC_RPCS, robinhoodChain } from "../src/sources/chainlink.ts";
import { REGISTRY_ABI, REGISTRY_BYTECODE } from "../src/chain/anchor.ts";

const config = loadConfig();
if (!config.ANCHOR_PRIVATE_KEY) throw new Error("ANCHOR_PRIVATE_KEY is not set. Run: npm run anchor:wallet");
if (config.REGISTRY_ADDRESS) throw new Error(`REGISTRY_ADDRESS is already set (${config.REGISTRY_ADDRESS}). Remove it from .env to deploy a new one.`);

const account = privateKeyToAccount(config.ANCHOR_PRIVATE_KEY as `0x${string}`);
const pub = chainClient(config.RPC_URL);
const urls = [...(config.RPC_URL ? [config.RPC_URL] : []), ...PUBLIC_RPCS];
const wallet = createWalletClient({ account, chain: robinhoodChain, transport: fallback(urls.map((u) => http(u, { timeout: 20_000 }))) });

const args = [account.address, BigInt(config.EPOCH_SEC)] as const;
const data = encodeDeployData({ abi: REGISTRY_ABI, bytecode: REGISTRY_BYTECODE, args });
const [balance, gas, gasPrice] = await Promise.all([pub.getBalance({ address: account.address }), pub.estimateGas({ account: account.address, data }), pub.getGasPrice()]);
const cost = gas * gasPrice;
// One anchor per hour costs roughly a tenth of a deploy.
const anchorGas = 75_000n;
console.log(`publisher      ${account.address}`);
console.log(`epoch          ${config.EPOCH_SEC}s`);
console.log(`balance        ${formatEther(balance)} ETH`);
console.log(`deploy         ~${gas} gas x ${gasPrice} wei = ${formatEther(cost)} ETH`);
console.log(`anchoring      ~${formatEther(anchorGas * gasPrice * 24n * 30n)} ETH per month at today's gas price`);

if (!process.argv.includes("--yes")) {
  console.log("\nEstimate only. Run again with --yes to deploy.");
  process.exit(0);
}
if (balance < (cost * 3n) / 2n) throw new Error("Balance too low for the deploy plus margin. Send ETH on Robinhood Chain to the publisher address.");

const hash = await wallet.deployContract({ abi: REGISTRY_ABI, bytecode: REGISTRY_BYTECODE, args });
console.log(`deploy tx      ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy failed in block ${receipt.blockNumber}`);
const address = receipt.contractAddress;

const [publisher, epochSeconds] = await Promise.all([
  pub.readContract({ address, abi: REGISTRY_ABI, functionName: "publisher" }),
  pub.readContract({ address, abi: REGISTRY_ABI, functionName: "epochSeconds" }),
]);
if (publisher !== account.address || Number(epochSeconds) !== config.EPOCH_SEC) throw new Error("deployed contract does not report the expected settings");

const env = readFileSync(".env", "utf8");
appendFileSync(".env", `${env.endsWith("\n") ? "" : "\n"}REGISTRY_ADDRESS=${address}\n`);
console.log(`registry       ${address} (block ${receipt.blockNumber})`);
console.log("REGISTRY_ADDRESS written to .env. Restart the service to start anchoring.");
