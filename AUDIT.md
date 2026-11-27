# Security review

**Hyalis, 2026-11-28.** This is our own review of the public code with standard open tools. It is **not an audit by a third party**. Each finding below has our triage and the reason for it, so anyone can check our reasoning. Users' vaults hold at most $100 each during the beta, while the contracts have not had an external audit.

| Area | Tool | Result |
|---|---|---|
| Smart contracts | [Slither](https://github.com/crytic/slither) 0.11.6, 102 detectors, solc 0.8.28 | 42 findings on 11 contracts: **none exploitable** after triage (details below) |
| Smart contracts | [Mythril](https://github.com/Consensys/mythril) symbolic execution, 300 s per contract, official solc 0.8.28 | **No issues detected** in AgentVault, AgentVaultFactory, UniswapV3Adapter and ReceiptRegistry |
| Vault behaviour | Foundry fuzzing: 5 invariants, each over 256 runs of 500 random actions (640,000 calls), plus 7 fuzzed and unit properties | All hold. Fuzzing found one dust-sized edge case, described below as a Low finding |
| Source verification | [Sourcify](https://sourcify.dev), all five deployments | **Verified**: both the creation and the runtime bytecode match this source (links in [Scope](#scope)) |
| Deployed code | Bytecode comparison across chains | Robinhood Chain and Arbitrum One run **byte-identical** code, apart from each chain's token and router addresses |
| Dependencies | `npm audit` (server, website, dev tools) | **0** known vulnerabilities |
| Secrets | [gitleaks](https://github.com/gitleaks/gitleaks) over the full history, plus our own pattern scan | **No leaks detected**. Our scan's only matches are public examples: AWS's documented sample key, Anvil's published test keys, and fake strings in tests |
| Behaviour | 137 unit tests, 10 fork tests on copies of mainnet | All pass (see [Tests](#tests)) |

The raw Slither output is in [`docs/audit/slither-2026-11-28.txt`](docs/audit/slither-2026-11-28.txt). Every check in this table also runs in [CI](https://github.com/hyalisxyz/hyalis/actions/workflows/ci.yml) on every change to `main`: Slither, Mythril, the fuzz and invariant tests, gitleaks and the unit tests. Their full logs are public. We also wanted to run Aderyn, but it has been retired and its downloads withdrawn.

## Scope

| Contract | What it does | Deployed |
|---|---|---|
| `contracts/src/vault/AgentVault.sol` | A user's own vault. Only the owner withdraws; the agent's executor can only swap within the vault's limits and send everything back to the owner | Made per user by the factory |
| `contracts/src/vault/AgentVaultFactory.sol` | Makes vaults; keeps the price feed for each token (feed changes wait 24 hours) | Robinhood Chain `0xeafa7d3b763cfa8d4509907263072722910631cf` · Arbitrum One `0x8c4730f9fed980132eb6a8a681ceb558870de41a` |
| `contracts/src/vault/adapters/UniswapV3Adapter.sol` | Routes a vault's swap through Uniswap V3, in one pool or two | Robinhood Chain `0x88781501b8ca8a04c4ce287ccc4e20fb8996aa45` · Arbitrum One `0x242be6fe51aaa67a9bac7592b755def337a416fb` |
| `contracts/src/ReceiptRegistry.sol` | Stores one Merkle root of receipts per hour, in order, linked to the previous one; no owner, no upgrade | Robinhood Chain `0x8c4730f9fed980132eb6a8a681ceb558870de41a` |
| `contracts/src/vault/Interfaces.sol` | Interfaces and a minimal SafeERC20 | (library code) |

The test mocks in `contracts/test/` were left out of the review.

Each deployment's source is verified on Sourcify, and anyone can download it from there:

- Robinhood Chain:
  - [AgentVaultFactory](https://repo.sourcify.dev/4663/0xeafa7d3b763cfa8d4509907263072722910631cf)
  - [UniswapV3Adapter](https://repo.sourcify.dev/4663/0x88781501b8ca8a04c4ce287ccc4e20fb8996aa45)
  - [ReceiptRegistry](https://repo.sourcify.dev/4663/0x8c4730f9fed980132eb6a8a681ceb558870de41a)
- Arbitrum One:
  - [AgentVaultFactory](https://repo.sourcify.dev/42161/0x8c4730f9fed980132eb6a8a681ceb558870de41a)
  - [UniswapV3Adapter](https://repo.sourcify.dev/42161/0x242be6fe51aaa67a9bac7592b755def337a416fb)

Vaults are created by a verified factory, so their code is part of the factory's verified source.

### The deployed code is this code

The Arbitrum One factory and adapter were deployed on 2026-11-28 from this repository. We compared their runtime bytecode with the Robinhood Chain deployments, read from both chains. The code is the same length, and every byte that differs (7 places in the factory, 4 in the adapter) is one of the chain-specific addresses fixed at deployment: the cash token (USDG or USDC), WETH, and the Uniswap router. Nothing else differs.

## Findings

Severity and confidence are Slither's own ratings. "Accepted" means the behaviour is intended and safe for the reason given. "False positive" means the detector's pattern matched, but the problem it looks for cannot occur here.

### High: reentrancy-balance (6), Accepted

`AgentVault._execute` reads the vault's balances, calls the adapter, then reads them again to measure what the swap really did.

- Every entry point that moves funds (`swap`, `withdraw`, `returnToOwner`) has a reentrancy guard. A call back into the vault during the swap reverts.
- Only the owner's executor can call `swap`, and only through an adapter the owner allowed, with tokens that have a price feed in the factory.
- Measuring by balance is deliberate: the vault never trusts the adapter's reported output. It requires `amountOut >= required` (the oracle price less the allowed slippage) and `spent <= amountIn`.
- Someone could send tokens to the vault during a swap to make the output look larger. That would only give the vault their tokens.

### Medium: divide-before-multiply (1), Accepted

In `_checkAndBook`, the minimum output is `((valueIn * 10^dec) / price) * (10000 - slippage) / 10000`. Dividing first can round the minimum down by up to one base unit of the output token (for example 1e-18 of a token, or $0.000001 of USDC). That is far below any price movement, and the oracle floor still applies. The one case where this rounding matters is the dust case below.

### Low: a swap worth less than two base units of the output token has no floor (found by fuzzing)

The invariant tests found it. When a swap is so small that its oracle floor rounds down to 0, which happens when it is worth less than two base units of the output token, the vault accepts any output for it. A hostile venue could then keep that input.

- **Size:** at most two base units of the output token. For USDC that is under $0.000002; for WETH it is a few wei. The test reproduces it with 6 wei of WETH (about 1e-14 USD).
- **Preconditions:** the executor would have to send such a swap, and the owner would have to have allowed a hostile venue. Vaults made by Hyalis allow only the Uniswap V3 adapter, which routes through Uniswap's router. The backend never sends an order under $1.
- **Fix for the next vault version:** refuse a swap whose floor is 0. The deployed vaults are immutable, so the fix applies to new deployments.
- **Pinned by a test:** `test_knownLimit_dustSwapHasNoFloor`. The invariants check that a thief can only ever hold such dust.

### Medium: incorrect-equality (5), False positive

The strict comparisons flagged are `today == day` (has the UTC day changed), `b == 0` (skip empty balances), `root == bytes32(0)` (no root for that hour) and the feed delay check. None of them compares a balance an attacker could nudge to make the check fail.

### Medium: uninitialized-local (1), False positive

`path` in `UniswapV3Adapter.swap` is set in both route branches. Any other route length reverts with `BadRoute` before `path` is used.

### Medium: unused-return (4), Accepted

- `latestRoundData()`: only the answer and its time are used. The vault rejects a price that is zero or below, and one older than the feed's maximum age.
- `feedOf()`: only the feed's existence matters there.
- `IVenueAdapter.swap()`: the adapter's own figure is ignored on purpose, because the vault measures the result from its balances (see above).

### Low: calls-loop (6), Accepted

`returnToOwner` sends each token back in a loop. If one token were to block transfers, that call would revert. The owner can still take every other token out one by one with `withdraw`, which is always available, paused or not. The constructor and `setTokens` call the factory once per token; the owner chooses the list.

### Low: missing-zero-check (5), Accepted

- `setExecutor(0)` is a valid choice: it switches the agent off.
- A zero WETH address is allowed by design and checked wherever WETH is used.
- `setAdmin(0)` on the factory would give up the admin role. That is the admin's own decision, and the admin can only propose feed changes, which take effect 24 hours later.

### Low: timestamp (5), Accepted

Time is used for whole UTC days (daily volume), for price staleness measured in hours, and for the hour a receipt root may be published. Block producers can shift the time by seconds, which cannot change any of these outcomes in a meaningful way.

### Informational (9)

- **low-level-calls:** sending ETH to the owner, which falls back to WETH if the owner's wallet refuses ETH, and the SafeERC20 calls. These are intended.
- **unindexed-event-address:** some events have address fields that are not indexed. Indexing them in a future version would make them easier to filter; it has no security impact.

## Trust assumptions and known limits

These are not bugs. They are the limits a user relies on, stated plainly.

1. **The executor is trusted within the vault's limits.** It can only swap allowed tokens through allowed adapters, each trade within `maxTradeUsd`, each day within `maxDailyUsd`, at no worse than the oracle price less `maxSlippageBps`. The contract caps that at 5%; Hyalis only starts agents on vaults set to 3% or less, and the app sets 2%. It cannot withdraw to anyone but the owner. A compromised executor could still trade badly within those limits; the owner can pause the vault or change the executor at any time.
2. **Prices come from Chainlink.** The vault rejects stale or non-positive prices. It does not read Arbitrum's sequencer-uptime feed. During a sequencer outage the backend also stops, and its own check (quotes within 3% of the oracle) adds a second guard.
3. **Market hours.** Stock feeds stop updating when markets close. The backend does not trade closed markets; the vault itself only knows the feed's maximum age.
4. **Not externally audited.** Until a third-party audit, each vault holds at most $100.
5. **Off-chain components** (the backend that decides trades, the AI that writes rules) are outside what a contract review can prove. Every decision they make is sealed as a receipt, so it can be checked afterwards.

## Tests

- **Fuzz and invariant tests** (`contracts/test/VaultInvariants.t.sol`, run with `forge test`). A vault holds three tokens with live-like price feeds. A handler then performs random sequences of these actions:
  - swaps through a venue that is honest, underpays, steals the approved input, over-pulls, or pays a thief;
  - price moves of up to 30%, and time passing;
  - strangers trying to withdraw or swap;
  - Stop, which returns everything to the owner;
  - the owner depositing again.

  After every sequence these must hold:
  1. Nobody but the owner ever holds the vault's funds. A thief can hold at most the dust above.
  2. Every successful swap paid at least the oracle price less the slippage allowance, through an honest venue.
  3. Strangers can never move funds.
  4. The day's volume never exceeds the owner's daily limit.
  5. No allowance is ever left behind for a venue.

  Fuzzed single properties: only the owner withdraws, even while paused; only the executor swaps; the slippage cap cannot be raised; trades over the limit are refused; a stale price stops trading.
- **137 unit tests** (`npm test`): strategy engine, guards and policy, receipts and Merkle proofs against the registry on a local chain, token tiers, security headers and redaction, and more.
- **10 fork tests** (`npm run test:fork`), run on local copies of mainnet with real pools, feeds and tokens:
  - Robinhood Chain:
    - a vault made and funded in one transaction, trading, and paying out when the run ends;
    - an owner whose wallet refuses ETH still getting everything back, as WETH;
    - swaps inside and outside the limits;
    - house wallets trading stocks and ETH.
  - Arbitrum One: a vault funded with ETH buys LINK (two pools, through WETH) and BTC in USDC, then the money comes back as ETH.
  - $HYALIS on Pons: tiers and burns with real Pons tokens, on the bonding curve and after graduating to Uniswap v4.
  - ERC-8004 identities and paid image requests (x402) against the live contracts.

## Reproduce

```bash
pip install slither-analyzer          # Python 3.12 or 3.13
cd contracts && slither . --filter-paths "test/"
forge install foundry-rs/forge-std@v1.9.7 --no-git && forge test   # fuzz and invariant tests
npm audit && (cd web && npm audit)
npm test
npm run test:fork                     # needs anvil, plus RPC_URL and ARB_RPC_URL (archive nodes)
```

## Reporting a problem

Please report security issues privately; see [SECURITY.md](SECURITY.md).
