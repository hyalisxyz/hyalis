import { readFileSync } from "node:fs";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  DB_PATH: z.string().default("data/agent-utility.db"),
  /** Extra RPC endpoint tried before the public ones. */
  RPC_URL: z.string().url().optional(),
  /** Plankton public API. Leave blank to run on Chainlink only. */
  PLANKTON_API: z.string().url().optional().or(z.literal("")),
  /** Model used to turn a written strategy into rules. Internal: never returned by the API. */
  BRAIN_MODEL: z.string().default("claude-opus-5-5"),
  /** Public name of the product, used when the AI speaks about itself. */
  BRAND_NAME: z.string().default("Hyalis"),
  /** Public label for the brain version, recorded on receipts instead of the model id. */
  BRAIN_LABEL: z.string().default("brain-v1"),
  /** Seconds between ticks of the runner. */
  TICK_SEC: z.coerce.number().int().min(10).default(300),
  /** How much Chainlink history to keep for indicators and backtests. */
  BACKFILL_DAYS: z.coerce.number().int().min(3).max(90).default(30),
  /** Pyth API key: second price source for crypto (the key is not entitled to equities). */
  PYTH_API_KEY: z.string().min(10).optional(),
  /** Optional CoinGecko demo key; without it the public rate limit applies. */
  COINGECKO_API_KEY: z.string().min(10).optional(),
  /** ReceiptRegistry on Robinhood Chain. Anchoring is off while this or the key is unset. */
  REGISTRY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** Key of the wallet that publishes roots. Kept only in .env; never logged or returned. */
  ANCHOR_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  /** Project token on Robinhood Chain (launched on Pons). Unset until launch: everyone is on the free tier. */
  TOKEN_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** Tiers by token amount held (whole tokens, not price), lowest first. JSON. */
  TOKEN_TIERS: z.string().optional(),
  /** Tokens to burn for one extra agent slot. */
  BURN_TOKENS_PER_SLOT: z.coerce.number().positive().default(500_000),
  /** How long a burned slot lasts. */
  BURN_SLOT_DAYS: z.coerce.number().int().positive().default(30),
  /** Where the sign-in message says it comes from. */
  APP_DOMAIN: z.string().default("localhost"),
  /** Epoch length for receipt roots, in seconds. */
  EPOCH_SEC: z.coerce.number().int().min(60).default(3600),
  /**
   * Public base URL of this service (scheme and host, no path). Agent registration files are
   * served under it and their URLs are written on chain, so it must be the address people reach.
   * Defaults to https://APP_DOMAIN (or http://localhost:PORT when APP_DOMAIN is localhost).
   */
  PUBLIC_URL: z.string().url().optional(),
  /** Earlier PUBLIC_URLs, comma separated, whose on-chain agentURIs still count after a domain move. */
  LEGACY_PUBLIC_URLS: z.string().optional(),
  /** ERC-8004 Identity Registry on Robinhood Chain. */
  IDENTITY_REGISTRY: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"),
  /** Wallet that owns house agents' ERC-8004 identities. Defaults to the anchor wallet. */
  HOUSE_IDENTITY_OWNER: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /**
   * Key of the wallet that pays the image service for agent avatars with x402 (USDG only; the
   * service pays the gas). Avatar making is on only when this, MEDIA_API, MEDIA_MODEL and
   * MEDIA_PAY_TO are all set. Kept only in .env; never logged or returned.
   */
  MEDIA_PAYER_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  /** The image service's API base URL. */
  MEDIA_API: z.string().url().optional(),
  /** The model the service runs for avatars. */
  MEDIA_MODEL: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(),
  /** The only address avatar payments may go to (the service's payment contract). */
  MEDIA_PAY_TO: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** Most one image may cost, and most spent per UTC day, in USDG. */
  MEDIA_MAX_USDG_PER_CALL: z.coerce.number().positive().max(1).default(0.01),
  MEDIA_DAILY_USDG: z.coerce.number().positive().max(50).default(0.25),
  /**
   * The social reader: an AI service with live search of X, used for social_mood rules. On only
   * when the key, the API base URL and the model are all set. Kept only in .env.
   */
  SOCIAL_API_KEY: z.string().min(20).optional(),
  SOCIAL_API: z.string().url().optional(),
  SOCIAL_MODEL: z.string().regex(/^[a-z0-9.-]{2,60}$/).optional(),
  /** Most spent on readings per UTC day, in dollars. */
  SOCIAL_DAILY_USD: z.coerce.number().positive().max(50).default(2),
  /** Hours between readings of one symbol. */
  SOCIAL_REFRESH_HOURS: z.coerce.number().min(1).max(24).default(6),
  /**
   * Real-money agents. Each live agent's wallet is derived from this mnemonic at its index.
   * Kept only in .env; never logged or returned. Swaps happen only while LIVE_TRADING is true.
   */
  LIVE_MNEMONIC: z.string().refine((m) => m.trim().split(/\s+/).length >= 12, "LIVE_MNEMONIC must be a 12 or 24 word phrase").optional(),
  LIVE_TRADING: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Least a swap may return, below its quote, in basis points. */
  LIVE_SLIPPAGE_BPS: z.coerce.number().int().min(5).max(300).default(100),
  /** Furthest a swap's price may be from the oracle price, in basis points. */
  LIVE_MAX_GAP_BPS: z.coerce.number().int().min(20).max(1000).default(300),
  /** Smallest order sent, in dollars. */
  LIVE_MIN_ORDER_USD: z.coerce.number().positive().default(1),
  /** Users' vaults: the AgentVaultFactory and the Uniswap V3 adapter on Robinhood Chain. Off while unset. */
  VAULT_FACTORY: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  VAULT_ADAPTER: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** Users' vaults on Arbitrum One (major crypto, USDC cash). Off while unset. */
  VAULT_ARB_FACTORY: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  VAULT_ARB_ADAPTER: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** Arbitrum One RPC tried before the public ones. */
  ARB_RPC_URL: z.string().url().optional(),
  /** Most a vault may hold when an agent starts on it, in dollars (beta limit). */
  VAULT_MAX_DEPOSIT_USD: z.coerce.number().positive().default(100),
  /** Where generated images are kept. Default: a "media" folder next to the database. */
  MEDIA_DIR: z.string().optional(),
  /**
   * Off-site backups to an S3-compatible bucket (Railway bucket). All four of endpoint, bucket,
   * access key and secret must be set, or backups are off.
   */
  BACKUP_S3_ENDPOINT: z.string().url().optional(),
  BACKUP_S3_BUCKET: z.string().min(3).optional(),
  BACKUP_S3_REGION: z.string().default("auto"),
  BACKUP_S3_ACCESS_KEY_ID: z.string().min(8).optional(),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().min(8).optional(),
  BACKUP_S3_URL_STYLE: z.enum(["virtual", "virtual-host", "path"]).default("virtual").transform((s) => (s === "path" ? "path" : "virtual") as "virtual" | "path"),
  /**
   * Backups run only where this is "true" (the production service). A laptop with the bucket
   * credentials in .env, for restoring, never uploads its own database over production's.
   */
  BACKUP_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Turns on GET /v1/admin/export (full database copy, operator token only). Only while moving hosts. */
  ADMIN_EXPORT_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Set on the old host after a move (https URL of the new one): it then only redirects there. */
  MOVED_TO: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), "MOVED_TO must be an https URL")
    .optional(),
  /** Hours between database snapshots. */
  BACKUP_EVERY_HOURS: z.coerce.number().positive().max(168).default(6),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  return EnvSchema.parse(present);
}

/** equity: tokenized stocks and ETFs, trade 24/5. crypto: trades 24/7. */
export type AssetClass = "equity" | "crypto";

/**
 * chainlink: on-chain feed on Robinhood Chain; every price an agent uses can be re-read on chain.
 * coingecko: off-chain data feed; the price is recorded but cannot be checked on chain.
 */
export type PriceSource = "chainlink" | "coingecko";

export interface Market {
  symbol: string;
  assetClass: AssetClass;
  source: PriceSource;
  /** Chainlink proxy address, or "coingecko:<id>" for data-feed markets. */
  feed: `0x${string}` | `coingecko:${string}`;
  /** CoinGecko coin id: the price source for data-feed markets, a second source for Chainlink crypto. */
  coingeckoId?: string;
  decimals: number;
  heartbeatSec: number;
  deviationPct: number;
  /** Pyth price feed id, used as a second source where the API key is entitled to it. */
  pythId?: string;
  /** The tradable token on Robinhood Chain, when there is one (stock tokens, WETH). */
  token?: `0x${string}`;
  tokenDecimals?: number;
}

export const isVerified = (m: Pick<Market, "source">) => m.source === "chainlink";

export function loadMarkets(path = "data/markets.json"): Market[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { markets: Market[] };
  return raw.markets;
}

export const CHAIN_ID = 4663;

/** The public base URL, without a trailing slash. */
export function publicUrl(c: Pick<Config, "PUBLIC_URL" | "APP_DOMAIN" | "PORT">): string {
  if (c.PUBLIC_URL) return new URL(c.PUBLIC_URL).origin;
  return c.APP_DOMAIN === "localhost" ? `http://localhost:${c.PORT}` : `https://${c.APP_DOMAIN}`;
}

/** LEGACY_PUBLIC_URLS as a list of origins. */
export function legacyUrls(c: Pick<Config, "LEGACY_PUBLIC_URLS">): string[] {
  return (c.LEGACY_PUBLIC_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new URL(s).origin);
}
