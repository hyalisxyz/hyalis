import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { bundleBytes, bundleSha256, epochBundle } from "./bundle.ts";
import type { S3 } from "./s3.ts";

/**
 * Off-site copies, kept in a bucket separate from the database volume.
 *
 *  - Database snapshots: a consistent copy (VACUUM INTO, safe while the service runs), gzipped.
 *    Written as db/latest.db.gz every few hours, db/day-<0..6>.db.gz (one per weekday, so the
 *    last seven days are kept) and db/month-YYYY-MM.db.gz (the first of each month, kept for
 *    good). db/latest.json describes the latest one, with its hash, for restore to check.
 *  - Epoch bundles: every anchored epoch as epochs/<epoch>.json, uploaded once. With these alone
 *    every receipt can be checked against the chain, even if the database is gone.
 */

export interface BackupReport {
  snapshot: { key: string; bytes: number; sha256: string } | null;
  bundles: number;
  pendingBundles: number;
  error: string | null;
}

export interface SnapshotManifest {
  v: 1;
  at: number;
  key: string;
  sha256: string;
  bytes: number;
  rawBytes: number;
  receipts: number;
  epochs: number;
  lastEpoch: number | null;
}

const meta = (db: DatabaseSync, key: string) => (db.prepare("SELECT value FROM archive_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
const setMeta = (db: DatabaseSync, key: string, value: string) =>
  db.prepare("INSERT INTO archive_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

export class Backup {
  private readonly db: DatabaseSync;
  private readonly s3: S3;
  private readonly tmpDir: string;
  private readonly everySec: number;
  /** Put before every key, e.g. "staging/"; empty in production. */
  private readonly prefix: string;

  constructor(db: DatabaseSync, s3: S3, o: { dbPath: string; everySec?: number; prefix?: string }) {
    this.db = db;
    this.s3 = s3;
    // Snapshots are written next to the database first, on the same volume.
    this.tmpDir = join(o.dbPath === ":memory:" ? process.cwd() : dirname(o.dbPath), "backup-tmp");
    this.everySec = o.everySec ?? 6 * 3600;
    this.prefix = o.prefix ?? "";
    // What was archived is recorded in the database, but it lives in one bucket. If this database
    // now writes somewhere else (it was copied to a new host, or the bucket changed), that bucket
    // holds none of it: forget the record so everything goes up again, snapshot first.
    const destination = `${new URL(s3.cfg.endpoint).host}/${s3.cfg.bucket}/${this.prefix}`;
    const before = meta(db, "destination");
    if (before !== destination) {
      db.exec("BEGIN");
      try {
        db.exec("DELETE FROM archived_epochs");
        db.prepare("DELETE FROM archive_meta WHERE key = 'last_snapshot_at'").run();
        setMeta(db, "destination", destination);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      if (before !== null) console.log(`[backup] new destination ${destination} (was ${before}): uploading everything again`);
    }
  }

  /** A consistent, gzipped copy of the database, uploaded under the rotation keys. */
  async snapshot(now: number): Promise<SnapshotManifest> {
    mkdirSync(this.tmpDir, { recursive: true });
    const file = join(this.tmpDir, `snapshot-${now}.db`);
    if (existsSync(file)) rmSync(file);
    try {
      // VACUUM INTO writes a complete, consistent copy without stopping the service.
      this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      const raw = readFileSync(file);
      const gz = gzipSync(raw, { level: 9 });
      const sha256 = createHash("sha256").update(gz).digest("hex");
      const d = new Date(now * 1000);
      const count = (sql: string) => Number((this.db.prepare(sql).get() as { n: number | null }).n ?? 0);
      const manifest: SnapshotManifest = {
        v: 1,
        at: now,
        key: "db/latest.db.gz",
        sha256,
        bytes: gz.length,
        rawBytes: raw.length,
        receipts: count("SELECT COUNT(*) AS n FROM receipts"),
        epochs: count("SELECT COUNT(*) AS n FROM epochs"),
        lastEpoch: (this.db.prepare("SELECT MAX(epoch) AS n FROM epochs").get() as { n: number | null }).n,
      };
      await this.s3.put(`${this.prefix}db/latest.db.gz`, gz, "application/gzip");
      await this.s3.put(`${this.prefix}db/day-${d.getUTCDay()}.db.gz`, gz, "application/gzip");
      const month = `${this.prefix}db/month-${d.toISOString().slice(0, 7)}.db.gz`;
      if (!(await this.s3.exists(month))) await this.s3.put(month, gz, "application/gzip");
      // The manifest goes last: it only ever describes a snapshot that is fully uploaded.
      await this.s3.put(`${this.prefix}db/latest.json`, Buffer.from(JSON.stringify(manifest, null, 2)), "application/json");
      setMeta(this.db, "last_snapshot_at", String(now));
      return manifest;
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** Uploads anchored epochs that are not archived yet, oldest first. */
  async bundles(now: number, limit = 200): Promise<{ uploaded: number; pending: number }> {
    const todo = this.db
      .prepare("SELECT e.epoch FROM epochs e LEFT JOIN archived_epochs a ON a.epoch = e.epoch WHERE e.anchor_tx IS NOT NULL AND a.epoch IS NULL ORDER BY e.epoch")
      .all() as Array<{ epoch: number }>;
    let uploaded = 0;
    for (const { epoch } of todo.slice(0, limit)) {
      const b = epochBundle(this.db, epoch);
      if (!b) continue;
      const bytes = bundleBytes(b);
      await this.s3.put(`${this.prefix}epochs/${epoch}.json`, bytes, "application/json");
      this.db.prepare("INSERT INTO archived_epochs (epoch, sha256, bytes, archived_at) VALUES (?, ?, ?, ?)").run(epoch, bundleSha256(b), bytes.length, now);
      uploaded++;
    }
    return { uploaded, pending: todo.length - uploaded };
  }

  /** One round: new bundles every time, a snapshot when the last one is old enough. */
  async run(now: number): Promise<BackupReport> {
    const report: BackupReport = { snapshot: null, bundles: 0, pendingBundles: 0, error: null };
    try {
      const b = await this.bundles(now);
      report.bundles = b.uploaded;
      report.pendingBundles = b.pending;
      const last = Number(meta(this.db, "last_snapshot_at") ?? 0);
      if (now - last >= this.everySec) {
        const m = await this.snapshot(now);
        report.snapshot = { key: m.key, bytes: m.bytes, sha256: m.sha256 };
      }
    } catch (e) {
      report.error = (e as Error).message.split("\n")[0] ?? "backup failed";
    }
    return report;
  }

  status() {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as { n: number | null }).n ?? 0);
    return {
      lastSnapshotAt: Number(meta(this.db, "last_snapshot_at") ?? 0) || null,
      bundlesArchived: n("SELECT COUNT(*) AS n FROM archived_epochs"),
      bundlesPending: n("SELECT COUNT(*) AS n FROM epochs e LEFT JOIN archived_epochs a ON a.epoch = e.epoch WHERE e.anchor_tx IS NOT NULL AND a.epoch IS NULL"),
    };
  }
}
