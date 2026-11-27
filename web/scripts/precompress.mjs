// Writes a Brotli (.br) and gzip (.gz) copy next to every text file in dist, so the server
// can send the smallest version a browser accepts without compressing on each request.
// Fonts (woff2) and images are already compressed and are left alone.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const TEXT = /\.(js|css|html|svg|json|txt|xml|map)$/;
const MIN_BYTES = 1024;

let files = 0;
let before = 0;
let after = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    if (!TEXT.test(name)) continue;
    const raw = readFileSync(path);
    if (raw.length < MIN_BYTES) continue;
    const br = brotliCompressSync(raw, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
    });
    const gz = gzipSync(raw, { level: 9 });
    // Keep a compressed copy only when it is actually smaller.
    if (br.length < raw.length) writeFileSync(`${path}.br`, br);
    if (gz.length < raw.length) writeFileSync(`${path}.gz`, gz);
    files++;
    before += raw.length;
    after += Math.min(br.length, raw.length);
  }
}
walk(ROOT);
console.log(`precompressed ${files} files: ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB (brotli)`);
