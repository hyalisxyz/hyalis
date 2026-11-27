/**
 * Independent check of a whole epoch from its bundle. Needs nothing from our server but the
 * bundle itself, which anyone may keep a copy of.
 *
 *   npm run verify-epoch -- --file 498683.json [--rpc <url>]
 *   npm run verify-epoch -- 498683 --api https://<server> [--rpc <url>]
 *
 * Checks that every leaf is the hash of its record, that the leaves rebuild the root, and that
 * the ReceiptRegistry on Robinhood Chain holds that root, previous root and leaf count.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chainClient } from "../sources/chainlink.ts";
import { verifyBundle, type EpochBundle } from "../archive/bundle.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { api: { type: "string" }, rpc: { type: "string" }, file: { type: "string" } },
});

let bundle: EpochBundle;
if (values.file) bundle = JSON.parse(readFileSync(values.file, "utf8"));
else {
  const epoch = positionals[0];
  if (!epoch || !values.api) {
    console.error("usage: verify-epoch --file <bundle.json> | <epoch> --api <server>");
    process.exit(2);
  }
  const res = await fetch(`${new URL(values.api).origin}/v1/epochs/${epoch}/bundle.json`);
  if (!res.ok) {
    console.error(`could not fetch epoch ${epoch}: HTTP ${res.status}`);
    process.exit(2);
  }
  bundle = (await res.json()) as EpochBundle;
}

console.log(`epoch ${bundle.epoch}: ${bundle.receipts.length} receipts, root ${bundle.root}`);
const r = await verifyBundle(bundle, chainClient(values.rpc ?? process.env.RPC_URL));
for (const c of r.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.name.padEnd(7)} ${c.detail}`);
console.log(r.ok ? "every receipt in this epoch is the one anchored on Robinhood Chain" : "this bundle does NOT match the chain");
process.exit(r.ok ? 0 : 1);
