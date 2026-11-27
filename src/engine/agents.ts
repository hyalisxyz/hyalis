import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { recordHash } from "../receipts/merkle.ts";
import { Strategy } from "../strategy/schema.ts";
import { Policy } from "../guard/policy.ts";
import type { Account } from "../paper/broker.ts";
import type { ChainKey } from "../chains.ts";

export const START_EQUITY = 10_000;

export interface AgentRow {
  id: string;
  name: string;
  prompt: string | null;
  strategy: Strategy;
  strategyHash: `0x${string}`;
  policy: Policy;
  status: "active" | "paused";
  /** Why it is paused: "owner" (by its owner or the admin), "over_quota" (more agents than slots), or "ended" (its run ended). */
  pauseReason: "owner" | "over_quota" | "ended" | null;
  /** Wallet that owns the agent; null for house agents created with the admin token. */
  owner: string | null;
  /** The agent whose sealed lessons this one was built from. */
  basedOn: string | null;
  /** Real-money agents: the index of its wallet under LIVE_MNEMONIC. Null for paper agents. */
  liveIndex: number | null;
  /** A user's real-money agent: its AgentVault (owned by the user). Null otherwise. */
  vault: string | null;
  /** The chain a real-money agent trades on; "robinhood" for paper agents too. */
  chain: ChainKey;
  /** For a vault agent after its run ended: "closing", "returning", then "returned". */
  stopState: "closing" | "returning" | "returned" | null;
  /** When its run ended, and why. */
  endedAt: number | null;
  endedReason: string | null;
  createdAt: number;
}

export interface AccountRow {
  account: Account;
  startEquity: number;
  day: number;
  dayStartEquity: number;
  equity: number;
}

const toAgent = (r: any): AgentRow => ({
  id: r.id,
  name: r.name,
  prompt: r.prompt ?? null,
  strategy: Strategy.parse(JSON.parse(r.strategy_json)),
  strategyHash: r.strategy_hash,
  policy: Policy.parse(JSON.parse(r.policy_json)),
  status: r.status,
  pauseReason: r.pause_reason ?? null,
  owner: r.owner ?? null,
  basedOn: r.based_on ?? null,
  liveIndex: r.live_index === null || r.live_index === undefined ? null : Number(r.live_index),
  vault: r.vault ?? null,
  chain: (r.chain ?? "robinhood") as ChainKey,
  stopState: r.stop_state ?? null,
  endedAt: r.ended_at ?? null,
  endedReason: r.ended_reason ?? null,
  createdAt: Number(r.created_at),
});

export function createAgent(
  db: DatabaseSync,
  a: { name: string; prompt: string | null; strategy: Strategy; policy: Policy; owner?: string | null; basedOn?: string | null; liveIndex?: number | null; vault?: string | null; chain?: ChainKey },
  now: number,
): AgentRow {
  const id = randomUUID();
  const strategyHash = recordHash(a.strategy);
  // A real-money agent starts paused and empty; funding its wallet sets its cash and starts it.
  const live = (a.liveIndex !== undefined && a.liveIndex !== null) || Boolean(a.vault);
  const start = live ? 0 : START_EQUITY;
  db.prepare("INSERT INTO agents (id, name, prompt, strategy_json, strategy_hash, policy_json, status, pause_reason, owner, based_on, live_index, vault, chain, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, a.name, a.prompt, JSON.stringify(a.strategy), strategyHash, JSON.stringify(a.policy), live ? "paused" : "active", live ? "owner" : null, a.owner ?? null, a.basedOn ?? null,
    a.liveIndex ?? null, a.vault ?? null, a.chain ?? "robinhood", now,
  );
  const day = Math.floor(now / 86400);
  db.prepare("INSERT INTO accounts (agent_id, account_json, start_equity, day, day_start_equity, equity, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id, JSON.stringify({ cash: start, positions: [] } satisfies Account), start, day, start, start, now,
  );
  return getAgent(db, id)!;
}

export function getAgent(db: DatabaseSync, id: string): AgentRow | null {
  const r = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
  return r ? toAgent(r) : null;
}

export function listAgents(db: DatabaseSync, status?: "active"): AgentRow[] {
  const rows = status ? db.prepare("SELECT * FROM agents WHERE status = ? ORDER BY created_at, rowid").all(status) : db.prepare("SELECT * FROM agents ORDER BY created_at, rowid").all();
  return rows.map(toAgent);
}

export function setStatus(db: DatabaseSync, id: string, status: "active" | "paused", reason: "owner" | "over_quota" | "ended" = "owner") {
  db.prepare("UPDATE agents SET status = ?, pause_reason = ? WHERE id = ?").run(status, status === "paused" ? reason : null, id);
}

export function agentsOf(db: DatabaseSync, owner: string): AgentRow[] {
  return db.prepare("SELECT * FROM agents WHERE owner = ? ORDER BY created_at, rowid").all(owner).map(toAgent);
}

export function getAccount(db: DatabaseSync, agentId: string): AccountRow {
  const r = db.prepare("SELECT * FROM accounts WHERE agent_id = ?").get(agentId) as any;
  if (!r) throw new Error(`no account for agent ${agentId}`);
  return { account: JSON.parse(r.account_json), startEquity: r.start_equity, day: r.day, dayStartEquity: r.day_start_equity, equity: r.equity };
}

export function saveAccount(db: DatabaseSync, agentId: string, a: AccountRow, now: number) {
  db.prepare("UPDATE accounts SET account_json = ?, day = ?, day_start_equity = ?, equity = ?, updated_at = ? WHERE agent_id = ?").run(
    JSON.stringify(a.account), a.day, a.dayStartEquity, a.equity, now, agentId,
  );
}
