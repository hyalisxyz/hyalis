/**
 * Entry point. Normally this runs the service (src/service.ts). With MOVED_TO set, this host has
 * handed over to another one: it runs no trading, anchoring or backups, and sends every visitor
 * to the new address (src/moved.ts).
 */
import { loadConfig } from "./config.ts";

const config = loadConfig();
if (config.MOVED_TO) (await import("./moved.ts")).runMoved(config);
else await import("./service.ts");
