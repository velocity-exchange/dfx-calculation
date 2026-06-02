# archive — post-incident recovery / backtracking pipeline

These scripts are **archived**. The active project now focuses solely on the
two-phase `snapshot.ts` → `revalue.ts` notional pipeline (see the top-level
[`README.md`](../README.md)). Everything here was the one-off recovery
backtrack used after the incident, kept for reference and auditability.

All scripts here import the shared libraries from `../lib/` (core) and
`./lib/` (the recovery-only libs: `audit-log.ts`, `backtrack-events.ts`,
`parse-drift-logs.ts`). The two shell drivers `cd` to the repo root on
startup, so invoke them from anywhere:

```sh
./archive/run-recovery.sh
./archive/fetch-athena.sh <aws-profile>
```

`out/` and `oracle-prices/` still live at the repo root and are used in place.

## Recovery pipeline (post-incident backtrack)

Reverse-replays every event in the attack window to recover each affected
authority's **T0 (pre-incident) state**, then computes a per-authority refund.

```sh
./archive/run-recovery.sh                # uses existing out/base_snapshot.json
./archive/run-recovery.sh <RPC_URL>      # fetch a fresh T1 from chain first
```

Prerequisite: Athena event CSVs must already be in `out/athena/` — see
[Pulling the Athena event data](#pulling-the-athena-event-data). The
T0-side oracle close is bundled at `oracle-prices/pyth_oracle_prices-160600.csv`.

### Final output: `out/refunds.csv`

One row per authority where `|refund_usd| ≥ $0.01`:

| column                                                   | meaning                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `authority`                                              | Solana pubkey                                                         |
| `presence`                                               | `both` / `t0_only` (closed since) / `t1_only` (created during window) |
| `t0_total`, `t1_total`, `refund_usd`                     | USD at each side + `t0 − t1` (same oracle both sides)                 |
| `t0_borrow_lend`, `t1_borrow_lend`, `refund_borrow_lend` | Own-position component                                                |
| `t0_vaults`, `t1_vaults`, `refund_vaults`                | Vault-share component                                                 |

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

See **`METHODOLOGY.md`** (in this directory) for the correctness argument,
state-machine diagram, and remaining sources of drift.

### Single-authority refund from RPC only (`per-authority-refund.ts`)

Self-contained alternative to `run-recovery.sh` for one authority. No Athena
access required — discovers the authority's drift sub-accounts via
`getProgramAccounts`, paginates every transaction touching them in the
attack window via `getSignaturesForAddress`, parses Drift events directly
from the tx logs, runs the same per-event backtrack the bulk pipeline uses,
prices both sides at the same T0 oracle, and prints `refund_usd`.

```sh
bun ./archive/per-authority-refund.ts \
  --rpc-url $RPC \
  --authority EibQ2VYpzj18qSdEBkmxWVzde7FzamTxVG9rZyY689Yj
# → prints t0_total / t1_total / refund_usd
# → writes out/per_authority/<authority>_audit.csv
```

Good for spot-checking an entry in `refunds.csv`, debugging one user's
reversal, or running in environments without Drift Athena access.

**Tuning for rate-limited RPCs.** The script puts every RPC call through a
global token-paced rate limiter (default 15 req/s) plus exponential-backoff
retry on 429/5xx. Tune via:

- `--rpc-qps <N>` — global RPC ceiling. Default 15. Drop to 5–8 on free-tier
  endpoints; 30–50 on premium tiers.
- `--tx-concurrency <N>` — parallel `getTransaction` workers. Default 25.
  Has no effect once `--rpc-qps` is saturated, so prefer raising QPS first.
- `--sig-page-size <N>` — `getSignaturesForAddress` page size. Default 1000.
  Lower if the endpoint rejects large pages.

Progress lines surface a retry count (`450/9000 (37 retries so far)`) so
you can see at a glance whether you're being throttled. For very active
users (thousands of txs in the window) on a free-tier RPC, expect 10–30
minutes; on a premium tier (50 req/s) the same run takes 2–4 minutes.

**Limitations** vs the bulk pipeline (these are inherent to per-authority
scope, not bugs):

- **Bankruptcy socialization** is not modeled. A market bankruptcy applies
  a tiny socialized credit/debit to every holder of that market; computing
  that for one authority requires global holder state the script doesn't
  fetch. Bankruptcies in the user's _own_ events are reversed; bankruptcies
  of _other_ users that touch markets this authority holds are skipped.
  The script warns if any bankruptcy is present.
- **Referrer clawback as a referrer.** If this authority received referrer
  rewards on _other_ users' trades, that rebate lives on those users' txs —
  which the per-authority script does not fetch. Only rebates appearing on
  this authority's own txs are clawed back.
- **Vault depositor share math** is not included (only own-account positions).

For full-pipeline parity, use `out/refunds.csv` from `run-recovery.sh`.

### Pulling the Athena event data

The six CSVs under `out/athena/` come from Drift's on-chain event archive in
AWS Athena. One-shot driver:

```sh
aws sso login --profile <your-profile>
./archive/fetch-athena.sh <your-profile>      # or set AWS_PROFILE and omit the arg
```

This submits all six queries, polls them to completion, and writes the
CSVs into `out/athena/`. The rest of this section explains the access
details and queries so you can run them by hand or adapt the script.

Access details:

- AWS profile: SSO profile with read access to the Drift archive account
  (`875427118836`). Run `aws sso login --profile <your-profile>` first. The
  profile name varies per engineer — `drift-prod` is the canonical name in
  Drift's own infra, but external collaborators may have it under another
  name (e.g. `velocity-prod`). All commands below assume `$PROFILE` is set.
- Region: `eu-west-1`
- Database: `mainnet-beta-archive` (catalog `AwsDataCatalog`)
- Workgroup: `primary` — results land in `s3://mainnet-beta-data-ingestion-bucket/athena/`

Tables → output files for the attack window
(`year='2026' AND month='04' AND day='01'`):

| Athena table                     | written to                                       |
| -------------------------------- | ------------------------------------------------ |
| `eventtype_traderecord`          | `out/athena/trades.csv` (filter `action='fill'`) |
| `eventtype_fundingpaymentrecord` | `out/athena/funding.csv`                         |
| `eventtype_liquidationrecord`    | `out/athena/liq.csv`                             |
| `eventtype_settlepnlrecord`      | `out/athena/settle_pnl.csv`                      |
| `eventtype_swaprecord`           | `out/athena/swap.csv`                            |
| `eventtype_fundingraterecord`    | `out/athena/funding_rate.csv`                    |

> **Heads-up on the trades table.** Fills used to live in
> `eventtype_orderactionrecord` alongside `place` / `cancel` / `trigger`
> actions, and older docs / scripts may still reference that. As of mid-2026
> that table contains only the non-fill actions; the actual fill rows moved
> to `eventtype_traderecord` (same schema, same `action='fill'` filter).
> If `trades.csv` comes back with zero data rows, you've hit the old table.

All tables are partitioned by `year` / `month` / `day` (strings). **Always
partition-prune** — Drift requested it specifically. Slot bounds for the
attack window: `410344026 <= slot <= 410366402`.

For `eventtype_liquidationrecord`, six of its columns are nested structs
that Athena cannot serialize directly to CSV. List every column explicitly
and wrap these six in `CAST(... AS JSON)` so they emit as JSON strings the
row parser in `lib/backtrack-events.ts` can read: `liquidateperp`,
`liquidatespot`, `liquidateborrowforperppnl`, `liquidateperppnlfordeposit`,
`perpbankruptcy`, `spotbankruptcy`. (`SELECT *` will fail on this table.)

#### Running a query

Athena is fire-and-forget: you submit, poll for completion, then download
the result CSV from the workgroup's S3 output bucket. Per table:

```sh
# 1. Submit — returns a query execution ID (UUID)
QID=$(aws athena start-query-execution \
  --query-string "SELECT * FROM eventtype_traderecord
                  WHERE year='2026' AND month='04' AND day='01'
                  AND slot BETWEEN 410344026 AND 410366402
                  AND action='fill'" \
  --query-execution-context "Database=mainnet-beta-archive,Catalog=AwsDataCatalog" \
  --work-group primary \
  --profile "$PROFILE" --region eu-west-1 \
  --query 'QueryExecutionId' --output text)

# 2. Poll — state cycles QUEUED → RUNNING → SUCCEEDED (or FAILED)
while :; do
  state=$(aws athena get-query-execution --query-execution-id "$QID" \
    --profile "$PROFILE" --region eu-west-1 \
    --query 'QueryExecution.Status.State' --output text)
  [[ "$state" == "SUCCEEDED" ]] && break
  [[ "$state" == "FAILED" || "$state" == "CANCELLED" ]] && exit 1
  sleep 3
done

# 3. Download
aws s3 cp "s3://mainnet-beta-data-ingestion-bucket/athena/$QID.csv" \
  ./out/athena/trades.csv --profile "$PROFILE" --region eu-west-1
```

The same submit/poll/download pattern applies to all six tables — submit
them all up front (Athena runs concurrent queries fine) and the slowest one
sets the wall-clock floor.

#### Troubleshooting

- **`ForbiddenException: No access`** on any Athena call usually means the
  `sso_account_id` / `sso_role_name` in `~/.aws/config` don't match what
  the SSO portal actually grants you. Open
  `https://<your-org>.awsapps.com/start`, check the account ID + role tile
  for the Drift archive account, and update the profile to match.
- **`aws athena get-table-metadata` prints a "shape descriptor"** on macOS
  via the shim instead of JSON — call `/usr/local/bin/aws` directly, or
  pipe through `python3 -c "import sys,json; print(json.load(sys.stdin))"`
  to recover the column list. (Useful when building the explicit column
  list for the liquidation query.)
- **Empty `trades.csv`** — see the heads-up above; you're querying the
  wrong table.
