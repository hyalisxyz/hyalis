/**
 * Independent check of one receipt. It trusts nothing from the server except the data it
 * is checking, and re-reads every price from Robinhood Chain itself.
 *
 *   npm run verify -- <receiptId> [--api http://127.0.0.1:8787] [--rpc <url>]
 *   npm run verify -- --file receipt.json
 *
 * Checks:
 *  1. the leaf is the hash of the record
 *  2. the leaf is under the epoch root (Merkle proof)
 *  3. the registry contract on Robinhood Chain accepts the proof against the published root
 *  4. the Chainlink round the agent used really had that answer on chain
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Hex } from "viem";
import { leafOf, recordHash, verifyLeaf } from "../receipts/merkle.ts";
import { chainClient, readRound } from "../sources/chainlink.ts";
import { REGISTRY_ABI } from "../chain/anchor.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { api: { type: "string", default: "http://127.0.0.1:8787" }, rpc: { type: "string" }, file: { type: "string" } },
});

interface Receipt {
  id: number;
  epoch: number;
  leaf: Hex;
  record: Record<string, any>;
  sealed: boolean;
  root: Hex | null;
  proof: Hex[];
  anchor: { chainId: number; registry: `0x${string}`; tx: string } | null;
}

let receipt: Receipt;
if (values.file) receipt = JSON.parse(readFileSync(values.file, "utf8"));
else {
  const id = positionals[0];
  if (!id) {
    console.error("usage: npm run verify -- <receiptId> [--api url] | --file receipt.json");
    process.exit(2);
  }
  const res = await fetch(`${values.api}/v1/receipts/${id}`);
  if (!res.ok) throw new Error(`api returned HTTP ${res.status}`);
  receipt = (await res.json()) as Receipt;
}

let failed = false;
const line = (ok: boolean | null, msg: string) => {
  if (ok === false) failed = true;
  console.log(`${ok === null ? "  -  " : ok ? "  OK " : " FAIL"}  ${msg}`);
};

console.log(`receipt ${receipt.id} (${receipt.record.kind}) epoch ${receipt.epoch}`);

const leaf = leafOf(receipt.record);
line(leaf === receipt.leaf.toLowerCase(), `leaf matches record hash ${leaf}`);

if (!receipt.sealed || !receipt.root) line(null, "epoch not sealed yet; Merkle check skipped");
else line(verifyLeaf(receipt.root, leaf, receipt.proof), `leaf is under epoch root ${receipt.root}`);

const client = chainClient(values.rpc);

// 3. The root the server claims is the one published on Robinhood Chain. The contract checks
//    the proof itself, so this does not depend on the server's root or on this script's Merkle code.
if (!receipt.anchor) line(null, "epoch root not published on chain yet");
else {
  try {
    const ok = await client.readContract({
      address: receipt.anchor.registry,
      abi: REGISTRY_ABI,
      functionName: "verifyRecord",
      args: [BigInt(receipt.epoch), recordHash(receipt.record), receipt.proof],
    });
    line(ok === true, `receipt is under the root published in registry ${receipt.anchor.registry} (tx ${receipt.anchor.tx})`);
  } catch (e) {
    line(false, `could not read the registry: ${(e as Error).message.split("\n")[0]}`);
  }
}

const input = receipt.record.input;
if (!input) line(null, "no price input on this receipt");
else if (!/^0x[0-9a-fA-F]{40}$/.test(String(input.feed))) {
  // Data-feed markets (CoinGecko) have no on-chain round to compare against. Say so plainly.
  line(null, `price came from data feed ${input.feed} at ${input.updatedAt}: recorded, but not checkable on chain`);
} else {
  try {
    const onchain = await readRound(client, input.feed, input.roundId);
    line(
      onchain.answer === input.answer && onchain.updatedAt === input.updatedAt,
      `Chainlink ${input.feed} round ${input.roundId}: on chain ${onchain.answer} @ ${onchain.updatedAt}, receipt ${input.answer} @ ${input.updatedAt}`,
    );
  } catch (e) {
    line(false, `could not read round on chain: ${(e as Error).message}`);
  }
}

process.exit(failed ? 1 : 0);
