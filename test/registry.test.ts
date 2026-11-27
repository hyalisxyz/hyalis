import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { REGISTRY_ABI, REGISTRY_BYTECODE, Anchorer } from "../src/chain/anchor.ts";
import { buildTree, leafOf, proofFor, recordHash } from "../src/receipts/merkle.ts";
import { openDb } from "../src/store/db.ts";
import { addReceipt, closeEpochs, ZERO_ROOT } from "../src/engine/epochs.ts";

/**
 * Runs against a local anvil chain. Skipped when anvil (Foundry) is not installed.
 * Keys are anvil's public test accounts, never used anywhere real.
 */
const hasAnvil = spawnSync("anvil", ["--version"], { shell: process.platform === "win32" }).status === 0;
const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const EPOCH = 3600;
const anvilChain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });

let node: ChildProcess | null = null;
let pub: PublicClient;
const walletA = createWalletClient({ account: privateKeyToAccount(KEY_A), chain: anvilChain, transport: http(RPC) });
const walletB = createWalletClient({ account: privateKeyToAccount(KEY_B), chain: anvilChain, transport: http(RPC) });

async function deploy(): Promise<`0x${string}`> {
  const hash = await walletA.deployContract({ abi: REGISTRY_ABI, bytecode: REGISTRY_BYTECODE, args: [walletA.account.address, BigInt(EPOCH)] });
  const r = await pub.waitForTransactionReceipt({ hash });
  return r.contractAddress!;
}

const nowEpoch = async () => Math.floor(Number((await pub.getBlock()).timestamp) / EPOCH);

async function anchorTx(wallet: typeof walletA, registry: `0x${string}`, args: [bigint, Hex, Hex, number]) {
  const hash = await wallet.writeContract({ address: registry, abi: REGISTRY_ABI, functionName: "anchor", args });
  return pub.waitForTransactionReceipt({ hash });
}

/** Error name a call would revert with, or null when it would succeed. */
async function revertName(wallet: typeof walletA, registry: `0x${string}`, args: [bigint, Hex, Hex, number]): Promise<string | null> {
  try {
    await pub.simulateContract({ account: wallet.account, address: registry, abi: REGISTRY_ABI, functionName: "anchor", args });
    return null;
  } catch (e: any) {
    return e?.cause?.data?.errorName ?? e?.shortMessage ?? String(e);
  }
}

before(async () => {
  if (!hasAnvil) return;
  node = spawn("anvil", ["--port", String(PORT), "--silent"], { shell: process.platform === "win32" });
  pub = createPublicClient({ chain: anvilChain, transport: http(RPC) }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
});

after(() => {
  if (!node) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(node.pid), "/T", "/F"]);
  else node.kill();
});

const R = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Hex;

test("registry enforces publisher, ended epochs, order and the root chain", { skip: !hasAnvil && "anvil not installed" }, async () => {
  const reg = await deploy();
  const e = (await nowEpoch()) - 10;
  assert.equal(await revertName(walletA, reg, [BigInt(await nowEpoch()), R(1), ZERO_ROOT, 1]), "EpochNotEnded");
  assert.equal(await revertName(walletB, reg, [BigInt(e), R(1), ZERO_ROOT, 1]), "NotPublisher");
  assert.equal(await revertName(walletA, reg, [BigInt(e), R(1), R(9), 1]), "WrongPrevRoot");
  assert.equal(await revertName(walletA, reg, [BigInt(e), ZERO_ROOT, ZERO_ROOT, 1]), "EmptyRoot");
  assert.equal(await revertName(walletA, reg, [BigInt(e), R(1), ZERO_ROOT, 0]), "NoLeaves");

  assert.equal((await anchorTx(walletA, reg, [BigInt(e), R(1), ZERO_ROOT, 3])).status, "success");
  assert.equal(await revertName(walletA, reg, [BigInt(e), R(2), R(1), 1]), "EpochNotAfterLast"); // same epoch again
  assert.equal(await revertName(walletA, reg, [BigInt(e - 1), R(2), R(1), 1]), "EpochNotAfterLast"); // earlier epoch
  assert.equal(await revertName(walletA, reg, [BigInt(e + 2), R(2), ZERO_ROOT, 1]), "WrongPrevRoot"); // must link to R(1)
  assert.equal((await anchorTx(walletA, reg, [BigInt(e + 2), R(2), R(1), 1])).status, "success"); // gaps between epochs are fine

  const a = (await pub.readContract({ address: reg, abi: REGISTRY_ABI, functionName: "anchorOf", args: [BigInt(e)] })) as any;
  assert.equal(a.root, R(1));
  assert.equal(a.leafCount, 3);
  assert.equal(await pub.readContract({ address: reg, abi: REGISTRY_ABI, functionName: "lastRoot" }), R(2));
});

test("Solidity verifies the backend's Merkle proofs, and rejects forged ones", { skip: !hasAnvil && "anvil not installed" }, async () => {
  const reg = await deploy();
  let epoch = (await nowEpoch()) - 50;
  let prev = ZERO_ROOT;
  for (const n of [1, 2, 3, 7, 16, 33]) {
    const records = Array.from({ length: n }, (_, i) => ({ v: 1, i, note: `receipt ${i} of ${n}`, price: 100.25 + i }));
    const tree = buildTree(records.map(leafOf));
    await anchorTx(walletA, reg, [BigInt(epoch), tree.root, prev, tree.levels[0]!.length]);
    for (const rec of records) {
      const proof = proofFor(tree, leafOf(rec));
      const ok = await pub.readContract({ address: reg, abi: REGISTRY_ABI, functionName: "verifyRecord", args: [BigInt(epoch), recordHash(rec), proof] });
      assert.equal(ok, true, `n=${n} record ${rec.i}`);
    }
    const forged = { ...records[0]!, price: 1 };
    const bad = await pub.readContract({ address: reg, abi: REGISTRY_ABI, functionName: "verifyRecord", args: [BigInt(epoch), recordHash(forged), proofFor(tree, leafOf(records[0]))] });
    assert.equal(bad, false, `forged n=${n}`);
    const wrongEpoch = await pub.readContract({ address: reg, abi: REGISTRY_ABI, functionName: "verifyRecord", args: [BigInt(epoch + 1), recordHash(records[0]), proofFor(tree, leafOf(records[0]))] });
    assert.equal(wrongEpoch, false);
    prev = tree.root;
    epoch += 1;
  }
});

/** A database with receipts sealed into three past epochs. */
async function sealedDb() {
  const db = openDb(":memory:");
  const first = (await nowEpoch()) - 5;
  for (const e of [first, first + 1, first + 3]) {
    for (let i = 0; i < 4; i++) addReceipt(db, "agent-1", e, "snapshot", { equity: 10_000 + e + i }, e * EPOCH);
  }
  closeEpochs(db, first + 4, (first + 4) * EPOCH);
  return { db, first };
}

test("anchorer publishes sealed epochs in order and records the tx", { skip: !hasAnvil && "anvil not installed" }, async () => {
  const reg = await deploy();
  const { db, first } = await sealedDb();
  const a = new Anchorer({ db, publicClient: pub, walletClient: walletA as any, registry: reg, epochSec: EPOCH });
  await a.check();
  const r = await a.run();
  assert.equal(r.error, null);
  assert.deepEqual(r.anchored.map((x) => x.epoch), [first, first + 1, first + 3]);
  assert.equal(r.pending, 0);
  const rows = db.prepare("SELECT epoch, root, anchor_tx, anchor_block FROM epochs ORDER BY epoch").all() as any[];
  for (const row of rows) {
    assert.match(row.anchor_tx, /^0x[0-9a-f]{64}$/);
    const onchain = (await pub.readContract({ address: reg, abi: REGISTRY_ABI, functionName: "anchorOf", args: [BigInt(row.epoch)] })) as any;
    assert.equal(onchain.root, row.root);
  }
  assert.equal((await a.run()).anchored.length, 0); // nothing left to do
});

test("anchorer recovers after a crash between sending and saving", { skip: !hasAnvil && "anvil not installed" }, async () => {
  const reg = await deploy();
  const { db } = await sealedDb();
  const a = new Anchorer({ db, publicClient: pub, walletClient: walletA as any, registry: reg, epochSec: EPOCH });
  await a.run();
  // Forget the local record of the last anchor, as if the process died after the tx landed.
  db.exec("UPDATE epochs SET anchor_tx = NULL WHERE epoch = (SELECT MAX(epoch) FROM epochs)");
  const r = await new Anchorer({ db, publicClient: pub, walletClient: walletA as any, registry: reg, epochSec: EPOCH }).run();
  assert.equal(r.error, null);
  assert.deepEqual(r.anchored.map((x) => x.tx), ["already-on-chain"]);
});

test("anchorer stops on a conflict instead of sending", { skip: !hasAnvil && "anvil not installed" }, async () => {
  const reg = await deploy();
  const { db } = await sealedDb();
  const a = new Anchorer({ db, publicClient: pub, walletClient: walletA as any, registry: reg, epochSec: EPOCH });
  await a.run();
  // Local history rewritten after anchoring: the chain must win, and nothing more is sent.
  db.exec("UPDATE epochs SET anchor_tx = NULL, root = '0x" + "ab".repeat(32) + "' WHERE epoch = (SELECT MAX(epoch) FROM epochs)");
  const r = await a.run();
  assert.match(r.error!, /chain has root/);
  assert.equal(r.anchored.length, 0);
  assert.ok(a.halted);

  // Wrong key or wrong epoch length is caught before anything is sent.
  await assert.rejects(new Anchorer({ db, publicClient: pub, walletClient: walletB as any, registry: reg, epochSec: EPOCH }).check(), /publisher/);
  await assert.rejects(new Anchorer({ db, publicClient: pub, walletClient: walletA as any, registry: reg, epochSec: 60 }).check(), /epoch/);
});
