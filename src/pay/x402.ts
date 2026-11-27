import { randomBytes } from "node:crypto";
import { getAddress, isAddress, type Hex, type LocalAccount } from "viem";

/**
 * A client for x402 version 2, "exact" scheme on EVM (EIP-3009), written from the public
 * specification (x402-specification-v2, transports-v2/http, schemes/exact/scheme_exact_evm).
 *
 *   1. Send the request. A 402 carries PAYMENT-REQUIRED: base64 JSON with the accepted payments.
 *   2. Pick one this wallet is allowed to pay, sign a USDG transferWithAuthorization for it.
 *   3. Send the same request again with PAYMENT-SIGNATURE: base64 JSON of the PaymentPayload.
 *   4. The server settles on chain (and pays the gas) and answers; PAYMENT-RESPONSE names the tx.
 *
 * Nothing is signed unless the request matches a policy pinned in code: the network, the token,
 * the token's EIP-712 domain, the recipient, a ceiling per call, and what is left of a daily
 * budget. A server that asks for anything else gets no signature. The signature authorizes one
 * transfer of one amount to one address, once, inside a short window.
 */

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface PayPolicy {
  /** CAIP-2 network, e.g. eip155:4663. */
  network: string;
  chainId: number;
  /** The token paid with, and its EIP-712 domain (checked on chain when the policy is set up). */
  asset: `0x${string}`;
  domain: { name: string; version: string };
  /** The only address this policy pays. */
  payTo: `0x${string}`;
  /** Ceiling for one payment, in the token's smallest unit. */
  maxPerCall: bigint;
  /** What is left to spend today, in the token's smallest unit. */
  remaining: () => bigint;
}

export interface SignedPayment {
  amount: bigint;
  payTo: `0x${string}`;
  nonce: Hex;
  validAfter: bigint;
  validBefore: bigint;
}

export class PaymentRefused extends Error {
  constructor(reason: string) {
    super(`payment refused: ${reason}`);
    this.name = "PaymentRefused";
  }
}

/** base64 JSON as the transport spec uses it; standard alphabet, url-safe also accepted. */
export function decodeB64Json<T>(value: string): T {
  const b64 = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as T;
}
export const encodeB64Json = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");

const same = (a: string, b: string) => isAddress(a, { strict: false }) && isAddress(b, { strict: false }) && getAddress(a) === getAddress(b);

/** Picks the first offered payment the policy allows, or says why none fits. */
export function choosePayment(required: PaymentRequired, policy: PayPolicy): PaymentRequirements {
  if (required?.x402Version !== 2) throw new PaymentRefused(`unsupported x402 version ${String(required?.x402Version)}`);
  if (!Array.isArray(required.accepts) || required.accepts.length === 0) throw new PaymentRefused("the server offered no way to pay");
  const reasons: string[] = [];
  for (const r of required.accepts) {
    const why =
      r.scheme !== "exact" ? `scheme ${r.scheme}` :
      r.network !== policy.network ? `network ${r.network}` :
      !same(r.asset, policy.asset) ? `token ${r.asset}` :
      !same(r.payTo, policy.payTo) ? `recipient ${r.payTo}` :
      (r.extra?.assetTransferMethod ?? "eip3009") !== "eip3009" ? `transfer method ${String(r.extra?.assetTransferMethod)}` :
      r.extra?.name !== policy.domain.name || r.extra?.version !== policy.domain.version ? `token domain ${String(r.extra?.name)}/${String(r.extra?.version)}` :
      !/^[1-9]\d{0,30}$/.test(String(r.amount)) ? `amount ${r.amount}` :
      BigInt(r.amount) > policy.maxPerCall ? `amount ${r.amount} is over the per-call ceiling ${policy.maxPerCall}` :
      BigInt(r.amount) > policy.remaining() ? `amount ${r.amount} is over what is left of today's budget (${policy.remaining()})` :
      !(Number.isInteger(r.maxTimeoutSeconds) && r.maxTimeoutSeconds > 0) ? `timeout ${r.maxTimeoutSeconds}` :
      null;
    if (!why) return r;
    reasons.push(why);
  }
  throw new PaymentRefused(reasons.join("; "));
}

const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

/** EIP-712 typed data of an EIP-3009 transferWithAuthorization. */
export function authorizationTypedData(policy: Pick<PayPolicy, "chainId" | "asset" | "domain">, m: { from: `0x${string}`; to: `0x${string}`; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }) {
  return {
    domain: { name: policy.domain.name, version: policy.domain.version, chainId: policy.chainId, verifyingContract: policy.asset },
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
    primaryType: "TransferWithAuthorization" as const,
    message: m,
  };
}

/**
 * Signs the chosen payment. The window opens a little in the past (clocks differ) and closes
 * after the server's timeout, at most five minutes away.
 */
export async function signPayment(account: LocalAccount, required: PaymentRequired, chosen: PaymentRequirements, policy: PayPolicy, nowSec: number) {
  const value = BigInt(chosen.amount);
  const validAfter = BigInt(nowSec - 30);
  const validBefore = BigInt(nowSec + Math.min(chosen.maxTimeoutSeconds, 300));
  const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
  const to = getAddress(chosen.payTo);
  const signature = await account.signTypedData(authorizationTypedData(policy, { from: account.address, to, value, validAfter, validBefore, nonce }));
  const payload = {
    x402Version: 2,
    resource: required.resource,
    accepted: chosen,
    payload: {
      signature,
      authorization: { from: account.address, to, value: value.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString(), nonce },
    },
  };
  const signed: SignedPayment = { amount: value, payTo: to, nonce, validAfter, validBefore };
  return { header: encodeB64Json(payload), signed };
}

export interface X402Result {
  response: Response;
  /** Set when a payment was signed and sent. */
  payment: SignedPayment | null;
  /** The server's settlement report, when it sent one. */
  settlement: { success: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string } | null;
}

/**
 * fetch with x402. `beforeSend` runs after signing and before the signed request leaves, so the
 * caller can book the spend first; if it throws, nothing is sent.
 */
export async function x402Fetch(
  url: string,
  init: RequestInit & { body?: string },
  o: {
    account: LocalAccount;
    policy: PayPolicy;
    nowSec: () => number;
    beforeSend: (p: SignedPayment) => void;
    /** Runs before signing; throw PaymentRefused to stop (e.g. the wallet cannot cover it). */
    beforeSign?: (chosen: PaymentRequirements) => Promise<void>;
    fetchImpl?: typeof fetch;
    /** Time limit of each of the two requests (default 60 s). */
    timeoutMs?: number;
  },
): Promise<X402Result> {
  const f = o.fetchImpl ?? fetch;
  const limit = () => AbortSignal.timeout(o.timeoutMs ?? 60_000);
  const first = await f(url, { ...init, signal: limit() });
  if (first.status !== 402) return { response: first, payment: null, settlement: null };
  const header = first.headers.get("payment-required");
  if (!header) throw new PaymentRefused("402 without a PAYMENT-REQUIRED header");
  let required: PaymentRequired;
  try {
    required = decodeB64Json<PaymentRequired>(header);
  } catch {
    throw new PaymentRefused("PAYMENT-REQUIRED is not base64 JSON");
  }
  const chosen = choosePayment(required, o.policy);
  await o.beforeSign?.(chosen);
  const { header: signature, signed } = await signPayment(o.account, required, chosen, o.policy, o.nowSec());
  o.beforeSend(signed);
  const headers = new Headers(init.headers);
  headers.set("PAYMENT-SIGNATURE", signature);
  const response = await f(url, { ...init, headers, signal: limit() });
  const pr = response.headers.get("payment-response");
  let settlement: X402Result["settlement"] = null;
  if (pr) {
    try {
      settlement = decodeB64Json(pr);
    } catch {
      settlement = null;
    }
  }
  return { response, payment: signed, settlement };
}
