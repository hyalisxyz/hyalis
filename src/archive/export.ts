import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";

/**
 * A full, consistent copy of the database, gzipped, as a download (GET /v1/admin/export).
 * VACUUM INTO writes the copy without stopping the service, and works on a read-only connection.
 */
export function exportResponse(db: DatabaseSync): Response {
  const file = join(tmpdir(), `export-${randomUUID()}.db`);
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const gz = gzipSync(readFileSync(file), { level: 6 });
    console.log(`[admin] database exported, ${gz.length} bytes gzipped`);
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "");
    return new Response(gz, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="hyalis-${stamp}Z.db.gz"`,
        "cache-control": "no-store",
      },
    });
  } finally {
    rmSync(file, { force: true });
  }
}
