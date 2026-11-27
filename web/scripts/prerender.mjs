/**
 * Prerenders the landing page into dist/landing.html after the client build:
 *  1. builds src/entry-server.tsx for Node (dist-ssr, removed afterwards);
 *  2. renders "/" with it;
 *  3. puts the HTML into dist/index.html's root, with the landing page's own CSS linked and its
 *     JavaScript preloaded (from Vite's manifest), so it paints styled before scripts run.
 * The server sends landing.html for "/" only; every other path keeps the empty index.html.
 */
import { build } from "vite";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SSR = join(ROOT, "dist-ssr");

await build({ root: ROOT, logLevel: "warn", build: { ssr: "src/entry-server.tsx", outDir: SSR, emptyOutDir: true, manifest: false, copyPublicDir: false } });
const { render } = await import(pathToFileURL(join(SSR, "entry-server.js")).href);
const app = await render("/");
rmSync(SSR, { recursive: true, force: true });

const manifest = JSON.parse(readFileSync(join(DIST, ".vite", "manifest.json"), "utf8"));
const landing = manifest["src/pages/Landing.tsx"];
if (!landing) throw new Error("the manifest has no entry for src/pages/Landing.tsx");
// The landing chunk's CSS, and that of the chunks it imports.
const css = new Set();
const js = new Set([landing.file]);
const walk = (e) => {
  for (const c of e.css ?? []) css.add(c);
  for (const i of e.imports ?? []) {
    const d = manifest[i];
    if (d && !js.has(d.file)) {
      js.add(d.file);
      walk(d);
    }
  }
};
walk(landing);

let html = readFileSync(join(DIST, "index.html"), "utf8");
if (!html.includes('<div id="root"></div>')) throw new Error("dist/index.html has no empty root");
// Files the page already loads are not linked again.
const fresh = (f) => !html.includes(`/${f}"`);
const head = [...css].filter(fresh).map((c) => `<link rel="stylesheet" href="/${c}">`).join("") + [...js].filter(fresh).map((f) => `<link rel="modulepreload" href="/${f}">`).join("");
html = html.replace("</head>", `${head}</head>`).replace('<div id="root"></div>', `<div id="root">${app}</div>`);
writeFileSync(join(DIST, "landing.html"), html);
console.log(`prerendered / into dist/landing.html: ${(app.length / 1024).toFixed(1)} KB of HTML, ${css.size} stylesheet(s), ${js.size} preloaded chunk(s)`);
if (!existsSync(join(DIST, "landing.html"))) process.exit(1);
