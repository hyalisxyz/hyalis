/**
 * The project token's tiers and burns against real Pons V2 tokens, on a local fork of Robinhood
 * Chain: one still on its bonding curve (bought from the curve, as a holder would on launch day)
 * and one that has graduated to Uniswap v4. Our token code reads only balances, decimals, symbol
 * and Transfer logs, so any Pons token stands in for ours before it exists. Nothing touches the
 * real chain.
 *
 *   npm run test:fork
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatUnits, getAddress, http, parseAbi, parseEther, parseUnits, type Address, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { openDb } from "../../src/store/db.ts";
import { claimBurn, DEFAULT_TIERS, entitlement, TokenReader, type TokenConfig } from "../../src/token/token.ts";

const RPC_SRC = process.env.FORK_RPC ?? process.env.RPC_URL ?? "https://robinhood.drpc.org";
const PORT = 26545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 4663, name: "rh-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });

// Pons V2 tokens on Robinhood Chain (found from the launch factory's logs, 2026-11-28).
const ON_CURVE = { token: getAddress("0xed80DEA65A9CDE2075aFA074FB5f67f4BB7921d9"), curve: getAddress("0xF880bf796f240C3537Dbc6ff67276280fec50c19") }; // FRUG
const GRADUATED = { token: getAddress("0xc5D6C1D90C8a87a07E2670b99b1556E818803228"), holder: getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951") }; // BELL, held by the v4 PoolManager
const DEAD = getAddress("0x000000000000000000000000000000000000dEaD");
const curveAbi = parseAbi(["function buy(uint256 ethIn, uint256 minTokensOut, address recipient) payable", "function sell(uint256 tokensIn, uint256 minEthOut, address recipient)"]);

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

const bal = (token: Address, who: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const fund = (who: Address, eth: string) => pub.request({ method: "anvil_setBalance" as any, params: [who, `0x${parseEther(eth).toString(16)}`] as any });
const cfgFor = (token: Address): TokenConfig => ({ address: token, tiers: DEFAULT_TIERS, burnTokensPerSlot: 500_000, burnSlotDays: 30 });
const send = async (a: ReturnType<typeof privateKeyToAccount>, token: Address, to: Address, amount: bigint) => {
  const hash = await wallet(a).writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success");
  return hash;
};

test("a Pons token on its bonding curve: bought from the curve, tiers follow the balance, transfers and burns count", { skip: !hasAnvil && "anvil not installed", timeout: 600_000 }, async () => {
  const now = () => Math.floor(Date.now() / 1000);
  const db = openDb(":memory:");
  const { token, curve } = ON_CURVE;
  assert.ok((await bal(token, curve)) > 0n, "the token is still on its curve at the fork block");
  const cfg = cfgFor(token);
  const reader = new TokenReader(pub, token, 0);
  const meta = (await reader.metadata())!;
  assert.equal(meta.decimals, 18);

  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());
  await fund(alice.address, "1");
  await fund(bob.address, "0.1");

  // Before buying: free tier.
  assert.equal((await entitlement(db, reader, cfg, alice.address, now())).tier.name, "Free");

  // Buy on the curve, as on launch day.
  const hash = await wallet(alice).writeContract({ address: curve, abi: curveAbi, functionName: "buy", args: [parseEther("0.05"), 0n, alice.address], value: parseEther("0.05") });
  assert.equal((await pub.waitForTransactionReceipt({ hash })).status, "success");
  const got = await bal(token, alice.address);
  const e1 = await entitlement(db, reader, cfg, alice.address, now());
  assert.equal(e1.balance, formatUnits(got, 18)); // exact, as a decimal string
  console.log(`curve buy: 0.05 ETH bought ${Number(e1.balance).toLocaleString("en-US")} ${meta.symbol}: tier ${e1.tier.name}, ${e1.agentSlots} agent slots`);
  assert.ok(Number(e1.balance) >= 5_000_000, "0.05 ETH early on the curve buys at least the top tier");
  assert.equal(e1.tier.name, "Whale");

  // Wallet to wallet during the curve: Bob gets exactly the Holder amount.
  await send(alice, token, bob.address, parseUnits("1000000", 18));
  const eb = await entitlement(db, reader, cfg, bob.address, now());
  assert.equal(eb.tier.name, "Holder");
  assert.equal(eb.nextTier?.name, "Whale");
  assert.equal(eb.nextTier?.needed, 4_000_000);

  // Burn for slots: 500k per slot, so 1.2M to the dead address is 2 slots.
  const before = (await entitlement(db, reader, cfg, alice.address, now())).agentSlots;
  const burn = await send(alice, token, DEAD, parseUnits("1200000", 18));
  const c1 = await claimBurn(db, pub, cfg, alice.address, burn);
  assert.ok(c1.ok && c1.slots === 2 && !c1.already, JSON.stringify(c1));
  assert.equal((await entitlement(db, reader, cfg, alice.address, now())).agentSlots, before + 2);
  // Claimed twice: counted once. By someone else: refused.
  const c2 = await claimBurn(db, pub, cfg, alice.address, burn);
  assert.ok(c2.ok && c2.already);
  assert.deepEqual(await claimBurn(db, pub, cfg, bob.address, burn), { ok: false, reason: "this burn was already claimed by another wallet" });
  // A plain transfer is not a burn; too small a burn earns nothing.
  const plain = await send(alice, token, bob.address, parseUnits("10", 18));
  assert.equal((await claimBurn(db, pub, cfg, alice.address, plain)).ok, false);
  const small = await send(bob, token, DEAD, parseUnits("100000", 18));
  const c3 = await claimBurn(db, pub, cfg, bob.address, small);
  assert.ok(!c3.ok && /need at least 500000/.test(c3.reason), JSON.stringify(c3));

  // Selling back to the curve lowers the tier the next time it is read.
  const all = await bal(token, bob.address);
  await (async () => {
    // Selling to the curve needs an allowance first (standard ERC-20).
    const ap = await wallet(bob).writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [curve, all] });
    await pub.waitForTransactionReceipt({ hash: ap });
    const h = await wallet(bob).writeContract({ address: curve, abi: curveAbi, functionName: "sell", args: [all, 0n, bob.address] });
    assert.equal((await pub.waitForTransactionReceipt({ hash: h })).status, "success");
  })();
  assert.equal((await entitlement(db, reader, cfg, bob.address, now())).tier.name, "Free");
  console.log(`burn: 1.2M burned = +${c1.ok ? c1.slots : 0} slots; Bob sold all back to the curve and is Free again`);
});

test("a graduated Pons token (Uniswap v4): balances, tiers and burns read the same", { skip: !hasAnvil && "anvil not installed", timeout: 600_000 }, async () => {
  const now = () => Math.floor(Date.now() / 1000);
  const db = openDb(":memory:");
  const { token, holder } = GRADUATED;
  const cfg = cfgFor(token);
  const reader = new TokenReader(pub, token, 0);
  const carol = privateKeyToAccount(generatePrivateKey());
  await fund(carol.address, "0.1");
  // Tokens for Carol from the pool's balance (a stand-in for buying on Uniswap).
  await pub.request({ method: "anvil_impersonateAccount" as any, params: [holder] as any });
  await fund(holder, "1");
  const w = createWalletClient({ account: holder, chain, transport: http(RPC, { timeout: 240_000 }), pollingInterval: 250 });
  const h = await w.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [carol.address, parseUnits("6000000", 18)], account: holder, chain });
  await pub.waitForTransactionReceipt({ hash: h });
  await pub.request({ method: "anvil_stopImpersonatingAccount" as any, params: [holder] as any });

  const e = await entitlement(db, reader, cfg, carol.address, now());
  assert.equal(e.tier.name, "Whale");
  assert.equal(Number(e.balance), 6_000_000);
  const burn = await send(carol, token, DEAD, parseUnits("1500000", 18));
  const c = await claimBurn(db, pub, cfg, carol.address, burn);
  assert.ok(c.ok && c.slots === 3, JSON.stringify(c));
  const after = await entitlement(db, reader, cfg, carol.address, now());
  assert.equal(after.tier.name, "Holder"); // 4.5M left
  assert.equal(after.agentSlots, after.tier.agents + 3);
  console.log(`graduated ${(await reader.metadata())!.symbol}: 6M = Whale; burned 1.5M = +3 slots; 4.5M left = Holder with ${after.agentSlots} slots`);
});
