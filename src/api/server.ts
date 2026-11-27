import { Hono, type Context } from "hono";
import { errLine } from "../util/redact.ts";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { createHash, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { exportResponse } from "../archive/export.ts";
import { getAddress, isAddress, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import { CHAIN_ID, type Config, type Market } from "../config.ts";
import { compileStrategy, compileVersions } from "../brain/compile.ts";
import { deflatedSharpe } from "../engine/metrics.ts";
import { Policy, strategyPolicyErrors } from "../guard/policy.ts";
import { checkBounds, maxLookback, Strategy, usesSocial } from "../strategy/schema.ts";
import { agentsOf, createAgent, getAccount, getAgent, listAgents, setStatus, START_EQUITY, type AgentRow } from "../engine/agents.ts";
import { addReceipt, epochOf, receiptWithProof } from "../engine/epochs.ts";
import { latestStored, loadRounds } from "../engine/ingest.ts";
import { roundPrice } from "../sources/chainlink.ts";
import { recordHash } from "../receipts/merkle.ts";
import type { TickSummary } from "../engine/tick.ts";
import { runBacktest, type BacktestResult } from "../engine/backtest.ts";
import { HOUR } from "../strategy/series.ts";
import { createNonce, endSession, sessionAddress, verifySignIn } from "../users/auth.ts";
import { BURN_ADDRESSES, claimBurn, countCompile, entitlement, utcDay, type TokenConfig, type TokenReader } from "../token/token.ts";
import { agentImage, canonicalUri, expectedOwner, getIdentity, linkIdentity, linkIdentityByTx, RegistryLagError, registrationFile, type IdentityConfig } from "../identity/identity.ts";
import { agentRegistryId } from "../chain/identity.ts";
import { journalOf, lastJournalReceipt, lessonsBrief } from "../journal/lessons.ts";
import { avatarFile, avatarOf } from "../media/avatars.ts";
import { bundleBytes, epochBundle } from "../archive/bundle.ts";
import { firstMoodAt, moodAsOf, moodBoard } from "../signals/social.ts";
import { recordTrade, TradeError, tradesOf, tradeTokens } from "../trade/trades.ts";
import { agentNow } from "../engine/now.ts";
import { endAt, markEnded } from "../engine/end.ts";
import { markOf, queueCloses } from "../live/live.ts";
import { ROBINHOOD_VAULTS, vaultsOf, verifyVaultAddress, verifyVaultCreation, VaultCheckError, type VaultChain } from "../live/vaults.ts";
import { ARBITRUM, CHAIN_NAMES, type ChainKey } from "../chains.ts";
import { UNISWAP } from "../live/uniswap.ts";

export interface ApiDeps {
  db: DatabaseSync;
  config: Config;
  markets: Market[];
  lastTick: () => TickSummary | null;
  /** Anchoring status for /health. */
  anchor?: () => unknown;
  /** Operator token for house agents and moderation. Unset disables admin access entirely. */
  adminToken?: string;
  /** Robinhood Chain client: verifies sign-in signatures and burn transactions. */
  chain: PublicClient;
  token: { reader: TokenReader; cfg: TokenConfig };
  /** Replaceable in tests. */
  compile?: typeof compileStrategy;
  compileVersions?: typeof compileVersions;
  now?: () => number;
  /** POST requests allowed per client IP per minute. */
  rateLimitPerMinute?: number;
  /** Trust x-forwarded-for (only behind a proxy that sets it, such as Railway's). */
  trustProxy?: boolean;
  /** ERC-8004 identities (Agent Passport). Unset turns the identity routes off. */
  identity?: IdentityConfig;
  /** Folder of generated images (agent avatars). */
  mediaDir?: string;
  /** Avatar making status for /health. */
  media?: () => unknown;
  /** Off-site backup status for /health. */
  backup?: () => unknown;
  /** Whether the social reader is configured (social_mood rules can be read), and its status for /health. */
  socialOn?: boolean;
  /** Wallet address of a real-money agent, by its index; unset when live trading is not configured. */
  liveWallet?: (index: number) => string;
  /** Live trading status for /health. */
  live?: () => unknown;
  /** Users' vaults: where they are made, the adapter, the executor, and the latest executable equity. */
  vaults?: {
    factory: `0x${string}`;
    adapter: `0x${string}`;
    executor: `0x${string}`;
    maxDepositUsd: number;
  };
  /** Users' vaults on Arbitrum One (major crypto, USDC cash), read through its own client. */
  arbVaults?: {
    factory: `0x${string}`;
    adapter: `0x${string}`;
    executor: `0x${string}`;
    maxDepositUsd: number;
    pub: PublicClient;
  };
  social?: () => unknown;
}

/** Return in percent; 0 for an account not funded yet (a real-money agent before its deposit). */
const returnPct = (equity: number, start: number) => (start > 0 ? ((equity - start) / start) * 100 : 0);

const CreateAgent = z
  .object({
    name: z.string().min(1).max(60).optional(),
    /** A strategy in plain language; compiled by the brain. */
    prompt: z.string().min(10).max(4000).optional(),
    /** Or the rules directly, skipping the brain. */
    strategy: Strategy.optional(),
    policy: Policy.partial().optional(),
    /** Compile and backtest only; do not create the agent. */
    dryRun: z.boolean().optional(),
    /** Build on this agent's sealed lessons: they are given to the brain and recorded on the new agent. */
    basedOn: z.string().uuid().optional(),
    /** The journal digest a dry run showed; creating fails if the lessons changed since. */
    basedOnDigest: z.string().regex(/^0x[0-9a-f]{64}$/).optional(),
    backtestDays: z.number().int().min(1).max(90).optional(),
    /** Dry run only: the brain writes 3 or 4 versions, all are backtested, one is chosen on the first 70% of the history. */
    versions: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.prompt) !== Boolean(b.strategy), "send either prompt or strategy, not both");

const BacktestBody = z.object({
  strategy: Strategy,
  policy: Policy.partial().optional(),
  days: z.number().int().min(1).max(90).optional(),
});

type Who = { kind: "admin" } | { kind: "user"; address: string } | null;

/** Compares two secrets in constant time (hashing first, so different lengths leak nothing either). */
export function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Content Security Policy for the site. Everything it loads is its own (scripts, styles, fonts and
 * images are served from here, with no inline code); the only other place it talks to is
 * Robinhood Chain's public RPC endpoints, for reads and in-browser verification. The wallet runs
 * in its own extension and is not affected.
 */
export const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // Style attributes only (no <style> blocks): the prerendered landing page carries a few,
  // such as animation delays, that React would otherwise set from script.
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://robinhood-rpc.publicnode.com https://robinhood.drpc.org",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

export function buildApi(d: ApiDeps) {
  const app = new Hono();

  // Security headers on every response, the website's pages included. The site asks wallets to
  // sign, so no other site may frame it (clickjacking). Routes that set their own CSP keep it.
  app.use("*", async (c, next) => {
    await next();
    const h = c.res.headers;
    if (!h.has("content-security-policy")) h.set("content-security-policy", SITE_CSP);
    // The site's own pages are for this site; the public API (/v1) is meant to be read by others
    // too (agent images and ERC-8004 registration files, for example).
    h.set("cross-origin-resource-policy", c.req.path.startsWith("/v1/") ? "cross-origin" : "same-origin");
    h.set("x-frame-options", "DENY");
    h.set("x-content-type-options", "nosniff");
    h.set("referrer-policy", "strict-origin-when-cross-origin");
    h.set("strict-transport-security", "max-age=31536000");
    h.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  });

  // An error nobody caught: one safe line in the log, a plain answer to the caller. (Hono's default
  // would print the whole error, which for an RPC failure includes the RPC URL.)
  app.onError((e, c) => {
    console.error(`[api] ${c.req.method} ${c.req.path}:`, errLine(e));
    return c.json({ error: "something went wrong on our side; try again" }, 500);
  });

  app.use("/v1/*", cors({ origin: "*", allowMethods: ["GET", "POST"], allowHeaders: ["authorization", "content-type"] }));
  // JSON and SVG answers are gzipped for clients that accept it (markets is ~14 KB raw, ~2 KB gzipped).
  // Already-compressed types (PNG avatars) and answers under 1 KB are sent as they are.
  app.use("/v1/*", compress());
  const symbols = d.markets.map((m) => m.symbol);
  const bySymbol = new Map(d.markets.map((m) => [m.symbol, m]));
  const assetOf = (sym: string) => bySymbol.get(sym)?.assetClass ?? "equity";
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const compile = d.compile ?? compileStrategy;
  const versionsOf = d.compileVersions ?? compileVersions;

  // ------------------------------------------------------------------ helpers

  const bearer = (c: Context) => {
    const h = c.req.header("authorization") ?? "";
    return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
  };
  const who = (c: Context): Who => {
    const t = bearer(c);
    if (!t) return null;
    if (d.adminToken && sameSecret(t, d.adminToken)) return { kind: "admin" };
    const address = sessionAddress(d.db, t, now());
    return address ? { kind: "user", address } : null;
  };

  // A full copy of the database, for moving the service to another host. Off unless
  // ADMIN_EXPORT_ENABLED is true, and then only for the operator token; anyone else gets the same
  // 404 as for a path that does not exist.
  app.get("/v1/admin/export", (c) => {
    if (!d.config.ADMIN_EXPORT_ENABLED || who(c)?.kind !== "admin") return c.json({ error: "not found" }, 404);
    return exportResponse(d.db);
  });

  // A small fixed-window limiter for POSTs, per client IP.
  const hits = new Map<string, { window: number; n: number }>();
  const limit = d.rateLimitPerMinute ?? 30;
  app.use("*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const ip = (d.trustProxy ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : null) ?? c.req.header("x-real-ip") ?? "local";
    const window = Math.floor(Date.now() / 60_000);
    const h = hits.get(ip);
    if (!h || h.window !== window) hits.set(ip, { window, n: 1 });
    else if (++h.n > limit) return c.json({ error: "too many requests, slow down" }, 429);
    if (hits.size > 10_000) hits.clear();
    return next();
  });

  const backtest = (strategy: Strategy, policy: Policy, days: number): BacktestResult => {
    const to = now();
    const from = to - days * 86400;
    // Enough earlier history for the longest window, across weekends and holidays.
    const since = from - (maxLookback(strategy) * 2 + 24 * 6) * HOUR;
    const rounds = new Map(strategy.symbols.map((sym) => [sym, loadRounds(d.db, sym, since)]));
    const heartbeatSec = new Map(d.markets.map((m) => [m.symbol, m.heartbeatSec]));
    const assetClass = new Map(d.markets.map((m) => [m.symbol, m.assetClass]));
    return runBacktest({ strategy, policy, rounds, heartbeatSec, assetClass, from, to, moodAt: (sym, t) => moodAsOf(d.db, sym, t), moodSince: firstMoodAt(d.db) });
  };

  /** Public view of an agent. The written prompt stays private to its owner; its hash is sealed. */
  const publicAgent = (a: AgentRow) => ({
    id: a.id,
    name: a.name,
    status: a.status,
    pauseReason: a.pauseReason,
    owner: a.owner,
    house: a.owner === null,
    // Real money: the agent's own wallet, so its balance and every swap can be checked on chain.
    money: a.liveIndex === null && a.vault === null ? "paper" : "real",
    wallet: a.vault ?? (a.liveIndex !== null && d.liveWallet ? d.liveWallet(a.liveIndex) : null),
    vault: a.vault,
    chain: a.chain,
    endAt: endAt(a),
    endedAt: a.endedAt,
    endedReason: a.endedReason,
    stopState: a.stopState,
    // "verified" when every symbol is priced from Chainlink on Robinhood Chain.
    markets: a.strategy.symbols.every((s) => bySymbol.get(s)?.source === "chainlink") ? "verified" : "includes-data-feed",
    strategy: a.strategy,
    strategyHash: a.strategyHash,
    policy: a.policy,
    createdAt: a.createdAt,
    basedOn: a.basedOn,
    identity: d.identity ? getIdentity(d.db, a.id) : null,
    avatar: avatarPath(a.id),
  });
  /** Same-origin path of the agent's avatar once it is made, else null. */
  const avatarPath = (id: string) => (avatarOf(d.db, id)?.status === "ready" ? `/v1/agents/${id}/avatar` : null);
  const verifiedMarkets = (a: AgentRow) => a.strategy.symbols.every((s) => bySymbol.get(s)?.source === "chainlink");

  const wallet = (address: string) => entitlement(d.db, d.token.reader, d.token.cfg, address, now());

  // ------------------------------------------------------------------ public reads

  app.get("/health", (c) => c.json({ ok: true, lastTick: d.lastTick(), anchor: d.anchor?.() ?? null, media: d.media?.() ?? null, backup: d.backup?.() ?? null, social: d.social?.() ?? null, live: d.live?.() ?? null }));

  // Latest mood of posts on X per symbol agents read, each with the receipt it was sealed in.
  app.get("/v1/signals/social", (c) => c.json({ on: Boolean(d.socialOn), readings: moodBoard(d.db, now()) }));

  app.get("/v1/markets", (c) =>
    c.json(
      d.markets.map((m) => {
        const r = latestStored(d.db, m.symbol);
        return {
          symbol: m.symbol,
          assetClass: m.assetClass,
          // "verified": price from a Chainlink feed on Robinhood Chain, checkable on chain.
          // "data-feed": price from an off-chain API, recorded but not checkable; paper trading only.
          tier: m.source === "chainlink" ? "verified" : "data-feed",
          source: m.source,
          hours: m.assetClass === "crypto" ? "24/7" : "24/5",
          feed: m.feed,
          price: r ? roundPrice(r) : null,
          roundId: r?.roundId ?? null,
          updatedAt: r?.updatedAt ?? null,
          // The tradable token on Robinhood Chain, for the Trade page; null when there is none.
          token: m.token ?? null,
          tokenDecimals: m.token ? (m.tokenDecimals ?? 18) : null,
        };
      }),
    ),
  );

  // ------------------------------------------------------------------ manual trades (Trade page)

  /** What the Trade page offers, and where it swaps. */
  app.get("/v1/trade/config", (c) => c.json({ chainId: 4663, router: UNISWAP.router, quoter: UNISWAP.quoter, tokens: tradeTokens(d.markets) }));

  /** Records a swap the user made from their own wallet, from what the chain says it did. */
  app.post("/v1/trades", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { txHash?: string } | null;
    if (!body?.txHash || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) return c.json({ error: "txHash is required" }, 400);
    try {
      return c.json({ trade: await recordTrade(d.db, d.chain, d.markets, body.txHash as `0x${string}`, d.config.EPOCH_SEC, now()) }, 201);
    } catch (e) {
      if (e instanceof TradeError) return c.json({ error: e.message }, e.status as 404 | 422);
      console.error("[trade]", errLine(e));
      return c.json({ error: "could not read the transaction; try again" }, 503);
    }
  });

  app.get("/v1/wallets/:address/trades", (c) => {
    const a = c.req.param("address");
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return c.json({ error: "not an address" }, 400);
    return c.json(tradesOf(d.db, a));
  });

  app.get("/v1/token", async (c) => {
    const meta = await d.token.reader.metadata().catch(() => null);
    return c.json({
      launched: Boolean(d.token.cfg.address),
      address: d.token.cfg.address,
      symbol: meta?.symbol ?? null,
      chainId: CHAIN_ID,
      tiers: d.token.cfg.tiers,
      burn: { tokensPerSlot: d.token.cfg.burnTokensPerSlot, slotDays: d.token.cfg.burnSlotDays, to: [...BURN_ADDRESSES] },
    });
  });

  /** What a connected wallet sees straight away: balance, tier, slots, AI quota. No sign-in needed. */
  app.get("/v1/wallets/:address", async (c) => {
    const a = c.req.param("address");
    if (!isAddress(a, { strict: false })) return c.json({ error: "not an address" }, 400);
    try {
      return c.json(await wallet(a));
    } catch (e) {
      console.error("[wallet]", errLine(e));
      return c.json({ error: "could not read the wallet from the chain; try again" }, 503);
    }
  });

  // ------------------------------------------------------------------ sign-in

  app.post("/v1/auth/nonce", async (c) => {
    const body = z.object({ address: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success || !isAddress(body.data.address, { strict: false })) return c.json({ error: "send { address }" }, 400);
    return c.json(createNonce(d.db, body.data.address, { domain: d.config.APP_DOMAIN, brand: d.config.BRAND_NAME, chainId: CHAIN_ID }, now()));
  });

  app.post("/v1/auth/verify", async (c) => {
    const body = z
      .object({ address: z.string(), nonce: z.string(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "send { address, nonce, signature }" }, 400);
    const r = await verifySignIn(d.db, d.chain, { ...body.data, signature: body.data.signature as Hex }, now());
    return r.ok ? c.json({ token: r.token, address: r.address, expiresAt: r.expiresAt }) : c.json({ error: r.reason }, 401);
  });

  app.post("/v1/auth/logout", (c) => {
    const t = bearer(c);
    if (t) endSession(d.db, t);
    return c.json({ ok: true });
  });

  app.get("/v1/me", async (c) => {
    const w = who(c);
    if (w?.kind !== "user") return c.json({ error: "sign in first" }, 401);
    const agents = agentsOf(d.db, w.address).map((a) => ({ ...publicAgent(a), prompt: a.prompt, account: getAccount(d.db, a.id) }));
    try {
      return c.json({ ...(await wallet(w.address)), agents });
    } catch {
      return c.json({ error: "could not read the wallet from the chain; try again" }, 503);
    }
  });

  // ------------------------------------------------------------------ agents

  const createHandler = async (c: Context) => {
    const w = who(c);
    if (!w) return c.json({ error: "sign in first" }, 401);
    const parsed = CreateAgent.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const body = parsed.data;
    const policy = Policy.parse(body.policy ?? {});
    const allowed = policy.allowedSymbols.length ? policy.allowedSymbols.filter((s) => symbols.includes(s)) : symbols;
    const t = now();

    // The agent this one improves on: its lessons go to the brain and are recorded with the new agent.
    let base: { agent: AgentRow; journal: ReturnType<typeof journalOf>; sealed: ReturnType<typeof lastJournalReceipt> } | null = null;
    if (body.basedOn) {
      const b = getAgent(d.db, body.basedOn);
      if (!b) return c.json({ error: "basedOn: no agent with that id" }, 404);
      base = { agent: b, journal: journalOf(d.db, b.id, t), sealed: lastJournalReceipt(d.db, b.id) };
      // The record must name the lessons that were actually used, so a stale test is refused.
      if (body.basedOnDigest && body.basedOnDigest !== base.journal.digest)
        return c.json({ error: "the lessons of that agent changed since your test; test again to use the newest ones", digest: base.journal.digest }, 409);
    } else if (body.basedOnDigest) return c.json({ error: "basedOnDigest needs basedOn" }, 400);

    // Users: check slots before spending anything, and the daily AI quota before the brain call.
    let ent: Awaited<ReturnType<typeof wallet>> | null = null;
    if (w.kind === "user") {
      try {
        ent = await wallet(w.address);
      } catch {
        return c.json({ error: "could not read the wallet from the chain; try again" }, 503);
      }
      if (!body.dryRun && ent.agentsActive >= ent.agentSlots)
        return c.json({ error: "no free agent slot", agentSlots: ent.agentSlots, agentsActive: ent.agentsActive, tier: ent.tier.name, nextTier: ent.nextTier }, 403);
      if (body.prompt && ent.compilesToday >= ent.compilesPerDay)
        return c.json({ error: "daily AI limit reached; it resets at 00:00 UTC", compilesPerDay: ent.compilesPerDay, tier: ent.tier.name }, 429);
    }

    // Mood rules read posts on X and cost money per reading: only with the reader on, and for users
    // only on tiers that include them. House agents (operator token) may use them.
    const allowSocial = Boolean(d.socialOn) && (w.kind !== "user" || Boolean(ent?.tier.social));

    let strategy: Strategy;
    let errors: string[];
    // Several versions, tested side by side: one brain call, counted as one build.
    if (body.prompt && body.versions && body.dryRun) {
      if (w.kind === "user") countCompile(d.db, w.address, utcDay(t));
      let out;
      try {
        out = await versionsOf(body.prompt, { allowedSymbols: allowed, assetOf, policy, model: d.config.BRAIN_MODEL, brand: d.config.BRAND_NAME, allowSocial, ...(base ? { lessons: lessonsBrief(base.journal) } : {}) });
      } catch (e) {
        console.error("[brain]", errLine(e));
        return c.json({ error: "the brain could not turn this strategy into rules; try rewording it" }, 502);
      }
      const days = body.backtestDays ?? 30;
      const tested = out.versions
        .filter((v) => !v.errors.length && !checkBounds(v.strategy, new Set(allowed)).length && !strategyPolicyErrors(v.strategy, policy, assetOf).length && (!usesSocial(v.strategy) || allowSocial))
        .map((v) => ({ strategy: v.strategy, backtest: backtest(v.strategy, policy, days) }));
      if (!tested.length) return c.json({ error: "none of the versions fit the limits", errors: out.versions.flatMap((v) => v.errors) }, 422);
      // Chosen on the first 70% of the hours only (Sharpe there, then return); the rest is the check it never saw.
      const score = (b: BacktestResult) => [b.split?.inSample.sharpe ?? -Infinity, b.split?.inSample.returnPct ?? b.returnPct] as const;
      let best = 0;
      tested.forEach((v, k) => {
        const [s1, r1] = score(v.backtest);
        const [s0, r0] = score(tested[best]!.backtest);
        if (s1 > s0 || (s1 === s0 && r1 > r0)) best = k;
      });
      const srs = tested.map((v) => v.backtest.raw?.sr).filter((x): x is number => typeof x === "number");
      const chosen = tested[best]!;
      const deflated = chosen.backtest.raw && srs.length > 1 ? deflatedSharpe(chosen.backtest.raw, srs) : null;
      const clean = (b: BacktestResult) => {
        const { raw: _raw, ...rest } = b;
        return rest;
      };
      return c.json({
        strategy: chosen.strategy,
        policy,
        backtest: clean(chosen.backtest),
        versions: tested.map((v, k) => ({ strategy: v.strategy, backtest: clean(v.backtest), chosen: k === best })),
        selection: { trials: tested.length, by: "Sharpe ratio on the first 70% of the hours", deflatedSharpe: deflated },
      });
    }

    if (body.prompt) {
      if (w.kind === "user") countCompile(d.db, w.address, utcDay(t));
      try {
        ({ strategy, errors } = await compile(body.prompt, {
          allowedSymbols: allowed,
          assetOf,
          policy,
          model: d.config.BRAIN_MODEL,
          brand: d.config.BRAND_NAME,
          allowSocial,
          ...(base ? { lessons: lessonsBrief(base.journal) } : {}),
        }));
      } catch (e) {
        // Provider errors can name the model or vendor; keep them in the server log only.
        console.error("[brain]", errLine(e));
        return c.json({ error: "the brain could not turn this strategy into rules; try rewording it" }, 502);
      }
    } else {
      strategy = body.strategy!;
      errors = [...checkBounds(strategy, new Set(allowed)), ...strategyPolicyErrors(strategy, policy, assetOf)];
    }
    if (usesSocial(strategy) && !allowSocial)
      return c.json(
        { error: d.socialOn ? "mood rules on X come with the Holder tier" : "mood rules on X are not available right now", strategy, ...(ent ? { tier: ent.tier.name, nextTier: ent.nextTier } : {}) },
        403,
      );
    if (errors.length) return c.json({ error: "strategy does not fit the limits", errors, strategy }, 422);

    const bt = backtest(strategy, policy, body.backtestDays ?? 7);
    const lessonsUsed = base ? { agentId: base.agent.id, digest: base.journal.digest, lessons: base.journal.lessons } : undefined;
    const { raw: _raw, ...btPublic } = bt;
    if (body.dryRun) return c.json({ strategy, policy, backtest: btPublic, ...(lessonsUsed ? { basedOn: lessonsUsed } : {}) });

    const owner = w.kind === "user" ? w.address : null;
    const agent = createAgent(d.db, { name: body.name ?? strategy.name, prompt: body.prompt ?? null, strategy, policy, owner, basedOn: base?.agent.id ?? null }, t);
    // The agent's rules, the prompt they came from and its limits are sealed before it trades,
    // so its later record can be checked against what it was told to do.
    addReceipt(
      d.db,
      agent.id,
      epochOf(t, d.config.EPOCH_SEC),
      "agent",
      {
        agentId: agent.id,
        at: t,
        owner,
        strategyHash: agent.strategyHash,
        strategy,
        promptHash: body.prompt ? recordHash(body.prompt) : null,
        policy,
        brain: body.prompt ? d.config.BRAIN_LABEL : null,
        startEquity: START_EQUITY,
        // What it learned from: the earlier agent, the exact journal (sealed receipt and digest) and its lessons.
        ...(base
          ? {
              basedOn: {
                agentId: base.agent.id,
                journalReceipt: base.sealed?.id ?? null,
                journalLeaf: base.sealed?.leaf ?? null,
                digest: base.journal.digest,
                lessons: base.journal.lessons.map((l) => l.id),
              },
            }
          : {}),
      },
      t,
    );
    return c.json({ agent: publicAgent(agent), backtest: btPublic, ...(lessonsUsed ? { basedOn: lessonsUsed } : {}) }, 201);
  };
  app.post("/v1/agents", createHandler);
  app.post("/agents", createHandler); // older path, kept for scripts

  const statusHandler = async (c: Context) => {
    const w = who(c);
    if (!w) return c.json({ error: "sign in first" }, 401);
    const a = getAgent(d.db, c.req.param("id")!);
    if (!a) return c.json({ error: "not found" }, 404);
    if (w.kind === "user" && a.owner !== w.address) return c.json({ error: "not your agent" }, 403);
    const action = c.req.param("action");
    if (action === "pause") {
      setStatus(d.db, a.id, "paused", "owner");
      return c.json({ ok: true, status: "paused" });
    }
    if (a.status === "active") return c.json({ ok: true, status: "active" });
    if (a.owner) {
      let ent;
      try {
        ent = await wallet(a.owner);
      } catch {
        return c.json({ error: "could not read the wallet from the chain; try again" }, 503);
      }
      if (ent.agentsActive >= ent.agentSlots) return c.json({ error: "no free agent slot", agentSlots: ent.agentSlots, agentsActive: ent.agentsActive }, 403);
    }
    setStatus(d.db, a.id, "active");
    return c.json({ ok: true, status: "active" });
  };
  app.post("/v1/agents/:id/:action{pause|resume}", statusHandler);
  app.post("/agents/:id/:action{pause|resume}", statusHandler);

  app.post("/v1/burns", async (c) => {
    const w = who(c);
    if (w?.kind !== "user") return c.json({ error: "sign in first" }, 401);
    const body = z.object({ txHash: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "send { txHash }" }, 400);
    const claim = async () => claimBurn(d.db, d.chain, d.token.cfg, w.address, body.data.txHash as Hex);
    let r;
    try {
      r = await claim();
    } catch (e) {
      // Two claims of the same transaction at once: the second hits the unique key; answer as a repeat.
      if (!/UNIQUE/i.test((e as Error).message)) throw e;
      r = await claim();
    }
    if (!r.ok) return c.json({ error: r.reason }, 400);
    d.token.reader.forget(w.address);
    return c.json({ ...r, wallet: await wallet(w.address).catch(() => null) });
  });

  app.post("/v1/backtest", async (c) => {
    const parsed = BacktestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const policy = Policy.parse(parsed.data.policy ?? {});
    const errors = [...checkBounds(parsed.data.strategy, new Set(symbols)), ...strategyPolicyErrors(parsed.data.strategy, policy, assetOf)];
    if (errors.length) return c.json({ error: "strategy does not fit the limits", errors }, 422);
    const { raw: _raw, ...out } = backtest(parsed.data.strategy, policy, parsed.data.days ?? 7);
    return c.json(out);
  });

  /** Headline numbers for the dashboard. */
  app.get("/v1/stats", (c) => {
    const one = (sql: string) => d.db.prepare(sql).get() as any;
    const agents = one("SELECT COUNT(*) AS n, SUM(status = 'active') AS active, SUM(status = 'paused') AS paused FROM agents");
    const receipts = one("SELECT COUNT(*) AS n, SUM(kind = 'decision') AS decisions, SUM(json_extract(record_json, '$.fill') IS NOT NULL) AS fills FROM receipts");
    const epochs = one("SELECT COUNT(*) AS sealed, SUM(anchor_tx IS NOT NULL) AS anchored FROM epochs");
    const lastAnchor = one(
      "SELECT epoch, root, leaf_count AS leafCount, anchor_tx AS tx, anchor_block AS block, anchor_registry AS registry, closed_at AS closedAt FROM epochs WHERE anchor_tx IS NOT NULL ORDER BY epoch DESC LIMIT 1",
    );
    const rounds = one("SELECT COUNT(*) AS n FROM rounds");
    return c.json({
      agents: { total: Number(agents.n ?? 0), active: Number(agents.active ?? 0), paused: Number(agents.paused ?? 0) },
      receipts: { total: Number(receipts.n ?? 0), decisions: Number(receipts.decisions ?? 0), fills: Number(receipts.fills ?? 0) },
      epochs: { sealed: Number(epochs.sealed ?? 0), anchored: Number(epochs.anchored ?? 0) },
      lastAnchor: lastAnchor ?? null,
      prices: Number(rounds.n ?? 0),
      markets: { total: d.markets.length, verified: d.markets.filter((m) => m.source === "chainlink").length },
      lastTick: d.lastTick(),
      receiptKinds: Object.fromEntries((d.db.prepare("SELECT kind, COUNT(*) AS n FROM receipts GROUP BY kind").all() as Array<{ kind: string; n: number }>).map((r) => [r.kind, Number(r.n)])),
      lastReceiptAt: Number((d.db.prepare("SELECT MAX(created_at) AS t FROM receipts").get() as { t: number | null }).t ?? 0) || null,
    });
  });

  /** Latest decisions and liquidations across all agents, newest first. */
  app.get("/v1/activity", (c) => {
    const limitN = Math.min(100, Number(c.req.query("limit") ?? 30) || 30);
    const rows = d.db
      .prepare(
        `SELECT r.id, r.epoch, r.kind, r.leaf, r.record_json, r.created_at, a.name, e.anchor_tx
           FROM receipts r JOIN agents a ON a.id = r.agent_id LEFT JOIN epochs e ON e.epoch = r.epoch
          WHERE r.kind IN ('decision', 'fill', 'funding') ORDER BY r.id DESC LIMIT ?`,
      )
      .all(limitN)
      .map((r: any) => ({
        id: r.id,
        epoch: r.epoch,
        kind: r.kind,
        leaf: r.leaf,
        createdAt: r.created_at,
        agentName: r.name,
        anchored: Boolean(r.anchor_tx),
        anchorTx: r.anchor_tx ?? null,
        record: JSON.parse(r.record_json),
      }));
    return c.json(rows);
  });

  app.get("/v1/agents", (c) => {
    const owner = c.req.query("owner");
    const rows = owner && isAddress(owner, { strict: false }) ? agentsOf(d.db, getAddress(owner)) : listAgents(d.db);
    return c.json(rows.map((a) => ({ ...publicAgent(a), summary: a.strategy.summary })));
  });

  app.get("/v1/agents/:id", (c) => {
    const a = getAgent(d.db, c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    const acct = getAccount(d.db, a.id);
    return c.json({ agent: publicAgent(a), account: { ...acct, returnPct: returnPct(acct.equity, acct.startEquity) } });
  });

  // ------------------------------------------------------------------ users' vaults

  /** Where users' vaults can be made: each chain's factory, adapter, executor, cash token, WETH and tradable tokens. */
  type VaultSetup = { key: ChainKey; pub: PublicClient; cfg: NonNullable<ApiDeps["vaults"]>; vc: VaultChain; tokenOf: (sym: string) => `0x${string}` | null };
  const vaultSetups = (): VaultSetup[] => {
    const out: VaultSetup[] = [];
    if (d.vaults)
      out.push({ key: "robinhood", pub: d.chain, cfg: d.vaults, vc: ROBINHOOD_VAULTS, tokenOf: (sym) => (d.markets.find((m) => m.symbol === sym && m.source === "chainlink")?.token as `0x${string}` | undefined) ?? null });
    if (d.arbVaults) {
      const { pub, ...cfg } = d.arbVaults;
      out.push({ key: "arbitrum", pub, cfg, vc: { base: ARBITRUM.base.address, baseSymbol: ARBITRUM.base.symbol, baseDecimals: ARBITRUM.base.decimals, weth: ARBITRUM.weth }, tokenOf: (sym) => (bySymbol.has(sym) ? ARBITRUM.tokens[sym]?.token ?? null : null) });
    }
    return out;
  };
  const chainIdOf = (k: ChainKey) => (k === "arbitrum" ? ARBITRUM.id : CHAIN_ID);
  const explorerOf = (k: ChainKey) => (k === "arbitrum" ? ARBITRUM.explorer : "https://robinhoodchain.blockscout.com");

  app.get("/v1/vault/config", (c) => {
    const chains = Object.fromEntries(
      vaultSetups().map((v) => [
        v.key,
        {
          key: v.key, name: CHAIN_NAMES[v.key], chainId: chainIdOf(v.key), explorer: explorerOf(v.key), ...v.cfg,
          cash: v.vc.base, cashSymbol: v.vc.baseSymbol, cashDecimals: v.vc.baseDecimals, weth: v.vc.weth,
          // Symbol -> token for every market this chain's vaults can trade.
          tokens: Object.fromEntries(d.markets.map((m) => [m.symbol, v.tokenOf(m.symbol)]).filter(([, t]) => t)),
        },
      ]),
    );
    // The Robinhood fields at the top level stay for pages that read them.
    return c.json(d.vaults || d.arbVaults ? { on: true, ...(d.vaults ? { ...d.vaults, usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", chainId: CHAIN_ID } : {}), chains } : { on: false, chains: {} });
  });

  /**
   * Starts a user's real-money agent on the vault they just made: the vault is read from the
   * chain (made by our factory, owned by the signed-in wallet, our executor, the adapter and the
   * strategy's tokens allowed, within the beta deposit limit) before the agent is created.
   */
  app.post("/v1/vault/agents", async (c) => {
    const w = who(c);
    if (w?.kind !== "user") return c.json({ error: "sign in first" }, 401);
    const body = z
      .object({
        chain: z.enum(["robinhood", "arbitrum"]).default("robinhood"),
        // The transaction that made the vault, or (for a vault made earlier whose agent did not start) its address.
        txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
        vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
        strategy: Strategy,
        name: z.string().min(1).max(60).optional(),
        prompt: z.string().max(4000).optional(),
        basedOn: z.string().uuid().optional(),
      })
      .refine((b) => Boolean(b.txHash) !== Boolean(b.vault), "send txHash or vault")
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body", issues: body.error.issues }, 400);
    const setup = vaultSetups().find((v) => v.key === body.data.chain);
    if (!setup) return c.json({ error: `real-money agents on ${CHAIN_NAMES[body.data.chain]} are not available right now` }, 503);
    const s = body.data.strategy;
    // One chain per agent: every symbol must have a token on the chosen chain.
    const tradable = new Set(d.markets.map((m) => m.symbol).filter((sym) => setup.tokenOf(sym)));
    const errors = checkBounds(s, tradable).map((e) => (/not tradable|unknown symbol|not allowed/i.test(e) ? `${e} (real money on ${CHAIN_NAMES[setup.key]})` : e));
    if (s.side !== "long" || s.leverage !== 1) errors.push("real money trades long at 1x only (no shorts or leverage yet)");
    if (errors.length) return c.json({ error: "strategy does not fit real-money limits", errors }, 422);
    let ent;
    try {
      ent = await wallet(w.address);
    } catch {
      return c.json({ error: "could not read the wallet from the chain; try again" }, 503);
    }
    if (ent.agentsActive >= ent.agentSlots) return c.json({ error: "no free agent slot", agentSlots: ent.agentSlots, agentsActive: ent.agentsActive, tier: ent.tier.name }, 403);
    let v;
    try {
      const check = {
        owner: w.address as `0x${string}`, factory: setup.cfg.factory, adapter: setup.cfg.adapter, executor: setup.cfg.executor,
        tokens: s.symbols.map((sym) => setup.tokenOf(sym)!), maxDepositUsd: setup.cfg.maxDepositUsd,
        ethPrice: (() => { const r = latestStored(d.db, "ETH"); return r ? roundPrice(r) : null; })(),
        chain: setup.vc,
      };
      v = body.data.txHash
        ? await verifyVaultCreation(setup.pub, d.db, { ...check, txHash: body.data.txHash as `0x${string}` })
        : await verifyVaultAddress(setup.pub, d.db, { ...check, vault: body.data.vault as `0x${string}` });
    } catch (e) {
      if (e instanceof VaultCheckError) return c.json({ error: e.message }, e.status as 404 | 422);
      console.error("[vault]", errLine(e));
      return c.json({ error: "could not read the vault from the chain; try again" }, 503);
    }
    if ((v.deposit.usd * s.positionPct) / 100 < 1)
      return c.json({ error: `each trade would be $${((v.deposit.usd * s.positionPct) / 100).toFixed(2)}, under the $1 minimum: use a larger share of the deposit per trade`, vault: v.vault }, 422);
    const t = now();
    const policy = Policy.parse({ maxLeverage: 1, maxLeverageCrypto: 1, maxPositionPct: 100, maxOpenPositions: Math.max(1, s.maxOpenPositions), allowShort: false, allowedSymbols: s.symbols, dailyLossPct: 50 });
    const agent = createAgent(d.db, { name: body.data.name ?? s.name, prompt: body.data.prompt ?? null, strategy: s, policy, owner: w.address, basedOn: body.data.basedOn ?? null, vault: v.vault, chain: setup.key }, t);
    addReceipt(d.db, agent.id, epochOf(t, d.config.EPOCH_SEC), "agent", {
      agentId: agent.id, at: t, owner: w.address, strategyHash: agent.strategyHash, strategy: s, promptHash: body.data.prompt ? recordHash(body.data.prompt) : null, policy,
      brain: body.data.prompt ? d.config.BRAIN_LABEL : null, money: "real", chainId: chainIdOf(setup.key), vault: v.vault, vaultTx: body.data.txHash ?? null, executor: setup.cfg.executor, venue: "uniswap-v3", deposit: v.deposit,
    }, t);
    return c.json({ agent: publicAgent(agent), vault: v }, 201);
  });

  /** The signed-in wallet's vaults: what each holds and which agent trades it (none, for one whose agent never started). */
  app.get("/v1/vault/mine", async (c) => {
    const w = who(c);
    if (w?.kind !== "user") return c.json({ error: "sign in first" }, 401);
    try {
      const all = [];
      const failed: ChainKey[] = [];
      for (const v of vaultSetups()) {
        try {
          for (const x of await vaultsOf(v.pub, d.db, v.cfg.factory, w.address as `0x${string}`, v.vc)) all.push({ ...x, chain: v.key });
        } catch {
          failed.push(v.key);
        }
      }
      // One chain's node not answering still lists the vaults on the others.
      if (failed.length && !all.length && failed.length === vaultSetups().length) throw new Error("no chain answered");
      return c.json({ vaults: all, unread: failed });
    } catch {
      return c.json({ error: "could not read your vaults from the chain; try again" }, 503);
    }
  });

  /** The owner stops a run: it ends now, positions close, and a vault's funds go back to the owner's wallet. */
  app.post("/v1/agents/:id/stop", (c) => {
    const w = who(c);
    if (!w) return c.json({ error: "sign in first" }, 401);
    const a = getAgent(d.db, c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    if (w.kind === "user" && a.owner !== w.address) return c.json({ error: "not your agent" }, 403);
    const eq = markOf(d.db, a.id)?.equity ?? getAccount(d.db, a.id).equity;
    const t = now();
    if (!markEnded(d.db, a, "stopped by its owner", eq, d.config.EPOCH_SEC, t)) return c.json({ ok: true, already: true, agent: publicAgent(getAgent(d.db, a.id)!) });
    if (a.vault || a.liveIndex !== null) queueCloses(d.db, a.id, t);
    return c.json({ ok: true, agent: publicAgent(getAgent(d.db, a.id)!) });
  });

  /** What the agent is watching right now, how close each rule is, and its live profit or loss. */
  app.get("/v1/agents/:id/now", (c) => {
    const a = getAgent(d.db, c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    const t = d.lastTick();
    c.header("cache-control", "no-store");
    return c.json({ ...agentNow(d.db, a, d.markets, now()), lastTickAt: t?.at ?? null, tickSec: d.config.TICK_SEC });
  });

  /** Lessons from the agent's own sealed record, each with the receipts behind it. */
  app.get("/v1/agents/:id/journal", (c) => {
    const a = getAgent(d.db, c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    const j = journalOf(d.db, a.id, now());
    const sealed = lastJournalReceipt(d.db, a.id);
    // sealed.current: whether the newest sealed journal has exactly these lessons.
    return c.json({ ...j, sealed: sealed ? { receipt: sealed.id, leaf: sealed.leaf, current: sealed.digest === j.digest } : null });
  });

  // ------------------------------------------------------------------ ERC-8004 identity

  /** The ERC-8004 registration file the agent's on-chain identity points at. */
  app.get("/v1/agents/:id/registration.json", (c) => {
    if (!d.identity) return c.json({ error: "identities are not enabled" }, 404);
    const a = getAgent(d.db, c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    const x = getAccount(d.db, a.id);
    const track = { startEquity: x.startEquity, equity: x.equity, returnPct: returnPct(x.equity, x.startEquity) };
    c.header("cache-control", "public, max-age=300");
    const avatar = avatarPath(a.id);
    return c.json(registrationFile(d.identity, a, track, getIdentity(d.db, a.id), verifiedMarkets(a), now(), avatar ? d.identity.publicUrl + avatar : null));
  });

  /** The agent's generated avatar (made by ImageService, see media/avatars.ts). */
  app.get("/v1/agents/:id/avatar", (c) => {
    const f = d.mediaDir ? avatarFile(d.db, d.mediaDir, c.req.param("id")) : null;
    if (!f) return c.json({ error: "no avatar" }, 404);
    c.header("content-type", f.mime);
    c.header("cache-control", "public, max-age=86400");
    c.header("x-content-type-options", "nosniff");
    c.header("content-security-policy", "default-src 'none'");
    return c.body(new Uint8Array(f.bytes));
  });

  app.get("/v1/agents/:id/image.svg", (c) => {
    const a = getAgent(d.db, c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    c.header("content-type", "image/svg+xml; charset=utf-8");
    c.header("cache-control", "public, max-age=86400");
    // The image is static markup; nothing in it may run.
    c.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
    c.header("x-content-type-options", "nosniff");
    return c.body(agentImage(a));
  });

  /** What a wallet needs to register the agent, and the identity once it is linked. */
  app.get("/v1/agents/:id/identity", (c) => {
    if (!d.identity) return c.json({ error: "identities are not enabled" }, 404);
    const a = getAgent(d.db, c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    return c.json({
      chainId: CHAIN_ID,
      registry: d.identity.registry,
      agentRegistry: agentRegistryId(d.identity.registry),
      agentURI: canonicalUri(d.identity, a.id),
      expectedOwner: expectedOwner(d.identity, a),
      identity: getIdentity(d.db, a.id),
    });
  });

  /**
   * Links an ERC-8004 identity after checking it on chain: send { txHash } of the registration
   * transaction, or { agentId } of the token. No sign-in: the chain is the proof (see identity.ts).
   */
  app.post("/v1/agents/:id/identity", async (c) => {
    if (!d.identity) return c.json({ error: "identities are not enabled" }, 404);
    const a = getAgent(d.db, c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    const body = z
      .union([z.object({ txHash: z.string() }).strict(), z.object({ agentId: z.union([z.string(), z.number().int().nonnegative()]) }).strict()])
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "send { txHash } or { agentId }" }, 400);
    try {
      const r =
        "txHash" in body.data
          ? await linkIdentityByTx(d.db, d.chain, d.identity, a, body.data.txHash, now())
          : await linkIdentity(d.db, d.chain, d.identity, a, String(body.data.agentId), now());
      return r.ok ? c.json({ identity: r.identity, already: r.already }, r.already ? 200 : 201) : c.json({ error: r.reason }, r.status);
    } catch (e) {
      if (e instanceof RegistryLagError) return c.json({ error: "the registration is on chain but the RPC node has not caught up yet; try again in a few seconds" }, 503);
      console.error("[identity]", errLine(e));
      return c.json({ error: "could not read the registry on chain; try again" }, 503);
    }
  });

  app.get("/v1/agents/:id/receipts", (c) => {
    const limitN = Math.min(200, Number(c.req.query("limit") ?? 50) || 50);
    const before = Number(c.req.query("before") ?? Number.MAX_SAFE_INTEGER);
    const rows = d.db
      .prepare("SELECT id, epoch, kind, leaf, record_json, created_at FROM receipts WHERE agent_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
      .all(c.req.param("id"), before, limitN)
      .map((r: any) => ({ id: r.id, epoch: r.epoch, kind: r.kind, leaf: r.leaf, createdAt: r.created_at, record: JSON.parse(r.record_json) }));
    return c.json(rows);
  });

  app.get("/v1/receipts/:id", (c) => {
    const r = receiptWithProof(d.db, Number(c.req.param("id")));
    return r ? c.json(r) : c.json({ error: "not found" }, 404);
  });

  app.get("/v1/epochs", (c) =>
    c.json(
      d.db
        .prepare("SELECT epoch, root, prev_root AS prevRoot, leaf_count AS leafCount, closed_at AS closedAt, anchor_tx AS anchorTx, anchor_block AS anchorBlock, anchor_registry AS registry FROM epochs ORDER BY epoch DESC LIMIT 100")
        .all(),
    ),
  );

  /**
   * Everything needed to check one sealed epoch without this server: its receipts, root,
   * previous root and anchor. Final (and cached for good) once the epoch is anchored.
   */
  app.get("/v1/epochs/:epoch/bundle.json", (c) => {
    const n = c.req.param("epoch");
    if (!/^\d{1,12}$/.test(n)) return c.json({ error: "epoch must be a whole number" }, 400);
    let b;
    try {
      b = epochBundle(d.db, Number(n));
    } catch (e) {
      // The stored receipts no longer rebuild the stored root: never publish that.
      console.error("[bundle]", errLine(e));
      return c.json({ error: "this epoch's receipts do not match its root; it is not published" }, 500);
    }
    if (!b) return c.json({ error: "no sealed epoch with that number" }, 404);
    c.header("cache-control", b.anchor ? "public, max-age=31536000, immutable" : "no-store");
    c.header("content-type", "application/json; charset=utf-8");
    return c.body(new Uint8Array(bundleBytes(b)));
  });

  app.get("/v1/leaderboard", (c) => {
    const rows = d.db
      .prepare("SELECT a.id FROM agents a")
      .all()
      .map((r: any) => getAgent(d.db, r.id)!)
      .map((a) => {
        const x = getAccount(d.db, a.id);
        return {
          ...publicAgent(a),
          since: a.createdAt,
          equity: Math.round(x.equity * 100) / 100,
          returnPct: Math.round(returnPct(x.equity, x.startEquity) * 100) / 100,
          fills: Number((d.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE agent_id = ? AND json_extract(record_json, '$.fill') IS NOT NULL").get(a.id) as any).n),
        };
      })
      .sort((a, b) => b.returnPct - a.returnPct);
    return c.json(rows);
  });

  return app;
}
