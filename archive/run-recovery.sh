#!/usr/bin/env bash
# One-shot driver for the recovery pipeline.
#
# Final artefact: out/refunds.csv — per-authority refund_usd = t0 − t1,
# valued at the same (T0) oracle on both sides.
#
# Companion artefact: out/recovery_snapshot.csv — one row per authority
# whose positions changed, with their full T0 state inline.
#
# Usage:
#   ./run-recovery.sh                    # uses existing out/base_snapshot.json (skip RPC fetch)
#   ./run-recovery.sh <RPC_URL>          # fresh from chain
#
# Athena event CSVs in out/athena/ must already be present
# (see README → "Pulling the Athena event data").

set -euo pipefail
# This script lives in archive/; run from the repo root so ./out,
# ./oracle-prices and the kept snapshot.ts/revalue.ts all resolve. The
# recovery-only scripts live alongside this one under archive/.
cd "$(dirname "$0")/.."

RPC="${1:-}"
T0_ORACLE="./oracle-prices/pyth_oracle_prices-160600.csv"

# Preflight: required Athena inputs
for f in trades.csv funding.csv liq.csv settle_pnl.csv swap.csv funding_rate.csv; do
  if [ ! -s "./out/athena/$f" ]; then
    echo "missing input: out/athena/$f — see README → 'Pulling the Athena event data'" >&2
    exit 1
  fi
done

STEPS=5
[ -n "$RPC" ] && STEPS=6
n=1

if [ -n "$RPC" ]; then
  echo "==[$n/$STEPS] snapshot.ts — fetch T1 from chain"; n=$((n+1))
  bun ./snapshot.ts --rpc-url "$RPC" --output ./out/base_snapshot.json
  # If backtrack surfaces unknown sub-accounts in out/backtrack_anomalies.log,
  # run archive/resolve-missing-subaccounts.ts + archive/augment-snapshot.ts then re-run this script.
fi

echo "==[$n/$STEPS] backtrack-snapshot-perps.ts — produce T0"; n=$((n+1))
if [ -n "$RPC" ]; then
  bun ./archive/backtrack-snapshot-perps.ts --rpc-url "$RPC"
else
  bun ./archive/backtrack-snapshot-perps.ts --skip-referrer-clawback
fi

echo "==[$n/$STEPS] build-recovery-snapshot.ts — per-authority T0 positions"; n=$((n+1))
bun ./archive/build-recovery-snapshot.ts \
  --t0 ./out/base_snapshot_backtracked.json \
  --t1 ./out/base_snapshot.json \
  --output ./out/recovery_snapshot.csv

echo "==[$n/$STEPS] revalue.ts — price T0 snapshot @ T0 oracle"; n=$((n+1))
bun ./revalue.ts \
  --snapshot ./out/base_snapshot_backtracked.json \
  --spot-oracle-csv "$T0_ORACLE" \
  --perp-oracle-csv "$T0_ORACLE" \
  --output ./out/authority_notional_t0.csv

echo "==[$n/$STEPS] revalue.ts — price T1 snapshot @ T0 oracle"; n=$((n+1))
# Same oracle on both sides: refund = balance change only, not mark-to-market.
bun ./revalue.ts \
  --snapshot ./out/base_snapshot.json \
  --spot-oracle-csv "$T0_ORACLE" \
  --perp-oracle-csv "$T0_ORACLE" \
  --output ./out/authority_notional_t1_at_t0_oracle.csv

echo "==[$n/$STEPS] compute-refunds.ts — emit refunds.csv"
bun ./archive/compute-refunds.ts \
  --t0 ./out/authority_notional_t0.csv \
  --t1 ./out/authority_notional_t1_at_t0_oracle.csv \
  --output ./out/refunds.csv

echo
echo "Done."
echo "  refunds (final):                 out/refunds.csv"
echo "  recovery target (T0 positions):  out/recovery_snapshot.csv"
echo "  T0 per-authority USD notional:   out/authority_notional_t0.csv"
echo "  T1 per-authority USD @ T0 oracle: out/authority_notional_t1_at_t0_oracle.csv"
