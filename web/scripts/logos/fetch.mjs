// Downloads a logo for every market once and writes 48px WebP files to public/logos/, so the
// site serves them itself (its CSP allows no outside images).
// Stocks and ETFs: financialmodelingprep.com/image-stock. Crypto: CoinGecko's small coin images.
// Needs sharp for this run only:  npm i --no-save sharp && node scripts/logos/fetch.mjs
import sharp from "sharp";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = here("../../public/logos");
mkdirSync(out, { recursive: true });
const raw = JSON.parse(readFileSync(here("../../../data/markets.json"), "utf8"));
const markets = Array.isArray(raw) ? raw : raw.markets ?? Object.values(raw);

async function download(url) {
  const r = await fetch(url);
  if (!r.ok || !r.headers.get("content-type")?.includes("image")) throw new Error(`${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// A logo drawn in white on transparency would vanish on the ticker's white disc: put it on black.
async function write(symbol, buf) {
  const base = sharp(buf, { density: 300 }).resize(48, 48, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha();
  const { data, info } = await base.clone().raw().toBuffer({ resolveWithObject: true });
  let sum = 0, n = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] < 128) continue;
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    n++;
  }
  const img = n > 0 && sum / n > 235 ? base.clone().flatten({ background: "#17171b" }) : base.clone();
  await img.webp({ quality: 82, alphaQuality: 90 }).toFile(`${out}/${symbol}.webp`);
}

const crypto = markets.filter((m) => m.assetClass === "crypto");
const coins = await (await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&ids=${crypto.map((m) => m.coingeckoId).join(",")}`)).json();
let done = 0;
for (const m of markets) {
  try {
    const url = m.assetClass === "crypto"
      ? coins.find((c) => c.id === m.coingeckoId)?.image?.replace("/large/", "/small/")
      : `https://financialmodelingprep.com/image-stock/${m.symbol}.png`;
    if (!url) throw new Error("no image");
    await write(m.symbol, await download(url));
    done++;
  } catch (e) {
    console.log(`${m.symbol}: ${e.message}`);
  }
}
console.log(`${done}/${markets.length} logos, ${statSync(out).isDirectory() ? "in public/logos" : ""}`);
