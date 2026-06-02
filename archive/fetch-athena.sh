#!/usr/bin/env bash
# Fetch the six Athena event CSVs the recovery pipeline depends on into
# out/athena/. Submits all six queries in parallel, polls each to
# SUCCEEDED, then downloads results.
#
# Usage:
#   ./fetch-athena.sh                  # uses $AWS_PROFILE
#   ./fetch-athena.sh <profile>        # explicit SSO profile name
#   AWS_PROFILE=... ./fetch-athena.sh
#
# Prereq: aws sso login --profile <profile>  (see README → "Pulling the Athena event data")

set -euo pipefail
# This script lives in archive/; run from the repo root so ./out/athena
# (where the recovery pipeline expects the event CSVs) resolves.
cd "$(dirname "$0")/.."

PROFILE="${1:-${AWS_PROFILE:-}}"
if [ -z "$PROFILE" ]; then
  echo "usage: ./fetch-athena.sh <aws-profile>   (or set AWS_PROFILE)" >&2
  exit 1
fi

REGION=eu-west-1
DB=mainnet-beta-archive
WG=primary
OUT_BUCKET=s3://mainnet-beta-data-ingestion-bucket/athena
DEST=./out/athena

PARTITION="year='2026' AND month='04' AND day='01'"
SLOTS="slot BETWEEN 410344026 AND 410366402"

mkdir -p "$DEST"

# Preflight: confirm SSO session is live.
if ! aws sts get-caller-identity --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
  echo "SSO session for profile '$PROFILE' is not active." >&2
  echo "Run:  aws sso login --profile $PROFILE" >&2
  exit 1
fi

# eventtype_liquidationrecord has six nested-struct columns that Athena
# cannot serialize to CSV directly — wrap them in CAST(... AS JSON).
# SELECT * fails on this table, so list every column explicitly.
LIQ_QUERY="SELECT \
ts,liquidationtype,\"user\",liquidator,marginrequirement,totalcollateral,marginfreed,liquidationid,bankrupt,canceledorderids,\
CAST(liquidateperp AS JSON) AS liquidateperp,\
CAST(liquidatespot AS JSON) AS liquidatespot,\
CAST(liquidateborrowforperppnl AS JSON) AS liquidateborrowforperppnl,\
CAST(liquidateperppnlfordeposit AS JSON) AS liquidateperppnlfordeposit,\
CAST(perpbankruptcy AS JSON) AS perpbankruptcy,\
CAST(spotbankruptcy AS JSON) AS spotbankruptcy,\
txsig,slot,eventtype,txsigindex,source \
FROM eventtype_liquidationrecord WHERE $PARTITION AND $SLOTS"

# outfile|query — order matches the README table.
# Note: fills live in eventtype_traderecord, not eventtype_orderactionrecord
# (the latter now contains only place/cancel/trigger actions).
JOBS=(
  "trades.csv|SELECT * FROM eventtype_traderecord WHERE $PARTITION AND $SLOTS AND action='fill'"
  "funding.csv|SELECT * FROM eventtype_fundingpaymentrecord WHERE $PARTITION AND $SLOTS"
  "liq.csv|$LIQ_QUERY"
  "settle_pnl.csv|SELECT * FROM eventtype_settlepnlrecord WHERE $PARTITION AND $SLOTS"
  "swap.csv|SELECT * FROM eventtype_swaprecord WHERE $PARTITION AND $SLOTS"
  "funding_rate.csv|SELECT * FROM eventtype_fundingraterecord WHERE $PARTITION AND $SLOTS"
)

# Submit all queries up front; Athena runs them concurrently.
PAIRS=()
for job in "${JOBS[@]}"; do
  outfile="${job%%|*}"
  query="${job#*|}"
  qid=$(aws athena start-query-execution \
    --query-string "$query" \
    --query-execution-context "Database=$DB,Catalog=AwsDataCatalog" \
    --work-group "$WG" \
    --profile "$PROFILE" --region "$REGION" \
    --query 'QueryExecutionId' --output text)
  echo "submitted  $outfile  ($qid)"
  PAIRS+=("$outfile|$qid")
done

# Poll each to completion. Athena queries for a single partition with a
# slot filter typically finish in seconds; the slowest sets the floor.
for pair in "${PAIRS[@]}"; do
  outfile="${pair%%|*}"
  qid="${pair#*|}"
  while true; do
    state=$(aws athena get-query-execution \
      --query-execution-id "$qid" \
      --profile "$PROFILE" --region "$REGION" \
      --query 'QueryExecution.Status.State' --output text)
    case "$state" in
      SUCCEEDED) echo "succeeded  $outfile  ($qid)"; break ;;
      FAILED|CANCELLED)
        reason=$(aws athena get-query-execution --query-execution-id "$qid" \
          --profile "$PROFILE" --region "$REGION" \
          --query 'QueryExecution.Status.StateChangeReason' --output text)
        echo "FAILED     $outfile  ($qid): $reason" >&2
        exit 1
        ;;
      *) sleep 3 ;;
    esac
  done
done

# Download each result CSV to its README-specified filename.
for pair in "${PAIRS[@]}"; do
  outfile="${pair%%|*}"
  qid="${pair#*|}"
  aws s3 cp "$OUT_BUCKET/$qid.csv" "$DEST/$outfile" \
    --profile "$PROFILE" --region "$REGION" --no-progress
done

echo
echo "Done. Wrote 6 CSVs to $DEST/:"
for pair in "${PAIRS[@]}"; do
  outfile="${pair%%|*}"
  rows=$(wc -l < "$DEST/$outfile" | tr -d ' ')
  printf "  %-20s %s rows (incl. header)\n" "$outfile" "$rows"
done
