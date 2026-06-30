# Insurance-fund snapshot

Captures the state of Drift's Insurance Funds (IF) and computes, per staker,
the token amount their shares would currently redeem for.

Drift runs **one Insurance Fund per spot market**. Each IF holds tokens in a PDA
token account (`spotMarket.insuranceFund.vault`) and tracks ownership via
`insuranceFund.totalShares`. A staker's position lives in an
`InsuranceFundStake` account holding `ifShares` (raw) and `ifBase` (the rebase
exponent in effect when the shares were last touched).

## What it does

1. Reads, per spot market, the live IF vault token balance and share totals
   (`totalShares`, `userShares`, `sharesBase`) via `@drift-labs/sdk`. The vault
   balances are fetched in batches with `getMultipleAccountsInfo` (chunks of
   100) rather than one RPC call per market.
2. Scans **every** `InsuranceFundStake` account on the Drift program
   (`program.account.insuranceFundStake.all()` — a single discriminator-filtered
   `getProgramAccounts`).
3. For each stake: rebases `ifShares` to the market's current `sharesBase`, then
   converts to a token amount with the SDK's `unstakeSharesToAmount`
   (`effectiveShares × vaultBalance ÷ totalShares`).
4. Groups deposits by authority and writes a JSON file, plus one CSV per spot
   market (`{marketIndex}_{symbol}.csv`).

## Run

```bash
bun ./insurance-fund/snapshot.ts \
  --rpc-url <RPC_URL> \
  --output ./insurance-fund/out/if_snapshot.json

# restrict to one spot market (e.g. USDC = 0):
bun ./insurance-fund/snapshot.ts --rpc-url <RPC_URL> --market-index 0

# point at a specific override config:
bun ./insurance-fund/snapshot.ts --rpc-url <RPC_URL> --config ./insurance-fund/vault-balances.config.json
```

> Requires a real RPC endpoint. The public `api.mainnet-beta.solana.com`
> endpoint rate-limits the bulk subscribe and disables `getProgramAccounts`, so
> the full scan will not run there.

## Vault-balance overrides (config)

Some IF vaults had their tokens moved out **administratively**, so the on-chain
token account reads `0` even though stakers are still owed against the true
backing. Valuing those stakes from the on-chain balance would (incorrectly)
yield 0 for everyone in that market.

To handle this, supply a config that overrides the vault balance per market.
When an override exists for a market, the snapshot values that market's stakes
against the override balance instead of the on-chain one (the on-chain value is
still recorded in the output for audit).

- The script loads `insurance-fund/vault-balances.config.json` automatically if
  it exists, or use `--config <path>`.
- See [`vault-balances.config.example.json`](./vault-balances.config.example.json)
  for the shape. Copy it to `vault-balances.config.json` and fill in real values.
- Spot-market indices: USDC = `0` (6 decimals), SOL = `1` (9 decimals).

Each override gives the balance one of two ways:

- **`vaultBalance`** — raw base units, an **integer** (no decimal point), e.g.
  `"15595120840000"` for 15,595,120.84 USDC. (Raw wins if both are given.)
- **`vaultBalanceUi`** — a human/decimal token amount, e.g. `"15595120.84"`,
  scaled to base units by `decimals`.

`decimals` is the market's base-unit decimals (USDC = 6, SOL = 9). It's optional
(defaults to the on-chain market decimals); it scales `vaultBalanceUi` and sets
how amounts display for that market.

```jsonc
{
  "marketOverrides": {
    "0": {
      "vaultBalance": "15595120840000",
      "decimals": 6,
      "reason": "USDC IF drained ..."
    },
    "1": {
      "vaultBalance": "14352791091478",
      "decimals": 9,
      "reason": "SOL IF drained ..."
    }
  }
}
```

> Putting a decimal point in `vaultBalance` is rejected with a clear error — use
> `vaultBalanceUi` for decimal amounts, or convert to integer base units.

When a market's on-chain balance is `0` but shares still exist and no override
is configured, the script logs a warning so the situation isn't missed.

## Output shape

Keyed by staker authority. Each authority maps to an array of deposits (one per
spot market they staked in), carrying both shares and the token value:

```jsonc
{
  "snapshotTimestampUtc": "2026-06-02T...Z",
  "rpcUrl": "...",
  "marketIndexFilter": null,
  "configPath": "/abs/path/to/vault-balances.config.json", // or null
  "markets": {
    "0": {
      "marketIndex": 0,
      "symbol": "USDC",
      "decimals": 6,
      "vault": "<IF vault token account>",
      "vaultBalance": "123456789", // raw units used for valuation
      "vaultBalanceUi": "123.456789", // human-readable
      "vaultBalanceSource": "onchain", // or "config" when overridden
      "onchainVaultBalance": "123456789", // always the raw on-chain value
      "onchainVaultBalanceUi": "123.456789",
      "balanceOverrideReason": "...", // present only when overridden
      "totalIfShares": "...",
      "userIfShares": "...",
      "sharesBase": "0",
      "depositorCount": 42,
      "surplusRedistributed": "...", // vaultBalance − Σ tokenAmount (forfeited appreciation)
      "surplusRedistributedUi": "...",
      "nonRequestedShares": "..." // totalIfShares − Σ requested shares (surplus recipients)
    }
  },
  "byAuthority": {
    "<authority pubkey>": [
      {
        "marketIndex": 0,
        "stakePubkey": "<InsuranceFundStake account>",
        "ifShares": "...", // raw shares stored on the stake
        "ifBase": "0",
        "effectiveShares": "...", // ifShares rebased to current sharesBase
        "tokenAmount": "...", // reconciled claim INCLUDING redistributed surplus
        "tokenAmountUi": "1.234999",
        "preRedistributionTokenAmount": "...", // value before redistribution (capped for open requests; matches Drift UI)
        "preRedistributionTokenAmountUi": "1.234567",
        "surplusShare": "...", // this deposit's slice of the redistributed vault surplus
        "costBasis": "...",
        "lastWithdrawRequestShares": "...",
        "lastWithdrawRequestValue": "...",
        "lastWithdrawRequestTs": "..."
      }
    ]
  }
}
```

Notes:

- `preRedistributionTokenAmount` matches the Drift UI's valuation. When a staker
  has an open unstake request (`lastWithdrawRequestValue > 0`), the requested
  shares are valued at the amount locked in at request time (capped against
  current value) via the SDK's `unstakeSharesToAmountWithOpenRequest`, exactly as
  the UI's `fetchInsuranceFundData` does; otherwise all shares are valued at the
  live share price. The raw `lastWithdrawRequest*` fields are still included for
  audit.
- `tokenAmount` is the **reconciled** claim: `preRedistributionTokenAmount +
  surplusShare` (see below). Use it for "what this staker is owed against the full
  vault"; use `preRedistributionTokenAmount` for the live per-staker UI value.
- Stakes with zero effective shares (empty/closed positions) are skipped.
- **Surplus redistribution.** A staker with an open withdraw request is paid
  `min(currentValue, lockedValue)` on unstake, yet the on-chain program burns the
  full requested shares (`remove_insurance_fund_stake`): the appreciation they
  forfeit stays in the vault and accrues to the holders who remain. So the sum of
  `preRedistributionTokenAmount` across a market is **less** than the vault
  balance whenever open requests exist — the difference is real tokens you recover
  on a full vault withdrawal. The snapshot reproduces the end state by splitting
  that surplus (`surplusRedistributed`) pro-rata across all non-requested shares
  (`nonRequestedShares` = other stakers, the un-requested portion of partial
  requesters, and the protocol slice). Each deposit gets a `surplusShare`, folded
  into `tokenAmount`. Invariant: for every market with `nonRequestedShares > 0`,
  `Σ tokenAmount` equals the vault balance exactly (floor-division dust goes to
  the largest holder). If every share is under request the surplus can't be
  reattributed and the script warns.
- The protocol-owned slice of each market's Insurance Fund (`totalShares −
  userShares`, tracked on the market with no `InsuranceFundStake` account) is
  attributed to the protocol authority
  `4JM5vsoGPkMMZCZusMC6rTNZpm4pFweBPQf36vT8yZ8x` as a synthetic deposit, mirroring
  the DFX pipeline (`dfx/revalue.ts`). It appears under that authority in
  `byAuthority` and as a per-market CSV row, identified by `stakePubkey =
  "protocol_owned"` (it is not a real stake account). Markets with no protocol
  slice (`totalShares == userShares`) produce no such row. The synthetic row is
  **not** included in a market's `depositorCount`.

## Per-market CSVs

Alongside the JSON, the script writes one CSV per spot market named
`{marketIndex}_{symbol}.csv` (e.g. `0_USDC.csv`, `1_SOL.csv`) into the committed
`insurance-fund/snapshots/` directory by default (override with `--csv-dir
<path>`). The JSON output itself stays under the gitignored `out/`.

Each row is one staker deposit, with `authority` first followed by the same
attributes as the JSON deposits:

```
authority,marketIndex,stakePubkey,ifShares,ifBase,effectiveShares,tokenAmount,tokenAmountUi,preRedistributionTokenAmount,preRedistributionTokenAmountUi,surplusShare,costBasis,lastWithdrawRequestShares,lastWithdrawRequestValue,lastWithdrawRequestTs
```

Rows are sorted by `tokenAmount` descending (largest stakers first), then by
authority. One CSV is written per in-scope market; markets with no depositors
get a header-only file.

## Layout

- `snapshot.ts` — CLI entrypoint: setup, scan, group, write JSON + per-market CSVs.
- `lib/insurance-fund.ts` — helpers: `rebaseShares`, `valueStake`,
  `readIfMarketStates` (batched vault reads), `parseTokenAccountAmount`,
  `fetchAllIfStakes`, `applyBalanceOverride`, `toUi` / `fromUi`.
