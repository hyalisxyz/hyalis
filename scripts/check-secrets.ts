/**
 * Confirms the secrets on Railway match the local .env, by comparing lengths and a short hash.
 * No value is printed.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const REQUIRED = ["ANTHROPIC_API_KEY", "ADMIN_TOKEN", "PYTH_API_KEY", "ANCHOR_PRIVATE_KEY"];
/** Compared only when set in .env. */
const OPTIONAL = ["RPC_URL", "MEDIA_PAYER_KEY"];
const fp = (v: string) => `${v.length} chars, sha256 ${createHash("sha256").update(v).digest("hex").slice(0, 8)}`;

const local = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1]!, m[2]!.trim()]),
);
const remote = JSON.parse(execFileSync("railway", ["variables", "--json"], { encoding: "utf8", shell: process.platform === "win32" })) as Record<string, string>;

const SECRETS = [...REQUIRED, ...OPTIONAL.filter((k) => local[k])];
let ok = true;
for (const k of SECRETS) {
  const same = remote[k] === local[k];
  ok &&= same;
  console.log(`${same ? "OK  " : "DIFF"} ${k.padEnd(20)} ${remote[k] ? fp(remote[k]) : "missing"}`);
}
process.exit(ok ? 0 : 1);
