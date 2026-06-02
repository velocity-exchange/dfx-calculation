# authority-notional

Deterministic per-authority notional accounting for Drift Protocol users.

Produces a CSV (`out/authority_notional.csv`) where each row is one authority
(wallet) and columns are:

| column                  | meaning                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `authority`             | Authority pubkey (base58)                                               |
| `total_notional`        | `borrow_lend_total + vaults_total`, USD with 6 decimals                 |
| `borrow_lend_total`     | Net USD value of the authority's own drift positions                    |
| `borrow_lend_breakdown` | JSON: per-spot-market value, USDC cross + isolated, unrealized perp PnL |
| `vaults_total`          | USD value attributed to this authority via vault shares                 |
| `vaults_breakdown`      | JSON: per-vault USD value owed to this authority                        |

Vault authorities are excluded — their value is fully attributed back to depositors.

## Pipeline

The pipeline is split into two phases so the same on-chain capture can be
re-priced against any set of oracle closes:

```
snapshot.ts          revalue.ts
   │                    │
on-chain ──▶ base_snapshot.json + oracle CSV ──▶ authority_notional.csv
```

### Phase 1 — `snapshot.ts`

Reads `users.json` (list of drift user account pubkeys + authorities) and
fetches each user's on-chain state via RPC. Writes a **price-independent**
JSON dump of:

- Spot market metadata (decimals)
- Perp market metadata (AMM cumulative funding, contract type, expiry, ...)
- Per-authority borrow/lend aggregate (signed token amounts; no USD prices)
- All vaults: depositor list, share rows, vault drift user's positions

Output: `out/base_snapshot.json` (~40 MB).

### Phase 2 — `revalue.ts`

Reads `base_snapshot.json` plus two oracle CSVs (spot prices + perp prices —
the same file may be passed for both) and emits the final
`out/authority_notional.csv`.

Splitting phases means re-pricing against a different timestamp is cheap
(no RPC roundtrip) and the snapshot itself is reproducible / auditable.

## Inputs

- **`users.json`** — drift user accounts + authorities. Pre-bundled.
- **`oracle-prices/*.csv`** — pyth historical oracle closes. Two example
  snapshots are included:
  - `pyth_oracle_prices-160600.csv`
  - `pyth_oracle_prices-183100.csv`

Two CSV schemas are accepted by the loader (`lib/oracle-csv.ts`):

| schema | columns                                                             | how market type is determined            |
| ------ | ------------------------------------------------------------------- | ---------------------------------------- |
| A      | `market_type,market_index,oracle_price[,error]`                     | explicit `market_type` column            |
| B      | `market_index,market_symbol,oracle_price` (the bundled pyth format) | symbol ends in `-PERP` → perp, else spot |

## Run

Requires [Bun](https://bun.sh).

```sh
bun install

# Phase 1 — fetch on-chain state (writes out/base_snapshot.json)
bun ./snapshot.ts \
  --rpc-url https://your-rpc-endpoint \
  --users-json ./users.json \
  --output ./out/base_snapshot.json

# Phase 2 — price the snapshot and emit the final CSV
bun ./revalue.ts \
  --snapshot ./out/base_snapshot.json \
  --spot-oracle-csv ./oracle-prices/pyth_oracle_prices-160600.csv \
  --perp-oracle-csv ./oracle-prices/pyth_oracle_prices-183100.csv \
  --output ./out/authority_notional.csv
```

Default values (used when a flag is omitted): see `CliFlags` in `snapshot.ts`
and `revalue.ts`. The `--require-perp-oracle-csv` flag (revalue) makes a
missing perp oracle entry a hard error instead of silently zero-ing that
position's PnL.

## File layout

```
authority-notional/
├── snapshot.ts                # phase 1 entry
├── revalue.ts                 # phase 2 entry
├── users.json                 # input: drift users
├── oracle-prices/             # input: pyth oracle closes (bundled)
├── out/                       # outputs (gitignored)
├── archive/                   # archived post-incident recovery pipeline (see archive/README.md)
└── lib/
    ├── pipeline-json.ts       # users.json reader
    ├── rate-limit.ts          # withRetry, limitConcurrency, sleep
    ├── vault.ts               # discover vaults, list depositors, share rows
    ├── types.ts               # ShareRowScaled
    ├── aggregate-borrow-lend.ts # price-independent per-user aggregation
    ├── perp-snapshot.ts       # perp market + position JSON (de)serializers
    ├── snapshot-types.ts      # Snapshot, BN<->string helpers, stable JSON
    ├── oracle-csv.ts          # loadOracleCloseByMarket (both schemas)
    ├── value-from-snapshot.ts # snapshot + oracle prices → priced totals
    └── vault-fees.ts          # crystallize management/profit-share fees
```

## Notes

- **Pricing source of truth**: the revalue phase never reads chain oracle
  state — every USD figure traces back to the CSV you pass in. USDC is
  always priced from the **spot** oracle set (typically ~1.0).
- **Blacklisted authorities** (attacker wallets, the Faris vault and its
  depositors) are stored in the snapshot for traceability and filtered out
  in the revalue phase. See `BLACKLISTED_AUTHORITIES` in `snapshot.ts`.
- **Manager residual**: when a vault has `totalShares == 0` but still holds
  notional (e.g. lending interest accrued after the last withdrawal), the
  residual is attributed 100% to the manager. See the override in
  `revalue.ts`.
- **Vault sanity check**: phase 1 throws if any vault authority owns more
  than one drift sub-account in `users.json` — the vault-depositor share
  math assumes a 1:1 mapping.

## Archived: recovery / backtracking pipeline

The post-incident backtrack (reverse-replay the attack window to recover each
authority's T0 state and compute per-authority refunds) has been **archived**
under [`archive/`](archive/). It is no longer part of the active pipeline.

- Driver: `./archive/run-recovery.sh` → `out/refunds.csv`
- Single-authority variant: `bun ./archive/per-authority-refund.ts`
- Athena event pull: `./archive/fetch-athena.sh <aws-profile>`
- Full docs + methodology: [`archive/README.md`](archive/README.md) and
  [`archive/METHODOLOGY.md`](archive/METHODOLOGY.md)

`out/base_snapshot_backtracked.json` (when present) is itself a fully-formed
`base_snapshot.json` and can be re-priced through `revalue.ts` like any other.
