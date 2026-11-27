import type { DatabaseSync } from "node:sqlite";
import { getAddress, type LocalAccount } from "viem";
import { CHAIN_ID } from "../config.ts";
import { PaymentRefused, x402Fetch, type PayPolicy, type SignedPayment } from "../pay/x402.ts";

/**
 * The image service: image outputs paid per request with x402 in USDG on Robinhood Chain.
 *
 * Its address, model and payment recipient come from configuration (MEDIA_API, MEDIA_MODEL,
 * MEDIA_PAY_TO), and every payment is pinned to that recipient. Checked on chain on 2026-11-24:
 *  - USDG supports EIP-3009 with the EIP-712 domain "Global Dollar" / "1" (its DOMAIN_SEPARATOR
 *    and TRANSFER_WITH_AUTHORIZATION_TYPEHASH match);
 *  - the service settles the transfer and pays its gas; the paying wallet needs USDG only.
 * An output that fails is refunded by the service as credit to the paying wallet.
 */
export const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
export const USDG_DOMAIN = { name: "Global Dollar", version: "1" } as const;
export const USDG_DECIMALS = 6;

export const usdgUnits = (usd: number) => BigInt(Math.round(usd * 10 ** USDG_DECIMALS));
export const usdgText = (units: bigint | string) => (Number(units) / 10 ** USDG_DECIMALS).toFixed(6);

// ------------------------------------------------------------------ payments ledger

/**
 * Every signed payment is booked before it is sent ("signed"), then marked "settled" with its
 * transaction, or "rejected" when the server answered that it was not taken. A payment whose
 * fate is unknown (the connection dropped) stays "signed" and counts as spent.
 */
export const dayStart = (now: number) => now - (now % 86400);

export function spentToday(db: DatabaseSync, now: number): bigint {
  const rows = db.prepare("SELECT amount FROM payments WHERE created_at >= ? AND status != 'rejected'").all(dayStart(now)) as Array<{ amount: string }>;
  return rows.reduce((a, r) => a + BigInt(r.amount), 0n);
}

function book(db: DatabaseSync, p: SignedPayment, o: { service: string; purpose: string; agentId: string | null; prompt: string }, now: number): number {
  db.prepare("INSERT INTO payments (service, purpose, agent_id, prompt, amount, pay_to, nonce, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'signed', ?, ?)").run(
    o.service, o.purpose, o.agentId, o.prompt, p.amount.toString(), p.payTo, p.nonce, now, now,
  );
  return Number((db.prepare("SELECT id FROM payments WHERE nonce = ?").get(p.nonce) as { id: number }).id);
}

const mark = (db: DatabaseSync, id: number, status: "settled" | "rejected", f: { tx?: string | null; outputId?: string | null; error?: string | null }, now: number) =>
  db.prepare("UPDATE payments SET status = ?, tx = COALESCE(?, tx), output_id = COALESCE(?, output_id), error = ?, updated_at = ? WHERE id = ?").run(status, f.tx ?? null, f.outputId ?? null, f.error ?? null, now, id);

// ------------------------------------------------------------------ images

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * An answer about an output carries its status at the top, with the image (and its base64) in a
 * nested `output` that has no status of its own; an older shape puts everything in `output`.
 * Both are read here, so the status is never looked for in the wrong place.
 */
const statusOf = (j: any): string | undefined => j?.status ?? j?.output?.status;
const idOf = (j: any): string | null => (typeof j?.id === "string" ? j.id : typeof j?.output?.id === "string" ? j.output.id : null);
const base64Of = (j: any): string | undefined => (typeof j?.output?.base64 === "string" ? j.output.base64 : typeof j?.base64 === "string" ? j.base64 : undefined);

/** The image type from its first bytes; anything else is refused. */
export function sniffImage(b: Uint8Array): { mime: "image/png" | "image/jpeg" | "image/webp"; ext: "png" | "jpg" | "webp" } | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { mime: "image/png", ext: "png" };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

export interface ImageServiceConfig {
  api: string;
  /** The only address payments may go to; a service asking for any other gets no signature. */
  payTo: `0x${string}`;
  account: LocalAccount;
  model: string;
  maxPerCall: bigint;
  dailyBudget: bigint;
  fetchImpl?: typeof fetch;
  /** Waits between polls of a slow output; replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  pollEveryMs?: number;
  maxWaitMs?: number;
  /**
   * The paying wallet's USDG balance on chain. Checked before signing, so an empty wallet stops
   * the work instead of sending payments that cannot settle.
   */
  usdgBalance?: () => Promise<bigint>;
}

export interface ImageResult {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  outputId: string | null;
  paymentId: number | null;
  amount: string | null;
  tx: string | null;
}

export class ImageServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageServiceError";
  }
}

export class ImageService {
  readonly cfg: ImageServiceConfig;
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync, cfg: ImageServiceConfig) {
    this.db = db;
    this.cfg = cfg;
  }

  get address() {
    return this.cfg.account.address;
  }

  policy(now: () => number): PayPolicy {
    return {
      network: `eip155:${CHAIN_ID}`,
      chainId: CHAIN_ID,
      asset: USDG,
      domain: USDG_DOMAIN,
      payTo: getAddress(this.cfg.payTo),
      maxPerCall: this.cfg.maxPerCall,
      remaining: () => {
        const left = this.cfg.dailyBudget - spentToday(this.db, now());
        return left > 0n ? left : 0n;
      },
    };
  }

  /**
   * Makes one image and returns its bytes. Payment is booked before the signed request is sent.
   * Throws PaymentRefused (nothing signed), or ImageServiceError (signed; see the ledger for its fate).
   */
  async makeImage(req: { prompt: string; width: number; height: number; purpose: string; agentId: string | null }, nowSec: () => number): Promise<ImageResult> {
    const f = this.cfg.fetchImpl ?? fetch;
    const api = this.cfg.api.replace(/\/+$/, "");
    let paymentId: number | null = null;
    const r = await x402Fetch(
      `${api}/outputs`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: this.cfg.model, prompt: req.prompt, width: req.width, height: req.height }) },
      {
        account: this.cfg.account,
        policy: this.policy(nowSec),
        nowSec,
        beforeSend: (p) => {
          paymentId = book(this.db, p, { service: "image-service", purpose: req.purpose, agentId: req.agentId, prompt: req.prompt }, nowSec());
        },
        beforeSign: async (chosen) => {
          if (!this.cfg.usdgBalance) return;
          let have: bigint;
          try {
            have = await this.cfg.usdgBalance();
          } catch {
            throw new PaymentRefused("the paying wallet's USDG balance could not be read");
          }
          if (have < BigInt(chosen.amount)) throw new PaymentRefused(`the paying wallet ${this.address} holds ${usdgText(have)} USDG, less than the ${usdgText(chosen.amount)} asked`);
        },
        fetchImpl: f,
      },
    );
    const body = (await r.response.json().catch(() => null)) as any;
    if (r.response.status === 402 || r.response.status >= 400) {
      // A 402 after paying means the payment was not taken (expired, invalid, or underfunded).
      if (paymentId !== null && r.response.status === 402) mark(this.db, paymentId, "rejected", { error: String(body?.error?.message ?? "402 after payment") }, nowSec());
      throw new ImageServiceError(`The image service answered ${r.response.status}: ${String(body?.error?.message ?? "no message")}`);
    }
    if (paymentId === null) throw new ImageServiceError(`The image service answered ${r.response.status} without asking for payment`);
    const tx = r.settlement?.transaction || null;
    const outputId = idOf(body);
    mark(this.db, paymentId, "settled", { tx, outputId }, nowSec());
    if (!outputId) throw new ImageServiceError("The image service answered without an output id");
    const got = await this.collect(outputId, body);
    return { ...got, outputId, paymentId, amount: r.payment ? r.payment.amount.toString() : null, tx };
  }

  /**
   * The image of an output that is already paid for, without paying again: used when a payment
   * settled but the image was never stored (a slow output, a restart).
   */
  fetchPaidOutput(outputId: string): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
    return this.collect(outputId, null);
  }

  /** Waits for an output to be ready (fast ones already are), then downloads and checks its file. */
  private async collect(outputId: string, first: unknown): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
    const f = this.cfg.fetchImpl ?? fetch;
    const sleep = this.cfg.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const api = this.cfg.api.replace(/\/+$/, "");
    let reply = first as any;
    const deadline = Date.now() + (this.cfg.maxWaitMs ?? 240_000);
    while (statusOf(reply) !== "ready") {
      if (statusOf(reply) === "failed") throw new ImageServiceError(`The image service could not make the output (${outputId}); its credits went back to ${this.address}`);
      if (Date.now() > deadline) throw new ImageServiceError(`output ${outputId} was not ready in time`);
      if (reply !== null) await sleep(this.cfg.pollEveryMs ?? 3000);
      const res = await f(`${api}/outputs/${encodeURIComponent(outputId)}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new ImageServiceError(`reading output ${outputId}: ${res.status}`);
      reply = await res.json();
    }

    // The file itself; the inline base64 is the fallback.
    let bytes: Uint8Array | null = null;
    const file = await f(`${api}/outputs/${encodeURIComponent(outputId)}/file`, { signal: AbortSignal.timeout(60_000) });
    if (file.ok) bytes = new Uint8Array(await file.arrayBuffer());
    const b64 = base64Of(reply);
    if ((!bytes || bytes.length === 0) && b64) bytes = new Uint8Array(Buffer.from(b64, "base64"));
    if (!bytes || bytes.length === 0) throw new ImageServiceError(`output ${outputId} came back without a file`);
    if (bytes.length > MAX_BYTES) throw new ImageServiceError(`output ${outputId} is ${bytes.length} bytes, over the ${MAX_BYTES} limit`);
    const kind = sniffImage(bytes);
    if (!kind) throw new ImageServiceError(`output ${outputId} is not a PNG, JPEG or WebP image`);
    return { bytes, mime: kind.mime, ext: kind.ext };
  }
}

export { PaymentRefused };
