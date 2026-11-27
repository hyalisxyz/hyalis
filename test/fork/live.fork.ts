/**
 * Real-money trading against the real contracts, on a local fork of Robinhood Chain mainnet:
 * a live agent's wallet receives ETH, is funded (ETH wrapped and swapped to USDG on Uniswap V3),
 * buys and sells ETH and a stock token through the official SwapRouter02, and its account and
 * receipts follow what the swaps really did. Also: the oracle guard refuses a swap far from the
 * oracle price, and no router allowance is left behind. Nothing touches the real chain.
 *
 *   npm run test:fork
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, getAddress, http, parseEther, type PublicClient } from "viem";
import { english, generateMnemonic } from "viem/accounts";
import { openDb } from "../../src/store/db.ts";
import { createAgent, getAccount, getAgent, setStatus } from "../../src/engine/agents.ts";
import { Policy } from "../../src/guard/policy.ts";
import { LiveTrader, openOrders, queueOrder } from "../../src/live/live.ts";
import { bestQuote, UNISWAP, USDG, WETH } from "../../src/live/uniswap.ts";
import type { Market } from "../../src/config.ts";
import { strategy } from "../helpers.ts";

const RPC_SRC = process.env.FORK_RPC ?? process.env.RPC_URL ?? "https://robinhood.drpc.org";
const PORT = 23545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 4663, name: "rh-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const AAPL = getAddress("0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9");
const MARKETS: Market[] = [
  { symbol: "ETH", assetClass: "crypto", source: "chainlink", feed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9", decimals: 8, heartbeatSec: 86400, deviationPct: 0.5, token: WETH, tokenDecimals: 18 },
  { symbol: "AAPL", assetClass: "equity", source: "chainlink", feed: "0x00000000000000000000000000000000000000a1", decimals: 8, heartbeatSec: 86400, deviationPct: 0.5, token: AAPL, tokenDecimals: 18 },
];

let node: ChildProcess | null = null;
let pub: PublicClient;
const hasAnvil = spawnSync("anvil", ["--version"], { shell: process.platform === "win32" }).status === 0;

before(async () => {
  if (!hasAnvil) return;
  node = spawn("anvil", ["--fork-url", RPC_SRC, "--port", String(PORT), "--silent", "--chain-id", "4663", "--base-fee", "10000000", "--gas-price", "20000000"], { shell: process.platform === "win32" });
  pub = createPublicClient({ chain, transport: http(RPC, { timeout: 240_000 }), pollingInterval: 250 }) as PublicClient;
  for (let i = 0; i < 300; i++) {
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

test("a live agent is funded, buys and sells ETH and AAPL on Uniswap V3, and its books follow the chain", { skip: !hasAnvil && "anvil not installed", timeout: 900_000 }, async () => {
  const db = openDb(":memory:");
  const now = () => Math.floor(Date.now() / 1000);
  // Oracle prices: the pools' own mid prices here, so the oracle guard passes; one test below moves it.
  const setOracle = (symbol: string, feed: string, price: number) =>
    db.prepare("INSERT OR REPLACE INTO rounds (feed, round_id, symbol, answer, decimals, updated_at) VALUES (?, ?, ?, ?, 8, ?)").run(feed, String(now()), symbol, String(Math.round(price * 1e8)), now());
  const priceOf = async (token: `0x${string}`) => {
    const q = (await bestQuote(pub, USDG, token, 1_000_000n))!;
    return 1 / (Number(q.amountOut) / 1e18);
  };
  setOracle("ETH", MARKETS[0]!.feed, await priceOf(WETH));
  setOracle("AAPL", MARKETS[1]!.feed, await priceOf(AAPL));

  const trader = new LiveTrader(
    db,
    pub,
    { mnemonic: generateMnemonic(english), markets: MARKETS, slippageBps: 100, maxGapBps: 300, minOrderUsd: 1, epochSec: 3600 },
    (account) => createWalletClient({ account, chain, transport: http(RPC, { timeout: 240_000 }) }),
  );
  const agent = createAgent(db, { name: "eth real", prompt: null, strategy: strategy({ symbols: ["ETH", "AAPL"], positionPct: 50, maxOpenPositions: 2 }), policy: Policy.parse({}), owner: null, liveIndex: 0 }, now());
  assert.equal(agent.status, "paused"); // a live agent waits for its money
  assert.equal(getAccount(db, agent.id).startEquity, 0);
  const me = trader.addressOf(0);

  // Gas priced as on mainnet (about 0.02 gwei); anvil's default would eat the small gas reserve.
  // Funding: 0.006 ETH arrives; 0.0003 stays for gas, the rest becomes USDG.
  await pub.request({ method: "anvil_setBalance" as any, params: [me, `0x${parseEther("0.006").toString(16)}`] as any });
  const preview = await trader.fundFromEth(agent, now, { dryRun: true });
  assert.equal(preview.done, null);
  assert.equal(preview.plan.keepEth, "0.0003");
  const funded = await trader.fundFromEth(agent, now, { dryRun: false });
  assert.ok(funded.done!.cash > 1, `funded ${funded.done!.cash} USDG`);
  const acc0 = getAccount(db, agent.id);
  assert.equal(acc0.account.cash, funded.done!.cash);
  assert.equal(acc0.startEquity, funded.done!.cash);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE kind = 'funding'").get()!.n, 1);
  setStatus(db, agent.id, "active");
  const gasLeft = await pub.getBalance({ address: me });
  assert.ok(gasLeft > parseEther("0.00028"), `funding used ${0.0003 - Number(gasLeft) / 1e18} ETH of gas`);

  // Open ETH with half the cash: real WETH arrives, the account books what was really paid.
  const half = Math.floor((acc0.account.cash / 2) * 100) / 100;
  queueOrder(db, { agentId: agent.id, symbol: "ETH", action: "open", usdIn: half, decisionLeaf: null }, now());
  const r1 = await trader.run(now);
  assert.equal(r1.failed.length, 0, JSON.stringify(r1.failed));
  assert.equal(r1.filled.length, 1);
  const acc1 = getAccount(db, getAgent(db, agent.id)!.id);
  const pos = acc1.account.positions.find((p) => p.symbol === "ETH")!;
  const weth = await pub.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [me] });
  assert.ok(Math.abs(pos.qty - Number(weth) / 1e18) < 1e-12, "position is the WETH really held");
  assert.ok(Math.abs(acc1.account.cash - (acc0.account.cash - half)) < 0.000_01);
  assert.equal(await pub.readContract({ address: WETH, abi: erc20Abi, functionName: "allowance", args: [me, UNISWAP.router] }), 0n);

  // Open AAPL (a stock token) with $1.
  queueOrder(db, { agentId: agent.id, symbol: "AAPL", action: "open", usdIn: 1, decisionLeaf: null }, now());
  const r2 = await trader.run(now);
  assert.equal(r2.failed.length, 0, JSON.stringify(r2.failed));
  assert.ok(getAccount(db, agent.id).account.positions.find((p) => p.symbol === "AAPL")!.qty > 0);

  // Close both: positions gone, cash back, minus only pool fees and price impact.
  queueOrder(db, { agentId: agent.id, symbol: "ETH", action: "close", usdIn: null, decisionLeaf: null }, now());
  queueOrder(db, { agentId: agent.id, symbol: "AAPL", action: "close", usdIn: null, decisionLeaf: null }, now());
  const r3 = await trader.run(now);
  assert.equal(r3.failed.length, 0, JSON.stringify(r3.failed));
  const acc3 = getAccount(db, agent.id);
  assert.equal(acc3.account.positions.length, 0);
  const usdg = Number(await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [me] })) / 1e6;
  assert.ok(Math.abs(acc3.account.cash - usdg) < 0.000_01, `books ${acc3.account.cash} vs chain ${usdg}`);
  const lost = (acc0.account.cash - usdg) / acc0.account.cash;
  assert.ok(lost >= 0 && lost < 0.01, `round trips cost ${(lost * 100).toFixed(3)}%`);
  const fills = db.prepare("SELECT record_json FROM receipts WHERE kind = 'fill'").all().map((r: any) => JSON.parse(r.record_json));
  assert.equal(fills.length, 4);
  assert.ok(fills.every((f) => f.money === "real" && /^0x[0-9a-f]{64}$/.test(f.swap.tx) && f.swap.wallet === me));

  // The oracle guard: with the oracle at half the pool price, buying is refused before signing.
  setOracle("AAPL", MARKETS[1]!.feed, (await priceOf(AAPL)) / 2);
  queueOrder(db, { agentId: agent.id, symbol: "AAPL", action: "open", usdIn: 1, decisionLeaf: null }, now());
  const r4 = await trader.run(now);
  assert.match(r4.failed[0]!.error, /from the oracle/);
  assert.equal(openOrders(db).length, 0);
  console.log(`funded ${funded.done!.cash.toFixed(4)} USDG; after four swaps ${usdg.toFixed(4)} (${(lost * 100).toFixed(3)}% in fees and impact)`);
});

test("a swap a user makes on the Trade page is read from the chain and recorded: ETH in, a token, ETH out", { skip: !hasAnvil && "anvil not installed", timeout: 900_000 }, async () => {
  const { recordTrade, tradesOf } = await import("../../src/trade/trades.ts");
  const { encodeFunctionData, parseAbi } = await import("viem");
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const db = openDb(":memory:");
  const user = privateKeyToAccount(generatePrivateKey());
  await pub.request({ method: "anvil_setBalance" as any, params: [user.address, `0x${parseEther("0.01").toString(16)}`] as any });
  const w = createWalletClient({ account: user, chain, transport: http(RPC, { timeout: 240_000 }), pollingInterval: 250 });
  const router = parseAbi([
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)",
    "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
    "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])",
  ]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const go = async (data: `0x${string}`, value = 0n) => {
    const h = await w.sendTransaction({ to: UNISWAP.router, data, value });
    assert.equal((await pub.waitForTransactionReceipt({ hash: h })).status, "success");
    return h;
  };

  // 1. Sell 0.002 ETH for USDG (the router wraps the ETH sent along).
  const q1 = (await bestQuote(pub, WETH, USDG, parseEther("0.002")))!;
  const call1 = encodeFunctionData({ abi: router, functionName: "exactInputSingle", args: [{ tokenIn: WETH, tokenOut: USDG, fee: q1.fee, recipient: user.address, amountIn: parseEther("0.002"), amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
  const h1 = await go(encodeFunctionData({ abi: router, functionName: "multicall", args: [deadline, [call1]] }), parseEther("0.002"));
  const t1 = await recordTrade(db, pub, MARKETS, h1, 3600, Math.floor(Date.now() / 1000));
  assert.equal(t1.sellSymbol, "ETH");
  assert.equal(t1.sellAmount, "0.002");
  assert.equal(t1.buySymbol, "USDG");
  assert.ok(Number(t1.buyAmount) > 1);

  // 2. Sell 1 USDG for AAPL (approve exactly, then swap).
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: USDG, abi: erc20Abi, functionName: "approve", args: [UNISWAP.router, 1_000_000n] }) });
  const q2 = (await bestQuote(pub, USDG, AAPL, 1_000_000n))!;
  const call2 = encodeFunctionData({ abi: router, functionName: "exactInputSingle", args: [{ tokenIn: USDG, tokenOut: AAPL, fee: q2.fee, recipient: user.address, amountIn: 1_000_000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
  const t2 = await recordTrade(db, pub, MARKETS, await go(encodeFunctionData({ abi: router, functionName: "multicall", args: [deadline, [call2]] })), 3600, Math.floor(Date.now() / 1000));
  assert.deepEqual([t2.sellSymbol, t2.sellAmount, t2.buySymbol], ["USDG", "1", "AAPL"]);

  // 3. Sell all that AAPL for ETH: the router receives WETH and unwraps it to the user.
  const aapl = await pub.readContract({ address: AAPL, abi: erc20Abi, functionName: "balanceOf", args: [user.address] });
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: AAPL, abi: erc20Abi, functionName: "approve", args: [UNISWAP.router, aapl] }) });
  const q3 = await bestQuote(pub, AAPL, WETH, aapl);
  if (q3) {
    const swap3 = encodeFunctionData({ abi: router, functionName: "exactInputSingle", args: [{ tokenIn: AAPL, tokenOut: WETH, fee: q3.fee, recipient: "0x0000000000000000000000000000000000000002", amountIn: aapl, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
    const unwrap = encodeFunctionData({ abi: router, functionName: "unwrapWETH9", args: [0n, user.address] });
    const t3 = await recordTrade(db, pub, MARKETS, await go(encodeFunctionData({ abi: router, functionName: "multicall", args: [deadline, [swap3, unwrap]] })), 3600, Math.floor(Date.now() / 1000));
    assert.deepEqual([t3.sellSymbol, t3.buySymbol], ["AAPL", "ETH"]);
    assert.ok(Number(t3.buyAmount) > 0);
  }

  // Recorded once, sealed, and listed for the wallet; not a router transaction is refused.
  assert.equal((await recordTrade(db, pub, MARKETS, h1, 3600, Math.floor(Date.now() / 1000))).receipt, t1.receipt);
  assert.ok(tradesOf(db, user.address).length >= 2);
  const rec = JSON.parse((db.prepare("SELECT record_json FROM receipts WHERE id = ?").get(t1.receipt) as any).record_json);
  assert.equal(rec.kind, "trade");
  assert.equal(rec.agentId, `wallet:${user.address}`);
  const plain = await w.sendTransaction({ to: user.address, value: 1n });
  await pub.waitForTransactionReceipt({ hash: plain });
  await assert.rejects(recordTrade(db, pub, MARKETS, plain, 3600, Math.floor(Date.now() / 1000)), /not a swap through the Uniswap V3 router/);
});
