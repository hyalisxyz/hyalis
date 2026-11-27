import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { getAddress, type Hex, type PublicClient } from "viem";

/**
 * Sign-in with a wallet signature (EIP-4361 style message). Signing costs no gas and moves no
 * funds. Reading a wallet's balance and tier needs no sign-in at all, since that data is public
 * on chain; signing in is only needed to act: create agents, claim burns, pause agents.
 *
 * The signature is checked with the chain client, which also accepts smart-contract wallets
 * (ERC-1271 / ERC-6492), not just plain keys.
 */

const NONCE_TTL_SEC = 10 * 60;
export const SESSION_TTL_SEC = 7 * 86400;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function signInMessage(o: { domain: string; brand: string; address: string; nonce: string; issuedAt: number; expiresAt: number; chainId: number }): string {
  return [
    `${o.domain} wants you to sign in with your Ethereum account:`,
    o.address,
    "",
    `Sign in to ${o.brand}. This request does not trigger a transaction and costs no gas.`,
    "",
    `URI: https://${o.domain}`,
    "Version: 1",
    `Chain ID: ${o.chainId}`,
    `Nonce: ${o.nonce}`,
    `Issued At: ${new Date(o.issuedAt * 1000).toISOString()}`,
    `Expiration Time: ${new Date(o.expiresAt * 1000).toISOString()}`,
  ].join("\n");
}

export function createNonce(db: DatabaseSync, address: string, o: { domain: string; brand: string; chainId: number }, now: number) {
  const addr = getAddress(address);
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = now + NONCE_TTL_SEC;
  const message = signInMessage({ ...o, address: addr, nonce, issuedAt: now, expiresAt });
  // Old unused nonces are cleaned up as new ones are issued.
  db.prepare("DELETE FROM auth_nonces WHERE expires_at < ?").run(now);
  db.prepare("INSERT INTO auth_nonces (nonce, address, message, expires_at) VALUES (?, ?, ?, ?)").run(nonce, addr, message, expiresAt);
  return { nonce, message, expiresAt };
}

export type SignInResult = { ok: true; token: string; address: string; expiresAt: number } | { ok: false; reason: string };

export async function verifySignIn(db: DatabaseSync, client: PublicClient, o: { address: string; nonce: string; signature: Hex }, now: number): Promise<SignInResult> {
  let addr: string;
  try {
    addr = getAddress(o.address);
  } catch {
    return { ok: false, reason: "invalid address" };
  }
  const row = db.prepare("SELECT address, message, expires_at, used_at FROM auth_nonces WHERE nonce = ?").get(o.nonce) as
    | { address: string; message: string; expires_at: number; used_at: number | null }
    | undefined;
  if (!row) return { ok: false, reason: "unknown sign-in request; ask for a new one" };
  if (row.used_at) return { ok: false, reason: "this sign-in request was already used" };
  if (row.expires_at < now) return { ok: false, reason: "this sign-in request expired; ask for a new one" };
  if (row.address !== addr) return { ok: false, reason: "this sign-in request was made for another address" };

  // Spend the nonce before checking, so a signature can never be tried twice.
  db.prepare("UPDATE auth_nonces SET used_at = ? WHERE nonce = ?").run(now, o.nonce);
  let valid = false;
  try {
    valid = await client.verifyMessage({ address: addr as `0x${string}`, message: row.message, signature: o.signature });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "signature does not match the address" };

  const token = randomBytes(32).toString("hex");
  const expiresAt = now + SESSION_TTL_SEC;
  db.prepare("INSERT INTO sessions (token_hash, address, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), addr, now, expiresAt);
  db.prepare("INSERT INTO users (address, created_at, last_seen) VALUES (?, ?, ?) ON CONFLICT(address) DO UPDATE SET last_seen = excluded.last_seen").run(addr, now, now);
  return { ok: true, token, address: addr, expiresAt };
}

/** Address for a session token, or null. Only a hash of the token is stored. */
export function sessionAddress(db: DatabaseSync, token: string, now: number): string | null {
  const row = db.prepare("SELECT address, expires_at FROM sessions WHERE token_hash = ?").get(sha256(token)) as { address: string; expires_at: number } | undefined;
  return row && row.expires_at > now ? row.address : null;
}

export function endSession(db: DatabaseSync, token: string) {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}
