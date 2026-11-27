/**
 * Points the house agents' ERC-8004 identities at the server's current public URL, after a
 * domain move (setAgentURI on the Identity Registry). Reads the URI the server now names for
 * each agent and changes only those whose on-chain URI differs.
 *
 *   node --env-file=.env scripts/update-agent-uris.ts --api https://<server>          (dry run)
 *   node --env-file=.env scripts/update-agent-uris.ts --api https://<server> --send   (sends)
 *
 * The identities are owned by the house wallet (ANCHOR_PRIVATE_KEY); the key is never printed.
 * Safe to run again: an identity already pointing at the right URI is skipped.
 */
import { createWalletClient, fallback, formatEther, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID } from "../src/config.ts";
import { chainClient, PUBLIC_RPCS, robinhoodChain } from "../src/sources/chainlink.ts";
import { IDENTITY_ABI, IDENTITY_REGISTRY } from "../src/chain/identity.ts";

const args = process.argv.slice(2);
const apiArg = args[args.indexOf("--api") + 1];
const SEND = args.includes("--send");
if (!args.includes("--api") || !apiArg || apiArg.startsWith("--")) {
  console.error("usage: node --env-file=.env scripts/update-agent-uris.ts --api https://<server> [--send]");
  process.exit(2);
}
const API = new URL(apiArg).origin;
const KEY = process.env.ANCHOR_PRIVATE_KEY as Hex | undefined;
if (!KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  console.error("ANCHOR_PRIVATE_KEY is not set (run with --env-file=.env)");
  process.exit(2);
}
const account = privateKeyToAccount(KEY);
const pub = chainClient(process.env.RPC_URL || undefined);
const urls = [...(process.env.RPC_URL ? [process.env.RPC_URL] : []), ...PUBLIC_RPCS];
const wallet = createWalletClient({ account, chain: robinhoodChain, transport: fallback(urls.map((u) => http(u, { timeout: 30_000 }))) });

async function get(path: string) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json() as Promise<any>;
}

console.log(`server   ${API}`);
console.log(`wallet   ${account.address}`);
console.log(`mode     ${SEND ? "SEND" : "dry run (add --send to update)"}`);
if ((await pub.getChainId()) !== CHAIN_ID) throw new Error(`RPC is not on chain ${CHAIN_ID}`);
console.log(`balance  ${formatEther(await pub.getBalance({ address: account.address }))} ETH\n`);

const agents = ((await get("/v1/agents")) as any[]).filter((a) => a.house);
let changed = 0;
for (const a of agents) {
  const info = await get(`/v1/agents/${a.id}/identity`);
  const tokenId = info.identity?.agentId as string | undefined;
  const uri = info.agentURI as string;
  console.log(`${a.name} (#${tokenId ?? "none"})`);
  if (!tokenId) {
    console.log("  no identity linked; skipped\n");
    continue;
  }
  if (getAddress(info.registry) !== IDENTITY_REGISTRY) throw new Error(`server uses registry ${info.registry}`);
  if (!uri.startsWith(API + "/")) throw new Error(`server's agentURI ${uri} is not under ${API}; check PUBLIC_URL on the server`);
  const id = BigInt(tokenId);
  const [owner, current] = await Promise.all([
    pub.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "ownerOf", args: [id] }),
    pub.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "tokenURI", args: [id] }),
  ]);
  if (current === uri) {
    console.log("  already up to date\n");
    continue;
  }
  if (getAddress(owner) !== account.address) {
    console.log(`  SKIP: owned by ${owner}, not this wallet\n`);
    continue;
  }
  console.log(`  ${current}\n  -> ${uri}`);
  if (!SEND) {
    console.log("");
    continue;
  }
  const { request } = await pub.simulateContract({ account, address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "setAgentURI", args: [id, uri] });
  const hash = await wallet.writeContract(request);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`setAgentURI for #${tokenId} reverted (${hash})`);
  const after = await pub.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "tokenURI", args: [id] });
  if (after !== uri) throw new Error(`#${tokenId} still reads ${after}`);
  console.log(`  updated in ${hash}\n`);
  changed++;
}
console.log(`${changed} identit${changed === 1 ? "y" : "ies"} updated`);
