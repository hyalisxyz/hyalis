import { concat, createPublicClient, http, keccak256, stringToBytes, type Hex } from "viem";
import { robinhoodChain } from "./chain";
import type { ReceiptProof } from "./api";

/**
 * Verifies a receipt in the browser, without trusting the backend:
 *  1. the leaf is the hash of the record (same canonical JSON and Merkle format as the backend)
 *  2. the leaf is under the hourly root, by the Merkle proof
 *  3. the registry contract on Robinhood Chain accepts the proof against the published root
 *  4. the Chainlink round the agent used had exactly that answer on chain
 */

function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("number must be finite");
    return JSON.stringify(Object.is(v, -0) ? 0 : v);
  }
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
  }
  throw new TypeError(`${typeof v} cannot be encoded`);
}

export const recordHash = (record: unknown): Hex => keccak256(stringToBytes(canonicalJson(record)));
const leafOf = (record: unknown): Hex => keccak256(concat(["0x00", recordHash(record)]));
const nodeOf = (a: Hex, b: Hex): Hex => keccak256(concat(BigInt(a) < BigInt(b) ? ["0x01", a, b] : ["0x01", b, a]));

const REGISTRY_ABI = [
  {
    type: "function",
    name: "verifyRecord",
    stateMutability: "view",
    inputs: [{ type: "uint64" }, { type: "bytes32" }, { type: "bytes32[]" }],
    outputs: [{ type: "bool" }],
  },
] as const;
const AGGREGATOR_ABI = [
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ type: "uint80" }],
    outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
  },
] as const;

export type CheckState = "ok" | "fail" | "skip" | "wait";
export interface Check {
  label: string;
  state: CheckState;
  detail: string;
}

const client = createPublicClient({ chain: robinhoodChain, transport: http() });

export async function verifyReceipt(r: ReceiptProof, onUpdate?: (checks: Check[]) => void): Promise<Check[]> {
  const checks: Check[] = [
    { label: "Record matches its hash", state: "wait", detail: "" },
    { label: "Included in the hourly root", state: "wait", detail: "" },
    { label: "Root confirmed by the contract on Robinhood Chain", state: "wait", detail: "" },
    { label: "Price matches the Chainlink round on chain", state: "wait", detail: "" },
  ];
  const emit = () => onUpdate?.(checks.map((c) => ({ ...c })));
  emit();

  const leaf = leafOf(r.record);
  checks[0] = { ...checks[0]!, state: leaf === r.leaf.toLowerCase() ? "ok" : "fail", detail: leaf };
  emit();

  if (!r.sealed || !r.root) checks[1] = { ...checks[1]!, state: "skip", detail: "This epoch is not sealed yet; it is sealed when the hour ends." };
  else {
    let h = leaf;
    for (const p of r.proof) h = nodeOf(h, p.toLowerCase() as Hex);
    checks[1] = { ...checks[1]!, state: h === r.root.toLowerCase() ? "ok" : "fail", detail: `root ${r.root}` };
  }
  emit();

  if (!r.anchor) checks[2] = { ...checks[2]!, state: "skip", detail: "The root is not published on chain yet; that happens in the tick after sealing." };
  else {
    try {
      const ok = await client.readContract({ address: r.anchor.registry, abi: REGISTRY_ABI, functionName: "verifyRecord", args: [BigInt(r.epoch), recordHash(r.record), r.proof] });
      checks[2] = { ...checks[2]!, state: ok ? "ok" : "fail", detail: `registry ${r.anchor.registry}, tx ${r.anchor.tx}` };
    } catch (e) {
      checks[2] = { ...checks[2]!, state: "fail", detail: `could not read the registry: ${(e as Error).message.split("\n")[0]}` };
    }
  }
  emit();

  const input = r.record?.input;
  if (!input) checks[3] = { ...checks[3]!, state: "skip", detail: "This receipt has no price input." };
  else if (!/^0x[0-9a-fA-F]{40}$/.test(String(input.feed))) checks[3] = { ...checks[3]!, state: "skip", detail: `Price from data feed ${input.feed}: recorded, not checkable on chain.` };
  else {
    try {
      const [, answer, , updatedAt] = await client.readContract({ address: input.feed, abi: AGGREGATOR_ABI, functionName: "getRoundData", args: [BigInt(input.roundId)] });
      const same = answer.toString() === input.answer && Number(updatedAt) === input.updatedAt;
      checks[3] = { ...checks[3]!, state: same ? "ok" : "fail", detail: `round ${input.roundId}: on chain ${answer} at ${updatedAt}` };
    } catch (e) {
      checks[3] = { ...checks[3]!, state: "fail", detail: `could not read the round: ${(e as Error).message.split("\n")[0]}` };
    }
  }
  emit();
  return checks;
}
