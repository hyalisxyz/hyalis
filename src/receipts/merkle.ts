import { concat, keccak256, stringToBytes, type Hex } from "viem";
import { canonicalJson } from "./canonical.ts";

/**
 * Merkle tree over receipts, with domain separation (as in RFC 6962):
 *   leaf = keccak256(0x00 ‖ keccak256(canonicalJson(record)))
 *   node = keccak256(0x01 ‖ min(a, b) ‖ max(a, b))
 * The prefixes keep a leaf from ever being passed off as an inner node. Children are
 * ordered by value, so a proof is just the list of sibling hashes with no left/right flags.
 */

const LEAF = "0x00" as Hex;
const NODE = "0x01" as Hex;

export const recordHash = (record: unknown): Hex => keccak256(stringToBytes(canonicalJson(record)));
export const leafOf = (record: unknown): Hex => keccak256(concat([LEAF, recordHash(record)]));

const lt = (a: Hex, b: Hex) => BigInt(a) < BigInt(b);
export const nodeOf = (a: Hex, b: Hex): Hex => keccak256(concat(lt(a, b) ? [NODE, a, b] : [NODE, b, a]));

export interface MerkleTree {
  root: Hex;
  levels: Hex[][];
}

/** Leaves are deduplicated and sorted, so the root does not depend on insertion order. */
export function buildTree(leaves: readonly Hex[]): MerkleTree {
  if (leaves.length === 0) throw new Error("cannot build a tree with no leaves");
  const base = [...new Set(leaves.map((l) => l.toLowerCase() as Hex))].sort((a, b) => (lt(a, b) ? -1 : 1));
  const levels: Hex[][] = [base];
  for (let cur = base; cur.length > 1; ) {
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? nodeOf(cur[i]!, cur[i + 1]!) : cur[i]!);
    levels.push(next);
    cur = next;
  }
  return { root: levels.at(-1)![0]!, levels };
}

export function proofFor(tree: MerkleTree, leaf: Hex): Hex[] {
  let i = tree.levels[0]!.indexOf(leaf.toLowerCase() as Hex);
  if (i < 0) throw new Error("leaf not in tree");
  const proof: Hex[] = [];
  for (const level of tree.levels.slice(0, -1)) {
    const sib = i ^ 1;
    if (sib < level.length) proof.push(level[sib]!);
    i >>= 1;
  }
  return proof;
}

export function verifyLeaf(root: Hex, leaf: Hex, proof: readonly Hex[]): boolean {
  let h = leaf.toLowerCase() as Hex;
  for (const p of proof) h = nodeOf(h, p.toLowerCase() as Hex);
  return h === root.toLowerCase();
}
