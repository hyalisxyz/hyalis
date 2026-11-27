/**
 * Registers the house agents in the ERC-8004 Identity Registry and links them on the server.
 *
 *   node --env-file=.env scripts/register-identities.ts --api https://<server>          (dry run)
 *   node --env-file=.env scripts/register-identities.ts --api https://<server> --send   (sends)
 *
 * The identities are owned by the house wallet (ANCHOR_PRIVATE_KEY, the same wallet the server
 * uses as HOUSE_IDENTITY_OWNER by default). The key is never printed.
 *
 * Crash safety: each transaction is signed first and its raw form written to a journal
 * (data/identity-journal.json) before it is sent. Run again after any failure: a journaled
 * transaction is looked up, re-sent if it never arrived, or dropped if its nonce was used by
 * another transaction (the server's anchorer shares this wallet). No agent is registered twice
 * by a re-run, and nothing is sent without --send.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createWalletClient, encodeFunctionData, fallback, formatEther, getAddress, http, keccak256, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID } from "../src/config.ts";
import { chainClient, PUBLIC_RPCS, robinhoodChain } from "../src/sources/chainlink.ts";
import { IDENTITY_ABI, IDENTITY_REGISTRY, registrationsIn } from "../src/chain/identity.ts";

const JOURNAL = "data/identity-journal.json";
const args = process.argv.slice(2);
const apiArg = args[args.indexOf("--api") + 1];
const SEND = args.includes("--send");
if (!args.includes("--api") || !apiArg || apiArg.startsWith("--")) {
  console.error("usage: node --env-file=.env scripts/register-identities.ts --api https://<server> [--send]");
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

type Entry = { tx: Hex; raw: Hex; uri: string; at: string };
const journal: Record<string, Entry> = existsSync(JOURNAL) ? JSON.parse(readFileSync(JOURNAL, "utf8")) : {};
const saveJournal = () => writeFileSync(JOURNAL, JSON.stringify(journal, null, 2) + "\n");
const jkey = (agentId: string) => `${API}|${agentId}`;

async function get(path: string) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
}
/** Asks the server to link. The server's RPC node can lag a few blocks behind ours, so 404/503 are retried. */
async function link(agentId: string, txHash: Hex) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}/v1/agents/${agentId}/identity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash }) });
    const body = (await res.json().catch(() => ({}))) as any;
    if (res.ok) return body.identity as { agentId: string; verified: boolean; explorer: string };
    if ((res.status === 404 || res.status === 503) && attempt < 8) {
      console.log(`  server not ready (${res.status}: ${body.error ?? "no reason"}); retrying in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    throw new Error(`link refused (${res.status}): ${body.error ?? "no reason given"}`);
  }
}

/** Waits for a journaled transaction; re-sends it if it never arrived. Returns its receipt, or null if it is dead. */
async function settle(e: Entry) {
  const found = await pub.getTransactionReceipt({ hash: e.tx }).catch(() => null);
  if (found) return found;
  const nonce = parseTransaction(e.raw).nonce!;
  const next = await pub.getTransactionCount({ address: account.address, blockTag: "latest" });
  if (next > nonce) {
    // The nonce was used, but not by this transaction (receipt not found): it can never be mined.
    const again = await pub.getTransactionReceipt({ hash: e.tx }).catch(() => null);
    return again ?? null;
  }
  console.log(`  re-sending ${e.tx}`);
  await pub.sendRawTransaction({ serializedTransaction: e.raw }).catch((err) => {
    if (!/already known|known transaction|nonce too low/i.test((err as Error).message)) throw err;
  });
  return pub.waitForTransactionReceipt({ hash: e.tx, timeout: 180_000 });
}

async function main() {
  console.log(`server   ${API}`);
  console.log(`wallet   ${account.address}`);
  console.log(`mode     ${SEND ? "SEND" : "dry run (add --send to register)"}`);

  const chainId = await pub.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`RPC is on chain ${chainId}, expected ${CHAIN_ID}`);
  const version = await pub.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "getVersion" });
  if (version !== "2.0.0") throw new Error(`registry version is ${version}; this script was checked against 2.0.0`);
  // The registry mints with a safe transfer: a wallet with code (e.g. an EIP-7702 delegation) may refuse it.
  const code = await pub.getCode({ address: account.address });
  if (code && code !== "0x") throw new Error(`the house wallet has code (${code.slice(0, 12)}…); the registry's safe mint may revert`);
  const balance = await pub.getBalance({ address: account.address });
  console.log(`balance  ${formatEther(balance)} ETH\n`);

  const agents = ((await get("/v1/agents")) as any[]).filter((a) => a.house);
  if (!agents.length) return console.log("no house agents on this server");
  let planned = 0n;

  for (const a of agents) {
    console.log(`${a.name} (${a.id})`);
    const info = await get(`/v1/agents/${a.id}/identity`);
    if (getAddress(info.registry) !== IDENTITY_REGISTRY) throw new Error(`server uses registry ${info.registry}, this script ${IDENTITY_REGISTRY}`);
    if (info.identity?.verified) {
      console.log(`  already linked: ERC-8004 #${info.identity.agentId}\n`);
      continue;
    }
    if (!info.expectedOwner || getAddress(info.expectedOwner) !== account.address) {
      console.log(`  SKIP: the server expects house identities to be owned by ${info.expectedOwner ?? "nobody (off)"}, not ${account.address}\n`);
      continue;
    }
    const uri: string = info.agentURI;
    if (!uri.startsWith(API + "/")) throw new Error(`server's agentURI ${uri} is not under ${API}; check PUBLIC_URL on the server`);

    // A transaction from an earlier run comes first.
    const prior = journal[jkey(a.id)];
    if (prior) {
      if (prior.uri !== uri) throw new Error(`journal entry for ${a.id} is for ${prior.uri}, server now says ${uri}; resolve by hand`);
      if (!SEND) {
        console.log(`  journal has ${prior.tx}; run with --send to finish it\n`);
        continue;
      }
      const r = await settle(prior);
      if (r && r.status === "success" && registrationsIn(r, IDENTITY_REGISTRY).some((x) => x.uri === uri)) {
        const id = await link(a.id, prior.tx);
        console.log(`  linked from earlier tx: ERC-8004 #${id.agentId} ${id.explorer}\n`);
        delete journal[jkey(a.id)];
        saveJournal();
        continue;
      }
      console.log(`  earlier tx ${prior.tx} ${r ? "failed" : "was replaced"}; registering again`);
      delete journal[jkey(a.id)];
      saveJournal();
    }

    const data = encodeFunctionData({ abi: IDENTITY_ABI, functionName: "register", args: [uri] });
    await pub.call({ account: account.address, to: IDENTITY_REGISTRY, data }); // reverts here, before anything is signed
    const req = await wallet.prepareTransactionRequest({ to: IDENTITY_REGISTRY, data, chain: robinhoodChain });
    const cost = req.gas! * (req.maxFeePerGas ?? req.gasPrice ?? 0n);
    planned += cost;
    console.log(`  agentURI ${uri}`);
    console.log(`  gas ${req.gas} · at most ${formatEther(cost)} ETH`);
    if (!SEND) {
      console.log("");
      continue;
    }
    if (balance < planned) throw new Error(`not enough ETH: need ${formatEther(planned)}, have ${formatEther(balance)}`);

    const raw = await wallet.signTransaction(req as any);
    const tx = keccak256(raw);
    journal[jkey(a.id)] = { tx, raw, uri, at: new Date().toISOString() };
    saveJournal();
    await pub.sendRawTransaction({ serializedTransaction: raw });
    console.log(`  sent ${tx}`);
    const r = await pub.waitForTransactionReceipt({ hash: tx, timeout: 180_000 });
    if (r.status !== "success") throw new Error(`registration ${tx} reverted`);
    const id = await link(a.id, tx);
    console.log(`  linked: ERC-8004 #${id.agentId} ${id.explorer}\n`);
    delete journal[jkey(a.id)];
    saveJournal();
  }
  console.log(`${SEND ? "spent" : "would spend"} at most ${formatEther(planned)} ETH`);
}

main().catch((e) => {
  console.error("\nSTOPPED:", (e as Error).message.split("\n")[0]);
  process.exit(1);
});
