/**
 * Error text that is safe to log. Errors from RPC and HTTP libraries can carry the request URL,
 * and an RPC URL can carry an API key (Alchemy puts it in the path). Every log of an error goes
 * through errLine: first line only, the library's short message when it has one, keys removed.
 */

export function redact(s: string): string {
  // URL forms first, then bare keys, so a key is replaced once.
  return s
    .replace(/(\.alchemy\.com\/v\d+\/)[A-Za-z0-9_-]+/gi, "$1<hidden>")
    .replace(/(\.g\.alchemy\.com\/)(?!v\d+\/)[A-Za-z0-9_-]{16,}/gi, "$1<hidden>")
    .replace(/alch_(?!<hidden>)[A-Za-z0-9_-]+/g, "alch_<hidden>")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-<hidden>")
    .replace(/pyth_[A-Za-z0-9_-]+/g, "pyth_<hidden>")
    .replace(/([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|x-cg-demo-api-key)=)[^&\s"']+/gi, "$1<hidden>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1<hidden>");
}

/** One safe line for an error: the short message if the library gives one, keys removed. */
export function errLine(e: unknown): string {
  const raw = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return redact(String(raw).split("\n")[0] ?? "").slice(0, 500);
}
