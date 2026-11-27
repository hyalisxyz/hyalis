import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toBytes } from "viem";
import type { AgentRow } from "../engine/agents.ts";
import { addReceipt, epochOf } from "../engine/epochs.ts";
import { CHAIN_ID } from "../config.ts";
import { PaymentRefused, ImageService, ImageServiceError, usdgText } from "./images.ts";

/**
 * Agent avatars, made by the image service and paid per image with x402.
 *
 * The prompt is built only from the agent's structured rules (long or short, stocks or crypto)
 * and a motif chosen by the hash of its id. No text a user wrote reaches the image model, so an
 * agent's name cannot steer what is drawn. Each avatar is sealed as a "media" receipt with its
 * hash and the payment that bought it.
 */

export const AVATAR_SIZE = 512;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_SEC = 3600;

const MOTIFS = [
  "a faceted crystal",
  "a lighthouse beam",
  "an origami bird",
  "a compass rose",
  "a nautilus shell",
  "a hummingbird",
  "a chess knight",
  "a paper crane",
  "a fox head",
  "a mountain peak",
  "an owl",
  "a koi fish",
];

/** The image prompt for an agent, from its rules only. */
export function avatarPrompt(agent: Pick<AgentRow, "id" | "strategy">, assetOf: (s: string) => "equity" | "crypto"): string {
  const h = toBytes(keccak256(toBytes(agent.id)));
  const motif = MOTIFS[h[0]! % MOTIFS.length]!;
  const classes = new Set(agent.strategy.symbols.map(assetOf));
  const world = classes.size > 1 ? "orbiting rings of glass" : classes.has("crypto") ? "a lattice of glowing hexagons" : "a skyline of glass towers";
  const mood = agent.strategy.side === "short" ? "descending light trails, calm and precise" : "ascending light trails, confident and bright";
  return (
    `A minimal emblem of ${motif} made of translucent cobalt-blue glass, over ${world}, ${mood}. ` +
    `Clean warm-white paper background with a faint thermal-receipt texture, cobalt blue and crisp white light, a small round ink-stamp accent, centered, symmetrical, sharp, high detail. ` +
    `No text, no letters, no numbers, no logos, no people.`
  );
}

export interface MediaRow {
  agent_id: string;
  status: "ready" | "failed";
  file: string | null;
  mime: string | null;
  sha256: string | null;
  bytes: number | null;
  model: string;
  prompt: string;
  payment_id: number | null;
  output_id: string | null;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export const avatarOf = (db: DatabaseSync, agentId: string) => (db.prepare("SELECT * FROM agent_media WHERE agent_id = ?").get(agentId) as MediaRow | undefined) ?? null;

/** The stored file of a ready avatar, or null. The path is built here, never taken from input. */
export function avatarFile(db: DatabaseSync, dir: string, agentId: string): { bytes: Buffer; mime: string } | null {
  const m = avatarOf(db, agentId);
  if (!m || m.status !== "ready" || !m.file || !m.mime) return null;
  const path = join(dir, m.file);
  return existsSync(path) ? { bytes: readFileSync(path), mime: m.mime } : null;
}

/** Agents that need an avatar: none yet, or failed earlier with attempts left and the wait over. */
export function avatarQueue(db: DatabaseSync, now: number, limit: number): string[] {
  return (
    db
      .prepare(
        `SELECT a.id FROM agents a LEFT JOIN agent_media m ON m.agent_id = a.id
          WHERE m.agent_id IS NULL OR (m.status = 'failed' AND m.attempts < ? AND m.updated_at <= ?)
          ORDER BY a.created_at, a.rowid LIMIT ?`,
      )
      .all(MAX_ATTEMPTS, now - RETRY_AFTER_SEC, limit) as Array<{ id: string }>
  ).map((r) => r.id);
}

/** How long the service keeps an output to download; older paid outputs are not collected. */
const PAID_OUTPUT_KEPT_SEC = 20 * 3600;

/**
 * The newest settled avatar payment for an agent whose image was never delivered, if still
 * collectable. An image already sealed in a media receipt counts as delivered for good, so an
 * avatar that is remade (a new style) is always bought fresh.
 */
function unusedPayment(db: DatabaseSync, agentId: string, now: number): { id: number; output_id: string; amount: string; tx: string | null; prompt: string | null } | null {
  return (
    (db
      .prepare(
        `SELECT p.id, p.output_id, p.amount, p.tx, p.prompt FROM payments p
          WHERE p.agent_id = ? AND p.purpose = 'avatar' AND p.status = 'settled' AND p.output_id IS NOT NULL AND p.updated_at >= ?
            AND NOT EXISTS (SELECT 1 FROM agent_media m WHERE m.payment_id = p.id AND m.status = 'ready')
            AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.kind = 'media' AND json_extract(r.record_json, '$.maker.output') = p.output_id)
          ORDER BY p.id DESC LIMIT 1`,
      )
      .get(agentId, now - PAID_OUTPUT_KEPT_SEC) as { id: number; output_id: string; amount: string; tx: string | null; prompt: string | null } | undefined) ?? null
  );
}

/**
 * Marks avatars to be made again (for example after the style of the prompt changed). The old
 * image and its sealed receipt stay; the agent goes back in the queue and gets a new one, paid
 * for afresh, sealed in a new receipt. Returns the agents marked.
 */
export function remakeAvatars(db: DatabaseSync, agentIds: string[]): string[] {
  const done: string[] = [];
  for (const id of agentIds) {
    const r = db.prepare("UPDATE agent_media SET status = 'failed', attempts = 0, error = 'remake requested', updated_at = 0 WHERE agent_id = ? AND status = 'ready'").run(id);
    if (r.changes) done.push(id);
  }
  return done;
}

export interface AvatarReport {
  made: Array<{ agentId: string; amount: string | null; tx: string | null }>;
  failed: Array<{ agentId: string; error: string }>;
  /** Set when the budget or the policy stopped the run before anything was signed. */
  stopped: string | null;
}

/**
 * Makes avatars for up to `limit` agents. A refusal by the payment policy (budget spent, price
 * over the ceiling) stops the run without counting as an attempt; other failures are retried
 * up to three times, an hour apart.
 */
export async function makeAvatars(
  db: DatabaseSync,
  images: ImageService,
  o: { dir: string; assetOf: (s: string) => "equity" | "crypto"; agentOf: (id: string) => AgentRow | null; epochSec: number; now: () => number; limit?: number },
): Promise<AvatarReport> {
  const report: AvatarReport = { made: [], failed: [], stopped: null };
  for (const id of avatarQueue(db, o.now(), o.limit ?? 1)) {
    const agent = o.agentOf(id);
    if (!agent) continue;
    let prompt = avatarPrompt(agent, o.assetOf);
    const prev = avatarOf(db, id);
    const attempts = (prev?.attempts ?? 0) + 1;
    let img;
    try {
      // An image paid for earlier but never stored (it was slow, or the service restarted) is
      // collected as it is; only when there is none is a new one bought.
      const paid = unusedPayment(db, id, o.now());
      // A collected image is recorded with the prompt it was made from, not today's. A payment
      // booked before prompts were kept has none; such an image is not collected.
      if (paid && paid.prompt) prompt = paid.prompt;
      img = paid && paid.prompt
        ? { ...(await images.fetchPaidOutput(paid.output_id)), outputId: paid.output_id, paymentId: paid.id, amount: paid.amount, tx: paid.tx }
        : await images.makeImage({ prompt, width: AVATAR_SIZE, height: AVATAR_SIZE, purpose: "avatar", agentId: id }, o.now);
    } catch (e) {
      if (e instanceof PaymentRefused) {
        report.stopped = e.message;
        break;
      }
      const error = e instanceof ImageServiceError ? e.message : `unexpected: ${(e as Error).message.split("\n")[0]}`;
      db.prepare(
        `INSERT INTO agent_media (agent_id, status, model, prompt, attempts, error, created_at, updated_at) VALUES (?, 'failed', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET status = 'failed', attempts = excluded.attempts, error = excluded.error, updated_at = excluded.updated_at`,
      ).run(id, images.cfg.model, prompt, attempts, error, o.now(), o.now());
      report.failed.push({ agentId: id, error });
      continue;
    }

    // Written under a temporary name and renamed, so a crash never leaves half a file in place.
    mkdirSync(o.dir, { recursive: true });
    const file = `${id}.${img.ext}`;
    const tmp = join(o.dir, `${file}.tmp`);
    writeFileSync(tmp, img.bytes);
    renameSync(tmp, join(o.dir, file));
    const sha256 = createHash("sha256").update(img.bytes).digest("hex");
    const now = o.now();
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO agent_media (agent_id, status, file, mime, sha256, bytes, model, prompt, payment_id, output_id, attempts, error, created_at, updated_at)
         VALUES (?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET status = 'ready', file = excluded.file, mime = excluded.mime, sha256 = excluded.sha256, bytes = excluded.bytes,
           model = excluded.model, prompt = excluded.prompt, payment_id = excluded.payment_id, output_id = excluded.output_id, attempts = excluded.attempts,
           error = NULL, updated_at = excluded.updated_at`,
      ).run(id, file, img.mime, sha256, img.bytes.length, images.cfg.model, prompt, img.paymentId, img.outputId, attempts, now, now);
      addReceipt(db, id, epochOf(now, o.epochSec), "media", {
        at: now,
        media: "avatar",
        sha256,
        mime: img.mime,
        bytes: img.bytes.length,
        maker: { service: "image-service", model: images.cfg.model, output: img.outputId },
        prompt,
        payment: { protocol: "x402", network: `eip155:${CHAIN_ID}`, asset: "USDG", amount: img.amount ? usdgText(img.amount) : null, tx: img.tx, payer: images.address },
      }, now);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    report.made.push({ agentId: id, amount: img.amount, tx: img.tx });
  }
  return report;
}
