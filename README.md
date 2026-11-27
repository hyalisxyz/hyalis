# Hyalis: phase 1 backend

AI trading agents for tokenized stocks on Robinhood Chain. In this phase they paper trade only. Every decision is recorded with the exact Chainlink round it used, and the records are sealed under a Merkle root each epoch, so anyone can check them.

One Node service does everything: price ingest, strategy brain, guardrails, paper broker, receipts, and the API.

## How a decision is made

```
written strategy ──► brain (LLM) ──► Strategy rules (schema + bounds checked)
                                              │
Chainlink rounds ──► hourly closes ──► decide() ──► gate ──► policy ──► paper broker
(Robinhood Chain)                             │        │         │            │
Plankton marks/halts (optional) ──────────────┘        └─────────┴────────────┴──► receipt
                                                                                 │
                                                       epoch ends ──► Merkle root (prev-linked)
```

- **Brain** (`src/brain`): turns plain language into a `Strategy` with structured outputs. The model writes rules only and never places orders.
- **Engine** (`src/strategy`): pure functions over hourly closes. Conditions: `change_pct`, `below_high_pct`, `price_vs_sma`, `sma_cross`, `rsi`, plus stop loss, take profit, and max hold.
- **Gate** (`src/guard/gate.ts`): fails closed. It blocks on a halt, a missing, bad, future, or stale price, or a second source more than 150 bps away.
- **Policy** (`src/guard/policy.ts`): owner limits. Max leverage (platform cap 3x), position size, open positions, daily loss stop, shorting on or off, and the symbol list.
- **Paper broker** (`src/paper`): isolated margin. Spot is long at 1x; short or above 1x is a perp. Includes fees and liquidation at 90% margin loss.
- **Receipts** (`src/receipts`, `src/engine/epochs.ts`): canonical JSON, domain-separated Merkle tree, one root per epoch, each root linked to the one before it.

## Run

```bash
npm install
npm test                 # unit tests + an end-to-end tick on a fake chain
npm run tick             # one tick against Robinhood Chain (backfills ~10 days of rounds)
node --env-file=.env src/main.ts   # API + ticker
```

Node 24+ runs the TypeScript directly; there is no build step.

## Markets

`data/markets.json` (rebuilt by `npm run sync-markets`) has two tiers, and the API reports which one each market is in:

| Tier | Markets | Price | Hours |
|---|---|---|---|
| **verified** | 35 stocks/ETFs + BTC, ETH, LINK, ENA | Chainlink on Robinhood Chain; every price an agent used can be re-read on chain | stocks 24/5, crypto 24/7 |
| **data-feed** | 28 major crypto assets | CoinGecko; recorded on receipts but not checkable on chain; paper trading only | 24/7 |

Second sources for the gate: Pyth for BTC and ETH (the key is not entitled to more), CoinGecko for LINK and ENA, Plankton for stocks when it responds. CoinGecko history is backfilled two coins per tick to stay inside the free rate limit, and a coin is not re-fetched more than once a day.

All 96 Robinhood stock tokens were checked on chain (`data/stock-token-candidates.txt`), but only the 35 with a Chainlink feed are listed: `node scripts/scan-stock-pools.ts` showed that the others have no Uniswap v4 pool deep enough to price them.

## Wallets, tiers and the token

The project token will launch on a Pons bonding curve. Until `TOKEN_ADDRESS` is set, every wallet is on the free tier and everything else works the same.

- **Tiers** are by whole tokens held, never by price, so they mean the same on the bonding curve and after graduation. Default: Free (0) = 1 agent, 10 AI compiles/day; Holder (1M) = 3 agents, 50/day; Whale (5M) = 10 agents, 50/day. Change with `TOKEN_TIERS`.
- **Burns**: sending `BURN_TOKENS_PER_SLOT` (default 500k) to `0x…dEaD` or `0x0` and claiming the transaction adds one agent slot for `BURN_SLOT_DAYS` (30). Only the sender can claim, and each transaction counts once.
- **Quotas** are checked every tick before trading. If a wallet has more active agents than slots (tokens sold, a burn expired), its newest agents pause with reason `over_quota` and resume, oldest first, when slots return. Agents are never deleted. If the chain cannot be read, nobody is paused.
- **Sign-in** is a wallet signature (EIP-4361 style, no gas), checked through the chain client so smart-contract wallets work too. Reading a wallet's balance and tier needs no sign-in.

## API

Public, no sign-in:

| Method | Path | |
|---|---|---|
| GET | `/health` | last tick, anchoring status |
| GET | `/v1/markets` | every market with tier, source, hours and latest price |
| GET | `/v1/token` | launched or not, token address, tiers, burn rules |
| GET | `/v1/wallets/:address` | **what a connected wallet sees**: balance, tier, next tier and tokens needed, burn slots, agent slots and usage, AI compiles today |
| GET | `/v1/agents` (`?owner=`), `/v1/agents/:id` | agents with rules and account; the written prompt stays private |
| GET | `/v1/agents/:id/receipts`, `/v1/receipts/:id` | receipts, with Merkle proof and on-chain anchor |
| GET | `/v1/epochs`, `/v1/leaderboard` | sealed roots; agents ranked by return |
| POST | `/v1/backtest` | `{strategy, policy?, days?}`: rules over stored history, no AI call |
| GET | `/v1/agents/:id/registration.json`, `/v1/agents/:id/image.svg` | the agent's ERC-8004 registration file and its image |
| GET | `/v1/agents/:id/identity` | the agentURI and registry a wallet needs to register the agent, and the linked identity |
| POST | `/v1/agents/:id/identity` | `{txHash}` or `{agentId}`: link an ERC-8004 identity after checking owner and URI on chain (no sign-in: the chain is the proof) |

Signed in (`Authorization: Bearer <session>`):

| Method | Path | |
|---|---|---|
| POST | `/v1/auth/nonce` → `/v1/auth/verify` | `{address}` returns a message to sign; `{address, nonce, signature}` returns a 7-day session |
| GET | `/v1/me` | the wallet view plus the user's agents, prompts included |
| POST | `/v1/agents` | `{prompt}` or `{strategy}`, optional `policy`, `backtestDays`; `dryRun: true` compiles and backtests without creating. Checks free slots and the daily AI quota first |
| POST | `/v1/agents/:id/pause` / `resume` | owner only; resume needs a free slot |
| POST | `/v1/burns` | `{txHash}`: claim a burn for an extra slot |

The admin token (`ADMIN_TOKEN`) can do the same for house agents (no owner, no quota). Every POST is rate limited per IP.

## Backtest

`src/engine/backtest.ts` replays a strategy once per market hour through `step()`, the same function live agents use. A test checks that a backtest and a live agent produce identical fills on the same data, and another checks that no decision sees a round published after it. It reports return, the equal-weight buy-and-hold benchmark, max drawdown, trades, win rate, exposure, fees, and why orders were blocked. Because decisions are hourly, a stop can fill past its level when the price gaps within the hour; the result lists this and other caveats.

History depth is `BACKFILL_DAYS` (default 30). Busy feeds extend 400 rounds per tick until they reach it.

## On-chain anchoring

`contracts/src/ReceiptRegistry.sol` stores one Merkle root per epoch on Robinhood Chain. A root can be added only after its epoch has ended, only in increasing epoch order, only by the publisher set at deploy, and it must name the previous root. The contract has no owner, no upgrade and no pause. It verifies proofs in the same format as the backend, and a test checks the backend's proofs against the contract on a local chain.

The service publishes sealed epochs after each tick (`src/chain/anchor.ts`). The chain is the source of truth. If a root for an epoch is already on chain (a crash after sending), it is recorded and skipped. If a different root is there, or the links do not match, anchoring stops and `/health` reports why.

```bash
npm run anchor:wallet          # creates a dedicated publisher key in .env and prints its address
npm run anchor:deploy          # estimate; fund the address with a little ETH on Robinhood Chain
npm run anchor:deploy -- --yes # deploy, writes REGISTRY_ADDRESS to .env
npm run build:contracts        # after changing the contract: compile and export the ABI
```

## Agent Passport (ERC-8004)

Each agent can have a public identity in the ERC-8004 Identity Registry on Robinhood Chain (`0x8004A169…a432`, the standard's shared registry; ~26k agents from many projects). The identity is an ERC-721 token whose agentURI is the agent's registration file on this API (`/v1/agents/:id/registration.json`): name, description, image, links to its page and sealed receipts, and its paper-trading record. The written prompt is never in it.

- A user registers their own agent from the agent page: one transaction from their wallet, which then owns the token. House agents are owned by the house wallet (`HOUSE_IDENTITY_OWNER`, default the anchor wallet).
- The server links a token to an agent only after the chain shows the token exists, its owner is the agent's owner, and its agentURI is exactly that agent's file (`src/identity/identity.ts`). The link is sealed as an `identity` receipt.
- Links are re-checked every few hours. A transferred token, or one whose URI was changed, stays on record but stops counting as verified, and leaves the registration file's `registrations`. A failed RPC call never changes a status.
- The registry mints with a safe transfer, so a wallet that is a contract unable to receive NFTs (including some EIP-7702 delegated accounts) cannot register. The page checks this before asking for a signature.
- agentURIs are written on chain under `PUBLIC_URL`. After a domain move, keep the old one in `LEGACY_PUBLIC_URLS` (or update each token with `setAgentURI`).

```bash
node --env-file=.env scripts/register-identities.ts --api https://<server>          # dry run: what would be registered, and the gas
node --env-file=.env scripts/register-identities.ts --api https://<server> --send   # register and link the house agents
```

The script signs each transaction and writes it to `data/identity-journal.json` before sending, so a re-run after any failure finishes or replaces it instead of registering twice.

## Agent journal (lessons)

`src/journal/lessons.ts` reads an agent's own receipts, pairs each opening fill with its close, and turns patterns with at least three trades into lessons: liquidations, stop-outs, time exits, take profits, weak or strong symbols, weak stock sessions, fees. No model writes them, and each names the receipts behind it. The journal is sealed as a `journal` receipt whenever its lessons change (`GET /v1/agents/:id/journal`).

`POST /v1/agents` with `basedOn` gives the brain those lessons as evidence; the user's explicit asks still win, and the AI notes which lesson each change answers. The new agent's receipt records the exact journal used. Creating the tested rules with `basedOnDigest` is refused (409) if the lessons changed since the test.

## Backups and epoch bundles

The chain holds only each epoch's root. So that the receipts behind it can never be lost:

- `GET /v1/epochs/:epoch/bundle.json` serves an epoch's full set of receipts with its root, previous root and anchor (canonical JSON, cached for good once anchored). Anyone can keep a copy and check it without us:

  ```bash
  npm run verify-epoch -- 498683 --api https://<server>     # or: --file 498683.json
  ```

  It rebuilds the root from the receipts and checks root, previous root and leaf count against the ReceiptRegistry on Robinhood Chain.
- The service backs up to a Railway bucket in another region (`src/archive/`): every anchored epoch as `epochs/<epoch>.json` (once), and every `BACKUP_EVERY_HOURS` a consistent gzipped database copy as `db/latest.db.gz`, `db/day-<0-6>.db.gz` and `db/month-YYYY-MM.db.gz`, with `db/latest.json` (hash, counts) written last. Only where `BACKUP_ENABLED=true`, so a laptop with the credentials never uploads over production. On Railway the `BACKUP_S3_*` variables reference the bucket (`${{agent-backups.ENDPOINT}}` and so on).
- Restore checks the manifest hash, SQLite's integrity check and every epoch root before it writes anything:

  ```bash
  npm run restore -- --list
  npm run restore -- --out data/restored.db             # latest; --key db/day-3.db.gz for an older one
  ```

The S3 client is ours (SigV4), checked against AWS's documented signing examples.

## Avatars (image service, paid with x402)

Each agent gets one avatar from an image service, paid per image in USDG with x402 from a wallet that holds only USDG (the service pays the gas). `src/pay/x402.ts` is our own client for x402 v2 "exact" (EIP-3009): it signs nothing unless the network, token, EIP-712 domain, recipient (`MEDIA_PAY_TO`), a per-call ceiling (`MEDIA_MAX_USDG_PER_CALL`) and a daily budget (`MEDIA_DAILY_USDG`) all fit, and it checks the wallet's balance first. Every payment is booked before it is sent. The prompt comes from the agent's rules only, never from user text. Each avatar is sealed as a `media` receipt with its hash and payment, served at `/v1/agents/:id/avatar`, and used as the ERC-8004 image.

```bash
node scripts/new-media-wallet.ts   # creates MEDIA_PAYER_KEY in .env and prints the address to fund with USDG
```

Off until `MEDIA_PAYER_KEY`, `MEDIA_API`, `MEDIA_MODEL` and `MEDIA_PAY_TO` are all set. At 0.000735 USDG a 512x512 image (2026-11-24), 1 USDG pays for about 1,300 avatars.

## Deployment (Railway)

Built from the `Dockerfile` (Node 26.13.1, same as development) on every push to `main` of the private GitHub repo. One service with a volume at `/data` for the SQLite database (`DB_PATH=/data/agent-utility.db`), health check `/health`, and deploy overlap 0, so two instances never write the database or publish roots at the same time.

- Secrets (`ANTHROPIC_API_KEY`, `ADMIN_TOKEN`, `PYTH_API_KEY`, `ANCHOR_PRIVATE_KEY`, and `RPC_URL` / `MEDIA_PAYER_KEY` when set) are copied from the local `.env` with `node scripts/push-secrets.ts` and checked with `node scripts/check-secrets.ts`; neither prints a value.
- `RPC_URL` (an Alchemy endpoint) is tried before the public RPCs; it also serves as the fork source for `npm run test:fork`.
- Anchoring runs on Railway only. Keep `REGISTRY_ADDRESS` unset locally, or two databases would publish to the same registry and anchoring would stop on the conflict.
- `node scripts/smoke-prod.ts https://<domain>` checks the wallet view and an AI dry run against the live service.
- At token launch: set `TOKEN_ADDRESS` on the Railway service (and `APP_DOMAIN` to the website's domain). Changing a variable redeploys.

## Verify a receipt yourself

```bash
npm run verify -- 42 --api http://127.0.0.1:8787
npm run verify -- --file receipt.json
```

The verifier checks that the leaf is the hash of the record, that the leaf sits under the epoch root, and that the Chainlink round the agent used had that exact answer on chain. It reads the chain itself, so it does not trust the server for prices.

## Data sources

- `data/markets.json` comes from Chainlink's public feed directory (`npm run sync-markets`).
- Plankton's public API is read-only here, used as a second price and for halts. Most of its markets are small caps without a Chainlink feed, so the overlap is small for now.

## Known gaps (phase 1)

- Paper only: no vault, no on-chain orders, no funding on perps.
- A receipt records the latest round and the range of rounds behind its hourly closes. The verifier checks the latest round on chain; recomputing every indicator from chain is not built yet.
- The brain needs `ANTHROPIC_API_KEY`. Agents can also be created from rules directly.
- The exchange calendar (`src/market/calendar.ts`) covers 2026–2027. Later years are treated as closed until the table is extended, so nothing trades on a guessed calendar.
- Only one price source is fully wired (Chainlink). Plankton is optional and often slow; a second independent source (Pyth with an API key, or on-chain pool prices) is still open.

## Market hours

The Chainlink equity feeds update 24/5, from Sunday 20:00 to Friday 20:00 New York time, with no updates on Saturday. This was measured from the stored rounds, not assumed. While the market is closed, the engine makes no decisions and no fills, and only writes the hourly snapshot. Indicator windows count market hours only, so "24 hours" always means one trading day, and a Monday-morning window never compares against a frozen weekend price. NYSE holidays close the overnight session before them, and early-close days close at 13:00.

## Network note

From some ISPs, every `robinhood.com` domain (the official RPC, docs and APIs) resolves to a block page. The service uses the public RPC mirrors first for that reason. A server hosted abroad is not affected.
