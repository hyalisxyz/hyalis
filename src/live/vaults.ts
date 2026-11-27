import type { DatabaseSync } from "node:sqlite";
import { formatUnits, getAddress, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import factoryArt from "../chain/AgentVaultFactory.json" with { type: "json" };
import vaultArt from "../chain/AgentVault.json" with { type: "json" };
import { balanceOf, USDG, WETH } from "./uniswap.ts";

/** A chain's cash token and WETH, as a vault there must hold them. Robinhood Chain when not given. */
export interface VaultChain {
  base: Address;
  baseSymbol: string;
  baseDecimals: number;
  weth: Address;
}
export const ROBINHOOD_VAULTS: VaultChain = { base: USDG, baseSymbol: "USDG", baseDecimals: 6, weth: WETH };

/**
 * Reads a vault a user just made from the chain and checks it before an agent may trade it:
 * the transaction succeeded and made it through our factory, the signed-in wallet owns it, our
 * executor is its executor, it allows our Uniswap adapter and every token the strategy trades,
 * its slippage allowance is sane, it is not already in use, and it holds no more than the beta
 * limit. Nothing here can move the user's funds; it only reads.
 */

export class VaultCheckError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "VaultCheckError";
    this.status = status;
  }
}

type VaultCheck = { owner: Address; factory: Address; adapter: Address; executor: Address; tokens: Address[]; maxDepositUsd: number; ethPrice: number | null; chain?: VaultChain };

export async function verifyVaultCreation(pub: PublicClient, db: DatabaseSync, o: VaultCheck & { txHash: Hex }) {
  const r = await pub.getTransactionReceipt({ hash: o.txHash }).catch(() => null);
  if (!r) throw new VaultCheckError("the vault transaction is not mined yet; try again in a few seconds", 404);
  if (r.status !== "success") throw new VaultCheckError("the vault transaction failed on chain");
  const created = parseEventLogs({ abi: factoryArt.abi as any, logs: r.logs.filter((l) => getAddress(l.address) === getAddress(o.factory)), eventName: "VaultCreated" })[0] as any;
  if (!created) throw new VaultCheckError("this transaction did not make a vault through the Hyalis factory");
  if (getAddress(created.args.owner) !== getAddress(o.owner)) throw new VaultCheckError("this vault belongs to another wallet");
  return checkVault(pub, db, getAddress(created.args.vault), o, r.blockNumber);
}

/** A vault named by its address: it must be one our factory made for this owner. */
export async function verifyVaultAddress(pub: PublicClient, db: DatabaseSync, o: VaultCheck & { vault: Address }) {
  const mine = (await pub.readContract({ address: o.factory, abi: factoryArt.abi as any, functionName: "vaultsOf", args: [o.owner] })) as string[];
  if (!mine.some((v) => getAddress(v) === getAddress(o.vault))) throw new VaultCheckError("this vault was not made by the Hyalis factory for your wallet");
  return checkVault(pub, db, getAddress(o.vault), o, undefined);
}

/** The vaults our factory made for an owner, what each holds, and which agent (if any) trades it. */
export async function vaultsOf(pub: PublicClient, db: DatabaseSync, factory: Address, owner: Address, c: VaultChain = ROBINHOOD_VAULTS) {
  const list = (await pub.readContract({ address: factory, abi: factoryArt.abi as any, functionName: "vaultsOf", args: [owner] })) as string[];
  const out = [];
  for (const v of list) {
    const vault = getAddress(v);
    const [cash, weth] = await Promise.all([balanceOf(pub, c.base, vault), balanceOf(pub, c.weth, vault)]);
    const agent = db.prepare("SELECT id FROM agents WHERE vault = ?").get(vault) as { id: string } | undefined;
    // "usdg" kept for pages that read it; "cash" and "cashToken" name the chain's own cash token.
    out.push({ vault, cash: formatUnits(cash, c.baseDecimals), cashToken: c.baseSymbol, usdg: formatUnits(cash, c.baseDecimals), weth: formatUnits(weth, 18), agentId: agent?.id ?? null });
  }
  return out;
}

async function checkVault(pub: PublicClient, db: DatabaseSync, vault: Address, o: VaultCheck, blockNumber: bigint | undefined) {
  const c = o.chain ?? ROBINHOOD_VAULTS;
  if (db.prepare("SELECT 1 FROM agents WHERE vault = ?").get(vault)) throw new VaultCheckError("this vault already has an agent");
  const V = { address: vault, abi: vaultArt.abi as any };
  const read = (functionName: string, args: unknown[] = []) => pub.readContract({ ...V, functionName, args, ...(blockNumber !== undefined ? { blockNumber } : {}) });
  const [owner, executor, base, adapterOk, policy] = await Promise.all([read("owner"), read("executor"), read("baseToken"), read("adapterAllowed", [o.adapter]), read("policy")]);
  if (getAddress(owner as string) !== getAddress(o.owner)) throw new VaultCheckError("the vault's owner is not your wallet");
  if (getAddress(executor as string) !== getAddress(o.executor)) throw new VaultCheckError("the vault does not name the Hyalis agent as its executor");
  if (getAddress(base as string) !== getAddress(c.base)) throw new VaultCheckError(`the vault's base token is not ${c.baseSymbol}`);
  if (!adapterOk) throw new VaultCheckError("the vault does not allow the Uniswap adapter");
  for (const t of o.tokens) if (!(await read("tokenAllowed", [t]))) throw new VaultCheckError(`the vault does not allow ${t}`);
  const slippage = Number((policy as any)[3] ?? (policy as any).maxSlippageBps);
  if (!(slippage > 0 && slippage <= 300)) throw new VaultCheckError("the vault's slippage allowance must be between 0.01% and 3%");

  const [cash, weth] = await Promise.all([balanceOf(pub, c.base, vault), balanceOf(pub, c.weth, vault)]);
  const usd = Number(formatUnits(cash, c.baseDecimals)) + (o.ethPrice ? Number(formatUnits(weth, 18)) * o.ethPrice : 0);
  if (usd < 1) throw new VaultCheckError("the vault holds less than $1; deposit with the vault, then start the agent");
  if (usd > o.maxDepositUsd * 1.05) throw new VaultCheckError(`during the beta a vault may hold at most $${o.maxDepositUsd}; withdraw the rest from your vault and try again`);
  return { vault, deposit: { cash: formatUnits(cash, c.baseDecimals), cashToken: c.baseSymbol, usdg: formatUnits(cash, c.baseDecimals), weth: formatUnits(weth, 18), usd: Math.round(usd * 100) / 100 } };
}
