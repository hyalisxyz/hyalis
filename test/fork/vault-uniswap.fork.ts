/**
 * AgentVault with the Uniswap V3 adapter, on a local fork of Robinhood Chain mainnet: real
 * Chainlink feeds, real WETH, USDG and AAPL, the official SwapRouter02. The owner's vault is
 * traded by the executor (the agent's key) through one pool and through two, inside the limits
 * the contract enforces; strangers and bad routes are refused; the owner withdraws everything.
 * Nothing touches the real chain.
 *
 *   npm run test:fork
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, encodeFunctionData, erc20Abi, http, parseEther, parseEventLogs, toFunctionSelector, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import factoryArt from "../../src/chain/AgentVaultFactory.json" with { type: "json" };
import vaultArt from "../../src/chain/AgentVault.json" with { type: "json" };
import uniArt from "../../src/chain/UniswapV3Adapter.json" with { type: "json" };
import { bestQuote, UNISWAP, USDG, WETH } from "../../src/live/uniswap.ts";

const RPC_SRC = process.env.FORK_RPC ?? process.env.RPC_URL ?? "https://robinhood.drpc.org";
const PORT = 24545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 4663, name: "rh-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
// Fresh keys, funded on the fork only. Anvil's well-known test keys are not used: on Robinhood
// Chain mainnet the first of them carries an EIP-7702 delegation that forwards any ETH it receives.
const OWNER = privateKeyToAccount(generatePrivateKey());
const EXECUTOR = privateKeyToAccount(generatePrivateKey());
const STRANGER = privateKeyToAccount(generatePrivateKey());
const AAPL = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" as Hex;
const FEEDS: Record<string, Hex> = { [USDG]: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2", [WETH]: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9", [AAPL]: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0" };
const WETH_ABI = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }, ...erc20Abi] as const;

let node: ChildProcess | null = null;
let pub: PublicClient;
const hasAnvil = spawnSync("anvil", ["--version"], { shell: process.platform === "win32" }).status === 0;
const wallet = (a: typeof OWNER) => createWalletClient({ account: a, chain, transport: http(RPC, { timeout: 240_000 }), pollingInterval: 250 });

before(async () => {
  if (!hasAnvil) return;
  node = spawn("anvil", ["--fork-url", RPC_SRC, "--port", String(PORT), "--silent", "--chain-id", "4663"], { shell: process.platform === "win32" });
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

const mined = async (h: Promise<Hex>) => {
  const r = await pub.waitForTransactionReceipt({ hash: await h });
  assert.equal(r.status, "success");
  return r;
};
async function reverts(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e: any) {
    return e?.cause?.data?.errorName ?? e?.cause?.reason ?? e?.shortMessage ?? String(e);
  }
}
const bal = (token: Hex, who: Hex) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const one = (fee: number) => encodeAbiParameters([{ type: "uint24" }], [fee]);
const two = (f1: number, mid: Hex, f2: number) => encodeAbiParameters([{ type: "uint24" }, { type: "address" }, { type: "uint24" }], [f1, mid, f2]);

test("AgentVault + Uniswap V3 adapter on a Robinhood Chain fork: swaps inside the limits, owner keeps control", { skip: !hasAnvil && "anvil not installed", timeout: 600_000 }, async () => {
  for (const a of [OWNER, EXECUTOR, STRANGER]) await pub.request({ method: "anvil_setBalance" as any, params: [a.address, "0x56BC75E2D63100000"] as any });
  const o = wallet(OWNER);
  const x = wallet(EXECUTOR);
  const s = wallet(STRANGER);
  const maxAge = 4 * 86400;

  const f = await mined(o.deployContract({ abi: factoryArt.abi as any, bytecode: factoryArt.bytecode as Hex, args: [OWNER.address, USDG, WETH, [USDG, WETH, AAPL], [USDG, WETH, AAPL].map((t) => ({ feed: FEEDS[t]!, maxAge }))] }));
  const factory = f.contractAddress!;
  const ad = await mined(o.deployContract({ abi: uniArt.abi as any, bytecode: uniArt.bytecode as Hex, args: [UNISWAP.router] }));
  const adapter = ad.contractAddress!;
  // A small beta vault: $25 a trade, $60 a day, 2% below the oracle at worst.
  const policy = { maxTradeUsd: 25n * 10n ** 8n, maxDailyUsd: 60n * 10n ** 8n, maxTokenUsd: 0n, maxSlippageBps: 200 };
  // One transaction: the vault with its tokens and venue allowed, funded with 0.012 ETH (about $20), arriving as WETH.
  const c = await mined(o.writeContract({ address: factory, abi: factoryArt.abi as any, functionName: "createVaultWith", args: [EXECUTOR.address, policy, [WETH, AAPL], [adapter], "0x0000000000000000000000000000000000000000", 0n], value: parseEther("0.012") }));
  const vault = (parseEventLogs({ abi: factoryArt.abi as any, logs: c.logs, eventName: "VaultCreated" })[0] as any).args.vault as Hex;
  const V = { address: vault, abi: vaultArt.abi as any };
  assert.equal(await pub.readContract({ ...V, functionName: "tokenAllowed", args: [AAPL] }), true);
  assert.equal(await pub.readContract({ ...V, functionName: "adapterAllowed", args: [adapter] }), true);
  assert.equal(await pub.readContract({ ...V, functionName: "owner" }), OWNER.address);

  assert.equal(await bal(WETH, vault), parseEther("0.012"));

  const swap = (who: typeof x, tin: Hex, tout: Hex, amt: bigint, data: Hex, min = 0n) =>
    who.writeContract({ ...V, functionName: "swap", args: [adapter, tin, tout, amt, min, data, ("0x" + "ab".repeat(32)) as Hex] });

  // 1. One pool: half the WETH to USDG, at the best fee tier.
  const halfEth = parseEther("0.006");
  const q1 = (await bestQuote(pub, WETH, USDG, halfEth))!;
  const r1 = await mined(swap(x, WETH, USDG, halfEth, one(q1.fee)));
  const ev = parseEventLogs({ abi: vaultArt.abi as any, logs: r1.logs, eventName: "Swapped" })[0] as any;
  assert.equal(ev.args.amountIn, halfEth);
  assert.ok((await bal(USDG, vault)) >= (q1.amountOut * 99n) / 100n);

  // 2. Two pools: the rest of the WETH to AAPL, through USDG.
  const qa = (await bestQuote(pub, WETH, USDG, halfEth))!;
  const qb = (await bestQuote(pub, USDG, AAPL, qa.amountOut))!;
  await mined(swap(x, WETH, AAPL, halfEth, two(qa.fee, USDG, qb.fee)));
  assert.ok((await bal(AAPL, vault)) > 0n);
  assert.equal(await bal(WETH, vault), 0n);

  // Nothing is left in the adapter, and it holds no allowance from the vault.
  for (const t of [WETH, USDG, AAPL]) assert.equal(await bal(t, adapter), 0n);
  assert.equal(await pub.readContract({ address: WETH, abi: erc20Abi, functionName: "allowance", args: [vault, adapter] }), 0n);

  // Refused: a stranger, a route that does not say its fee, a trade over the limit, a min above the pool.
  assert.equal(await reverts(() => pub.simulateContract({ account: STRANGER.address, ...V, functionName: "swap", args: [adapter, USDG, WETH, 1_000_000n, 0n, one(500), ("0x" + "00".repeat(32)) as Hex] })), "NotExecutor");
  // The adapter's own error reaches the caller by its selector (the vault's ABI does not name it).
  assert.match((await reverts(() => pub.simulateContract({ account: EXECUTOR.address, ...V, functionName: "swap", args: [adapter, USDG, WETH, 1_000_000n, 0n, "0x", ("0x" + "00".repeat(32)) as Hex] }))) ?? "", new RegExp(`BadRoute|${toFunctionSelector("BadRoute()")}`));
  const usdg = await bal(USDG, vault);
  await mined(o.writeContract({ ...V, functionName: "setPolicy", args: [{ ...policy, maxTradeUsd: 1n * 10n ** 8n, maxDailyUsd: 60n * 10n ** 8n }] }));
  assert.equal(await reverts(() => pub.simulateContract({ account: EXECUTOR.address, ...V, functionName: "swap", args: [adapter, USDG, WETH, usdg, 0n, one(100), ("0x" + "00".repeat(32)) as Hex] })), "TradeTooLarge");
  await mined(o.writeContract({ ...V, functionName: "setPolicy", args: [policy] }));
  assert.ok(await reverts(() => pub.simulateContract({ account: EXECUTOR.address, ...V, functionName: "swap", args: [adapter, USDG, WETH, 1_000_000n, 10n ** 18n, one(100), ("0x" + "00".repeat(32)) as Hex] })));

  // Stop from the app: the executor hands everything back, only ever to the owner, WETH as ETH.
  await mined(o.writeContract({ address: WETH, abi: WETH_ABI, functionName: "deposit", value: parseEther("0.001") }));
  await mined(o.writeContract({ address: WETH, abi: WETH_ABI, functionName: "transfer", args: [vault, parseEther("0.001")] }));
  const ethBefore = await pub.getBalance({ address: OWNER.address });
  const usdgOwnerBefore = await bal(USDG, OWNER.address);
  const usdgInVault = await bal(USDG, vault);
  await mined(x.writeContract({ ...V, functionName: "returnToOwner", args: [[USDG, WETH]] }));
  assert.equal(await bal(USDG, vault), 0n);
  assert.equal(await bal(WETH, vault), 0n);
  assert.equal((await bal(USDG, OWNER.address)) - usdgOwnerBefore, usdgInVault);
  assert.equal((await pub.getBalance({ address: OWNER.address })) - ethBefore, parseEther("0.001"));
  assert.equal(await reverts(() => pub.simulateContract({ account: STRANGER.address, ...V, functionName: "returnToOwner", args: [[AAPL]] })), "NotOwnerOrExecutor");
  // Nobody can send ETH in directly.
  assert.ok(await reverts(() => pub.call({ account: STRANGER.address, to: vault, value: 1n })));

  // The owner revokes the agent, then takes everything out; the executor can do nothing after.
  await mined(o.writeContract({ ...V, functionName: "setExecutor", args: ["0x0000000000000000000000000000000000000000"] }));
  assert.equal(await reverts(() => pub.simulateContract({ account: EXECUTOR.address, ...V, functionName: "swap", args: [adapter, USDG, WETH, 1_000_000n, 0n, one(100), ("0x" + "00".repeat(32)) as Hex] })), "NotExecutor");
  for (const t of [USDG, AAPL]) {
    const b = await bal(t, vault);
    if (b > 0n) await mined(o.writeContract({ ...V, functionName: "withdraw", args: [t, b, OWNER.address] }));
    assert.equal(await bal(t, vault), 0n);
  }
  assert.equal(await reverts(() => pub.simulateContract({ account: STRANGER.address, ...V, functionName: "withdraw", args: [USDG, 1n, STRANGER.address] })), "NotOwner");
  void s;
});

test("a vault owned by a wallet that refuses ETH still gets everything back, as WETH", { skip: !hasAnvil && "anvil not installed", timeout: 600_000 }, async () => {
  const rejectArt = (await import("../fixtures/RejectEth.json", { with: { type: "json" } })).default as any;
  const deployer = privateKeyToAccount(generatePrivateKey());
  const exec = privateKeyToAccount(generatePrivateKey());
  for (const a of [deployer, exec]) await pub.request({ method: "anvil_setBalance" as any, params: [a.address, "0x56BC75E2D63100000"] as any });
  const d = wallet(deployer);
  const x = wallet(exec);
  const f = await mined(d.deployContract({ abi: factoryArt.abi as any, bytecode: factoryArt.bytecode as Hex, args: [deployer.address, USDG, WETH, [USDG, WETH], [USDG, WETH].map((t) => ({ feed: FEEDS[t]!, maxAge: 4 * 86400 }))] }));
  const owner = (await mined(d.deployContract({ abi: rejectArt.abi, bytecode: rejectArt.bytecode as Hex }))).contractAddress!;
  // The smart wallet creates its vault through the factory (it is the vault's owner).
  const policy = { maxTradeUsd: 25n * 10n ** 8n, maxDailyUsd: 60n * 10n ** 8n, maxTokenUsd: 0n, maxSlippageBps: 200 };
  const create = encodeFunctionData({ abi: factoryArt.abi as any, functionName: "createVaultWith", args: [exec.address, policy, [WETH], [], "0x0000000000000000000000000000000000000000", 0n] });
  const r = await mined(d.writeContract({ address: owner, abi: rejectArt.abi, functionName: "call", args: [f.contractAddress!, create] }));
  const vault = (parseEventLogs({ abi: factoryArt.abi as any, logs: r.logs, eventName: "VaultCreated" })[0] as any).args.vault as Hex;
  assert.equal(String(await pub.readContract({ address: vault, abi: vaultArt.abi as any, functionName: "owner" })).toLowerCase(), owner.toLowerCase());
  await mined(d.writeContract({ address: WETH, abi: WETH_ABI, functionName: "deposit", value: parseEther("0.002") }));
  await mined(d.writeContract({ address: WETH, abi: WETH_ABI, functionName: "transfer", args: [vault, parseEther("0.002")] }));
  await mined(x.writeContract({ address: vault, abi: vaultArt.abi as any, functionName: "returnToOwner", args: [[WETH]] }));
  assert.equal(await bal(WETH, vault), 0n);
  assert.equal(await bal(WETH, owner), parseEther("0.002"));
});
