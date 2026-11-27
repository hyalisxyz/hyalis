/**
 * Deterministic JSON: object keys sorted, no whitespace. The same record always gives the
 * same bytes, so its hash can be recomputed by anyone. Values that have no single JSON form
 * (NaN, Infinity, undefined, bigint, functions) are rejected instead of silently changed.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

function encode(v: unknown, path: string): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError(`${path}: number must be finite`);
    return JSON.stringify(Object.is(v, -0) ? 0 : v);
  }
  if (Array.isArray(v)) return "[" + v.map((x, i) => encode(x, `${path}[${i}]`)).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .sort()
        .map((k) => {
          if (o[k] === undefined) throw new TypeError(`${path}.${k}: undefined is not allowed`);
          return JSON.stringify(k) + ":" + encode(o[k], `${path}.${k}`);
        })
        .join(",") +
      "}"
    );
  }
  throw new TypeError(`${path}: ${typeof v} cannot be encoded`);
}
