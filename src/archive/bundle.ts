import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { getAddress, type Hex, type PublicClient } from "viem";
import { buildTree, leafOf } from "../receipts/merkle.ts";
import { REGISTRY_ABI } from "../chain/anchor.ts";
import { canonicalJson } from "../receipts/canonical.ts";
import { CHAIN_ID } from "../config.ts";

/**
 * Epoch bundles: everything needed to check one sealed epoch without our server.
 *
 * The chain holds only each epoch's root. The receipts behind it live in our database, so if the
 * database were lost the roots would prove nothing. A bundle is the full set of an epoch's
 * receipts with its root, the root before it and the anchoring transaction. Anyone can keep a
 * copy, rebuild the root from the receipts, and compare it with the ReceiptRegistry contract on
 * Robinhood Chain (verifyBundle below, or `npm run verify-epoch`). Once its epoch is anchored a
 * bundle never changes again, so it can be cached and mirrored forever.
 */

export const BUNDLE_VERSION = 1;

export interface EpochBundle {
  v: number;
  chainId: number;
  /** ReceiptRegistry address the root was anchored to, or null before it is anchored. */
  registry: `0x${string}` | null;
  epoch: number;
  root: Hex;
  prevRoot: Hex;
  leafCount: number;
  closedAt: number;
  anchor: { tx: string; block: number | null } | null;
  /** Every receipt of the epoch, by id. Each leaf is the hash of its record. */
  receipts: Array<{ id: number; leaf: Hex; record: Record<string, unknown> }>;
}

/**
 * The bundle of a sealed epoch, or null if the epoch is not sealed. Throws if the stored receipts
 * no longer rebuild the stored root: such a bundle must never be published.
 */
export function epochBundle(db: DatabaseSync, epoch: number): EpochBundle | null {
  const ep = db.prepare("SELECT * FROM epochs WHERE epoch = ?").get(epoch) as any;
  if (!ep) return null;
  const rows = db.prepare("SELECT id, leaf, record_json FROM receipts WHERE epoch = ? ORDER BY id").all(epoch) as Array<{ id: number; leaf: Hex; record_json: string }>;
  const receipts = rows.map((r) => ({ id: Number(r.id), leaf: r.leaf, record: JSON.parse(r.record_json) as Record<string, unknown> }));
  for (const r of receipts) if (leafOf(r.record) !== r.leaf) throw new Error(`epoch ${epoch}: receipt ${r.id} no longer hashes to its leaf`);
  const tree = buildTree(receipts.map((r) => r.leaf));
  if (tree.root !== ep.root) throw new Error(`epoch ${epoch}: receipts rebuild ${tree.root}, stored root is ${ep.root}`);
  return {
    v: BUNDLE_VERSION,
    chainId: CHAIN_ID,
    registry: ep.anchor_registry ? getAddress(ep.anchor_registry) : null,
    epoch: Number(ep.epoch),
    root: ep.root,
    prevRoot: ep.prev_root,
    leafCount: Number(ep.leaf_count),
    closedAt: Number(ep.closed_at),
    anchor: ep.anchor_tx ? { tx: ep.anchor_tx, block: ep.anchor_block ?? null } : null,
    receipts,
  };
}

/** Bytes of a bundle as published (canonical JSON, so the same bundle always has the same hash). */
export const bundleBytes = (b: EpochBundle) => Buffer.from(canonicalJson(b), "utf8");
export const bundleSha256 = (b: EpochBundle) => createHash("sha256").update(bundleBytes(b)).digest("hex");

export interface BundleCheck {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

/**
 * Checks a bundle on its own terms, and against the chain when a client is given:
 *  1. every leaf is the hash of its record
 *  2. the leaves rebuild the stated root, with the stated count
 *  3. the registry on chain holds the same root, previous root and leaf count for the epoch
 */
export async function verifyBundle(b: EpochBundle, client?: PublicClient): Promise<BundleCheck> {
  const checks: BundleCheck["checks"] = [];
  const bad = b.receipts.filter((r) => leafOf(r.record) !== r.leaf.toLowerCase());
  checks.push({ name: "leaves", ok: bad.length === 0, detail: bad.length ? `receipts ${bad.map((r) => r.id).join(", ")} do not hash to their leaves` : `${b.receipts.length} receipts hash to their leaves` });
  let rebuilt: { root: Hex; count: number } | null = null;
  try {
    const tree = buildTree(b.receipts.map((r) => r.leaf));
    rebuilt = { root: tree.root, count: tree.levels[0]!.length };
  } catch (e) {
    checks.push({ name: "root", ok: false, detail: (e as Error).message });
  }
  if (rebuilt) {
    const ok = rebuilt.root === b.root.toLowerCase() && rebuilt.count === b.leafCount;
    checks.push({ name: "root", ok, detail: ok ? `leaves rebuild root ${b.root}` : `leaves rebuild ${rebuilt.root} (${rebuilt.count} leaves), bundle says ${b.root} (${b.leafCount})` });
  }
  if (client) {
    if (!b.registry) checks.push({ name: "chain", ok: false, detail: "the bundle names no registry: its epoch was not anchored yet" });
    else {
      const a = (await client.readContract({ address: b.registry, abi: REGISTRY_ABI, functionName: "anchorOf", args: [BigInt(b.epoch)] })) as { root: Hex; prevRoot: Hex; leafCount: number };
      const ok = a.root.toLowerCase() === b.root.toLowerCase() && a.prevRoot.toLowerCase() === b.prevRoot.toLowerCase() && Number(a.leafCount) === b.leafCount;
      checks.push({
        name: "chain",
        ok,
        detail: ok
          ? `registry ${b.registry} on chain ${b.chainId} holds this root, previous root and count`
          : `registry holds root ${a.root}, previous ${a.prevRoot}, ${a.leafCount} leaves`,
      });
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}
