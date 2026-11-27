import type { DatabaseSync } from "node:sqlite";
import { getAddress, type Account, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";
import artifact from "./ReceiptRegistry.json" with { type: "json" };

export const REGISTRY_ABI = artifact.abi as typeof artifact.abi;
export const REGISTRY_BYTECODE = artifact.bytecode as Hex;

const ZERO = ("0x" + "00".repeat(32)) as Hex;

export interface AnchorReport {
  anchored: Array<{ epoch: number; tx: Hex | "already-on-chain"; block: number | null }>;
  pending: number;
  error: string | null;
}

/**
 * Publishes sealed epoch roots to the ReceiptRegistry contract, oldest first.
 *
 * Crash safety: the chain is the source of truth. Before sending, it reads the anchor for the
 * epoch on chain; if the same root is already there (a previous run sent it and stopped before
 * saving), it is recorded as done. If a different root is there, or the chain's last root does
 * not match the local prev_root, it stops and reports the conflict instead of sending.
 */
export class Anchorer {
  private readonly db: DatabaseSync;
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient<Transport, Chain, Account>;
  private readonly registry: `0x${string}`;
  private readonly epochSec: number;
  private readonly maxPerRun: number;
  /** Set when a conflict is found; anchoring stays stopped until an operator looks at it. */
  halted: string | null = null;

  constructor(o: {
    db: DatabaseSync;
    publicClient: PublicClient;
    walletClient: WalletClient<Transport, Chain, Account>;
    registry: `0x${string}`;
    epochSec: number;
    maxPerRun?: number;
  }) {
    this.db = o.db;
    this.pub = o.publicClient;
    this.wallet = o.walletClient;
    this.registry = getAddress(o.registry);
    this.epochSec = o.epochSec;
    this.maxPerRun = o.maxPerRun ?? 24;
  }

  private read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.pub.readContract({ address: this.registry, abi: REGISTRY_ABI, functionName: functionName as any, args: args as any }) as Promise<T>;
  }

  /** Checks the deployment matches this backend. Throws with a clear reason if not. */
  async check(): Promise<void> {
    const code = await this.pub.getCode({ address: this.registry });
    if (!code || code === "0x") throw new Error(`no contract at registry address ${this.registry}`);
    const [publisher, epochSeconds] = await Promise.all([this.read<string>("publisher"), this.read<bigint>("epochSeconds")]);
    if (getAddress(publisher) !== getAddress(this.wallet.account.address))
      throw new Error(`registry publisher is ${publisher}, but the anchor key is ${this.wallet.account.address}`);
    if (Number(epochSeconds) !== this.epochSec) throw new Error(`registry epoch is ${epochSeconds}s, backend EPOCH_SEC is ${this.epochSec}s`);
  }

  async run(): Promise<AnchorReport> {
    const report: AnchorReport = { anchored: [], pending: 0, error: this.halted };
    if (this.halted) return report;

    const todo = this.db
      .prepare("SELECT epoch, root, prev_root, leaf_count FROM epochs WHERE anchor_tx IS NULL ORDER BY epoch")
      .all() as Array<{ epoch: number; root: Hex; prev_root: Hex; leaf_count: number }>;
    report.pending = todo.length;

    for (const e of todo.slice(0, this.maxPerRun)) {
      const onchain = await this.read<{ root: Hex }>("anchorOf", [BigInt(e.epoch)]);
      if (onchain.root !== ZERO) {
        if (onchain.root.toLowerCase() !== e.root.toLowerCase()) return this.stop(report, `epoch ${e.epoch}: chain has root ${onchain.root}, local root is ${e.root}`);
        this.markDone(e.epoch, "already-on-chain", null);
        report.anchored.push({ epoch: e.epoch, tx: "already-on-chain", block: null });
        continue;
      }
      const lastRoot = await this.read<Hex>("lastRoot");
      if (lastRoot.toLowerCase() !== e.prev_root.toLowerCase())
        return this.stop(report, `epoch ${e.epoch}: chain's last root is ${lastRoot}, but this epoch links to ${e.prev_root}`);

      const { request } = await this.pub.simulateContract({
        account: this.wallet.account,
        address: this.registry,
        abi: REGISTRY_ABI,
        functionName: "anchor",
        args: [BigInt(e.epoch), e.root, e.prev_root, e.leaf_count],
      });
      const hash = await this.wallet.writeContract(request as any);
      const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") return this.stop(report, `epoch ${e.epoch}: anchor tx ${hash} reverted`);
      this.markDone(e.epoch, hash, Number(receipt.blockNumber));
      report.anchored.push({ epoch: e.epoch, tx: hash, block: Number(receipt.blockNumber) });
    }
    report.pending -= report.anchored.length;
    return report;
  }

  private markDone(epoch: number, tx: string, block: number | null) {
    this.db.prepare("UPDATE epochs SET anchor_tx = ?, anchor_block = ?, anchor_registry = ? WHERE epoch = ?").run(tx, block, this.registry, epoch);
  }

  private stop(report: AnchorReport, why: string): AnchorReport {
    this.halted = why;
    report.error = why;
    report.pending -= report.anchored.length;
    return report;
  }
}
