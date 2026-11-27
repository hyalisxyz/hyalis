# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub's **Report a vulnerability** button on the [Security tab](https://github.com/hyalisxyz/hyalis/security) of this repository.

Please include what is affected (contract, address, API route or page), how to reproduce it, and what an attacker could do with it. We will answer, keep you informed while we fix it, and credit you when the fix is public, if you wish.

Users' funds come first. If a report affects money in vaults, we will pause trading while we look into it.

## Scope

- The contracts in `contracts/src/` and their deployments, listed in [AUDIT.md](AUDIT.md#scope)
- The API at `https://hyalis.xyz/v1/` and the website at `https://hyalis.xyz`

Out of scope: third-party services (Uniswap, Chainlink, Pons, wallets), denial of service by volume, and reports from automated scanners that come without a working example.

## Our own review

See [AUDIT.md](AUDIT.md) for our latest review, its tools and every finding with our triage. It is not a third-party audit. During the beta each vault holds at most $100.
