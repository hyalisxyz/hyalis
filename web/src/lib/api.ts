/** Typed client for the backend API (same origin in production, proxied in development). */

export interface Market {
  symbol: string;
  assetClass: "equity" | "crypto";
  tier: "verified" | "data-feed";
  source: "chainlink" | "coingecko";
  hours: "24/5" | "24/7";
  feed: string;
  price: number | null;
  roundId: string | null;
  updatedAt: number | null;
  /** Tradable token on Robinhood Chain, when there is one. */
  token?: string | null;
  tokenDecimals?: number | null;
}

export interface Condition {
  type: string;
  description: string;
  [k: string]: unknown;
}

export interface Strategy {
  name: string;
  summary: string;
  symbols: string[];
  side: "long" | "short";
  entry: Condition[];
  exitConditions: Condition[];
  stopLossPct: number;
  takeProfitPct: number;
  maxHoldHours: number;
  positionPct: number;
  maxOpenPositions: number;
  leverage: number;
  notes: string[];
  riskLevel?: "low" | "medium" | "high";
  endAfterMinutes?: number;
  endAtProfitPct?: number;
  endAtLossPct?: number;
  trailingStopPct?: number;
  atrStopMultiple?: number;
  maxDrawdownPct?: number;
}

export interface Agent {
  id: string;
  name: string;
  status: "active" | "paused";
  pauseReason: "owner" | "over_quota" | null;
  owner: string | null;
  house: boolean;
  markets: "verified" | "includes-data-feed";
  strategy: Strategy;
  strategyHash: string;
  createdAt: number;
  summary?: string;
  identity: Identity | null;
  /** The agent whose sealed lessons this one was built from. */
  basedOn: string | null;
  /** Same-origin path of its generated avatar, once made. */
  avatar: string | null;
  /** "real": trades real tokens from its own wallet; "paper": simulated fills on real prices. */
  money?: "paper" | "real";
  /** A real-money agent's wallet on Robinhood Chain (its own, or the user's vault). */
  wallet?: string | null;
  /** A user's real-money agent: the vault it trades. */
  vault?: string | null;
  /** The chain a real-money agent trades on. */
  chain?: "robinhood" | "arbitrum";
  /** When the run ends by its time limit; when it ended, and why. */
  endAt?: number | null;
  endedAt?: number | null;
  endedReason?: string | null;
  /** A vault agent after its run ended: selling, sending back, done. */
  stopState?: "closing" | "returning" | "returned" | null;
}

/** A pattern in the agent's own sealed record, with the receipts behind it. */
export interface Lesson {
  id: string;
  kind: "weakness" | "strength" | "risk";
  title: string;
  detail: string;
  stats: { trades: number; wins: number; netPnl: number; avgReturnPct: number };
  confidence: "low" | "medium" | "high";
  evidence: number[];
}

export interface Journal {
  agentId: string;
  asOf: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  netPnl: number;
  fees: number;
  lessons: Lesson[];
  digest: string;
  sealed: { receipt: number; leaf: string; current: boolean } | null;
}

/** The agent's ERC-8004 identity, linked only after the server checked it on chain. */
export interface Identity {
  agentRegistry: string;
  agentId: string;
  owner: string;
  agentURI: string;
  status: "ok" | "owner-changed" | "uri-changed" | "missing";
  verified: boolean;
  linkedAt: number;
  checkedAt: number;
  explorer: string;
}

export interface IdentityInfo {
  chainId: number;
  registry: `0x${string}`;
  agentRegistry: string;
  agentURI: string;
  expectedOwner: string | null;
  identity: Identity | null;
}

export interface LeaderRow extends Agent {
  since: number;
  equity: number;
  returnPct: number;
  fills: number;
}

export interface Position {
  symbol: string;
  side: "long" | "short";
  venue: "spot" | "perp";
  qty: number;
  entryPrice: number;
  leverage: number;
  margin: number;
  openedAt: number;
}

export interface AgentDetail {
  agent: Agent;
  account: { account: { cash: number; positions: Position[] }; startEquity: number; equity: number; returnPct: number };
}

export interface ReceiptRow {
  id: number;
  epoch: number;
  kind: "agent" | "decision" | "fill" | "snapshot" | "identity" | "journal" | "media" | "signal" | "funding";
  leaf: string;
  createdAt: number;
  record: any;
}

export interface Activity extends ReceiptRow {
  agentName: string;
  anchored: boolean;
  anchorTx: string | null;
}

export interface ReceiptProof {
  id: number;
  epoch: number;
  leaf: `0x${string}`;
  record: any;
  sealed: boolean;
  root: `0x${string}` | null;
  prevRoot: `0x${string}` | null;
  proof: `0x${string}`[];
  anchor: { chainId: number; registry: `0x${string}`; tx: string; block: number | null } | null;
}

export interface Stats {
  agents: { total: number; active: number; paused: number };
  receipts: { total: number; decisions: number; fills: number };
  epochs: { sealed: number; anchored: number };
  lastAnchor: { epoch: number; root: string; leafCount: number; tx: string; block: number; registry: string; closedAt: number } | null;
  prices: number;
  markets: { total: number; verified: number };
  lastTick: { at: number; market: { open: boolean; session: string; reason: string | null } } | null;
  /** When the newest receipt was printed (unix seconds). */
  lastReceiptAt: number | null;
  /** Receipts by kind: decision, snapshot, agent, funding, fill, ... */
  receiptKinds?: Record<string, number>;
}

export interface Tier {
  name: string;
  minTokens: number;
  agents: number;
  compilesPerDay: number;
}

export interface TokenInfo {
  launched: boolean;
  address: string | null;
  symbol: string | null;
  chainId: number;
  tiers: Tier[];
  burn: { tokensPerSlot: number; slotDays: number; to: string[] };
}

export interface Wallet {
  address: string;
  token: { launched: boolean; address: string | null; symbol: string | null };
  balance: string;
  tier: Tier;
  nextTier: (Tier & { needed: number }) | null;
  burnSlots: Array<{ slots: number; expiresAt: number; txHash: string }>;
  agentSlots: number;
  agentsActive: number;
  agentsPausedOverQuota: number;
  compilesToday: number;
  compilesPerDay: number;
}

export interface Backtest {
  from: number;
  to: number;
  hours: number;
  startEquity: number;
  endEquity: number;
  returnPct: number;
  maxDrawdownPct: number;
  trades: Array<{ symbol: string; side: string; openedAt: number; closedAt: number; entry: number; exit: number; pnl: number; returnPct: number; how: string; reason: string }>;
  openPositions: number;
  winRatePct: number | null;
  fees: number;
  exposurePct: number;
  benchmarkReturnPct: number | null;
  blocked: Record<string, number>;
  equityCurve: Array<[number, number]>;
  metrics?: { sharpe: number | null; sortino: number | null; calmar: number | null; profitFactor: number | null; probabilisticSharpe: number | null };
  split?: { cutAt: number; inSample: { returnPct: number; sharpe: number | null }; outOfSample: { returnPct: number; sharpe: number | null } } | null;
  caveats: string[];
}

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(body?.error ?? `request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function req<T>(method: string, path: string, body?: unknown, token?: string | null): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export interface AgentNow {
  at: number;
  status: "active" | "paused";
  money: "paper" | "real";
  endAt: number | null;
  endedAt: number | null;
  endedReason: string | null;
  stopState: "closing" | "returning" | "returned" | null;
  ends: { afterMinutes: number | null; profitPct: number | null; lossPct: number | null };
  cash: number;
  equity: number;
  startEquity: number;
  returnPct: number;
  positions: number;
  maxPositions: number;
  lastTickAt: number | null;
  tickSec: number;
  orders: Array<{ id: number; symbol: string; action: "open" | "close"; status: string; tx: string | null; at: number }>;
  symbols: Array<{
    symbol: string;
    price: number | null;
    priceAt: number | null;
    /** Market move since the agent started, in percent. */
    sinceStartPct: number | null;
    market: { open: boolean; reason: string | null };
    state: "waiting" | "signal" | "holding" | "market-closed";
    rules: "entry" | "exit";
    met: number;
    of: number;
    checks: Array<{ description: string; pass: boolean; value: number | null; detail: string }>;
    position: { side: string; qty: number; entryPrice: number; openedAt: number; price: number | null; pnl: number | null; pnlPct: number | null; stopAt: number; takeProfitAt: number | null; closesBy: number | null } | null;
  }>;
}

export interface UserTrade {
  tx: string;
  wallet: string;
  sellSymbol: string;
  sellAmount: string;
  buySymbol: string;
  buyAmount: string;
  block: number;
  at: number;
  receipt: number | null;
}

export const api = {
  tradeConfig: () => req<{ chainId: number; router: string; quoter: string; tokens: import("./swap").TradeToken[] }>("GET", "/v1/trade/config"),
  trades: (address: string) => req<UserTrade[]>("GET", `/v1/wallets/${address}/trades`),
  recordTrade: (txHash: string) => req<{ trade: UserTrade }>("POST", "/v1/trades", { txHash }),
  stats: () => req<Stats>("GET", "/v1/stats"),
  markets: () => req<Market[]>("GET", "/v1/markets"),
  leaderboard: () => req<LeaderRow[]>("GET", "/v1/leaderboard"),
  activity: (limit = 30) => req<Activity[]>("GET", `/v1/activity?limit=${limit}`),
  agent: (id: string) => req<AgentDetail>("GET", `/v1/agents/${id}`),
  agentNow: (id: string) => req<AgentNow>("GET", `/v1/agents/${id}/now`),
  receipts: (id: string, limit = 100) => req<ReceiptRow[]>("GET", `/v1/agents/${id}/receipts?limit=${limit}`),
  receipt: (id: number | string) => req<ReceiptProof>("GET", `/v1/receipts/${id}`),
  epochs: () => req<Array<{ epoch: number; root: string; prevRoot: string; leafCount: number; closedAt: number; anchorTx: string | null; anchorBlock: number | null; registry: string | null }>>("GET", "/v1/epochs"),
  token: () => req<TokenInfo>("GET", "/v1/token"),
  wallet: (address: string) => req<Wallet>("GET", `/v1/wallets/${address}`),
  me: (token: string) => req<Wallet & { agents: Array<Agent & { prompt: string | null; account: any }> }>("GET", "/v1/me", undefined, token),
  nonce: (address: string) => req<{ nonce: string; message: string; expiresAt: number }>("POST", "/v1/auth/nonce", { address }),
  verify: (address: string, nonce: string, signature: string) =>
    req<{ token: string; address: string; expiresAt: number }>("POST", "/v1/auth/verify", { address, nonce, signature }),
  logout: (token: string) => req<{ ok: true }>("POST", "/v1/auth/logout", {}, token),
  backtest: (strategy: Strategy, days: number) => req<Backtest>("POST", "/v1/backtest", { strategy, days }),
  vaultConfig: () =>
    req<{ on: boolean; factory: string; adapter: string; executor: string; maxDepositUsd: number; usdg: string; weth: string; chainId: number; chains: Partial<Record<VaultChainKey, VaultChainConfig>> }>("GET", "/v1/vault/config"),
  vaultMine: (token: string) =>
    req<{ vaults: Array<{ vault: string; cash?: string; cashToken?: string; usdg: string; weth: string; agentId: string | null; chain?: VaultChainKey }> }>("GET", "/v1/vault/mine", undefined, token),
  startVaultAgent: (token: string, body: { chain?: VaultChainKey; txHash?: string; vault?: string; strategy: Strategy; name?: string; prompt?: string; basedOn?: string }) =>
    req<{ agent: Agent; vault: { vault: string; deposit: { usd: number } } }>("POST", "/v1/vault/agents", body, token),
  stopAgent: (token: string, id: string) => req<{ ok: true; agent: Agent }>("POST", `/v1/agents/${id}/stop`, {}, token),
  createAgent: (token: string, body: { prompt?: string; strategy?: Strategy; dryRun?: boolean; backtestDays?: number; name?: string; basedOn?: string; basedOnDigest?: string; policy?: Record<string, unknown>; versions?: boolean }) =>
    req<{
      agent?: Agent;
      strategy?: Strategy;
      backtest: Backtest;
      basedOn?: { agentId: string; digest: string; lessons: Lesson[] };
      versions?: Array<{ strategy: Strategy; backtest: Backtest; chosen: boolean }>;
      selection?: { trials: number; by: string; deflatedSharpe: number | null };
    }>("POST", "/v1/agents", body, token),
  journal: (id: string) => req<Journal>("GET", `/v1/agents/${id}/journal`),
  setStatus: (token: string, id: string, action: "pause" | "resume") => req<{ ok: true; status: string }>("POST", `/v1/agents/${id}/${action}`, {}, token),
  claimBurn: (token: string, txHash: string) => req<{ ok: true; slots: number; amount: string; expiresAt: number; already: boolean; wallet: Wallet | null }>("POST", "/v1/burns", { txHash }, token),
  identityInfo: (id: string) => req<IdentityInfo>("GET", `/v1/agents/${id}/identity`),
  linkIdentity: (id: string, body: { txHash: string } | { agentId: string }) => req<{ identity: Identity; already: boolean }>("POST", `/v1/agents/${id}/identity`, body),
};

export type VaultChainKey = "robinhood" | "arbitrum";
/** Where users' vaults are made on one chain, and the tokens they can trade there. */
export interface VaultChainConfig {
  key: VaultChainKey;
  name: string;
  chainId: number;
  explorer: string;
  factory: string;
  adapter: string;
  executor: string;
  maxDepositUsd: number;
  cash: string;
  cashSymbol: string;
  cashDecimals: number;
  weth: string;
  tokens: Record<string, string>;
}

export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const txUrl = (tx: string) => `${EXPLORER}/tx/${tx}`;
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;
