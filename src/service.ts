import { serve } from "@hono/node-server";
import { errLine } from "./util/redact.ts";
import { serveStatic } from "@hono/node-server/serve-static";
import { cacheFor } from "./api/static.ts";
import { existsSync, readFileSync } from "node:fs";
import { createWalletClient, erc20Abi, fallback, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { legacyUrls, loadConfig, loadMarkets, publicUrl } from "./config.ts";
import { recheckIdentities, type IdentityConfig } from "./identity/identity.ts";
import { getAgent } from "./engine/agents.ts";
import { dirname, join } from "node:path";
import { spentToday, ImageService, USDG, usdgText, usdgUnits } from "./media/images.ts";
import { makeAvatars } from "./media/avatars.ts";
import { moodSpentToday, moodWanted, SocialReader } from "./signals/social.ts";
import { arbitrumVenue, LiveTrader, openOrders, VAULT_EXECUTOR_INDEX } from "./live/live.ts";
import { Backup } from "./archive/backup.ts";
import { S3 } from "./archive/s3.ts";
import { openDb } from "./store/db.ts";
import { chainClient, PUBLIC_RPCS, robinhoodChain } from "./sources/chainlink.ts";
import { PlanktonClient } from "./sources/plankton.ts";
import { PythClient } from "./sources/pyth.ts";
import { CoinGeckoClient } from "./sources/coingecko.ts";
import { DexQuoteClient } from "./sources/dexquote.ts";
import { runTick, type TickSummary } from "./engine/tick.ts";
import { Anchorer, type AnchorReport } from "./chain/anchor.ts";
import { buildApi } from "./api/server.ts";
import { entitlement, parseTiers, TokenReader, type TokenConfig } from "./token/token.ts";
import { enforceSlots } from "./token/quota.ts";

// Anything that escapes every handler is logged as one safe line (no URLs with keys). A promise
// nobody awaited is logged and the service keeps running; a thrown exception ends the process
// so Railway restarts it from a clean state.
process.on("unhandledRejection", (e) => console.error("[process] unhandled rejection:", errLine(e)));
process.on("uncaughtException", (e) => {
  console.error("[process] uncaught exception:", errLine(e));
  process.exit(1);
});

const config = loadConfig();
const markets = loadMarkets();
const db = openDb(config.DB_PATH);
const chain = chainClient(config.RPC_URL);
const plankton = config.PLANKTON_API ? new PlanktonClient(config.PLANKTON_API) : null;
const pyth = config.PYTH_API_KEY ? new PythClient(config.PYTH_API_KEY) : null;
const coingecko = new CoinGeckoClient({ apiKey: config.COINGECKO_API_KEY ?? null });
const tokenCfg: TokenConfig = {
  address: (config.TOKEN_ADDRESS as `0x${string}` | undefined) ?? null,
  tiers: parseTiers(config.TOKEN_TIERS),
  burnTokensPerSlot: config.BURN_TOKENS_PER_SLOT,
  burnSlotDays: config.BURN_SLOT_DAYS,
};
const tokenReader = new TokenReader(chain, tokenCfg.address);
console.log(`[token] ${tokenCfg.address ? `launched at ${tokenCfg.address}` : "not launched yet: every wallet is on the free tier"}; tiers ${tokenCfg.tiers.map((t) => `${t.name}>=${t.minTokens}:${t.agents}`).join(" ")}`);
// ERC-8004 identities: house agents are owned by HOUSE_IDENTITY_OWNER, or else by the anchor wallet.
const identityCfg: IdentityConfig = {
  registry: getAddress(config.IDENTITY_REGISTRY),
  publicUrl: publicUrl(config),
  legacyUrls: legacyUrls(config),
  houseOwner: config.HOUSE_IDENTITY_OWNER
    ? getAddress(config.HOUSE_IDENTITY_OWNER)
    : config.ANCHOR_PRIVATE_KEY
      ? privateKeyToAccount(config.ANCHOR_PRIVATE_KEY as `0x${string}`).address
      : null,
  receiptRegistry: config.REGISTRY_ADDRESS ? getAddress(config.REGISTRY_ADDRESS) : null,
  brand: config.BRAND_NAME,
  epochSec: config.EPOCH_SEC,
};
console.log(`[identity] ERC-8004 registry ${identityCfg.registry}; agentURIs under ${identityCfg.publicUrl}; house owner ${identityCfg.houseOwner ?? "none (house identities off)"}`);
// Avatars made by the image service, paid per image with x402 from a wallet that holds only USDG.
// On only when the payer key, the service address, its model and its payment recipient are all set.
const mediaDir = config.MEDIA_DIR ?? join(dirname(config.DB_PATH), "media");
const mediaReady = Boolean(config.MEDIA_PAYER_KEY && config.MEDIA_API && config.MEDIA_MODEL && config.MEDIA_PAY_TO);
const images = mediaReady
  ? new ImageService(db, {
      api: config.MEDIA_API!,
      payTo: config.MEDIA_PAY_TO as `0x${string}`,
      account: privateKeyToAccount(config.MEDIA_PAYER_KEY as `0x${string}`),
      model: config.MEDIA_MODEL!,
      maxPerCall: usdgUnits(config.MEDIA_MAX_USDG_PER_CALL),
      dailyBudget: usdgUnits(config.MEDIA_DAILY_USDG),
      usdgBalance: () =>
        chain.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [privateKeyToAccount(config.MEDIA_PAYER_KEY as `0x${string}`).address] }),
    })
  : null;
console.log(
  `[media] ${images ? `avatars by the image service (${config.MEDIA_MODEL}), paid by ${images.address}, at most ${config.MEDIA_DAILY_USDG} USDG a day` : config.MEDIA_PAYER_KEY ? "off (MEDIA_API, MEDIA_MODEL and MEDIA_PAY_TO are also needed)" : "off (MEDIA_PAYER_KEY not set)"}; files in ${mediaDir}`,
);
let lastMedia: { at: number; made: number; failed: number; stopped: string | null; error: string | null } | null = null;
let mediaRunning = false;
async function mediaRound() {
  if (!images || mediaRunning) return;
  mediaRunning = true;
  try {
    const r = await makeAvatars(db, images, {
      dir: mediaDir,
      assetOf: (s) => markets.find((m) => m.symbol === s)?.assetClass ?? "equity",
      agentOf: (id) => getAgent(db, id),
      epochSec: config.EPOCH_SEC,
      now: () => Math.floor(Date.now() / 1000),
    });
    lastMedia = { at: Math.floor(Date.now() / 1000), made: r.made.length, failed: r.failed.length, stopped: r.stopped, error: null };
    for (const m of r.made) console.log(`[media] avatar for ${m.agentId}: ${m.amount ? usdgText(m.amount) : "?"} USDG, tx ${m.tx ?? "unknown"}`);
    for (const f of r.failed) console.log(`[media] avatar for ${f.agentId} failed: ${f.error}`);
  } catch (e) {
    lastMedia = { at: Math.floor(Date.now() / 1000), made: 0, failed: 0, stopped: null, error: errLine(e) ?? "error" };
    console.error("[media] round failed:", lastMedia.error);
  } finally {
    mediaRunning = false;
  }
}
// Social mood: readings of posts on X for symbols agents with mood rules trade, within a daily budget.
const social =
  config.SOCIAL_API_KEY && config.SOCIAL_API && config.SOCIAL_MODEL
    ? new SocialReader(db, {
        api: config.SOCIAL_API,
        apiKey: config.SOCIAL_API_KEY,
        model: config.SOCIAL_MODEL,
        dailyUsd: config.SOCIAL_DAILY_USD,
        refreshSec: config.SOCIAL_REFRESH_HOURS * 3600,
        perRound: 2,
        epochSec: config.EPOCH_SEC,
        assetOf: (s) => markets.find((m) => m.symbol === s)?.assetClass ?? "equity",
      })
    : null;
console.log(`[social] ${social ? `on: each wanted symbol read every ${config.SOCIAL_REFRESH_HOURS}h, at most $${config.SOCIAL_DAILY_USD} a day` : "off (SOCIAL_API_KEY, SOCIAL_API and SOCIAL_MODEL are needed)"}`);
let lastSocial: { at: number; read: number; failed: number; stopped: string | null; error: string | null } | null = null;
let socialRunning = false;
async function socialRound() {
  if (!social || socialRunning) return;
  socialRunning = true;
  try {
    const r = await social.refresh(() => Math.floor(Date.now() / 1000));
    lastSocial = { at: Math.floor(Date.now() / 1000), read: r.read.length, failed: r.failed.length, stopped: r.stopped, error: null };
    for (const x of r.read) console.log(`[social] ${x.symbol}: mood ${x.score} from ${x.posts} posts, $${x.costUsd.toFixed(3)}`);
    for (const f of r.failed) console.log(`[social] ${f.symbol} failed: ${f.error}`);
  } catch (e) {
    lastSocial = { at: Math.floor(Date.now() / 1000), read: 0, failed: 0, stopped: null, error: errLine(e) ?? "error" };
    console.error("[social] round failed:", lastSocial.error);
  } finally {
    socialRunning = false;
  }
}
// Off-site backups: database snapshots and epoch bundles, to a bucket separate from the volume.
const backup =
  config.BACKUP_ENABLED &&
  config.BACKUP_S3_ENDPOINT && config.BACKUP_S3_BUCKET && config.BACKUP_S3_ACCESS_KEY_ID && config.BACKUP_S3_SECRET_ACCESS_KEY
    ? new Backup(
        db,
        new S3({
          endpoint: config.BACKUP_S3_ENDPOINT,
          bucket: config.BACKUP_S3_BUCKET,
          region: config.BACKUP_S3_REGION,
          accessKeyId: config.BACKUP_S3_ACCESS_KEY_ID,
          secretAccessKey: config.BACKUP_S3_SECRET_ACCESS_KEY,
          style: config.BACKUP_S3_URL_STYLE,
        }),
        { dbPath: config.DB_PATH, everySec: config.BACKUP_EVERY_HOURS * 3600 },
      )
    : null;
console.log(`[backup] ${backup ? `to bucket ${config.BACKUP_S3_BUCKET}, snapshots every ${config.BACKUP_EVERY_HOURS}h, epoch bundles as they are anchored` : config.BACKUP_ENABLED ? "off (BACKUP_S3_* not set)" : "off (BACKUP_ENABLED is not true)"}`);
let lastBackup: Awaited<ReturnType<Backup["run"]>> & { at: number } | null = null;
const dex = new DexQuoteClient(chain);
// Real-money agents: wallets from LIVE_MNEMONIC, swaps on Uniswap V3 only while LIVE_TRADING is true.
const trader = config.LIVE_MNEMONIC
  ? new LiveTrader(db, chain, {
      mnemonic: config.LIVE_MNEMONIC,
      markets,
      slippageBps: config.LIVE_SLIPPAGE_BPS,
      maxGapBps: config.LIVE_MAX_GAP_BPS,
      minOrderUsd: config.LIVE_MIN_ORDER_USD,
      epochSec: config.EPOCH_SEC,
      rpcUrl: config.RPC_URL,
      ...(config.VAULT_ADAPTER ? { vaultAdapter: getAddress(config.VAULT_ADAPTER) } : {}),
    })
  : null;
// Arbitrum One: major crypto with no token on Robinhood Chain, traded in users' vaults there.
const arbVenue = trader && config.VAULT_ARB_FACTORY && config.VAULT_ARB_ADAPTER ? arbitrumVenue({ rpcUrl: config.ARB_RPC_URL, vaultAdapter: getAddress(config.VAULT_ARB_ADAPTER) }) : null;
if (trader && arbVenue) trader.addVenue(arbVenue);
const liveOn = Boolean(trader && config.LIVE_TRADING);
const vaults =
  trader && config.VAULT_FACTORY && config.VAULT_ADAPTER
    ? { factory: getAddress(config.VAULT_FACTORY), adapter: getAddress(config.VAULT_ADAPTER), executor: trader.addressOf(VAULT_EXECUTOR_INDEX), maxDepositUsd: config.VAULT_MAX_DEPOSIT_USD }
    : undefined;
console.log(`[vault] ${vaults ? `on: factory ${vaults.factory}, executor ${vaults.executor}, at most $${vaults.maxDepositUsd} a vault` : "off (VAULT_FACTORY, VAULT_ADAPTER and LIVE_MNEMONIC are needed)"}`);
const arbVaults =
  trader && arbVenue && config.VAULT_ARB_FACTORY && config.VAULT_ARB_ADAPTER
    ? { factory: getAddress(config.VAULT_ARB_FACTORY), adapter: getAddress(config.VAULT_ARB_ADAPTER), executor: trader.addressOf(VAULT_EXECUTOR_INDEX), maxDepositUsd: config.VAULT_MAX_DEPOSIT_USD, pub: arbVenue.pub }
    : undefined;
console.log(`[vault] Arbitrum One ${arbVaults ? `on: factory ${arbVaults.factory}` : "off (VAULT_ARB_FACTORY and VAULT_ARB_ADAPTER are needed)"}`);
console.log(`[live] ${trader ? (liveOn ? `on: swaps on Uniswap V3, slippage ${config.LIVE_SLIPPAGE_BPS} bps, oracle gap ${config.LIVE_MAX_GAP_BPS} bps` : "wallets set, trading off (LIVE_TRADING is not true)") : "off (LIVE_MNEMONIC not set)"}`);
let lastLive: { at: number; filled: number; failed: number; error: string | null } | null = null;
let lastExecutorEth: number | null = null;
/** The executor's gas on each chain with vaults, in ETH. */
const executorEth: Record<string, number> = {};
let marking = false;
/** Every 5 seconds: positions marked at executable prices, and runs ended the moment a target or limit is hit. */
async function markRound() {
  if (!trader || !liveOn || marking) return;
  marking = true;
  try {
    const ended = await trader.watchMarks(() => Math.floor(Date.now() / 1000));
    for (const n of ended) console.log(`[live] ${n}`);
    // A run that just ended sells at once, unless the main loop is already sending orders.
    if (ended.length && !liveRunning) await liveRound();
  } catch (e) {
    console.error("[live] marking failed:", errLine(e));
  } finally {
    marking = false;
  }
}
let liveRunning = false;
async function liveRound() {
  if (!trader || !liveOn || liveRunning) return;
  liveRunning = true;
  try {
    // New vaults, the end of each run, funds going back; then the orders (closes the watch queued go out at once).
    const notes = await trader.watch(() => Math.floor(Date.now() / 1000));
    if (vaults) {
      lastExecutorEth = Number(await chain.getBalance({ address: vaults.executor })) / 1e18;
      executorEth.robinhood = lastExecutorEth;
      if (lastExecutorEth < 0.0005) console.warn(`[vault] executor ${vaults.executor} has ${lastExecutorEth} ETH left for gas on Robinhood Chain; top it up`);
    }
    if (arbVaults) {
      try {
        executorEth.arbitrum = Number(await arbVaults.pub.getBalance({ address: arbVaults.executor })) / 1e18;
        if (executorEth.arbitrum < 0.0005) console.warn(`[vault] executor ${arbVaults.executor} has ${executorEth.arbitrum} ETH left for gas on Arbitrum One; top it up`);
      } catch {
        /* the Arbitrum node not answering is reported by the trades themselves */
      }
    }
    for (const n of notes) console.log(`[live] ${n}`);
    const r = await trader.run(() => Math.floor(Date.now() / 1000));
    if (r.filled.length || r.failed.length || notes.length) lastLive = { at: Math.floor(Date.now() / 1000), filled: r.filled.length, failed: r.failed.length, error: null };
    for (const f of r.filled) console.log(`[live] ${f.agentId} ${f.action} ${f.symbol} $${f.usd.toFixed(2)} tx ${f.tx}`);
    for (const f of r.failed) console.log(`[live] ${f.agentId} ${f.symbol} failed: ${f.error}`);
  } catch (e) {
    lastLive = { at: Math.floor(Date.now() / 1000), filled: 0, failed: 0, error: errLine(e) ?? "error" };
    console.error("[live] round failed:", lastLive.error);
  } finally {
    liveRunning = false;
  }
}
const ctx = { db, chain, markets, plankton, pyth, coingecko, dex, epochSec: config.EPOCH_SEC, backfillSec: config.BACKFILL_DAYS * 86400, liveOn };

/** Anchoring is optional: without a registry and key the service runs and seals locally. */
async function setupAnchorer(): Promise<{ anchorer: Anchorer | null; status: string }> {
  if (!config.REGISTRY_ADDRESS || !config.ANCHOR_PRIVATE_KEY) return { anchorer: null, status: "off (REGISTRY_ADDRESS or ANCHOR_PRIVATE_KEY not set)" };
  const urls = [...(config.RPC_URL ? [config.RPC_URL] : []), ...PUBLIC_RPCS];
  const walletClient = createWalletClient({
    account: privateKeyToAccount(config.ANCHOR_PRIVATE_KEY as `0x${string}`),
    chain: robinhoodChain,
    transport: fallback(urls.map((u) => http(u, { timeout: 20_000 }))),
  });
  const anchorer = new Anchorer({ db, publicClient: chain, walletClient, registry: config.REGISTRY_ADDRESS as `0x${string}`, epochSec: config.EPOCH_SEC });
  try {
    await anchorer.check();
    return { anchorer, status: `on (${config.REGISTRY_ADDRESS})` };
  } catch (e) {
    // A misconfigured registry must not stop trading or sealing; it is reported instead.
    return { anchorer: null, status: `off: ${(e as Error).message}` };
  }
}

const { anchorer, status: anchorStatus } = await setupAnchorer();
console.log(`[anchor] ${anchorStatus}`);

let last: TickSummary | null = null;
let lastAnchor: AnchorReport | null = null;
let running = false;

async function tickBody() {
  // Slots first, so an agent over its owner's quota does not trade this tick.
  try {
    const q = await enforceSlots(db, async (owner) => (await entitlement(db, tokenReader, tokenCfg, owner, Math.floor(Date.now() / 1000))).agentSlots);
    if (q.paused.length || q.resumed.length) console.log(`[quota] paused ${q.paused.length}, resumed ${q.resumed.length}`);
  } catch (e) {
    console.error("[quota] failed:", errLine(e));
  }
  try {
    last = await runTick(ctx);
    console.log(
      `[tick] ${new Date(last.at * 1000).toISOString()} market=${last.market.session}${last.market.reason ? ` (${last.market.reason})` : ""}` +
        ` rounds+${last.roundsAdded} agents=${last.agents} fills=${last.fills} blocked=${last.blocked}` +
        (last.feedsFailed.length ? ` feedsFailed=${last.feedsFailed.join(",")}` : "") +
        (last.sealedEpochs.length ? ` sealed=${last.sealedEpochs.join(",")}` : "") +
        (last.planktonOk === null ? "" : ` plankton=${last.planktonOk ? "ok" : "down"}`) +
        (last.pythOk === null ? "" : ` pyth=${last.pythOk ? "ok" : "down"}`) +
        (last.coingeckoOk === null ? "" : ` coingecko=${last.coingeckoOk ? "ok" : "down"}+${last.dataFeedRounds}`) +
        (last.dexOk === null ? "" : ` dex=${last.dexOk ? "ok" : "partial"}`),
    );
  } catch (e) {
    console.error("[tick] failed:", errLine(e));
  }
  if (anchorer) {
    try {
      lastAnchor = await anchorer.run();
      if (lastAnchor.anchored.length || lastAnchor.error)
        console.log(
          `[anchor] published ${lastAnchor.anchored.map((a) => a.epoch).join(",") || "none"}, pending ${lastAnchor.pending}` +
            (lastAnchor.error ? ` STOPPED: ${lastAnchor.error}` : ""),
        );
    } catch (e) {
      // Network or gas problems: try again next tick.
      console.error("[anchor] failed:", errLine(e));
    }
  }
  try {
    const r = await recheckIdentities(db, chain, identityCfg, (id) => getAgent(db, id), Math.floor(Date.now() / 1000));
    if (r.changed.length || r.failed) console.log(`[identity] checked ${r.checked}, failed ${r.failed}` + r.changed.map((x) => ` ${x.agentId}:${x.from}->${x.to}`).join(""));
  } catch (e) {
    console.error("[identity] recheck failed:", errLine(e));
  }
}

/** One tick at a time; the flag is always released, so an unexpected error cannot stop the loop. */
async function tick() {
  if (running) return;
  running = true;
  try {
    await tickBody();
  } catch (e) {
    console.error("[tick] unexpected error:", errLine(e));
  } finally {
    running = false;
  }
}

/** Backups run on their own loop, so a slow or stalled upload never delays trading. */
let backingUp = false;
async function backupRound() {
  if (!backup || backingUp) return;
  backingUp = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    lastBackup = { ...(await backup.run(now)), at: now };
    if (lastBackup.error) console.error("[backup] failed:", lastBackup.error);
    else if (lastBackup.snapshot || lastBackup.bundles)
      console.log(`[backup] ${lastBackup.bundles} bundle(s)${lastBackup.snapshot ? `, snapshot ${lastBackup.snapshot.bytes} bytes` : ""}, pending ${lastBackup.pendingBundles}`);
  } catch (e) {
    console.error("[backup] unexpected error:", errLine(e));
  } finally {
    backingUp = false;
  }
}

if (process.argv.includes("--once")) {
  await tick();
  db.close();
} else {
  if (!process.env.ADMIN_TOKEN) console.warn("[warn] ADMIN_TOKEN is not set: anyone who can reach this port can create agents.");
  const app = buildApi({
    db,
    config,
    markets,
    lastTick: () => last,
    anchor: () => ({ status: anchorStatus, halted: anchorer?.halted ?? null, last: lastAnchor }),
    chain,
    token: { reader: tokenReader, cfg: tokenCfg },
    trustProxy: process.env.TRUST_PROXY === "true",
    adminToken: process.env.ADMIN_TOKEN,
    identity: identityCfg,
    mediaDir,
    backup: () => (backup ? { bucket: config.BACKUP_S3_BUCKET, ...backup.status(), last: lastBackup } : { status: "off" }),
    media: () =>
      images
        ? {
            payer: images.address,
            model: config.MEDIA_MODEL,
            spentTodayUsdg: usdgText(spentToday(db, Math.floor(Date.now() / 1000))),
            dailyBudgetUsdg: config.MEDIA_DAILY_USDG,
            last: lastMedia,
          }
        : { status: "off" },
    liveWallet: trader ? (i: number) => trader.addressOf(i) : undefined,
    live: () => (trader ? { status: liveOn ? "on" : "off", openOrders: openOrders(db).length, last: lastLive, executorEth: lastExecutorEth, executorEthByChain: executorEth, warning: Object.entries(executorEth).filter(([, e]) => e < 0.0005).map(([k]) => `the vaults' executor is low on ETH for gas on ${k}; top it up`).join("; ") || null } : { status: "off" }),
    vaults,
    arbVaults,
    socialOn: Boolean(social),
    social: () =>
      social
        ? {
            status: "on",
            wanted: moodWanted(db).length,
            spentTodayUsd: Math.round(moodSpentToday(db, Math.floor(Date.now() / 1000)) * 1000) / 1000,
            dailyBudgetUsd: config.SOCIAL_DAILY_USD,
            last: lastSocial,
          }
        : { status: "off" },
  });
  // The website (web/dist, built by Vite) is served from the same origin as the API.
  // Text files go out as the Brotli or gzip copy written at build time (web/scripts/precompress.mjs).
  // Any other non-API path gets index.html for client routing.
  if (existsSync("web/dist/index.html")) {
    const indexHtml = readFileSync("web/dist/index.html", "utf8");
    const site = serveStatic({ root: "./web/dist", precompressed: true, onFound: (path, c) => c.header("cache-control", cacheFor(path)) });
    if (existsSync("web/dist/landing.html")) {
      const variants = [
        { enc: "br", file: "web/dist/landing.html.br" },
        { enc: "gzip", file: "web/dist/landing.html.gz" },
      ].filter((v) => existsSync(v.file)).map((v) => ({ ...v, body: readFileSync(v.file) }));
      const plain = readFileSync("web/dist/landing.html");
      app.get("/", (c) => {
        c.header("cache-control", "no-cache");
        c.header("content-type", "text/html; charset=UTF-8");
        c.header("vary", "accept-encoding");
        const accepts = c.req.header("accept-encoding") ?? "";
        const v = variants.find((x) => accepts.includes(x.enc));
        if (v) {
          c.header("content-encoding", v.enc);
          return c.body(new Uint8Array(v.body));
        }
        return c.body(new Uint8Array(plain));
      });
      console.log("[web] landing page prerendered");
    }
    app.use("/*", site);
    // An agent's page carries its own share preview: name, return, and its avatar when it has one.
    const base = publicUrl(config);
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const withMeta = (html: string, m: { title: string; description: string; url: string; image?: string }) =>
      html
        .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(m.title)}" />`)
        .replace(/<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${esc(m.title)}" />`)
        .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${esc(m.description)}" />`)
        .replace(/<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${esc(m.description)}" />`)
        .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${esc(m.url)}" />`)
        .replace(/<title>[^<]*<\/title>/, `<title>${esc(m.title)}</title>`)
        .replace(/(<meta (?:property="og:image"|name="twitter:image") content=")[^"]*(" \/>)/g, (_, a, b) => (m.image ? `${a}${esc(m.image)}${b}` : `${a}${base}/og.png${b}`));
    app.get("*", (c) => {
      if (c.req.path.startsWith("/v1/")) return c.json({ error: "not found" }, 404);
      // A file that is not there (often a code chunk from an older build) is a 404, never the
      // page's HTML: served as a script, HTML fails to run and the page goes blank.
      if (c.req.path.startsWith("/assets/") || /\.(js|mjs|css|map|json|png|jpe?g|webp|svg|ico|woff2?|txt|xml)$/i.test(c.req.path)) {
        c.header("cache-control", "no-store");
        return c.text("not found", 404);
      }
      c.header("cache-control", "no-cache");
      const m = /^\/app\/agents\/([0-9a-f-]{36})$/i.exec(c.req.path);
      const a = m ? getAgent(db, m[1]!) : null;
      if (a) {
        const acct = db.prepare("SELECT start_equity, equity FROM accounts WHERE agent_id = ?").get(a.id) as { start_equity: number; equity: number } | undefined;
        const ret = acct && acct.start_equity > 0 ? ((acct.equity - acct.start_equity) / acct.start_equity) * 100 : 0;
        const avatar = db.prepare("SELECT 1 FROM agent_media WHERE agent_id = ? AND status = 'ready'").get(a.id);
        return c.html(
          withMeta(indexHtml, {
            title: `${a.name}: ${ret >= 0 ? "+" : ""}${ret.toFixed(2)}% · Hyalis`,
            description: `${a.strategy.summary} Every decision is sealed on Robinhood Chain.`,
            url: `${base}/app/agents/${a.id}`,
            ...(avatar ? { image: `${base}/v1/agents/${a.id}/avatar` } : {}),
          }),
        );
      }
      return c.html(indexHtml);
    });
    console.log("[web] serving web/dist");
  } else console.log("[web] web/dist not built; API only");
  serve({ fetch: app.fetch, port: config.PORT, hostname: process.env.HOST ?? "127.0.0.1" }, (info) =>
    console.log(`[api] listening on http://${info.address}:${info.port}`),
  );
  await tick();
  setInterval(tick, config.TICK_SEC * 1000);
  if (backup) {
    void backupRound();
    setInterval(backupRound, config.TICK_SEC * 1000);
  }
  // Live swaps run on their own loop, so a slow transaction never delays the tick.
  if (liveOn) {
    setInterval(liveRound, 20_000);
    setInterval(markRound, 5_000);
  }
  // Mood readings run on their own loop too; a slow search never delays trading.
  if (social) {
    void socialRound();
    setInterval(socialRound, config.TICK_SEC * 1000);
  }
  // Avatars run on their own loop, so waiting for an image never delays trading.
  if (images) {
    void mediaRound();
    setInterval(mediaRound, 60_000);
  }
}
