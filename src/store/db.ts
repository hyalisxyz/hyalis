import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rounds (
  feed TEXT NOT NULL,
  round_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  answer TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (feed, round_id)
);
CREATE INDEX IF NOT EXISTS rounds_symbol_time ON rounds(symbol, updated_at);

CREATE TABLE IF NOT EXISTS users (
  address TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS burns (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  address TEXT NOT NULL,
  amount TEXT NOT NULL,
  slots INTEGER NOT NULL,
  burned_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS burns_address ON burns(address, expires_at);

CREATE TABLE IF NOT EXISTS usage (
  address TEXT NOT NULL,
  day INTEGER NOT NULL,
  compiles INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (address, day)
);

CREATE TABLE IF NOT EXISTS feed_meta (
  feed TEXT PRIMARY KEY,
  backfilled_at INTEGER
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT,
  strategy_json TEXT NOT NULL,
  strategy_hash TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  account_json TEXT NOT NULL,
  start_equity REAL NOT NULL,
  day INTEGER NOT NULL,
  day_start_equity REAL NOT NULL,
  equity REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  kind TEXT NOT NULL,
  leaf TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_epoch ON receipts(epoch);
CREATE INDEX IF NOT EXISTS receipts_agent ON receipts(agent_id, id);

-- ERC-8004 identity of an agent: the token in the Identity Registry that points at its
-- registration file. Linked only after the chain confirms owner and URI; re-checked over time.
CREATE TABLE IF NOT EXISTS identities (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  registry TEXT NOT NULL,
  token_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  agent_uri TEXT NOT NULL,
  status TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  UNIQUE (registry, token_id)
);
CREATE INDEX IF NOT EXISTS identities_checked ON identities(checked_at);

-- Payments this service signs (x402). Booked before sending; see media/images.ts.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  purpose TEXT NOT NULL,
  agent_id TEXT,
  amount TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  tx TEXT,
  output_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_day ON payments(created_at);

-- An agent's generated avatar (one per agent).
CREATE TABLE IF NOT EXISTS agent_media (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  status TEXT NOT NULL,
  file TEXT,
  mime TEXT,
  sha256 TEXT,
  bytes INTEGER,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  payment_id INTEGER,
  output_id TEXT,
  attempts INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Off-site backup bookkeeping (archive/backup.ts).
CREATE TABLE IF NOT EXISTS archived_epochs (
  epoch INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  archived_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS epochs (
  epoch INTEGER PRIMARY KEY,
  root TEXT NOT NULL,
  prev_root TEXT NOT NULL,
  leaf_count INTEGER NOT NULL,
  closed_at INTEGER NOT NULL,
  anchor_tx TEXT
);

-- Social mood readings (signals/social.ts): one row per call to the social reader, sealed as a
-- "signal" receipt (leaf) when it succeeded. cost_usd counts toward the daily budget.
CREATE TABLE IF NOT EXISTS social_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  score REAL,
  posts INTEGER,
  summary TEXT,
  sources_json TEXT,
  window_from INTEGER,
  window_to INTEGER,
  model TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  leaf TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS social_readings_symbol ON social_readings(symbol, status, created_at);
CREATE INDEX IF NOT EXISTS social_readings_day ON social_readings(created_at);

-- Orders of real-money agents (live/live.ts): a decision waiting to be swapped on chain, then
-- its transaction and outcome. before_json keeps the wallet's balances before the swap, so a
-- swap whose answer was lost can still be settled from the chain.
CREATE TABLE IF NOT EXISTS live_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  symbol TEXT NOT NULL,
  action TEXT NOT NULL,
  usd_in REAL,
  status TEXT NOT NULL,
  tx TEXT,
  before_json TEXT,
  error TEXT,
  decision_leaf TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS live_orders_agent ON live_orders(agent_id, status);

-- Equity of a money agent at executable prices (what its positions would sell for now).
CREATE TABLE IF NOT EXISTS agent_marks (
  agent_id TEXT PRIMARY KEY,
  equity REAL NOT NULL,
  at INTEGER NOT NULL
);

-- Swaps users make on the Trade page from their own wallets (trade/trades.ts), read from the
-- chain and sealed as "trade" receipts.
CREATE TABLE IF NOT EXISTS user_trades (
  tx TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  sell_symbol TEXT NOT NULL,
  sell_amount TEXT NOT NULL,
  buy_symbol TEXT NOT NULL,
  buy_amount TEXT NOT NULL,
  block INTEGER NOT NULL,
  at INTEGER NOT NULL,
  receipt_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS user_trades_wallet ON user_trades(wallet, at);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive column changes for databases created by earlier versions. */
function migrate(db: DatabaseSync) {
  const cols = (table: string) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r: any) => String(r.name)));
  const epochs = cols("epochs");
  if (!epochs.has("anchor_block")) db.exec("ALTER TABLE epochs ADD COLUMN anchor_block INTEGER");
  if (!epochs.has("anchor_registry")) db.exec("ALTER TABLE epochs ADD COLUMN anchor_registry TEXT");
  const agents = cols("agents");
  // owner: the wallet that created the agent; NULL for house agents made with the admin token.
  if (!agents.has("owner")) db.exec("ALTER TABLE agents ADD COLUMN owner TEXT");
  // pause_reason: 'owner' (paused by its owner or admin) or 'over_quota' (more agents than slots).
  if (!agents.has("pause_reason")) db.exec("ALTER TABLE agents ADD COLUMN pause_reason TEXT");
  // based_on: the agent whose sealed lessons this one was built from, if any.
  if (!agents.has("based_on")) db.exec("ALTER TABLE agents ADD COLUMN based_on TEXT");
  // live_index: for real-money agents, the index of its wallet under LIVE_MNEMONIC; NULL for paper.
  if (!agents.has("live_index")) db.exec("ALTER TABLE agents ADD COLUMN live_index INTEGER");
  // vault: a user's AgentVault that the agent trades; stop_state: handing the funds back after the run ended.
  if (!agents.has("vault")) db.exec("ALTER TABLE agents ADD COLUMN vault TEXT");
  if (!agents.has("stop_state")) db.exec("ALTER TABLE agents ADD COLUMN stop_state TEXT");
  if (!agents.has("ended_at")) db.exec("ALTER TABLE agents ADD COLUMN ended_at INTEGER");
  if (!agents.has("ended_reason")) db.exec("ALTER TABLE agents ADD COLUMN ended_reason TEXT");
  // chain: where a real-money agent trades ("robinhood" or "arbitrum"); every agent before this was on Robinhood Chain.
  if (!agents.has("chain")) db.exec("ALTER TABLE agents ADD COLUMN chain TEXT NOT NULL DEFAULT 'robinhood'");
  // Finished vault runs whose account was zeroed when the money went back: restore the final equity.
  try {
    db.exec(`UPDATE accounts SET equity = (
        SELECT CAST(json_extract(r.record_json, '$.finalEquity') AS REAL) FROM receipts r
         WHERE r.agent_id = accounts.agent_id AND r.kind = 'funding' AND json_extract(r.record_json, '$.finalEquity') IS NOT NULL
         ORDER BY r.id DESC LIMIT 1)
      WHERE equity = 0 AND agent_id IN (SELECT id FROM agents WHERE stop_state = 'returned')
        AND EXISTS (SELECT 1 FROM receipts r WHERE r.agent_id = accounts.agent_id AND r.kind = 'funding' AND json_extract(r.record_json, '$.finalEquity') IS NOT NULL)`);
  } catch {
    /* tables created just now: nothing to restore */
  }
  db.exec("CREATE INDEX IF NOT EXISTS agents_owner ON agents(owner, status)");
  // prompt: what a paid image was asked for, so an image collected later is recorded as it was made.
  if (!cols("payments").has("prompt")) db.exec("ALTER TABLE payments ADD COLUMN prompt TEXT");
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
