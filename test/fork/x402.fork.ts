/**
 * Our x402 signatures against the real USDG contract, on a local fork of Robinhood Chain mainnet:
 * the authorization our client signs for the image service is executed with transferWithAuthorization,
 * the USDG moves to the service's payment contract (MEDIA_PAY_TO), and the same authorization
 * cannot be used twice. Skipped when MEDIA_PAY_TO is not set.
 * Nothing touches the real chain.
 *
 *   npm run test:fork
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, parseAbi, parseSignature, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { choosePayment, decodeB64Json, signPayment, type PaymentRequired, type PayPolicy } from "../../src/pay/x402.ts";
import { USDG, USDG_DOMAIN } from "../../src/media/images.ts";

const RPC_SRC = process.env.FORK_RPC ?? process.env.RPC_URL ?? "https://robinhood.drpc.org";
const PORT = 22545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 4663, name: "rh-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const USDG_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

let node: ChildProcess | null = null;
let pub: PublicClient;
/** The service's payment contract on mainnet; it also holds the USDG this test borrows. */
const PAY_TO_ENV = process.env.MEDIA_PAY_TO;
const PAY_TO = getAddress(PAY_TO_ENV ?? "0x0000000000000000000000000000000000000001");
const hasAnvil = spawnSync("anvil", ["--version"], { shell: process.platform === "win32" }).status === 0;

before(async () => {
  if (!hasAnvil) return;
  node = spawn("anvil", ["--fork-url", RPC_SRC, "--port", String(PORT), "--silent", "--chain-id", "4663"], { shell: process.platform === "win32" });
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

const rpc = (method: string, params: unknown[]) => pub.request({ method: method as any, params: params as any });

test("an x402 authorization signed by our client moves real USDG to the image service, once", { skip: (!hasAnvil && "anvil not installed") || (!PAY_TO_ENV && "MEDIA_PAY_TO not set"), timeout: 600_000 }, async () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  const relayer = privateKeyToAccount(generatePrivateKey()); // stands in for the facilitator that submits it
  await rpc("anvil_setBalance", [relayer.address, "0x56BC75E2D63100000"]);

  // Give the payer 1 USDG from the Credits contract's balance (impersonated, on the fork only).
  await rpc("anvil_impersonateAccount", [PAY_TO]);
  await rpc("anvil_setBalance", [PAY_TO, "0x56BC75E2D63100000"]);
  const fund = await pub.request({ method: "eth_sendTransaction" as any, params: [{ from: PAY_TO, to: USDG, data: encodeFunctionData({ abi: USDG_ABI, functionName: "transfer", args: [payer.address, 1_000_000n] }) }] as any });
  assert.equal((await pub.waitForTransactionReceipt({ hash: fund as Hex })).status, "success");
  await rpc("anvil_stopImpersonatingAccount", [PAY_TO]);

  // What the service's 402 offered on 2026-11-24, signed exactly as the client does it.
  const block = await pub.getBlock();
  const now = Number(block.timestamp);
  const required: PaymentRequired = {
    x402Version: 2,
    resource: { url: `${process.env.MEDIA_API ?? "https://images.test/api/v1"}/outputs` },
    accepts: [{ scheme: "exact", network: "eip155:4663", amount: "735", asset: USDG, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: "Global Dollar", version: "1" } }],
  };
  const policy: PayPolicy = { network: "eip155:4663", chainId: 4663, asset: USDG, domain: USDG_DOMAIN, payTo: PAY_TO, maxPerCall: 10_000n, remaining: () => 1_000_000n };
  const { header } = await signPayment(payer, required, choosePayment(required, policy), policy, now);
  const p = decodeB64Json<any>(header);
  const a = p.payload.authorization;
  const { v, r, s } = parseSignature(p.payload.signature);
  const args = [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v), r, s] as const;

  const before = await pub.readContract({ address: USDG, abi: USDG_ABI, functionName: "balanceOf", args: [PAY_TO] });
  const w = createWalletClient({ account: relayer, chain, transport: http(RPC, { timeout: 240_000 }) });
  const tx = await w.writeContract({ address: USDG, abi: USDG_ABI, functionName: "transferWithAuthorization", args });
  assert.equal((await pub.waitForTransactionReceipt({ hash: tx })).status, "success");
  const afterBal = await pub.readContract({ address: USDG, abi: USDG_ABI, functionName: "balanceOf", args: [PAY_TO] });
  assert.equal(afterBal - before, 735n, "the service received exactly the price");
  assert.equal(await pub.readContract({ address: USDG, abi: USDG_ABI, functionName: "balanceOf", args: [payer.address] }), 1_000_000n - 735n);

  /** null when the call would succeed, else the start of the revert message. */
  const revertOf = async (callArgs: readonly unknown[]) => {
    try {
      await pub.call({ account: relayer.address, to: USDG, data: encodeFunctionData({ abi: USDG_ABI, functionName: "transferWithAuthorization", args: callArgs as any }) });
      return null;
    } catch (e) {
      return String((e as any).shortMessage ?? (e as Error).message).split("\n")[0];
    }
  };
  // The same authorization cannot pay twice. Observed on this USDG: the nonce is marked used, and a
  // second submission does not revert but moves nothing (so an eth_call of it "succeeds").
  const used = await pub.readContract({ address: USDG, abi: parseAbi(["function authorizationState(address, bytes32) view returns (bool)"]), functionName: "authorizationState", args: [a.from, a.nonce] });
  const balBefore = await pub.readContract({ address: USDG, abi: USDG_ABI, functionName: "balanceOf", args: [PAY_TO] });
  let replayStatus = "not sent";
  try {
    const h = await w.sendTransaction({ to: USDG, data: encodeFunctionData({ abi: USDG_ABI, functionName: "transferWithAuthorization", args }), gas: 300_000n });
    replayStatus = (await pub.waitForTransactionReceipt({ hash: h })).status;
  } catch (e) {
    replayStatus = `refused: ${String((e as any).shortMessage ?? (e as Error).message).split("\n")[0]}`;
  }
  const balAfter = await pub.readContract({ address: USDG, abi: USDG_ABI, functionName: "balanceOf", args: [PAY_TO] });
  assert.equal(used, true);
  assert.equal(balAfter - balBefore, 0n, `a used authorization must not move USDG again (second submission: ${replayStatus})`);
  // A changed amount (with a fresh nonce) no longer matches the signature.
  const tampered = await revertOf([a.from, a.to, 736n, args[3], args[4], ("0x" + "11".repeat(32)) as Hex, args[6], args[7], args[8]]);
  assert.notEqual(tampered, null, "a signature for 735 must not pay 736");
});
