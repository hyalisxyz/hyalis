/**
 * Copies secret values from the local .env to the linked Railway service without printing
 * them. Only the names are shown.
 *
 *   railway link ...                 (once)
 *   node scripts/push-secrets.ts
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SECRETS = ["ANTHROPIC_API_KEY", "ADMIN_TOKEN", "PYTH_API_KEY", "ANCHOR_PRIVATE_KEY"];
/** Pushed only when set in .env. */
const OPTIONAL = ["RPC_URL", "MEDIA_PAYER_KEY"];

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null && m[2]!.trim() !== "")
    .map((m) => [m[1]!, m[2]!.trim()]),
);

const missing = SECRETS.filter((k) => !env[k]);
if (missing.length) throw new Error(`missing in .env: ${missing.join(", ")}`);

const names = [...SECRETS, ...OPTIONAL.filter((k) => env[k])];
const args = ["variables", "--skip-deploys", ...names.flatMap((k) => ["--set", `${k}=${env[k]}`])];
execFileSync("railway", args, { stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
console.log(`set on Railway: ${names.join(", ")} (values not shown)`);
