import type { DatabaseSync } from "node:sqlite";
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, fallback, formatUnits, getAddress, http, type Address, type Chain, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem";
import { arbitrum } from "viem/chains";
import { mnemonicToAccount } from "viem/accounts";
import type { Market } from "../config.ts";
import { PUBLIC_RPCS, robinhoodChain } from "../sources/chainlink.ts";
import { loadRounds } from "../engine/ingest.ts";
import { getAccount, getAgent, saveAccount, type AgentRow } from "../engine/agents.ts";
import { addReceipt, epochOf } from "../engine/epochs.ts";
import { equity, type Account, type Position } from "../paper/broker.ts";
import { balanceOf, bestQuote, ethBalance, markSeen, ROBINHOOD_DEX, send, SwapError, swapExactIn, USDG, WETH, wethAbi, type Dex, type Quote, type SwapResult } from "./uniswap.ts";
import vaultArt from "../chain/AgentVault.json" with { type: "json" };
import { endReason, hasEnd, markEnded } from "../engine/end.ts";
import { ARBITRUM, ARBITRUM_DEX, arbitrumTokenOf, CHAIN_NAMES, type ChainKey } from "../chains.ts";

const vaultAbi = vaultArt.abi as any;
/** The executor of users' vaults: the wallet at this index under LIVE_MNEMONIC, on every chain. It can only swap and hand funds back to each vault's owner. */
export const VAULT_EXECUTOR_INDEX = 900;

/**
 * Real-money agents. A live agent runs the same rules as a paper agent, but its decisions
 * become orders that swap real tokens on Uniswap V3, and its account is what those swaps
 * really did.
 *
 *  - Each house agent has its own wallet, derived from LIVE_MNEMONIC at the agent's index, so
 *    anyone can check its balance on chain. A user's agent trades the user's own vault.
 *  - An agent trades on one chain (its venue): Robinhood Chain (stocks, ETH; USDG is the cash)
 *    or Arbitrum One (major crypto; USDC is the cash). Receipts are sealed and anchored on
 *    Robinhood Chain whatever chain the trade ran on; each fill names its chain.
 *  - The tick turns a decision into an order (live_orders) instead of a paper fill; the
 *    trader sends it, reads what was really spent and received from the balances, and only
 *    then updates the account and seals a fill receipt with the transaction.
 *  - Spot only: long, 1x.
 *  - Guards: trading only while LIVE_TRADING is true; a swap is refused when its price is
 *    further than maxGapBps from the oracle, or below the minimum order; every swap carries a
 *    minimum output (quote less slippage) and a deadline; the router is approved for exactly
 *    the amount sold. The owner's policy (daily loss, size, positions) is checked as for paper.
 */

export const GAS_RESERVE_WEI = 300_000_000_000_000n; // 0.0003 ETH kept for gas when funding (a swap costs ~0.0000066 ETH)
export const MIN_GAS_WEI = 20_000_000_000_000n; // 0.00002 ETH: below this no swap is attempted
/** After a failed order an agent waits this long before deciding again. */
export const RETRY_AFTER_SEC = 15 * 60;
/** A sent transaction with no receipt after this long is treated as dropped. */
const DROPPED_AFTER_SEC = 20 * 60;

export interface LiveOrderRow {
  id: number;
  agent_id: string;
  symbol: string;
  action: "open" | "close";
  usd_in: number | null;
  status: "pending" | "sent" | "filled" | "failed";
  tx: string | null;
  before_json: string | null;
  error: string | null;
  decision_leaf: string | null;
  created_at: number;
  updated_at: number;
}

export function walletAt(mnemonic: string, index: number): LocalAccount {
  return mnemonicToAccount(mnemonic, { addressIndex: index });
}

/** Orders not yet settled, oldest first. */
export const openOrders = (db: DatabaseSync, agentId?: string) =>
  (agentId
    ? db.prepare("SELECT * FROM live_orders WHERE agent_id = ? AND status IN ('pending', 'sent') ORDER BY id").all(agentId)
    : db.prepare("SELECT * FROM live_orders WHERE status IN ('pending', 'sent') ORDER BY id").all()) as unknown as LiveOrderRow[];

/** Whether a live agent may decide now: nothing in flight, and no failure in the last minutes. */
export function liveMayDecide(db: DatabaseSync, agentId: string, now: number): boolean {
  if (openOrders(db, agentId).length) return false;
  const failed = db.prepare("SELECT MAX(updated_at) AS t FROM live_orders WHERE agent_id = ? AND status = 'failed'").get(agentId) as { t: number | null };
  return !(failed.t !== null && now - failed.t < RETRY_AFTER_SEC);
}

/** Close orders for every open position of an agent that has none on the way yet. */
export function queueCloses(db: DatabaseSync, agentId: string, now: number) {
  // After a failed sale, wait a minute before the next try.
  const lastFail = db.prepare("SELECT MAX(updated_at) AS t FROM live_orders WHERE agent_id = ? AND action = 'close' AND status = 'failed'").get(agentId) as { t: number | null };
  if (lastFail.t !== null && now - lastFail.t < 60) return;
  const pending = new Set(openOrders(db, agentId).map((o) => o.symbol));
  for (const p of getAccount(db, agentId).account.positions) if (!pending.has(p.symbol)) queueOrder(db, { agentId, symbol: p.symbol, action: "close", usdIn: null, decisionLeaf: null }, now);
}

/** The latest marked equity of a money agent (executable prices), written by the trader. */
export const markOf = (db: DatabaseSync, agentId: string) => (db.prepare("SELECT equity, at FROM agent_marks WHERE agent_id = ?").get(agentId) as { equity: number; at: number } | undefined) ?? null;

export function queueOrder(db: DatabaseSync, o: { agentId: string; symbol: string; action: "open" | "close"; usdIn: number | null; decisionLeaf: string | null }, now: number): number {
  db.prepare("INSERT INTO live_orders (agent_id, symbol, action, usd_in, status, decision_leaf, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)").run(
    o.agentId, o.symbol, o.action, o.usdIn, o.decisionLeaf, now, now,
  );
  return Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

const setOrder = (db: DatabaseSync, id: number, f: Partial<Pick<LiveOrderRow, "status" | "tx" | "before_json" | "error">>, now: number) =>
  db.prepare("UPDATE live_orders SET status = COALESCE(?, status), tx = COALESCE(?, tx), before_json = COALESCE(?, before_json), error = ?, updated_at = ? WHERE id = ?").run(
    f.status ?? null, f.tx ?? null, f.before_json ?? null, f.error ?? null, now, id,
  );

/**
 * One chain an agent trades on: how to read it, its Uniswap, its cash token and WETH, the
 * adapter users' vaults there allow, and the token of each symbol it can trade.
 */
export interface Venue {
  key: ChainKey;
  chainId: number;
  name: string;
  pub: PublicClient;
  dex: Dex;
  weth: Address;
  /** The cash token (USD stablecoin) the account is kept in. */
  base: { symbol: string; address: Address; decimals: number };
  vaultAdapter?: Address;
  tokenOf: (symbol: string) => { token: Address; decimals: number } | null;
  makeClient: (account: LocalAccount) => WalletClient;
}

const clientFor = (chain: Chain, urls: string[]) => (account: LocalAccount): WalletClient =>
  createWalletClient({ account, chain, transport: fallback(urls.map((u) => http(u, { timeout: 30_000 }))) });

/** Robinhood Chain: stocks and ETH, USDG cash; tokens from the markets list. */
export function robinhoodVenue(pub: PublicClient, o: { markets: Market[]; rpcUrl?: string; vaultAdapter?: Address; makeClient?: (account: LocalAccount) => WalletClient }): Venue {
  return {
    key: "robinhood",
    chainId: robinhoodChain.id,
    name: CHAIN_NAMES.robinhood,
    pub,
    dex: ROBINHOOD_DEX,
    weth: WETH,
    base: { symbol: "USDG", address: USDG, decimals: 6 },
    vaultAdapter: o.vaultAdapter,
    tokenOf: (symbol) => {
      const m = o.markets.find((x) => x.symbol === symbol);
      return m?.token ? { token: getAddress(m.token), decimals: m.tokenDecimals ?? 18 } : null;
    },
    makeClient: o.makeClient ?? clientFor(robinhoodChain, [...(o.rpcUrl ? [o.rpcUrl] : []), ...PUBLIC_RPCS]),
  };
}

/** Arbitrum One: major crypto, USDC cash. */
export function arbitrumVenue(o: { pub?: PublicClient; rpcUrl?: string; vaultAdapter?: Address; makeClient?: (account: LocalAccount) => WalletClient } = {}): Venue {
  const urls = [...(o.rpcUrl ? [o.rpcUrl] : []), ...ARBITRUM.rpcs];
  const pub = o.pub ?? (createPublicClient({ chain: arbitrum, transport: fallback(urls.map((u) => http(u, { timeout: 30_000 }))) }) as PublicClient);
  return {
    key: "arbitrum",
    chainId: ARBITRUM.id,
    name: ARBITRUM.name,
    pub,
    dex: ARBITRUM_DEX,
    weth: ARBITRUM.weth,
    base: { symbol: ARBITRUM.base.symbol, address: ARBITRUM.base.address, decimals: ARBITRUM.base.decimals },
    vaultAdapter: o.vaultAdapter,
    tokenOf: arbitrumTokenOf,
    makeClient: o.makeClient ?? clientFor(arbitrum, urls),
  };
}

export interface LiveTraderConfig {
  mnemonic: string;
  markets: Market[];
  /** Below the quote, the least a swap may return. */
  slippageBps: number;
  /** Furthest a swap's price may be from the oracle price. */
  maxGapBps: number;
  minOrderUsd: number;
  epochSec: number;
  rpcUrl?: string;
  /** Users' vaults on Robinhood Chain: the Uniswap adapter they allow. */
  vaultAdapter?: Address;
}

export interface LiveReport {
  filled: Array<{ agentId: string; symbol: string; action: string; usd: number; tx: string }>;
  failed: Array<{ agentId: string; symbol: string; error: string }>;
}

const units = (x: bigint, decimals: number) => Number(formatUnits(x, decimals));

export class LiveTrader {
  readonly db: DatabaseSync;
  /** Robinhood Chain's client (home chain). */
  readonly pub: PublicClient;
  readonly cfg: LiveTraderConfig;
  private readonly venues = new Map<ChainKey, Venue>();
  private readonly wallets = new Map<string, { account: LocalAccount; client: WalletClient }>();

  constructor(db: DatabaseSync, pub: PublicClient, cfg: LiveTraderConfig, walletClient?: (account: LocalAccount) => WalletClient) {
    this.db = db;
    this.pub = pub;
    this.cfg = cfg;
    this.venues.set("robinhood", robinhoodVenue(pub, { markets: cfg.markets, rpcUrl: cfg.rpcUrl, vaultAdapter: cfg.vaultAdapter, makeClient: walletClient }));
  }

  /** Adds (or replaces) a chain the trader can trade on. */
  addVenue(v: Venue) {
    this.venues.set(v.key, v);
    return this;
  }

  venue(key: ChainKey): Venue {
    const v = this.venues.get(key);
    if (!v) throw new SwapError(`trading on ${CHAIN_NAMES[key] ?? key} is not configured`);
    return v;
  }

  hasVenue = (key: ChainKey) => this.venues.has(key);
  venueOf = (a: Pick<AgentRow, "chain">) => this.venue(a.chain ?? "robinhood");

  /** A wallet under LIVE_MNEMONIC, signing on `chain` (the same address on every chain). */
  wallet(index: number, chain: ChainKey = "robinhood") {
    const k = `${chain}:${index}`;
    let w = this.wallets.get(k);
    if (!w) {
      const account = walletAt(this.cfg.mnemonic, index);
      w = { account, client: this.venue(chain).makeClient(account) };
      this.wallets.set(k, w);
    }
    return w;
  }

  private readonly addresses = new Map<number, Address>();
  /** The address at an index (the same on every chain); derived once, as derivation is slow. */
  addressOf = (index: number): Address => {
    let a = this.addresses.get(index);
    if (!a) this.addresses.set(index, (a = walletAt(this.cfg.mnemonic, index).address));
    return a;
  };

  /** Where an agent's money is: its own wallet, or the user's vault. */
  holderOf = (a: AgentRow): Address => (a.vault ? getAddress(a.vault) : this.addressOf(a.liveIndex!));
  /** Who signs for it, on its chain: its own wallet, or the vaults' executor. */
  signerOf = (a: AgentRow) => this.wallet(a.vault ? VAULT_EXECUTOR_INDEX : a.liveIndex!, a.chain);
  get executorAddress(): Address {
    return this.addressOf(VAULT_EXECUTOR_INDEX);
  }

  private market(v: Venue, symbol: string) {
    const m = v.tokenOf(symbol);
    if (!m) throw new SwapError(`${symbol} has no token on ${v.name}`);
    return m;
  }

  /** Latest oracle price, from the rounds the ticker stores. */
  oraclePrice(symbol: string, now: number): number {
    const r = loadRounds(this.db, symbol, now - 6 * 3600).at(-1);
    if (!r) throw new SwapError(`no recent oracle price for ${symbol}`);
    return r.price;
  }

  /** Sends every pending order and settles every sent one. */
  async run(now: () => number): Promise<LiveReport> {
    const report: LiveReport = { filled: [], failed: [] };
    for (const o of openOrders(this.db)) {
      const agent = getAgent(this.db, o.agent_id);
      if (!agent || (agent.liveIndex === null && agent.vault === null)) {
        setOrder(this.db, o.id, { status: "failed", error: "not a live agent" }, now());
        continue;
      }
      try {
        const r = o.status === "sent" ? await this.settleSent(agent, o, now) : await this.execute(agent, o, now);
        if (r) report.filled.push({ agentId: agent.id, symbol: o.symbol, action: o.action, usd: r.usd, tx: r.tx });
      } catch (e) {
        const error = e instanceof SwapError ? e.message : `unexpected: ${(e as Error).message.split("\n")[0]}`;
        const cur = this.db.prepare("SELECT status, tx FROM live_orders WHERE id = ?").get(o.id) as { status: string; tx: string | null };
        // A swap whose transaction went out stays "sent": its fate is read from the chain next round.
        if (cur.status === "sent" && cur.tx && !(e instanceof SwapError && /reverted/.test(error))) continue;
        setOrder(this.db, o.id, { status: "failed", error }, now());
        report.failed.push({ agentId: agent.id, symbol: o.symbol, error });
      }
    }
    return report;
  }

  private async execute(agent: AgentRow, o: LiveOrderRow, now: () => number) {
    const v = this.venueOf(agent);
    const cash = v.base;
    const { account, client } = this.signerOf(agent);
    const me = this.holderOf(agent);
    const { token, decimals } = this.market(v, o.symbol);
    const gas = await ethBalance(v.pub, account.address);
    if (gas < MIN_GAS_WEI) throw new SwapError(`wallet ${account.address} has too little ETH for gas on ${v.name}`);
    const oracle = this.oraclePrice(o.symbol, now());
    const gap = this.cfg.maxGapBps / 10_000;
    const row = getAccount(this.db, agent.id);

    let tokenIn: Address, tokenOut: Address, amountIn: bigint;
    if (o.action === "open") {
      const have = await balanceOf(v.pub, cash.address, me);
      amountIn = BigInt(Math.floor(Math.min(o.usd_in ?? 0, units(have, cash.decimals)) * 10 ** cash.decimals));
      if (units(amountIn, cash.decimals) < this.cfg.minOrderUsd) throw new SwapError(`order of $${units(amountIn, cash.decimals).toFixed(2)} is under the $${this.cfg.minOrderUsd} minimum`);
      [tokenIn, tokenOut] = [cash.address, token];
    } else {
      amountIn = await balanceOf(v.pub, token, me);
      if (amountIn === 0n) {
        // Nothing to sell: the position is already gone on chain; the account follows the chain.
        this.dropPosition(agent.id, row, o.symbol, now());
        setOrder(this.db, o.id, { status: "failed", error: "no tokens to sell; position removed" }, now());
        return null;
      }
      [tokenIn, tokenOut] = [token, cash.address];
    }

    const q = await bestQuote(v.pub, tokenIn, tokenOut, amountIn, v.dex);
    if (!q) throw new SwapError(`no Uniswap pool on ${v.name} can fill ${o.action} ${o.symbol}`);
    // Price per token of the quote, compared with the oracle before anything is signed.
    const usd = units(o.action === "open" ? amountIn : q.amountOut, cash.decimals);
    const tokens = units(o.action === "open" ? q.amountOut : amountIn, decimals);
    const px = usd / tokens;
    if (o.action === "open" ? px > oracle * (1 + gap) : px < oracle * (1 - gap))
      throw new SwapError(`quote ${px.toFixed(4)} is more than ${this.cfg.maxGapBps} bps from the oracle ${oracle.toFixed(4)}`);
    const minOut = (q.amountOut * BigInt(10_000 - this.cfg.slippageBps)) / 10_000n;

    const before = {
      cash: (await balanceOf(v.pub, cash.address, me)).toString(),
      token: (await balanceOf(v.pub, token, me)).toString(),
      quotedOut: q.amountOut.toString(), minOut: minOut.toString(), fee: q.fee, ...(q.via ? { via: q.via } : {}), oracle,
    };
    setOrder(this.db, o.id, { before_json: JSON.stringify(before) }, now());
    const onSent = (tx: Hex) => setOrder(this.db, o.id, { status: "sent", tx }, now());
    const res = agent.vault
      ? await this.vaultSwap(agent, { tokenIn, tokenOut, amountIn, quote: q, minOut, decision: (o.decision_leaf ?? null) as Hex | null, onSent })
      : await swapExactIn(v.pub, client, account, { tokenIn, tokenOut, amountIn, quote: q, minOut, deadlineSec: now() + 300, onSent }, v.dex);
    return this.book(agent, o, res, { decimals, oracle }, now());
  }

  /** A transaction sent in an earlier round (the service restarted, or the wait timed out). */
  private async settleSent(agent: AgentRow, o: LiveOrderRow, now: () => number) {
    const v = this.venueOf(agent);
    const r = await v.pub.getTransactionReceipt({ hash: o.tx as Hex }).catch(() => null);
    if (!r) {
      if (now() - o.updated_at > DROPPED_AFTER_SEC) throw new SwapError(`transaction ${o.tx} was not mined`);
      return null;
    }
    if (r.status !== "success") throw new SwapError(`transaction ${o.tx} reverted`);
    const me = this.holderOf(agent);
    if (agent.vault) markSeen(v.pub, me, r.blockNumber);
    const { token, decimals } = this.market(v, o.symbol);
    const b = JSON.parse(o.before_json ?? "{}");
    // "usdg": orders written before the cash token was named per chain.
    const cashBefore = BigInt(b.cash ?? b.usdg);
    const [cash, tok] = await Promise.all([balanceOf(v.pub, v.base.address, me), balanceOf(v.pub, token, me)]);
    const common = { tx: o.tx as Hex, fee: b.fee, ...(b.via ? { via: b.via } : {}), quotedOut: BigInt(b.quotedOut), minOut: BigInt(b.minOut), gasUsed: r.gasUsed };
    const res: SwapResult =
      o.action === "open"
        ? { ...common, spent: cashBefore - cash, received: tok - BigInt(b.token) }
        : { ...common, spent: BigInt(b.token) - tok, received: cash - cashBefore };
    return this.book(agent, o, res, { decimals, oracle: Number(b.oracle) }, now());
  }

  /** Updates the account from what the swap really did and seals the fill. */
  private book(agent: AgentRow, o: LiveOrderRow, res: SwapResult, m: { decimals: number; oracle: number }, t: number) {
    const v = this.venueOf(agent);
    const row = getAccount(this.db, agent.id);
    const a: Account = row.account;
    let next: Account;
    let fill: Record<string, unknown>;
    if (o.action === "open") {
      const usd = units(res.spent, v.base.decimals);
      const qty = units(res.received, m.decimals);
      const pos: Position = { symbol: o.symbol, side: "long", venue: "spot", qty, entryPrice: usd / qty, leverage: 1, margin: usd, openedAt: t };
      next = { ...a, cash: a.cash - usd, positions: [...a.positions, pos] };
      fill = { action: "open", symbol: o.symbol, side: "long", venue: "spot", price: usd / qty, qty, notional: usd, fee: 0, pnl: 0 };
    } else {
      const usd = units(res.received, v.base.decimals);
      const qty = units(res.spent, m.decimals);
      const p = a.positions.find((x) => x.symbol === o.symbol);
      const margin = p?.margin ?? 0;
      next = { cash: a.cash + usd, positions: a.positions.filter((x) => x.symbol !== o.symbol), lastExit: { ...a.lastExit, [o.symbol]: t } };
      fill = { action: "close", symbol: o.symbol, side: "long", venue: "spot", price: usd / qty, qty, notional: usd, fee: 0, pnl: usd - margin };
    }
    const prices = new Map(next.positions.map((p) => [p.symbol, p.symbol === o.symbol ? m.oracle : this.safeOracle(p.symbol, t) ?? p.entryPrice]));
    const eq = equity(next, prices);
    this.db.exec("BEGIN");
    try {
      saveAccount(this.db, agent.id, { ...row, account: next, equity: eq }, t);
      addReceipt(this.db, agent.id, epochOf(t, this.cfg.epochSec), "fill", {
        agentId: agent.id,
        strategyHash: agent.strategyHash,
        at: t,
        money: "real",
        order: o.id,
        decision: o.decision_leaf,
        symbol: o.symbol,
        fill,
        swap: {
          chainId: v.chainId,
          wallet: this.holderOf(agent),
          ...(agent.vault ? { vault: agent.vault, executor: this.executorAddress } : {}),
          venue: "uniswap-v3",
          cash: v.base.symbol,
          poolFee: res.fee,
          ...(res.via ? { via: res.via.mid, poolFee2: res.via.fee2 } : {}),
          tx: res.tx,
          spent: res.spent.toString(),
          received: res.received.toString(),
          quotedOut: res.quotedOut.toString(),
          minOut: res.minOut.toString(),
        },
        oraclePrice: m.oracle,
      }, t);
      setOrderRaw(this.db, o.id, "filled", res.tx, t);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { usd: Number(fill.notional), tx: res.tx };
  }

  /**
   * A swap inside a user's vault, sent by the executor. The vault enforces its own limits and
   * oracle floor; what was spent and received is read from the vault's balances.
   */
  private async vaultSwap(agent: AgentRow, o: { tokenIn: Address; tokenOut: Address; amountIn: bigint; quote: Quote; minOut: bigint; decision: Hex | null; onSent?: (tx: Hex) => void }): Promise<SwapResult> {
    const v = this.venueOf(agent);
    if (!v.vaultAdapter) throw new SwapError(`vault trading on ${v.name} is not configured`);
    const vault = getAddress(agent.vault!);
    const { account, client } = this.wallet(VAULT_EXECUTOR_INDEX, v.key);
    const [inBefore, outBefore] = await Promise.all([balanceOf(v.pub, o.tokenIn, vault), balanceOf(v.pub, o.tokenOut, vault)]);
    if (inBefore < o.amountIn) throw new SwapError(`vault holds ${inBefore} of ${o.tokenIn}, less than the ${o.amountIn} to sell`);
    // The adapter's route data: one pool's fee tier, or two pools through the hub.
    const route = o.quote.via
      ? encodeAbiParameters([{ type: "uint24" }, { type: "address" }, { type: "uint24" }], [o.quote.fee, o.quote.via.mid, o.quote.via.fee2])
      : encodeAbiParameters([{ type: "uint24" }], [o.quote.fee]);
    const decision = (o.decision && /^0x[0-9a-f]{64}$/i.test(o.decision) ? o.decision : `0x${"00".repeat(32)}`) as Hex;
    const data = encodeFunctionData({ abi: vaultAbi, functionName: "swap", args: [v.vaultAdapter, o.tokenIn, o.tokenOut, o.amountIn, o.minOut, route, decision] });
    const r = await send(v.pub, client, account, { to: vault, data, onSent: o.onSent });
    markSeen(v.pub, vault, r.blockNumber);
    const [inAfter, outAfter] = await Promise.all([balanceOf(v.pub, o.tokenIn, vault), balanceOf(v.pub, o.tokenOut, vault)]);
    return { tx: r.hash, fee: o.quote.fee, ...(o.quote.via ? { via: o.quote.via } : {}), spent: inBefore - inAfter, received: outAfter - outBefore, quotedOut: o.quote.amountOut, minOut: o.minOut, gasUsed: r.gasUsed };
  }

  /**
   * A new vault agent: WETH the user deposited is swapped to the chain's cash token inside the
   * vault, then the account starts from the cash that is there, and the agent starts.
   */
  async fundVault(agent: AgentRow, now: () => number): Promise<number | null> {
    const row = getAccount(this.db, agent.id);
    if (row.startEquity > 0 || !agent.vault) return null;
    const v = this.venueOf(agent);
    const vault = getAddress(agent.vault);
    const weth = await balanceOf(v.pub, v.weth, vault);
    let tx: Hex | null = null;
    if (weth > 10n ** 12n) {
      const q = await bestQuote(v.pub, v.weth, v.base.address, weth, v.dex);
      if (!q) throw new SwapError(`no Uniswap pool for WETH/${v.base.symbol} on ${v.name}`);
      const oracle = this.oraclePrice("ETH", now());
      const px = units(q.amountOut, v.base.decimals) / units(weth, 18);
      if (px < oracle * (1 - this.cfg.maxGapBps / 10_000)) throw new SwapError(`quote ${px.toFixed(2)} is too far below the oracle ${oracle.toFixed(2)}`);
      const res = await this.vaultSwap(agent, { tokenIn: v.weth, tokenOut: v.base.address, amountIn: weth, quote: q, minOut: (q.amountOut * BigInt(10_000 - this.cfg.slippageBps)) / 10_000n, decision: null });
      tx = res.tx;
    }
    const cash = units(await balanceOf(v.pub, v.base.address, vault), v.base.decimals);
    if (cash < this.cfg.minOrderUsd) throw new SwapError(`the vault holds $${cash.toFixed(2)}; at least $${this.cfg.minOrderUsd} is needed`);
    const t = now();
    this.db.exec("BEGIN");
    try {
      const account = { ...row.account, cash, peak: cash };
      this.db.prepare("UPDATE accounts SET account_json = ?, start_equity = ?, day_start_equity = ?, equity = ?, updated_at = ? WHERE agent_id = ?").run(JSON.stringify(account), cash, cash, cash, t, agent.id);
      addReceipt(this.db, agent.id, epochOf(t, this.cfg.epochSec), "funding", {
        agentId: agent.id, at: t, money: "real", chainId: v.chainId, vault, owner: agent.owner,
        deposit: { weth: formatUnits(weth, 18), [v.base.symbol.toLowerCase()]: cash.toFixed(6), cash: cash.toFixed(6), cashToken: v.base.symbol, swapTx: tx },
        startEquity: cash,
      }, t);
      // The run's clock starts when the money is in place.
      this.db.prepare("UPDATE agents SET status = 'active', pause_reason = NULL, created_at = ? WHERE id = ? AND ended_at IS NULL").run(t, agent.id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return cash;
  }

  /**
   * Equity at executable prices: cash plus what each position would sell for on Uniswap now.
   * Recorded for the live view, and used to end runs between ticks.
   */
  async markEquity(agent: AgentRow, now: number): Promise<number> {
    const v = this.venueOf(agent);
    const row = getAccount(this.db, agent.id);
    let eq = row.account.cash;
    for (const p of row.account.positions) {
      const { token } = this.market(v, p.symbol);
      const held = await balanceOf(v.pub, token, this.holderOf(agent));
      const q = held > 0n ? await bestQuote(v.pub, token, v.base.address, held, v.dex) : null;
      eq += q ? units(q.amountOut, v.base.decimals) : p.margin;
    }
    this.db.prepare("INSERT INTO agent_marks (agent_id, equity, at) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET equity = excluded.equity, at = excluded.at").run(agent.id, eq, now);
    return eq;
  }

  /**
   * Between ticks, for every money agent: start new vault agents, watch the end of each run at
   * executable prices, and hand an ended vault's funds back to its owner once it holds only cash.
   */
  async watch(now: () => number): Promise<string[]> {
    const notes: string[] = [];
    const agents = (this.db.prepare("SELECT id FROM agents WHERE live_index IS NOT NULL OR vault IS NOT NULL").all() as Array<{ id: string }>).map((r) => getAgent(this.db, r.id)!);
    for (const a of agents) {
      try {
        if (a.vault && a.endedAt === null && getAccount(this.db, a.id).startEquity === 0) {
          const usd = await this.fundVault(a, now);
          if (usd) notes.push(`${a.id} funded with $${usd.toFixed(2)}`);
          continue;
        }
        if (a.status === "active" && a.endedAt === null && hasEnd(a.strategy)) {
          const row = getAccount(this.db, a.id);
          const eq = await this.markEquity(a, now());
          const why = endReason(a, row.startEquity > 0 ? ((eq - row.startEquity) / row.startEquity) * 100 : 0, now());
          if (why && markEnded(this.db, a, why, eq, this.cfg.epochSec, now())) {
            queueCloses(this.db, a.id, now());
            notes.push(`${a.id} ended: ${why}`);
          }
        } else if (a.status === "active" && getAccount(this.db, a.id).account.positions.length) {
          await this.markEquity(a, now());
        }
        const fresh = getAgent(this.db, a.id)!;
        // "returning" too: a return cut short by a restart is simply done again (it moves whatever is still there).
        if (fresh.vault && (fresh.stopState === "closing" || fresh.stopState === "returning") && openOrders(this.db, a.id).length === 0) {
          const held = getAccount(this.db, a.id).account.positions;
          const failedCloses = held.length
            ? Number((this.db.prepare("SELECT COUNT(*) AS n FROM live_orders WHERE agent_id = ? AND action = 'close' AND status = 'failed' AND created_at >= ?").get(a.id, fresh.endedAt ?? 0) as { n: number }).n)
            : 0;
          if (held.length && failedCloses < 2) queueCloses(this.db, a.id, now());
          else if (held.length) {
            // The sale keeps failing (for a stock, usually because its market is closed): the owner
            // gets the tokens themselves rather than waiting, and can sell them on the Trade page.
            await this.returnFunds(fresh, now);
            notes.push(`${a.id} could not sell ${held.map((p) => p.symbol).join(", ")}; returned the tokens as they are to ${fresh.owner}`);
          }
          else {
            await this.returnFunds(fresh, now);
            notes.push(`${a.id} funds returned to ${fresh.owner}`);
          }
        }
      } catch (e) {
        notes.push(`${a.id}: ${e instanceof SwapError ? e.message : (e as Error).message.split("\n")[0]}`);
      }
    }
    return notes;
  }

  /**
   * The fast loop (every few seconds): for every money agent holding a position, its equity at
   * executable prices, and the end of its run (profit target, loss limit, time) as soon as it is
   * reached. Reads only, plus close orders for runs that end; returns the agents that ended.
   */
  async watchMarks(now: () => number): Promise<string[]> {
    const ended: string[] = [];
    const rows = this.db
      .prepare("SELECT a.id FROM agents a JOIN accounts c ON c.agent_id = a.id WHERE (a.live_index IS NOT NULL OR a.vault IS NOT NULL) AND a.status = 'active' AND a.ended_at IS NULL AND json_array_length(c.account_json, '$.positions') > 0")
      .all() as Array<{ id: string }>;
    for (const { id } of rows) {
      const a = getAgent(this.db, id);
      if (!a) continue;
      try {
        const row = getAccount(this.db, id);
        const eq = await this.markEquity(a, now());
        if (!hasEnd(a.strategy)) continue;
        const why = endReason(a, row.startEquity > 0 ? ((eq - row.startEquity) / row.startEquity) * 100 : 0, now());
        if (why && markEnded(this.db, a, why, eq, this.cfg.epochSec, now())) {
          queueCloses(this.db, id, now());
          ended.push(`${id} ended: ${why}`);
        }
      } catch {
        /* a quote that fails now is tried again in a few seconds */
      }
    }
    return ended;
  }

  /** Hands everything in an ended vault back to its owner (WETH as ETH) and seals it. */
  async returnFunds(agent: AgentRow, now: () => number) {
    const v = this.venueOf(agent);
    const vault = getAddress(agent.vault!);
    // Deposited as ETH: the cash goes back to WETH inside the vault, so the owner gets ETH back.
    const funding = this.db.prepare("SELECT record_json FROM receipts WHERE agent_id = ? AND kind = 'funding' ORDER BY id LIMIT 1").get(agent.id) as { record_json: string } | undefined;
    const depositedEth = funding ? Number(JSON.parse(funding.record_json)?.deposit?.weth ?? 0) > 0 : false;
    const cash = await balanceOf(v.pub, v.base.address, vault);
    if (depositedEth && cash >= 10n ** BigInt(v.base.decimals) / 2n) {
      const q = await bestQuote(v.pub, v.base.address, v.weth, cash, v.dex);
      if (q) {
        const oracle = this.oraclePrice("ETH", now());
        const px = units(cash, v.base.decimals) / units(q.amountOut, 18);
        if (px <= oracle * (1 + this.cfg.maxGapBps / 10_000))
          await this.vaultSwap(agent, { tokenIn: v.base.address, tokenOut: v.weth, amountIn: cash, quote: q, minOut: (q.amountOut * BigInt(10_000 - this.cfg.slippageBps)) / 10_000n, decision: null });
        // A pool far from the oracle: the owner gets the cash token rather than ETH at a bad price.
      }
    }
    const tokens = [v.base.address, v.weth, ...agent.strategy.symbols.map((s) => v.tokenOf(s)?.token).filter((t): t is Address => Boolean(t) && t !== v.weth)];
    const before: Record<string, string> = {};
    for (const t of tokens) before[t] = (await balanceOf(v.pub, t, vault)).toString();
    this.db.prepare("UPDATE agents SET stop_state = 'returning' WHERE id = ?").run(agent.id);
    const { account, client } = this.wallet(VAULT_EXECUTOR_INDEX, v.key);
    const r = await send(v.pub, client, account, { to: vault, data: encodeFunctionData({ abi: vaultAbi, functionName: "returnToOwner", args: [tokens] }) });
    markSeen(v.pub, vault, r.blockNumber);
    const t = now();
    const row = getAccount(this.db, agent.id);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE agents SET stop_state = 'returned' WHERE id = ?").run(agent.id);
      // The account is empty now, but its equity stays at what was handed back: the run's final result.
      const final = row.account.cash + row.account.positions.reduce((tot, p) => tot + p.margin, 0);
      saveAccount(this.db, agent.id, { ...row, account: { ...row.account, cash: 0, positions: [] }, equity: final }, t);
      addReceipt(this.db, agent.id, epochOf(t, this.cfg.epochSec), "funding", {
        agentId: agent.id, at: t, money: "real", chainId: v.chainId, vault, owner: agent.owner, returned: before, tx: r.hash, finalEquity: final, unsold: row.account.positions.map((p) => ({ symbol: p.symbol, qty: p.qty })),
        returnPct: row.startEquity > 0 ? Math.round(((row.account.cash - row.startEquity) / row.startEquity) * 10_000) / 100 : 0,
      }, t);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return r.hash;
  }

  private safeOracle(symbol: string, t: number): number | null {
    try {
      return this.oraclePrice(symbol, t);
    } catch {
      return null;
    }
  }

  private dropPosition(agentId: string, row: ReturnType<typeof getAccount>, symbol: string, t: number) {
    const account = { ...row.account, positions: row.account.positions.filter((p) => p.symbol !== symbol), lastExit: { ...row.account.lastExit, [symbol]: t } };
    saveAccount(this.db, agentId, { ...row, account }, t);
  }

  /** Balances of a live agent's wallet: gas, cash and each held token. */
  async balances(agent: AgentRow) {
    const v = this.venueOf(agent);
    const me = this.holderOf(agent);
    const eth = await ethBalance(v.pub, me);
    const cash = await balanceOf(v.pub, v.base.address, me);
    const tokens: Record<string, string> = {};
    for (const sym of agent.strategy.symbols) {
      const { token, decimals } = this.market(v, sym);
      tokens[sym] = formatUnits(await balanceOf(v.pub, token, me), decimals);
    }
    return { wallet: me, chain: v.key, eth: formatUnits(eth, 18), [v.base.symbol.toLowerCase()]: formatUnits(cash, v.base.decimals), tokens };
  }

  /**
   * Turns what was sent to a house agent's wallet into cash and books it: ETH above the gas
   * reserve is wrapped, all WETH not held as a position is swapped to the cash token, and the
   * account's cash and starting equity grow by what arrived. Safe to run again after a run that
   * stopped half way (ETH already wrapped, or cash already swapped but not booked).
   */
  async fundFromEth(agent: AgentRow, now: () => number, o: { dryRun: boolean; tx?: string }) {
    const v = this.venueOf(agent);
    const { account, client } = this.wallet(agent.liveIndex!, v.key);
    const me = account.address;
    const row0 = getAccount(this.db, agent.id);
    if (row0.account.positions.length) throw new SwapError("the agent holds positions; fund it while it holds only cash");
    const eth = await ethBalance(v.pub, me);
    const wrap = eth > GAS_RESERVE_WEI ? eth - GAS_RESERVE_WEI : 0n;
    const sell = (await balanceOf(v.pub, v.weth, me)) + wrap;
    const cashNow = units(await balanceOf(v.pub, v.base.address, me), v.base.decimals);
    const unbooked = cashNow - row0.account.cash;
    if (sell === 0n && unbooked < 0.01) throw new SwapError(`nothing to fund: wallet ${me} holds ${formatUnits(eth, 18)} ETH (the gas reserve is ${formatUnits(GAS_RESERVE_WEI, 18)}), no WETH and no unbooked ${v.base.symbol}`);
    let q: Quote | null = null;
    const oracle = this.oraclePrice("ETH", now());
    if (sell > 0n) {
      q = await bestQuote(v.pub, v.weth, v.base.address, sell, v.dex);
      if (!q) throw new SwapError(`no Uniswap pool for WETH/${v.base.symbol} on ${v.name}`);
      const px = units(q.amountOut, v.base.decimals) / units(sell, 18);
      if (px < oracle * (1 - this.cfg.maxGapBps / 10_000)) throw new SwapError(`quote ${px.toFixed(2)} is too far below the oracle ${oracle.toFixed(2)}`);
    }
    const plan = {
      wallet: me, chain: v.key, eth: formatUnits(eth, 18), wrapEth: formatUnits(wrap, 18), swapWeth: formatUnits(sell, 18), keepEth: formatUnits(eth - wrap, 18),
      unbookedCash: unbooked.toFixed(6), expectCash: q ? formatUnits(q.amountOut, v.base.decimals) : "0", cashToken: v.base.symbol, poolFee: q?.fee ?? null, oracle,
    };
    if (o.dryRun) return { plan, done: null };

    let res: SwapResult | null = null;
    if (wrap > 0n) await send(v.pub, client, account, { to: v.weth, data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), value: wrap });
    if (sell > 0n && q) {
      const minOut = (q.amountOut * BigInt(10_000 - this.cfg.slippageBps)) / 10_000n;
      res = await swapExactIn(v.pub, client, account, { tokenIn: v.weth, tokenOut: v.base.address, amountIn: sell, quote: q, minOut, deadlineSec: now() + 300 }, v.dex);
    }
    const cash = units(await balanceOf(v.pub, v.base.address, me), v.base.decimals);
    const t = now();
    const row = getAccount(this.db, agent.id);
    const added = cash - row.account.cash;
    if (added <= 0) throw new SwapError(`no ${v.base.symbol} arrived (wallet ${cash}, booked ${row.account.cash}); nothing booked`);
    const first = row.startEquity === 0;
    this.db.exec("BEGIN");
    try {
      const account = { ...row.account, cash };
      const eq = equity(account, new Map(account.positions.map((p) => [p.symbol, this.safeOracle(p.symbol, t) ?? p.entryPrice])));
      this.db
        .prepare("UPDATE accounts SET account_json = ?, start_equity = ?, day_start_equity = ?, equity = ?, updated_at = ? WHERE agent_id = ?")
        .run(JSON.stringify(account), row.startEquity + added, first ? eq : row.dayStartEquity + added, eq, t, agent.id);
      addReceipt(this.db, agent.id, epochOf(t, this.cfg.epochSec), "funding", {
        agentId: agent.id,
        at: t,
        money: "real",
        chainId: v.chainId,
        wallet: me,
        deposit: { eth: plan.swapWeth, [v.base.symbol.toLowerCase()]: added.toFixed(6), cash: added.toFixed(6), cashToken: v.base.symbol, swapTx: res?.tx ?? o.tx ?? null, poolFee: res?.fee ?? null },
        startEquity: row.startEquity + added,
      }, t);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { plan, done: { tx: res?.tx ?? o.tx ?? null, cash, added } };
  }
}

const setOrderRaw = (db: DatabaseSync, id: number, status: string, tx: string, now: number) =>
  db.prepare("UPDATE live_orders SET status = ?, tx = ?, error = NULL, updated_at = ? WHERE id = ?").run(status, tx, now, id);
