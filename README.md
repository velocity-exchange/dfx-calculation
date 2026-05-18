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
└── lib/
    ├── pipeline-json.ts       # users.json reader
    ├── rate-limit.ts          # withRetry, limitConcurrency, sleep
    ├── discover-vaults.ts     # scan Drift Vaults program accounts
    ├── list-depositors.ts     # scan VaultDepositor accounts per vault
    ├── shares.ts              # depositor + derived-manager share rows
    ├── allocate-shares.ts     # share fraction → depositor equity
    ├── types.ts               # ShareRowScaled, VaultComponent
    ├── aggregate-borrow-lend.ts # price-independent per-user aggregation
    ├── perp-snapshot.ts       # perp market + position JSON (de)serializers
    ├── snapshot-types.ts      # Snapshot, BN<->string helpers, stable JSON
    ├── oracle-csv.ts          # loadOracleCloseByMarket (both schemas)
    └── value-from-snapshot.ts # snapshot + oracle prices → priced totals
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

## Recovery pipeline (post-incident backtrack)

Reverse-replays every event in the attack window to recover each affected
authority's **T0 (pre-incident) state**, then computes a per-authority refund.

```sh
./run-recovery.sh                # uses existing out/base_snapshot.json
./run-recovery.sh <RPC_URL>      # fetch a fresh T1 from chain first
```

Prerequisite: Athena event CSVs must already be in `out/athena/` — see
[Pulling the Athena event data](#pulling-the-athena-event-data). The
T0-side oracle close is bundled at `oracle-prices/pyth_oracle_prices-160600.csv`.

### Final output: `out/refunds.csv`

One row per authority where `|refund_usd| ≥ $0.01`:

| column | meaning |
| --- | --- |
| `authority` | Solana pubkey |
| `presence` | `both` / `t0_only` (closed since) / `t1_only` (created during window) |
| `t0_total`, `t1_total`, `refund_usd` | USD at each side + `t0 − t1` (same oracle both sides) |
| `t0_borrow_lend`, `t1_borrow_lend`, `refund_borrow_lend` | Own-position component |
| `t0_vaults`, `t1_vaults`, `refund_vaults` | Vault-share component |

Positive `refund_usd` ⇒ user lost value during the window (owed). Negative
⇒ user gained value (clawback). Sorted by `|refund_usd|` desc.

### Other artefacts the same run produces

- `recovery_snapshot.csv` — per-authority T0 positions (USDC cross/isolated, signed spot tokens, perp positions with `base/quote/entry/breakEven/settledPnl/lastCumFR/lpShares`). The state to write back on chain.
- `backtrack_audit_trail.csv` — 62k+ rows, every per-authority reversal (auditable against on-chain txsigs).
- `backtrack_reconciliation.tsv` — zero-sum proof. Must be all zeros across every asset axis.
- `backtrack_anomalies.log` — every event that couldn't be bound to a known authority.
- `market_state_deltas.json` — per-market funding-rate deltas the operator un-applies before restoring user state.
- `no_restoration_needed.csv` — event-touched entities that need no restoration (closed accounts, etc.), with reason and $ value.
- `authority_notional_t0.csv`, `authority_notional_t1_at_t0_oracle.csv` — the two per-authority USD CSVs `refunds.csv` is diffed from.

### Re-pricing T0 against a different oracle

`out/base_snapshot_backtracked.json` is itself a fully-formed
`base_snapshot.json` — drop it into `revalue.ts` against any oracle CSV:

```sh
bun ./revalue.ts \
  --snapshot ./out/base_snapshot_backtracked.json \
  --spot-oracle-csv ./oracle-prices/pyth_oracle_prices-183100.csv \
  --perp-oracle-csv ./oracle-prices/pyth_oracle_prices-183100.csv \
  --output ./out/authority_notional_t0_alt.csv
```

(Note: `refunds.csv` itself requires both sides priced at the **same** oracle
— that's what `run-recovery.sh` does. Re-pricing against a different oracle
is only meaningful for the T0-side valuation in isolation.)

See **`METHODOLOGY.md`** for the correctness argument, state-machine diagram,
and remaining sources of drift.

### Pulling the Athena event data

The six CSVs under `out/athena/` come from Drift's on-chain event archive in
AWS Athena. Access details:

- AWS profile: `drift-prod` (SSO — run `aws sso login --profile drift-prod` first)
- Region: `eu-west-1`
- Database: `mainnet-beta-archive` (catalog `AwsDataCatalog`)
- Workgroup: `primary` — results land in `s3://mainnet-beta-data-ingestion-bucket/athena/`

Tables → output files for the attack window
(`year='2026' AND month='04' AND day='01'`):

| Athena table                     | written to                       |
| -------------------------------- | -------------------------------- |
| `eventtype_orderactionrecord`    | `out/athena/trades.csv` (filter `action='fill'`) |
| `eventtype_fundingpaymentrecord` | `out/athena/funding.csv`         |
| `eventtype_liquidationrecord`    | `out/athena/liq.csv`             |
| `eventtype_settlepnlrecord`      | `out/athena/settle_pnl.csv`      |
| `eventtype_swaprecord`           | `out/athena/swap.csv`            |
| `eventtype_fundingraterecord`    | `out/athena/funding_rate.csv`    |

All tables are partitioned by `year` / `month` / `day` (strings). **Always
partition-prune** — Drift requested it specifically. Slot bounds for the
attack window: `410344026 <= slot <= 410366402`.

For `eventtype_liquidationrecord`, wrap the nested structs with
`CAST(... AS JSON)` (e.g. `liquidateperp`, `liquidatespot`,
`liquidateborrowforperppnl`, `liquidateperppnlfordeposit`, `perpbankruptcy`,
`spotbankruptcy`) so the row parser in `lib/backtrack-events.ts` can read
them.

`aws athena get-table-metadata` on macOS sometimes prints a shape descriptor
instead of JSON via the shim — call `/usr/local/bin/aws` directly, or pipe
through `python3 -c "import sys,json; print(json.load(sys.stdin))"` to
recover the column list.
