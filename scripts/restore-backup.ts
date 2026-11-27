/**
 * Restores the database from the backup bucket.
 *
 *   node --env-file=.env scripts/restore-backup.ts --out data/restored.db                 (latest)
 *   node --env-file=.env scripts/restore-backup.ts --key db/day-3.db.gz --out data/r.db
 *   node --env-file=.env scripts/restore-backup.ts --list
 *
 * The file is checked before it is written where you asked: the latest snapshot must match the
 * hash in its manifest, it must decompress, SQLite's integrity check must pass, and every
 * sealed epoch in it must still rebuild its root. It never overwrites a file unless --force.
 */
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { S3 } from "../src/archive/s3.ts";
import { epochBundle } from "../src/archive/bundle.ts";
import type { SnapshotManifest } from "../src/archive/backup.ts";

const { values } = parseArgs({ options: { key: { type: "string" }, out: { type: "string" }, force: { type: "boolean" }, list: { type: "boolean" } } });
const env = process.env;
for (const k of ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"])
  if (!env[k]) {
    console.error(`${k} is not set (run with --env-file=.env)`);
    process.exit(2);
  }
const s3 = new S3({
  endpoint: env.BACKUP_S3_ENDPOINT!,
  bucket: env.BACKUP_S3_BUCKET!,
  region: env.BACKUP_S3_REGION || "auto",
  accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID!,
  secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY!,
  style: env.BACKUP_S3_URL_STYLE === "path" ? "path" : "virtual",
});

if (values.list) {
  for (const o of await s3.list("db/")) console.log(`${o.key.padEnd(28)} ${String(o.size).padStart(10)} bytes  ${o.lastModified}`);
  const epochs = await s3.list("epochs/");
  console.log(`epochs/: ${epochs.length} bundles`);
  process.exit(0);
}

if (!values.out) {
  console.error("usage: restore-backup.ts --out <file> [--key db/latest.db.gz] [--force] | --list");
  process.exit(2);
}
if (existsSync(values.out) && !values.force) {
  console.error(`${values.out} exists; pass --force to replace it`);
  process.exit(2);
}

const key = values.key ?? "db/latest.db.gz";
const gz = await s3.get(key);
if (!gz) throw new Error(`no backup at ${key}`);
const sha = createHash("sha256").update(gz).digest("hex");
if (key === "db/latest.db.gz") {
  const m = await s3.get("db/latest.json");
  const manifest = m ? (JSON.parse(m.toString("utf8")) as SnapshotManifest) : null;
  if (!manifest) throw new Error("db/latest.json is missing; cannot check the latest snapshot");
  if (manifest.sha256 !== sha) throw new Error(`hash ${sha} does not match the manifest's ${manifest.sha256} (a newer upload may be in progress; try again)`);
  console.log(`snapshot of ${new Date(manifest.at * 1000).toISOString()}: ${manifest.receipts} receipts, ${manifest.epochs} epochs`);
}

const tmp = `${values.out}.restoring`;
rmSync(tmp, { force: true });
writeFileSync(tmp, gunzipSync(gz));
const db = new DatabaseSync(tmp);
try {
  const ic = (db.prepare("PRAGMA integrity_check").get() as Record<string, string>)["integrity_check"];
  if (ic !== "ok") throw new Error(`SQLite integrity check failed: ${ic}`);
  const epochs = db.prepare("SELECT epoch FROM epochs ORDER BY epoch").all() as Array<{ epoch: number }>;
  for (const { epoch } of epochs) epochBundle(db, epoch); // throws if any epoch no longer rebuilds its root
  const receipts = Number((db.prepare("SELECT COUNT(*) AS n FROM receipts").get() as { n: number }).n);
  console.log(`checked: integrity ok, ${epochs.length} sealed epochs rebuild their roots, ${receipts} receipts`);
} finally {
  db.close();
}
if (existsSync(values.out)) rmSync(values.out);
renameSync(tmp, values.out);
console.log(`restored ${key} (sha256 ${sha.slice(0, 16)}…) to ${values.out}`);
