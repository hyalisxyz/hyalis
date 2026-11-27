import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { Config } from "./config.ts";
import { sameSecret } from "./api/server.ts";
import { exportResponse } from "./archive/export.ts";
import { errLine } from "./util/redact.ts";

export interface MovedOptions {
  /** The new address, for example https://example.com (no trailing slash needed). */
  movedTo: string;
  /** The operator token; the database export needs it. */
  adminToken?: string;
  /** Serve GET /v1/admin/export (only while moving the data over). */
  exportEnabled: boolean;
  /** Where the old database is; opened read-only, and only for the export. */
  dbPath: string;
}

/**
 * The old host after a move. It answers every request with a permanent redirect to the same path
 * on the new host, so old links (and ERC-8004 agentURIs that still name this host) keep working.
 * The only exceptions: /health, and the operator's database export while the move is in progress.
 */
export function buildMovedApp(o: MovedOptions): Hono {
  const target = o.movedTo.replace(/\/+$/, "");
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    h.set("x-content-type-options", "nosniff");
    h.set("x-frame-options", "DENY");
    h.set("referrer-policy", "strict-origin-when-cross-origin");
    h.set("strict-transport-security", "max-age=31536000");
  });
  app.onError((e, c) => {
    console.error(`[moved] ${c.req.method} ${c.req.path}:`, errLine(e));
    return c.json({ error: "something went wrong on our side; try again" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, movedTo: target }));

  app.get("/v1/admin/export", (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!o.exportEnabled || !o.adminToken || !token || !sameSecret(token, o.adminToken) || !existsSync(o.dbPath)) {
      return c.json({ error: "not found" }, 404);
    }
    const db = new DatabaseSync(o.dbPath, { readOnly: true });
    try {
      return exportResponse(db);
    } finally {
      db.close();
    }
  });

  // Everything else: same path and query on the new host. 308 keeps the method and body.
  app.all("*", (c) => {
    const url = new URL(c.req.url);
    return c.redirect(`${target}${url.pathname}${url.search}`, 308);
  });
  return app;
}

export function runMoved(config: Config): void {
  process.on("unhandledRejection", (e) => console.error("[process] unhandled rejection:", errLine(e)));
  const app = buildMovedApp({
    movedTo: config.MOVED_TO!,
    adminToken: process.env.ADMIN_TOKEN,
    exportEnabled: config.ADMIN_EXPORT_ENABLED,
    dbPath: config.DB_PATH,
  });
  console.log(`[moved] this host has moved to ${config.MOVED_TO}: redirecting everything; no trading, anchoring or backups here`);
  serve({ fetch: app.fetch, port: config.PORT, hostname: process.env.HOST ?? "127.0.0.1" }, (info) =>
    console.log(`[api] listening on http://${info.address}:${info.port}`),
  );
}
