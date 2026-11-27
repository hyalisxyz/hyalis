import type { DatabaseSync } from "node:sqlite";
import { setStatus } from "../engine/agents.ts";

/**
 * Keeps each wallet's active agents within its slots. Runs every tick, before trading.
 *
 *  - More active agents than slots (tokens sold or moved, a burn slot expired): the newest
 *    ones are paused with reason "over_quota". They are never deleted.
 *  - Slots free again: agents paused for quota resume, oldest first. Agents their owner
 *    paused stay paused.
 *  - If a wallet's slots cannot be read (RPC down), that wallet is left as it is. A network
 *    problem must not pause anyone.
 */
export async function enforceSlots(
  db: DatabaseSync,
  slotsFor: (owner: string) => Promise<number>,
): Promise<{ paused: string[]; resumed: string[]; skipped: string[] }> {
  const out = { paused: [] as string[], resumed: [] as string[], skipped: [] as string[] };
  const owners = db
    .prepare("SELECT DISTINCT owner FROM agents WHERE owner IS NOT NULL AND (status = 'active' OR pause_reason = 'over_quota')")
    .all()
    .map((r: any) => String(r.owner));

  for (const owner of owners) {
    let slots: number;
    try {
      slots = await slotsFor(owner);
    } catch {
      out.skipped.push(owner);
      continue;
    }
    const active = db.prepare("SELECT id FROM agents WHERE owner = ? AND status = 'active' ORDER BY created_at, rowid").all(owner).map((r: any) => String(r.id));
    const waiting = db
      .prepare("SELECT id FROM agents WHERE owner = ? AND status = 'paused' AND pause_reason = 'over_quota' ORDER BY created_at, rowid")
      .all(owner)
      .map((r: any) => String(r.id));

    if (active.length > slots) {
      for (const id of active.slice(slots)) {
        setStatus(db, id, "paused", "over_quota");
        out.paused.push(id);
      }
    } else if (active.length < slots) {
      for (const id of waiting.slice(0, slots - active.length)) {
        setStatus(db, id, "active");
        out.resumed.push(id);
      }
    }
  }
  return out;
}
