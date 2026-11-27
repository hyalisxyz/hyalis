import { createHash, createHmac } from "node:crypto";

/**
 * A small S3 client (Railway buckets are S3-compatible), written from AWS's Signature Version 4
 * specification. It signs and sends PUT, GET, HEAD and LIST; nothing else is needed here.
 * test/archive.test.ts checks the signer against the worked examples in AWS's S3 documentation.
 */

export interface S3Config {
  /** e.g. https://t3.storageapi.dev */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** "virtual": https://bucket.host/key (Railway's style); "path": https://host/bucket/key. */
  style?: "virtual" | "path";
  fetchImpl?: typeof fetch;
  /** Time limit of one attempt (default 60 s), attempts per request (default 3), wait between them. */
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sha256hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 requires; "/" kept in paths. */
export function uriEncode(s: string, keepSlash: boolean): string {
  let out = "";
  for (const ch of Buffer.from(s, "utf8")) {
    const c = String.fromCharCode(ch);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) out += c;
    else out += `%${ch.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export interface SignInput {
  method: string;
  host: string;
  /** Path before encoding, starting with "/". */
  path: string;
  query?: Record<string, string>;
  /** Headers to sign besides host, x-amz-date and x-amz-content-sha256. */
  headers?: Record<string, string>;
  payloadHash: string;
  amzDate: string; // YYYYMMDDTHHMMSSZ
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Returns the Authorization header and the signed headers, per AWS SigV4 for S3. */
export function signV4(i: SignInput): { authorization: string; signedHeaders: string; canonicalRequest: string } {
  const date = i.amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: i.host, "x-amz-content-sha256": i.payloadHash, "x-amz-date": i.amzDate };
  for (const [k, v] of Object.entries(i.headers ?? {})) headers[k.toLowerCase()] = v;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const query = Object.entries(i.query ?? {})
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [i.method, uriEncode(i.path, true), query, canonicalHeaders, signedHeaders, i.payloadHash].join("\n");
  const scope = `${date}/${i.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", i.amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, date), i.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  return { authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, signedHeaders, canonicalRequest };
}

export const amzDateOf = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export class S3 {
  readonly cfg: S3Config;
  constructor(cfg: S3Config) {
    this.cfg = cfg;
  }

  private target(key: string) {
    const ep = new URL(this.cfg.endpoint);
    const virtual = (this.cfg.style ?? "virtual") === "virtual";
    const host = virtual ? `${this.cfg.bucket}.${ep.host}` : ep.host;
    const path = virtual ? `/${key}` : `/${this.cfg.bucket}/${key}`;
    return { host, path, base: `${ep.protocol}//${host}` };
  }

  /**
   * One request, signed afresh for each attempt. Every attempt has a time limit, so a stalled
   * connection can never hang the caller. Network failures, 5xx and 429 are tried again (all
   * these calls are idempotent: a PUT of the same bytes to the same key, or a read).
   */
  private async send(method: string, key: string, o: { body?: Uint8Array; contentType?: string; query?: Record<string, string> } = {}) {
    const { host, path, base } = this.target(key);
    const body = o.body ?? new Uint8Array();
    const payloadHash = sha256hex(body);
    const extra: Record<string, string> = o.contentType ? { "content-type": o.contentType } : {};
    const qs = o.query ? "?" + Object.entries(o.query).map(([k, v]) => `${uriEncode(k, false)}=${uriEncode(v, false)}`).join("&") : "";
    const f = this.cfg.fetchImpl ?? fetch;
    const attempts = this.cfg.attempts ?? 3;
    for (let i = 1; ; i++) {
      const amzDate = amzDateOf(new Date());
      const { authorization } = signV4({ method, host, path, query: o.query, headers: extra, payloadHash, amzDate, region: this.cfg.region, accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey });
      try {
        const r = await f(`${base}${uriEncode(path, true)}${qs}`, {
          method,
          headers: { authorization, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash, ...extra },
          ...(method === "PUT" ? { body: new Uint8Array(body) } : {}),
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 60_000),
        });
        if ((r.status >= 500 || r.status === 429) && i < attempts) {
          await r.body?.cancel().catch(() => {});
          await sleep(this.cfg.retryDelayMs ?? 1000 * i);
          continue;
        }
        return r;
      } catch (e) {
        if (i >= attempts) throw new Error(`${method} ${key || "/"}: ${(e as Error).message} after ${attempts} attempts`);
        await sleep(this.cfg.retryDelayMs ?? 1000 * i);
      }
    }
  }

  private static async fail(what: string, r: Response): Promise<never> {
    const text = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`${what}: HTTP ${r.status} ${text}`);
  }

  async put(key: string, body: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    const r = await this.send("PUT", key, { body, contentType });
    if (!r.ok) await S3.fail(`put ${key}`, r);
  }

  /** The object's bytes, or null if there is no such key. */
  async get(key: string): Promise<Buffer | null> {
    const r = await this.send("GET", key);
    if (r.status === 404) return null;
    if (!r.ok) await S3.fail(`get ${key}`, r);
    return Buffer.from(await r.arrayBuffer());
  }

  async exists(key: string): Promise<boolean> {
    const r = await this.send("HEAD", key);
    if (r.status === 404) return false;
    if (!r.ok) await S3.fail(`head ${key}`, r);
    return true;
  }

  async delete(key: string): Promise<void> {
    const r = await this.send("DELETE", key);
    if (!r.ok && r.status !== 404) await S3.fail(`delete ${key}`, r);
  }

  /** Keys under a prefix (ListObjectsV2), all pages. */
  async list(prefix: string): Promise<Array<{ key: string; size: number; lastModified: string }>> {
    const out: Array<{ key: string; size: number; lastModified: string }> = [];
    let token: string | null = null;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
      const r = await this.send("GET", "", { query });
      if (!r.ok) await S3.fail(`list ${prefix}`, r);
      const xml = await r.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const tag = (t: string) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(m[1]!)?.[1] ?? "";
        out.push({ key: decodeXml(tag("Key")), size: Number(tag("Size")), lastModified: tag("LastModified") });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? decodeXml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") || null : null;
    } while (token);
    return out;
  }
}

const decodeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
