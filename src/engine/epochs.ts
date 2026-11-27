import type { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import { buildTree, leafOf, proofFor } from "../receipts/merkle.ts";

/**
 * Receipts are grouped into fixed epochs. When an epoch ends, its receipts are frozen under
 * one Merkle root, and each root names the root before it, so history can grow but not be
 * rewritten. Phase 2 publishes each root to a registry contract on Robinhood Chain.
 */

export const ZERO_ROOT = ("0x" + "00".repeat(32)) as Hex;
export const epochOf = (t: number, len: number) => Math.floor(t / len);

export type ReceiptKind = "decision" | "fill" | "snapshot" | "agent" | "identity" | "journal" | "media" | "signal" | "funding" | "trade" | "end";

export function addReceipt(db: DatabaseSync, agentId: string, epoch: number, kind: ReceiptKind, record: Record<string, unknown>, now: number) {
  const full = { v: 1, kind, agentId, epoch, ...record };
  const leaf = leafOf(full);
  db.prepare("INSERT OR IGNORE INTO receipts (agent_id, epoch, kind, leaf, record_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    agentId, epoch, kind, leaf, JSON.stringify(full), now,
  );
  return leaf;
}

export function hasReceipt(db: DatabaseSync, agentId: string, epoch: number, kind: ReceiptKind) {
  return db.prepare("SELECT 1 FROM receipts WHERE agent_id = ? AND epoch = ? AND kind = ? LIMIT 1").get(agentId, epoch, kind) !== undefined;
}

/** Seals every finished epoch that has receipts and no root yet. Returns the sealed epochs. */
export function closeEpochs(db: DatabaseSync, currentEpoch: number, now: number): number[] {
  const open = db
    .prepare("SELECT DISTINCT epoch FROM receipts WHERE epoch < ? AND epoch NOT IN (SELECT epoch FROM epochs) ORDER BY epoch")
    .all(currentEpoch)
    .map((r: any) => Number(r.epoch));
  const sealed: number[] = [];
  for (const e of open) {
    const last = db.prepare("SELECT epoch, root FROM epochs ORDER BY epoch DESC LIMIT 1").get() as { epoch: number; root: Hex } | undefined;
    if (last && last.epoch > e) {
      // A late receipt for an epoch older than the last seal. It is left unsealed rather than
      // inserted out of order; the API reports it as unsealed.
      continue;
    }
    const leaves = db.prepare("SELECT leaf FROM receipts WHERE epoch = ?").all(e).map((r: any) => r.leaf as Hex);
    const tree = buildTree(leaves);
    db.prepare("INSERT INTO epochs (epoch, root, prev_root, leaf_count, closed_at) VALUES (?, ?, ?, ?, ?)").run(e, tree.root, last?.root ?? ZERO_ROOT, tree.levels[0]!.length, now);
    sealed.push(e);
  }
  return sealed;
}

export interface ReceiptProof {
  id: number;
  epoch: number;
  leaf: Hex;
  record: Record<string, unknown>;
  sealed: boolean;
  root: Hex | null;
  prevRoot: Hex | null;
  proof: Hex[];
  /** Where the epoch root was published, once it has been. */
  anchor: { chainId: number; registry: string; tx: string; block: number | null } | null;
}

export function receiptWithProof(db: DatabaseSync, id: number): ReceiptProof | null {
  const r = db.prepare("SELECT * FROM receipts WHERE id = ?").get(id) as any;
  if (!r) return null;
  const ep = db.prepare("SELECT * FROM epochs WHERE epoch = ?").get(r.epoch) as any;
  const base = { id: Number(r.id), epoch: Number(r.epoch), leaf: r.leaf as Hex, record: JSON.parse(r.record_json) };
  if (!ep) return { ...base, sealed: false, root: null, prevRoot: null, proof: [], anchor: null };
  const leaves = db.prepare("SELECT leaf FROM receipts WHERE epoch = ?").all(r.epoch).map((x: any) => x.leaf as Hex);
  const tree = buildTree(leaves);
  if (tree.root !== ep.root) throw new Error(`stored root for epoch ${r.epoch} does not match its receipts`);
  const anchor = ep.anchor_tx && ep.anchor_registry ? { chainId: 4663, registry: ep.anchor_registry, tx: ep.anchor_tx, block: ep.anchor_block ?? null } : null;
  return { ...base, sealed: true, root: ep.root, prevRoot: ep.prev_root, proof: proofFor(tree, base.leaf), anchor };
}
