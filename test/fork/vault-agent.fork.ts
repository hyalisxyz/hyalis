/**
 * A user's real-money agent end to end, on a local fork of Robinhood Chain mainnet: the user
 * makes and funds a vault with ETH in one transaction; the server checks it and creates the
 * agent; the trader turns the ETH into USDG inside the vault and starts it; it buys ETH through
 * the vault; then the run ends (the owner stops it, or its 2 minutes are up), the position is
 * sold, and everything goes back to the user's wallet. Nothing touches the real chain.
 *
 *   npm run test:fork
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, parseEther, type Hex, type PublicClient } from "viem";
import { english, generateMnemonic, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import factoryArt from "../../src/chain/AgentVaultFactory.json" with { type: "json" };
import uniArt from "../../src/chain/UniswapV3Adapter.json" with { type: "json" };
import { openDb } from "../../src/store/db.ts";
import { createAgent, getAccount, getAgent } from "../../src/engine/agents.ts";
import { markEnded } from "../../src/engine/end.ts";
import { Policy } from "../../src/guard/policy.ts";
import { LiveTrader, openOrders, queueCloses, queueOrder, VAULT_EXECUTOR_INDEX } from "../../src/live/live.ts";
import { verifyVaultCreation } from "../../src/live/vaults.ts";
import { bestQuote, UNISWAP, USDG, WETH } from "../../src/live/uniswap.ts";
import type { Market } from "../../src/config.ts";
import { strategy } from "../helpers.ts";

const RPC_SRC = process.env.FORK_RPC ?? process.env.RPC_URL ?? "https://robinhood.drpc.org";
const PORT = 25545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 4663, name: "rh-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const FEEDS: Record<string, Hex> = { [USDG]: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2", [WETH]: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9" };
const MARKETS: Market[] = [{ symbol: "ETH", assetClass: "crypto", source: "chainlink", feed: FEEDS[WETH]!, decimals: 8, heartbeatSec: 86400, deviationPct: 0.5, token: WETH, tokenDecimals: 18 }];

let node: ChildProcess | null = null;
let pub: PublicClient;
const hasAnvil = spawnSync("anvil", ["--version"], { shell: process.platform === "win32" }).status === 0;
const wallet = (a: ReturnType<typeof privateKeyToAccount>) => createWalletClient({ account: a, chain, transport: http(RPC, { timeout: 240_000 }), pollingInterval: 250 });

before(async () => {
  if (!hasAnvil) return;
  node = spawn("anvil", ["--fork-url", RPC_SRC, "--port", String(PORT), "--silent", "--chain-id", "4663", "--base-fee", "10000000", "--gas-price", "20000000"], { shell: process.platform === "win32" });
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

const bal = (token: Hex, who: Hex) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

test("a user's vault agent: made and funded in one transaction, trades, and the money comes back when the run ends", { skip: !hasAnvil && "anvil not installed", timeout: 900_000 }, async () => {
  const now = () => Math.floor(Date.now() / 1000);
  const deployer = privateKeyToAccount(generatePrivateKey());
  const user = privateKeyToAccount(generatePrivateKey());
  await pub.request({ method: "anvil_setBalance" as any, params: [deployer.address, "0x56BC75E2D63100000"] as any });
  await pub.request({ method: "anvil_setBalance" as any, params: [user.address, `0x${parseEther("0.05").toString(16)}`] as any });
  const d = wallet(deployer);
  const factory = (await pub.waitForTransactionReceipt({ hash: await d.deployContract({ abi: factoryArt.abi as any, bytecode: factoryArt.bytecode as Hex, args: [deployer.address, USDG, WETH, [USDG, WETH], [USDG, WETH].map((t) => ({ feed: FEEDS[t]!, maxAge: 4 * 86400 }))] }) })).contractAddress!;
  const adapter = (await pub.waitForTransactionReceipt({ hash: await d.deployContract({ abi: uniArt.abi as any, bytecode: uniArt.bytecode as Hex, args: [UNISWAP.router] }) })).contractAddress!;

  const db = openDb(":memory:");
  // Oracle price for ETH: the pool's own price, so the guards pass on the fork.
  const q = (await bestQuote(pub, USDG, WETH, 1_000_000n))!;
  db.prepare("INSERT INTO rounds (feed, round_id, symbol, answer, decimals, updated_at) VALUES (?, ?, 'ETH', ?, 8, ?)").run(FEEDS[WETH]!, "1", String(Math.round((1 / (Number(q.amountOut) / 1e18)) * 1e8)), now());
  const trader = new LiveTrader(
    db,
    pub,
    { mnemonic: generateMnemonic(english), markets: MARKETS, slippageBps: 100, maxGapBps: 300, minOrderUsd: 1, epochSec: 3600, vaultAdapter: adapter },
    (account) => createWalletClient({ account, chain, transport: http(RPC, { timeout: 240_000 }), pollingInterval: 250 }),
  );
  const executor = trader.addressOf(VAULT_EXECUTOR_INDEX);
  await pub.request({ method: "anvil_setBalance" as any, params: [executor, `0x${parseEther("0.01").toString(16)}`] as any });

  // The user makes the vault and funds it with 0.006 ETH, in one transaction.
  const makeVault = async () => {
    const policy = { maxTradeUsd: 50n * 10n ** 8n, maxDailyUsd: 1000n * 10n ** 8n, maxTokenUsd: 0n, maxSlippageBps: 200 };
    const hash = await wallet(user).writeContract({ address: factory, abi: factoryArt.abi as any, functionName: "createVaultWith", args: [executor, policy, [WETH], [adapter], "0x0000000000000000000000000000000000000000", 0n], value: parseEther("0.006") });
    await pub.waitForTransactionReceipt({ hash });
    return verifyVaultCreation(pub, db, { txHash: hash, owner: user.address, factory, adapter, executor, tokens: [WETH], maxDepositUsd: 100, ethPrice: 1 / (Number(q.amountOut) / 1e18) });
  };
  const v = await makeVault();
  assert.ok(v.deposit.usd > 5 && v.deposit.usd < 15, JSON.stringify(v.deposit));
  await assert.rejects(verifyVaultCreation(pub, db, { txHash: ("0x" + "00".repeat(32)) as Hex, owner: user.address, factory, adapter, executor, tokens: [WETH], maxDepositUsd: 100, ethPrice: 1 }), /not mined yet/);

  const s = strategy({ symbols: ["ETH"], entry: [{ type: "now", description: "buy now" }], positionPct: 95, maxOpenPositions: 1, endAfterMinutes: 2 });
  const a = createAgent(db, { name: "my eth run", prompt: null, strategy: s, policy: Policy.parse({ maxPositionPct: 100 }), owner: user.address, vault: v.vault }, now());
  assert.equal(a.status, "paused");

  // The trader funds it: the WETH becomes USDG inside the vault, and the agent starts.
  await trader.watch(now);
  const funded = getAccount(db, a.id);
  assert.ok(funded.startEquity > 5, String(funded.startEquity));
  assert.equal(getAgent(db, a.id)!.status, "active");
  assert.equal(await bal(WETH, v.vault), 0n);

  // A decision to buy (what the tick queues for "now"): the vault buys ETH.
  queueOrder(db, { agentId: a.id, symbol: "ETH", action: "open", usdIn: funded.account.cash * 0.95, decisionLeaf: ("0x" + "ab".repeat(32)) as string }, now());
  const r1 = await trader.run(now);
  assert.equal(r1.failed.length, 0, JSON.stringify(r1.failed));
  const held = getAccount(db, a.id).account.positions[0]!;
  assert.ok(Math.abs(held.qty - Number(await bal(WETH, v.vault)) / 1e18) < 1e-12);
  // The live mark at executable prices.
  const eq = await trader.markEquity(getAgent(db, a.id)!, now());
  assert.ok(eq > funded.startEquity * 0.98 && eq < funded.startEquity * 1.02, `${eq} vs ${funded.startEquity}`);

  // The owner presses Stop: the position is sold, then everything goes back to the user.
  const usdgBefore = await bal(USDG, user.address);
  const ethBefore = await pub.getBalance({ address: user.address });
  assert.ok(markEnded(db, getAgent(db, a.id)!, "stopped by its owner", eq, 3600, now()));
  queueCloses(db, a.id, now());
  assert.equal((await trader.run(now)).failed.length, 0);
  assert.equal(getAccount(db, a.id).account.positions.length, 0);
  const notes = await trader.watch(now);
  assert.ok(notes.some((n) => /funds returned/.test(n)), notes.join("; "));
  // Deposited as ETH, so it comes back as ETH (the cash was swapped back to WETH and unwrapped).
  const ethBack = Number((await pub.getBalance({ address: user.address })) - ethBefore) / 1e18;
  assert.ok(ethBack > 0.006 * 0.97, `got back ${ethBack} ETH of 0.006`);
  assert.equal(await bal(USDG, user.address), usdgBefore);
  assert.equal(await bal(USDG, v.vault), 0n);
  assert.equal(await bal(WETH, v.vault), 0n);
  assert.equal(getAgent(db, a.id)!.stopState, "returned");
  // The finished run keeps its final result (not an empty vault's 0), and the live view reports it.
  const fin = getAccount(db, a.id);
  assert.ok(fin.equity > funded.startEquity * 0.97 && fin.equity < funded.startEquity * 1.03, String(fin.equity));
  const { agentNow } = await import("../../src/engine/now.ts");
  const view = agentNow(db, getAgent(db, a.id)!, MARKETS, now());
  assert.ok(Math.abs(view.returnPct) < 3, String(view.returnPct));
  const kinds = db.prepare("SELECT kind FROM receipts WHERE agent_id = ? ORDER BY id").all(a.id).map((x: any) => x.kind);
  assert.deepEqual(kinds, ["funding", "fill", "end", "fill", "funding"]);
  console.log(`stopped run: deposited 0.006 ETH, got back ${ethBack.toFixed(6)} ETH`);

  // A second run that ends by time: 2 minutes after it started, the watch ends it and pays out.
  const v2 = await makeVault();
  const a2 = createAgent(db, { name: "two minutes", prompt: null, strategy: s, policy: Policy.parse({ maxPositionPct: 100 }), owner: user.address, vault: v2.vault }, now());
  await trader.watch(now);
  queueOrder(db, { agentId: a2.id, symbol: "ETH", action: "open", usdIn: getAccount(db, a2.id).account.cash * 0.95, decisionLeaf: null }, now());
  await trader.run(now);
  db.prepare("UPDATE agents SET created_at = created_at - 130 WHERE id = ?").run(a2.id);
  const n1 = await trader.watch(now);
  assert.ok(n1.some((n) => /ended: time/.test(n)), n1.join("; "));
  await trader.run(now);
  const n2 = await trader.watch(now);
  assert.ok(n2.some((n) => /funds returned/.test(n)), n2.join("; "));
  assert.equal(await bal(USDG, v2.vault), 0n);
  assert.equal(openOrders(db).length, 0);

  // A third run whose position cannot be sold (here: the oracle moved far from the pool, as when a
  // stock market is closed): after two failed sales the tokens themselves go back to the owner.
  const v3 = await makeVault();
  const a3 = createAgent(db, { name: "cannot sell", prompt: null, strategy: s, policy: Policy.parse({ maxPositionPct: 100 }), owner: user.address, vault: v3.vault }, now());
  await trader.watch(now);
  queueOrder(db, { agentId: a3.id, symbol: "ETH", action: "open", usdIn: getAccount(db, a3.id).account.cash * 0.95, decisionLeaf: null }, now());
  await trader.run(now);
  const held3 = await bal(WETH, v3.vault);
  assert.ok(held3 > 0n);
  db.prepare("UPDATE rounds SET answer = ? WHERE symbol = 'ETH'").run(String(10n ** 8n * 99_999n)); // oracle far above the pool: selling is refused
  assert.ok(markEnded(db, getAgent(db, a3.id)!, "stopped by its owner", 0, 3600, now()));
  queueCloses(db, a3.id, now());
  await trader.run(now); // first failed sale
  db.prepare("UPDATE live_orders SET updated_at = updated_at - 120 WHERE agent_id = ?").run(a3.id);
  await trader.watch(now); // queues the second try
  await trader.run(now); // second failed sale
  const wethOwnerBefore = await bal(WETH, user.address);
  const ethOwnerBefore = await pub.getBalance({ address: user.address });
  const n3 = await trader.watch(now);
  assert.ok(n3.some((n) => /returned the tokens as they are/.test(n)), n3.join("; "));
  assert.equal(await bal(WETH, v3.vault), 0n);
  // WETH comes back as ETH (unwrapped by the vault).
  assert.ok((await pub.getBalance({ address: user.address })) - ethOwnerBefore >= held3 - 1n || (await bal(WETH, user.address)) - wethOwnerBefore === held3);
  assert.equal(getAgent(db, a3.id)!.stopState, "returned");
});
