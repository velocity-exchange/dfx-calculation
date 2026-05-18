/**
 * Single-file answer. One CSV per authority that needs pre-incident state
 * restored, with all T0 positions in the same row.
 *
 * Reads (already-produced):
 *   out/base_snapshot_backtracked.changed.json     — T0 (pre-attack target)
 *   out/base_snapshot.changed.json                 — T1 (current on-chain)
 *   oracle-prices/pyth_oracle_prices-160600.csv    — common oracle for $ valuation
 *
 * Writes:
 *   out/recovery_snapshot.csv
 *
 * Columns (all amounts use Drift native precision — see notes below):
 *   authority                — Solana pubkey (base58)
 *   presence                 — both | t0_only | t1_only
 *   t0_usd / t1_usd          — USD value at T0 / T1 (6-decimal fixed, same oracle for both)
 *   diff_usd                 — t1_usd − t0_usd (negative = user's value shrank during window)
 *   t0_usdc_cross            — signed USDC cross-collateral, raw 6-dec tokens
 *   t0_usdc_isolated         — unsigned USDC tied to isolated perp positions
 *   t0_spot                  — JSON array [{market, signed_token}]; non-USDC spot only
 *   t0_perp                  — JSON array [{market, base, quote, entry, breakEven, settledPnl, lastCumFR}]
 *
 * Sorted by |diff_usd| desc — largest movers first.
 *
 * Precision reminder (Drift):
 *   QUOTE_PRECISION       = 1e6   (USDC, perp quote*)
 *   BASE_PRECISION        = 1e9   (perp base)
 *   FUNDING_RATE_PRECISION = 1e9
 *   Spot tokens use each market's `decimals` field — typically 6 (USDC, JLP)
 *   or 9 (SOL).
 *
 * Run:
 *   bun ./build-recovery-snapshot.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Decimal } from "decimal.js";
import { BN } from "@drift-labs/sdk";

import { loadOracleCloseByMarket } from "./lib/oracle-csv.ts";
import {
  strToBn,
  type BorrowLendAggregateSnapshot,
  type PerpPositionSnapshot,
  type Snapshot,
} from "./lib/snapshot-types.ts";
import {
  sumBorrowLendQuote,
  valueBorrowLendAggregate,
  type ValueOptions,
} from "./lib/value-from-snapshot.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BN0 = new BN(0);

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

function firstExisting(...candidates: string[]): string {
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0]; // best-guess for error message
}
const t0Path =
  getFlag("--t0") ??
  firstExisting(
    path.resolve(__dirname, "out", "base_snapshot_backtracked.changed.json"),
    path.resolve(__dirname, "out", "base_snapshot_backtracked.json"),
  );
const t1Path =
  getFlag("--t1") ??
  firstExisting(
    path.resolve(__dirname, "out", "base_snapshot.changed.json"),
    path.resolve(__dirname, "out", "base_snapshot.json"),
  );
const oraclePath =
  getFlag("--oracle-csv") ??
  path.resolve(__dirname, "oracle-prices", "pyth_oracle_prices-160600.csv");
const outPath =
  getFlag("--output") ??
  path.resolve(__dirname, "out", "recovery_snapshot.csv");

console.log(`T0 (recovery target): ${t0Path}`);
console.log(`T1 (post-attack):     ${t1Path}`);
console.log(`oracle (both sides):  ${oraclePath}`);

const t0 = JSON.parse(fs.readFileSync(t0Path, "utf8")) as Snapshot;
const t1 = JSON.parse(fs.readFileSync(t1Path, "utf8")) as Snapshot;

const spotPricesByMarket = loadOracleCloseByMarket(oraclePath, "spot");
const perpOracleByMarket = loadOracleCloseByMarket(oraclePath, "perp");
const valOpts0: Omit<ValueOptions, "contextLabel"> = {
  spotPricesByMarket,
  perpOracleByMarket,
  spotMarkets: t0.spotMarkets,
  perpMarkets: t0.perpMarkets,
  requirePerpOracleCsv: false,
};
const valOpts1: Omit<ValueOptions, "contextLabel"> = {
  ...valOpts0,
  spotMarkets: t1.spotMarkets,
  perpMarkets: t1.perpMarkets,
};

function quoteToUsd6(q: BN): string {
  return new Decimal(q.toString(10)).div(1_000_000).toFixed(6);
}
function emptyAgg(): BorrowLendAggregateSnapshot {
  return {
    spotSignedTokenByMarket: {},
    usdcCrossSignedToken: "0",
    usdcIsolatedToken: "0",
    perpPositions: [],
  };
}
function bn(s: string | undefined): BN {
  return strToBn(s ?? "0");
}

function aggsEqual(
  a: BorrowLendAggregateSnapshot,
  b: BorrowLendAggregateSnapshot,
): boolean {
  if (a.usdcCrossSignedToken !== b.usdcCrossSignedToken) return false;
  if (a.usdcIsolatedToken !== b.usdcIsolatedToken) return false;
  const am = a.spotSignedTokenByMarket;
  const bm = b.spotSignedTokenByMarket;
  const keys = new Set([...Object.keys(am), ...Object.keys(bm)]);
  for (const k of keys) {
    if ((am[Number(k)] ?? "0") !== (bm[Number(k)] ?? "0")) return false;
  }
  const pa = new Map<number, PerpPositionSnapshot>(
    a.perpPositions.map((p) => [p.marketIndex, p]),
  );
  const pb = new Map<number, PerpPositionSnapshot>(
    b.perpPositions.map((p) => [p.marketIndex, p]),
  );
  for (const m of new Set([...pa.keys(), ...pb.keys()])) {
    const x = pa.get(m);
    const y = pb.get(m);
    if (!x || !y) return false;
    if (x.baseAssetAmount !== y.baseAssetAmount) return false;
    if (x.quoteAssetAmount !== y.quoteAssetAmount) return false;
    if (x.quoteEntryAmount !== y.quoteEntryAmount) return false;
    if (x.quoteBreakEvenAmount !== y.quoteBreakEvenAmount) return false;
    if (x.settledPnl !== y.settledPnl) return false;
    if (x.lastCumulativeFundingRate !== y.lastCumulativeFundingRate)
      return false;
    if (x.lpShares !== y.lpShares) return false;
  }
  return true;
}

// --- build rows
type Row = {
  authority: string;
  presence: "both" | "t0_only" | "t1_only";
  t0Usd: BN;
  t1Usd: BN;
  diffUsd: BN;
  t0: BorrowLendAggregateSnapshot;
};
const auths = new Set<string>([
  ...Object.keys(t0.borrowLendByAuthority),
  ...Object.keys(t1.borrowLendByAuthority),
]);
const rows: Row[] = [];
for (const a of auths) {
  const a0 = t0.borrowLendByAuthority[a];
  const a1 = t1.borrowLendByAuthority[a];
  const agg0 = a0 ?? emptyAgg();
  const agg1 = a1 ?? emptyAgg();
  if (a0 && a1 && aggsEqual(agg0, agg1)) continue; // no change → not a recovery target

  const priced0 = valueBorrowLendAggregate(agg0, {
    ...valOpts0,
    contextLabel: `T0/${a}`,
  });
  const priced1 = valueBorrowLendAggregate(agg1, {
    ...valOpts1,
    contextLabel: `T1/${a}`,
  });
  const t0Usd = sumBorrowLendQuote(priced0);
  const t1Usd = sumBorrowLendQuote(priced1);

  rows.push({
    authority: a,
    presence: a0 && a1 ? "both" : a0 ? "t0_only" : "t1_only",
    t0Usd,
    t1Usd,
    diffUsd: t1Usd.sub(t0Usd),
    t0: agg0,
  });
}
rows.sort((a, b) => b.diffUsd.abs().cmp(a.diffUsd.abs()));

// --- write CSV
function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function buildSpotJson(agg: BorrowLendAggregateSnapshot): string {
  const arr: { market: number; signed_token: string }[] = [];
  for (const [k, v] of Object.entries(agg.spotSignedTokenByMarket)) {
    if (bn(v).eq(BN0)) continue;
    arr.push({ market: Number(k), signed_token: v });
  }
  arr.sort((a, b) => a.market - b.market);
  return JSON.stringify(arr);
}
function buildPerpJson(agg: BorrowLendAggregateSnapshot): string {
  const arr = agg.perpPositions
    .filter(
      (p) =>
        !bn(p.baseAssetAmount).eq(BN0) ||
        !bn(p.quoteAssetAmount).eq(BN0) ||
        !bn(p.settledPnl).eq(BN0) ||
        !bn(p.lpShares).eq(BN0),
    )
    .map((p) => ({
      market: p.marketIndex,
      base: p.baseAssetAmount,
      quote: p.quoteAssetAmount,
      entry: p.quoteEntryAmount,
      breakEven: p.quoteBreakEvenAmount,
      settledPnl: p.settledPnl,
      lastCumFR: p.lastCumulativeFundingRate,
      lpShares: p.lpShares,
    }));
  arr.sort((a, b) => a.market - b.market);
  return JSON.stringify(arr);
}

const cols = [
  "authority",
  "presence",
  "t0_usd",
  "t1_usd",
  "diff_usd",
  "t0_usdc_cross",
  "t0_usdc_isolated",
  "t0_spot",
  "t0_perp",
];
const lines = [cols.join(",")];
for (const r of rows) {
  lines.push(
    [
      r.authority,
      r.presence,
      quoteToUsd6(r.t0Usd),
      quoteToUsd6(r.t1Usd),
      quoteToUsd6(r.diffUsd),
      r.t0.usdcCrossSignedToken,
      r.t0.usdcIsolatedToken,
      csvEscape(buildSpotJson(r.t0)),
      csvEscape(buildPerpJson(r.t0)),
    ].join(","),
  );
}
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join("\n") + "\n");

// --- summary
let absSum = BN0;
let signedSum = BN0;
for (const r of rows) {
  absSum = absSum.add(r.diffUsd.abs());
  signedSum = signedSum.add(r.diffUsd);
}
console.log(`\nWrote ${rows.length} rows: ${outPath}`);
console.log(`Σ |diff|        = $${quoteToUsd6(absSum)}`);
console.log(`Σ  diff (t1−t0) = $${quoteToUsd6(signedSum)}`);
console.log(`\nTop 5 movers (biggest |diff|):`);
for (const r of rows.slice(0, 5)) {
  console.log(
    `  ${r.authority}  diff=$${quoteToUsd6(
      r.diffUsd,
    )}  t0=$${quoteToUsd6(r.t0Usd)} → t1=$${quoteToUsd6(r.t1Usd)}`,
  );
}
