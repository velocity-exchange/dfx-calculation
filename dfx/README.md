# DFX recovery accounting

Deterministic accounting for the DFX recovery token: **how many DFX exist in
total**, and **how much DFX each user is entitled to**.

DFX is the claim token issued against the post-incident recovery. Its total
supply has two equivalent decompositions, and this pipeline computes both so
they can be reconciled against each other:

```
              ┌─ by source ────────────────────────────────────┐
total DFX  =  attackers_withdrawn        +  remaining_spot_balance
supply
              └─ by ownership ─────────────────────────────────┘
total DFX  =  users-owned shares         +  protocol-owned shares
supply
```

- **`attackers_withdrawn`** — total notional the attacker wallets withdrew
  (`attacker-withdrawals.ts`), excluding scam-token markets.
- **`remaining_spot_balance`** — value Drift's books still recognize in each
  spot market: `net_deposits + revenue_pool` per market (`spot-balances.ts`),
  valued in USD against the oracle closes.
- **users-owned shares** — the sum of every user's per-authority notional, i.e.
  each user's DFX entitlement (`snapshot.ts` → `revalue.ts` →
  `authority_notional.csv`).
- **protocol-owned shares** — the residual `total − users-owned`, attributed to
  the protocol treasury wallet
  `HVoDbY5fWufyposQrdpwsV6w8TkSEi2hS6AjAPz4HRDF` as a borrow-lend number. This
  makes the by-ownership identity hold exactly by construction.

The two decompositions are reconciled in `dfx/out/dfx_supply_summary.json`.

## The four scripts

| script                    | input                                          | output                                                       | role                                               |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `snapshot.ts`             | on-chain (RPC) + `users.json`                  | `out/base_snapshot.json`                                     | price-independent capture of user/vault state      |
| `revalue.ts`              | snapshot + oracle CSVs + the two supply inputs | `out/authority_notional.csv` + `out/dfx_supply_summary.json` | per-user DFX entitlement + total-supply accounting |
| `attacker-withdrawals.ts` | on-chain (data API)                            | `snapshots/attacker_withdrawals.json`                        | `attackers_withdrawn` supply term                  |
| `spot-balances.ts`        | on-chain (RPC)                                 | `snapshots/spot-balances.csv`                                | `remaining_spot_balance` supply term               |

## How total DFX supply is obtained

1. **Attacker withdrawals** (`attacker-withdrawals.ts`) tallies, per attacker
   wallet, `Σ amount × oraclePrice` over every `withdraw` record from the Drift
   data API. Scam-token markets 63/64/65 are excluded and reported
   separately. The grand total is `sumNotionalWithdrawn`.

2. **Remaining spot balance** (`spot-balances.ts`) captures, per spot market,
   the value Drift's own books still recognize — not the raw token vault:

   ```
   net_deposits   = depositTokenAmount − borrowTokenAmount   (what depositors are net owed)
   revenue_pool   = getTokenAmount(revenuePool.scaledBalance) (accrued interest-rate spread)
   remaining      = net_deposits + revenue_pool
   ```

   Scam markets 63/64/65 are excluded entirely. The raw on-chain vault
   balance and the `unaccounted` remainder (`vault − net_deposits −
revenue_pool`) are also written to the CSV for audit, but **`unaccounted` is
   excluded from `remaining`** — those are tokens in the vault PDA that the
   protocol's accounting doesn't track (direct/recovery transfers, e.g. ~262k
   USDC sitting in market 0's vault), and they back no depositor claim.

   Because `net_deposits` reflects depositor liabilities even when a vault was
   emptied administratively (the deposit balances persist on-chain), markets
   like **USDC-1** — vault reads 0, but ~472,842 USDC-1 is still owed — are
   valued correctly with no manual adjustment.

3. **Revalue** (`revalue.ts`) reads both of the above, values the remaining spot
   balances in USD against the **spot** oracle CSV (the same prices it uses for
   everything else), and computes:

   ```
   total_supply  = attackers_withdrawn + remaining_spot_balance
   users_owned   = Σ per-authority notional (all non-vault, non-blacklisted authorities)
   protocol_owned = total_supply − users_owned        ← attributed to HVoD…HRDF
   ```

   `protocol_owned` is added to the protocol wallet's row in
   `authority_notional.csv` as a borrow-lend number (surfaced in the breakdown
   as the key `dfx_protocol_residual`), and the full reconciliation is written
   to `dfx/out/dfx_supply_summary.json`.

   > If either supply input file is missing, revalue logs a warning and skips
   > the supply accounting — it still emits the plain per-authority CSV.

## How much DFX each user is entitled to

`out/authority_notional.csv` is the per-user entitlement snapshot — one row per
authority (wallet):

| column                  | meaning                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `authority`             | Authority pubkey (base58)                                                                                                              |
| `total_notional`        | `borrow_lend_total + vaults_total`, USD with 6 decimals — the wallet's DFX entitlement                                                 |
| `borrow_lend_total`     | Net USD value of the authority's own drift positions                                                                                   |
| `borrow_lend_breakdown` | JSON: per-spot-market value, USDC cross + isolated, unrealized perp PnL. For the protocol wallet, also carries `dfx_protocol_residual` |
| `vaults_total`          | USD value attributed to this authority via vault shares                                                                                |
| `vaults_breakdown`      | JSON: per-vault USD value owed to this authority                                                                                       |

Vault authorities and blacklisted authorities (attacker wallets, the Faris
vault + its depositors) are excluded. The sum of `total_notional` across all
rows **except** the protocol wallet is `users_owned`; the protocol wallet's row
holds `protocol_owned`. Summing the whole column therefore yields `total_supply`.

## Pipeline

The dFx capture is split into two phases so the same on-chain capture can be
re-priced against any set of oracle closes:

```
snapshot.ts          revalue.ts
   │                    │
on-chain ──▶ base_snapshot.json + oracle CSV ──▶ authority_notional.csv
                                  +                + dfx_supply_summary.json
              attacker_withdrawals.json
              spot-balances.csv
```

### Phase 1 — `snapshot.ts`

Reads `users.json` (list of drift user account pubkeys + authorities) and
fetches each user's on-chain state via RPC. Writes a **price-independent** JSON
dump of:

- Spot market metadata (decimals)
- Perp market metadata (AMM cumulative funding, contract type, expiry, ...)
- Per-authority borrow/lend aggregate (signed token amounts; no USD prices)
- All vaults: depositor list, share rows, vault drift user's positions

Output: `dfx/out/base_snapshot.json` (~30–40 MB).

### Phase 2 — `revalue.ts`

Reads `base_snapshot.json` plus two oracle CSVs (spot prices + perp prices — the
same file may be passed for both), prices every authority's positions, and (when
the supply inputs are present) layers on the DFX total-supply accounting
described above.

Splitting phases means re-pricing against a different timestamp is cheap (no RPC
roundtrip) and the snapshot itself is reproducible / auditable.

## Inputs

- **`dfx/users.json`** — drift user accounts + authorities. Pre-bundled.
- **`dfx/oracle-prices/*.csv`** — pyth historical oracle closes. Two example
  snapshots are included:
  - `pyth_oracle_prices-160600.csv`
  - `pyth_oracle_prices-183100.csv`
- **`dfx/snapshots/attacker_withdrawals.json`** — `attackers_withdrawn` term.
- **`dfx/snapshots/spot-balances.csv`** — `remaining_spot_balance` term.

Two oracle CSV schemas are accepted by the loader (`lib/oracle-csv.ts`):

| schema | columns                                                             | how market type is determined            |
| ------ | ------------------------------------------------------------------- | ---------------------------------------- |
| A      | `market_type,market_index,oracle_price[,error]`                     | explicit `market_type` column            |
| B      | `market_index,market_symbol,oracle_price` (the bundled pyth format) | symbol ends in `-PERP` → perp, else spot |

## Run

Requires [Bun](https://bun.sh). Run from the repo root.

```sh
bun install

# Supply term A — attacker withdrawals (writes dfx/snapshots/attacker_withdrawals.json)
bun ./dfx/attacker-withdrawals.ts --rpc-url https://your-rpc-endpoint

# Supply term B — remaining spot balances (writes dfx/snapshots/spot-balances.csv)
bun ./dfx/spot-balances.ts --rpc-url https://your-rpc-endpoint

# Phase 1 — fetch on-chain user/vault state (writes dfx/out/base_snapshot.json)
bun ./dfx/snapshot.ts \
  --rpc-url https://your-rpc-endpoint \
  --users-json ./dfx/users.json \
  --output ./dfx/out/base_snapshot.json

# Phase 2 — price the snapshot, emit the per-user CSV + supply summary
bun ./dfx/revalue.ts \
  --snapshot ./dfx/out/base_snapshot.json \
  --spot-oracle-csv ./dfx/oracle-prices/pyth_oracle_prices-160600.csv \
  --perp-oracle-csv ./dfx/oracle-prices/pyth_oracle_prices-160600.csv \
  --output ./dfx/out/authority_notional.csv
```

`bun run snapshot` and `bun run revalue` (see root `package.json`) are shortcuts
for the two dFx phases.

### revalue flags for the supply accounting

| flag                        | default                                        | meaning                                           |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `--attacker-withdrawals`    | `dfx/snapshots/attacker_withdrawals.json`      | source of `attackers_withdrawn`                   |
| `--spot-balances`           | `dfx/snapshots/spot-balances.csv`              | source of `remaining_spot_balance`                |
| `--protocol-authority`      | `HVoDbY5fWufyposQrdpwsV6w8TkSEi2hS6AjAPz4HRDF` | wallet the protocol-owned residual is attached to |
| `--supply-summary-output`   | `dfx/out/dfx_supply_summary.json`              | reconciliation summary                            |
| `--require-perp-oracle-csv` | off                                            | make a missing perp oracle entry a hard error     |

Other defaults: see `CliFlags` in `snapshot.ts` and `revalue.ts`.

## Layout

```
dfx/
├── snapshot.ts            # phase 1 entry (per-authority + vault capture)
├── revalue.ts             # phase 2 entry (pricing + DFX supply accounting)
├── attacker-withdrawals.ts# attackers_withdrawn supply term
├── spot-balances.ts       # remaining_spot_balance supply term
├── users.json             # input: drift users
├── oracle-prices/         # input: pyth oracle closes (bundled)
├── snapshots/             # committed inputs/outputs (attacker_withdrawals.json, spot-balances.csv)
└── out/                   # generated outputs (gitignored)
```

Entry scripts import shared helpers from the repo-root `lib/` (`../lib/*`):

- `pipeline-json.ts` — users.json reader
- `rate-limit.ts` — withRetry, limitConcurrency, sleep
- `vault.ts` — discover vaults, list depositors, share rows
- `types.ts` — ShareRowScaled
- `aggregate-borrow-lend.ts` — price-independent per-user aggregation
- `perp-snapshot.ts` — perp market + position JSON (de)serializers
- `snapshot-types.ts` — Snapshot, BN<->string helpers, stable JSON
- `oracle-csv.ts` — loadOracleCloseByMarket (both schemas)
- `value-from-snapshot.ts` — snapshot + oracle prices → priced totals
- `vault-fees.ts` — crystallize management/profit-share fees
- `dfx-supply.ts` — attacker-withdrawn / remaining-spot loaders + USD valuation

## Notes

- **Total supply reconciliation**: by-source (`attackers_withdrawn +
remaining_spot`) and by-ownership (`users_owned + protocol_owned`) must agree
  by construction, because `protocol_owned` is defined as the residual
  `total − users_owned`. The summary surfaces both so the equality is visible.
- **Pricing source of truth**: the revalue phase never reads chain oracle state
  — every USD figure (including the remaining spot balance) traces back to the
  CSV you pass in. USDC is always priced from the **spot** oracle set (~1.0).
- **Scam markets**: 63/64/65 are excluded from both supply terms (attacker
  withdrawals lists them separately; spot-balances omits them entirely).
- **Blacklisted authorities** (attacker wallets, the Faris vault and its
  depositors) are stored in the snapshot for traceability and filtered out in
  the revalue phase. See `BLACKLISTED_AUTHORITIES` in `snapshot.ts`.
- **Borrow-lend overrides**: some authorities can't be valued from the snapshot
  and are assigned a fixed borrow-lend number in `BORROW_LEND_OVERRIDES`
  (`revalue.ts`), applied before the users-owned sum. The override fully
  replaces the authority's organic value and is surfaced under its own breakdown
  key. Currently:
  - `amdLor8dLQD2sTbedx8SgbKYbxWpCEtAW9iiZoz4kZX` — a liquidator who liquidated
    the scam-token markets (63/64/65). Those markets are excluded everywhere
    else, so his position can't be priced from the snapshot; his backtracked
    amount is **$646.69**, assigned directly (breakdown key
    `liquidator_scam_token_backtrack`).
- **Manager residual**: when a vault has `totalShares == 0` but still holds
  notional, the residual is attributed 100% to the manager. See the override in
  `revalue.ts`.
- **Vault sanity check**: phase 1 throws if any vault authority owns more than
  one drift sub-account in `users.json` — the vault-depositor share math assumes
  a 1:1 mapping.
