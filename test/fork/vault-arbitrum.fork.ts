/**
 * A user's real-money agent on Arbitrum One, end to end on a local fork of Arbitrum mainnet:
 * the user makes and funds a vault with ETH in one transaction; it is checked as the server
 * checks it; the trader turns the ETH into USDC inside the vault and starts the agent; it buys
 * LINK (through WETH when two pools beat the direct one) and BTC; the owner stops it, both are
 * sold, and everything goes back to the user's wallet as ETH. Nothing touches the real chain.
 *
 *   npm run test:fork
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, parseEther, type Address, type Hex, type PublicClient } from "viem";
import { english, generateMnemonic, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import factoryArt from "../../src/chain/AgentVaultFactory.json" with { type: "json" };
import uniArt from "../../src/chain/UniswapV3Adapter.json" with { type: "json" };
import { openDb } from "../../src/store/db.ts";
import { createAgent, getAccount, getAgent } from "../../src/engine/agents.ts";
import { markEnded } from "../../src/engine/end.ts";
import { Policy } from "../../src/guard/policy.ts";
import { arbitrumVenue, LiveTrader, queueCloses, queueOrder, VAULT_EXECUTOR_INDEX } from "../../src/live/live.ts";
import { verifyVaultCreation } from "../../src/live/vaults.ts";
import { bestQuote } from "../../src/live/uniswap.ts";
import { ARBITRUM, ARBITRUM_DEX } from "../../src/chains.ts";
import type { Market } from "../../src/config.ts";
import { strategy } from "../helpers.ts";

// A fork reads every storage slot it touches from this node, one by one: a fast node matters. The
// block is pinned (ARB_FORK_BLOCK), so a second run reads from anvil's cache instead.
const RPC_SRC = process.env.ARB_FORK_RPC ?? process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
const PORT = 27545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 42161, name: "arb-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const USDC = ARBITRUM.base.address;
const WETH = ARBITRUM.weth;
const LINK = ARBITRUM.tokens.LINK!.token;
const BTC = ARBITRUM.tokens.BTC!.token;
// Robinhood markets as the service has them (no token on Robinhood Chain for LINK or BTC here).
const MARKETS: Market[] = ["ETH", "LINK", "BTC"].map((symbol) => ({ symbol, assetClass: "crypto", source: "chainlink", feed: ARBITRUM.tokens[symbol]!.feed, decimals: 8, heartbeatSec: 86400, deviationPct: 0.5 }));

let node: ChildProcess | null = null;
let pub: PublicClient;
const hasAnvil = spawnSync("anvil", ["--version"], { shell: process.platform === "win32" }).status === 0;
const wallet = (a: ReturnType<typeof privateKeyToAccount>) => createWalletClient({ account: a, chain, transport: http(RPC, { timeout: 240_000 }), pollingInterval: 250 });

before(async () => {
  if (!hasAnvil) return;
  const block = process.env.ARB_FORK_BLOCK ?? String(Number(await createPublicClient({ transport: http(RPC_SRC) }).getBlockNumber()) - 20);
  console.log(`forking Arbitrum One at block ${block} (set ARB_FORK_BLOCK=${block} to reuse the cache)`);
  node = spawn("anvil", ["--fork-url", RPC_SRC, "--fork-block-number", block, "--port", String(PORT), "--silent", "--chain-id", "42161", "--base-fee", "10000000", "--gas-price", "20000000"], { shell: process.platform === "win32" });
  pub = createPublicClient({ chain, transport: http(RPC, { timeout: 240_000 }), pollingInterval: 250 }) as PublicClient;
  for (let i = 0; i < 600; i++) {
    try {
      await pub.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("anvil fork did not start");
});
after(() => {
  if (!node) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(node.pid), "/T", "/F"]);
  else node.kill();
});

const bal = (token: Address, who: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

test("an Arbitrum vault agent: funded with ETH, buys LINK and BTC in USDC, and the money comes back as ETH", { skip: !hasAnvil && "anvil not installed", timeout: 3_600_000 }, async () => {
  const now = () => Math.floor(Date.now() / 1000);
  const deployer = privateKeyToAccount(generatePrivateKey());
  const user = privateKeyToAccount(generatePrivateKey());
  await pub.request({ method: "anvil_setBalance" as any, params: [deployer.address, "0x56BC75E2D63100000"] as any });
  await pub.request({ method: "anvil_setBalance" as any, params: [user.address, `0x${parseEther("0.05").toString(16)}`] as any });
  const d = wallet(deployer);
  // The factory as it would be deployed on Arbitrum One: USDC cash, WETH, Chainlink feeds for every token.
  const tokens = [USDC, ...Object.values(ARBITRUM.tokens).map((t) => t.token)];
  const feeds = [{ feed: ARBITRUM.base.feed, maxAge: 86400 + 3600 }, ...Object.values(ARBITRUM.tokens).map((t) => ({ feed: t.feed, maxAge: t.maxAge }))];
  const factory = (await pub.waitForTransactionReceipt({ hash: await d.deployContract({ abi: factoryArt.abi as any, bytecode: factoryArt.bytecode as Hex, args: [deployer.address, USDC, WETH, tokens, feeds] }) })).contractAddress!;
  const adapter = (await pub.waitForTransactionReceipt({ hash: await d.deployContract({ abi: uniArt.abi as any, bytecode: uniArt.bytecode as Hex, args: [ARBITRUM.uniswap.router] }) })).contractAddress!;

  const db = openDb(":memory:");
  // Oracle prices for the trader's own guard: the pools' prices, so the guards pass on the fork.
  for (const [sym, token, dec] of [["ETH", WETH, 18], ["LINK", LINK, 18], ["BTC", BTC, 8]] as const) {
    const q = (await bestQuote(pub, USDC, token, 1_000_000_000n, ARBITRUM_DEX))!;
    const px = 1000 / (Number(q.amountOut) / 10 ** dec);
    db.prepare("INSERT INTO rounds (feed, round_id, symbol, answer, decimals, updated_at) VALUES (?, ?, ?, ?, 8, ?)").run(ARBITRUM.tokens[sym]!.feed, "1", sym, String(Math.round(px * 1e8)), now());
    console.log(`${sym}: $1000 buys at ${px.toFixed(4)} via ${q.via ? `WETH (${q.fee} then ${q.via.fee2})` : `one pool (${q.fee})`}`);
  }
  const ethPrice = Number(db.prepare("SELECT answer FROM rounds WHERE symbol = 'ETH'").get()!.answer as string) / 1e8;

  const trader = new LiveTrader(db, pub, { mnemonic: generateMnemonic(english), markets: MARKETS, slippageBps: 100, maxGapBps: 300, minOrderUsd: 1, epochSec: 3600 });
  trader.addVenue(arbitrumVenue({ pub, vaultAdapter: adapter, makeClient: (account) => createWalletClient({ account, chain, transport: http(RPC, { timeout: 240_000 }), pollingInterval: 250 }) }));
  const executor = trader.addressOf(VAULT_EXECUTOR_INDEX);
  await pub.request({ method: "anvil_setBalance" as any, params: [executor, `0x${parseEther("0.01").toString(16)}`] as any });

  // The user makes the vault and funds it with 0.006 ETH, in one transaction.
  const policy = { maxTradeUsd: 50n * 10n ** 8n, maxDailyUsd: 1000n * 10n ** 8n, maxTokenUsd: 0n, maxSlippageBps: 200 };
  const hash = await wallet(user).writeContract({ address: factory, abi: factoryArt.abi as any, functionName: "createVaultWith", args: [executor, policy, [WETH, LINK, BTC], [adapter], "0x0000000000000000000000000000000000000000", 0n], value: parseEther("0.006") });
  await pub.waitForTransactionReceipt({ hash });
  const vc = { base: USDC, baseSymbol: "USDC", baseDecimals: 6, weth: WETH };
  const v = await verifyVaultCreation(pub, db, { txHash: hash, owner: user.address, factory, adapter, executor, tokens: [LINK, BTC], maxDepositUsd: 100, ethPrice, chain: vc });
  assert.ok(v.deposit.usd > 5 && v.deposit.usd < 50, JSON.stringify(v.deposit));
  assert.equal(v.deposit.cashToken, "USDC");
  // The same vault is not a Robinhood Chain vault: its base token is USDC, not USDG.
  await assert.rejects(verifyVaultCreation(pub, openDb(":memory:"), { txHash: hash, owner: user.address, factory, adapter, executor, tokens: [LINK], maxDepositUsd: 100, ethPrice }), /base token is not USDG/);

  const s = strategy({ symbols: ["LINK", "BTC"], entry: [{ type: "now", description: "buy now" }], positionPct: 45, maxOpenPositions: 2 });
  const a = createAgent(db, { name: "arb run", prompt: null, strategy: s, policy: Policy.parse({ maxPositionPct: 100, maxOpenPositions: 2 }), owner: user.address, vault: v.vault, chain: "arbitrum" }, now());
  assert.equal(getAgent(db, a.id)!.chain, "arbitrum");

  // Funding: the WETH becomes USDC inside the vault, and the agent starts.
  const notes0 = await trader.watch(now);
  assert.ok(notes0.some((n) => /funded/.test(n)), notes0.join("; "));
  const funded = getAccount(db, a.id);
  assert.ok(funded.startEquity > 5, String(funded.startEquity));
  assert.equal(await bal(WETH, v.vault), 0n);

  // Buys LINK and BTC with USDC through the vault.
  queueOrder(db, { agentId: a.id, symbol: "LINK", action: "open", usdIn: funded.account.cash * 0.45, decisionLeaf: null }, now());
  queueOrder(db, { agentId: a.id, symbol: "BTC", action: "open", usdIn: funded.account.cash * 0.45, decisionLeaf: null }, now());
  const r1 = await trader.run(now);
  assert.equal(r1.failed.length, 0, JSON.stringify(r1.failed));
  const held = getAccount(db, a.id).account.positions;
  assert.equal(held.length, 2);
  assert.ok((await bal(LINK, v.vault)) > 0n && (await bal(BTC, v.vault)) > 0n);
  const fills = db.prepare("SELECT record_json FROM receipts WHERE agent_id = ? AND kind = 'fill'").all(a.id).map((r: any) => JSON.parse(r.record_json));
  assert.ok(fills.every((f) => f.swap.chainId === 42161 && f.swap.cash === "USDC"), JSON.stringify(fills.map((f) => f.swap)));
  const eq = await trader.markEquity(getAgent(db, a.id)!, now());
  assert.ok(eq > funded.startEquity * 0.97 && eq < funded.startEquity * 1.03, `${eq} vs ${funded.startEquity}`);

  // Stop: both are sold, then everything goes back to the user as ETH.
  const ethBefore = await pub.getBalance({ address: user.address });
  assert.ok(markEnded(db, getAgent(db, a.id)!, "stopped by its owner", eq, 3600, now()));
  queueCloses(db, a.id, now());
  const r2 = await trader.run(now);
  assert.equal(r2.failed.length, 0, JSON.stringify(r2.failed));
  assert.equal(getAccount(db, a.id).account.positions.length, 0);
  const notes = await trader.watch(now);
  assert.ok(notes.some((n) => /funds returned/.test(n)), notes.join("; "));
  const ethBack = Number((await pub.getBalance({ address: user.address })) - ethBefore) / 1e18;
  assert.ok(ethBack > 0.006 * 0.95, `got back ${ethBack} ETH of 0.006`);
  for (const t of [USDC, WETH, LINK, BTC]) assert.equal(await bal(t, v.vault), 0n);
  assert.equal(getAgent(db, a.id)!.stopState, "returned");
  console.log(`Arbitrum run: deposited 0.006 ETH, bought LINK and BTC, got back ${ethBack.toFixed(6)} ETH`);
});
