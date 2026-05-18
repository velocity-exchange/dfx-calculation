/**
 * Diff per-authority positions between two snapshots (T0 = pre-attack /
 * backtracked, T1 = post-attack / on-chain). Output: only the authorities
 * whose positions changed, with USD valuations using ONE oracle set (so the
 * diff captures balance changes, not mark-to-market price drift).
 *
 * Run:
 *   bun ./diff-snapshots.ts \
 *     --t0 ./out/base_snapshot_backtracked.json \
 *     --t1 ./out/base_snapshot.json \
 *     --oracle-csv ./oracle-prices/pyth_oracle_prices-160600.csv \
 *     --output ./out/snapshot_diff.csv
 *
 * If --oracle-csv is omitted, the diff is token-only (no USD column).
 *
 * Output columns:
 *   authority, changed_buckets, t0_usd, t1_usd, diff_usd, components_json
 *
 * `diff_usd = t1_usd - t0_usd` — negative means the user's position value
 * shrank between T0 and T1 (i.e. they lost during the window).
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

const t0Path =
  getFlag("--t0") ??
  path.resolve(__dirname, "out", "base_snapshot_backtracked.json");
const t1Path =
  getFlag("--t1") ?? path.resolve(__dirname, "out", "base_snapshot.json");
const oracleCsv = getFlag("--oracle-csv");
const outPath =
  getFlag("--output") ?? path.resolve(__dirname, "out", "snapshot_diff.csv");

if (!fs.existsSync(t0Path)) throw new Error(`T0 snapshot not found: ${t0Path}`);
if (!fs.existsSync(t1Path)) throw new Error(`T1 snapshot not found: ${t1Path}`);

console.log(`T0 (pre-attack):  ${t0Path}`);
console.log(`T1 (post-attack): ${t1Path}`);
console.log(`oracle:           ${oracleCsv ?? "(none — token-only diff)"}`);

const t0 = JSON.parse(fs.readFileSync(t0Path, "utf8")) as Snapshot;
const t1 = JSON.parse(fs.readFileSync(t1Path, "utf8")) as Snapshot;

const valueOpts: Omit<ValueOptions, "contextLabel"> | null = oracleCsv
  ? {
      spotPricesByMarket: loadOracleCloseByMarket(oracleCsv, "spot"),
      perpOracleByMarket: loadOracleCloseByMarket(oracleCsv, "perp"),
      // Use T0 market metadata (cumulative funding rates) for T0 PnL math and
      // T1 metadata for T1. Markets list is the union so per-side lookup is
      // exact.
      spotMarkets: t0.spotMarkets,
      perpMarkets: t0.perpMarkets,
      requirePerpOracleCsv: false,
    }
  : null;

const valueOptsT1: Omit<ValueOptions, "contextLabel"> | null = valueOpts
  ? { ...valueOpts, spotMarkets: t1.spotMarkets, perpMarkets: t1.perpMarkets }
  : null;

// ---------------------------------------------------------------------------

type PerpDelta = {
  marketIndex: number;
  baseDelta: string;
  quoteDelta: string;
  settledPnlDelta: string;
  lpSharesDelta: string;
};

type SpotDelta = {
  marketIndex: number;
  delta: string;
};

type AuthorityDiff = {
  authority: string;
  t0Present: boolean;
  t1Present: boolean;
  usdcCrossDelta: string;       // t1 - t0
  usdcIsolatedDelta: string;    // t1 - t0
  spot: SpotDelta[];            // non-quote spot tokens that changed
  perp: PerpDelta[];            // perp positions that changed
};

function bnFromAgg(s: string | undefined): BN {
  return strToBn(s ?? "0");
}

function emptyAgg(): BorrowLendAggregateSnapshot {
  return {
    spotSignedTokenByMarket: {},
    usdcCrossSignedToken: "0",
    usdcIsolatedToken: "0",
    perpPositions: [],
  };
}

function perpKey(p: PerpPositionSnapshot): number {
  return p.marketIndex;
}

function diffAuthority(
  auth: string,
  a0: BorrowLendAggregateSnapshot | undefined,
  a1: BorrowLendAggregateSnapshot | undefined,
): AuthorityDiff | null {
  const agg0 = a0 ?? emptyAgg();
  const agg1 = a1 ?? emptyAgg();

  const usdcCross = bnFromAgg(agg1.usdcCrossSignedToken).sub(
    bnFromAgg(agg0.usdcCrossSignedToken),
  );
  const usdcIso = bnFromAgg(agg1.usdcIsolatedToken).sub(
    bnFromAgg(agg0.usdcIsolatedToken),
  );

  const spotMarkets = new Set<number>([
    ...Object.keys(agg0.spotSignedTokenByMarket).map(Number),
    ...Object.keys(agg1.spotSignedTokenByMarket).map(Number),
  ]);
  const spot: SpotDelta[] = [];
  for (const m of [...spotMarkets].sort((x, y) => x - y)) {
    const d = bnFromAgg(agg1.spotSignedTokenByMarket[m]).sub(
      bnFromAgg(agg0.spotSignedTokenByMarket[m]),
    );
    if (!d.eq(BN0)) spot.push({ marketIndex: m, delta: d.toString(10) });
  }

  const perpByMarket0 = new Map<number, PerpPositionSnapshot>();
  for (const p of agg0.perpPositions) perpByMarket0.set(perpKey(p), p);
  const perpByMarket1 = new Map<number, PerpPositionSnapshot>();
  for (const p of agg1.perpPositions) perpByMarket1.set(perpKey(p), p);
  const perpMarkets = new Set<number>([
    ...perpByMarket0.keys(),
    ...perpByMarket1.keys(),
  ]);
  const perp: PerpDelta[] = [];
  for (const m of [...perpMarkets].sort((x, y) => x - y)) {
    const p0 = perpByMarket0.get(m);
    const p1 = perpByMarket1.get(m);
    const base0 = strToBn(p0?.baseAssetAmount ?? "0");
    const base1 = strToBn(p1?.baseAssetAmount ?? "0");
    const quote0 = strToBn(p0?.quoteAssetAmount ?? "0");
    const quote1 = strToBn(p1?.quoteAssetAmount ?? "0");
    const pnl0 = strToBn(p0?.settledPnl ?? "0");
    const pnl1 = strToBn(p1?.settledPnl ?? "0");
    const lp0 = strToBn(p0?.lpShares ?? "0");
    const lp1 = strToBn(p1?.lpShares ?? "0");
    const baseD = base1.sub(base0);
    const quoteD = quote1.sub(quote0);
    const pnlD = pnl1.sub(pnl0);
    const lpD = lp1.sub(lp0);
    if (baseD.eq(BN0) && quoteD.eq(BN0) && pnlD.eq(BN0) && lpD.eq(BN0)) continue;
    perp.push({
      marketIndex: m,
      baseDelta: baseD.toString(10),
      quoteDelta: quoteD.toString(10),
      settledPnlDelta: pnlD.toString(10),
      lpSharesDelta: lpD.toString(10),
    });
  }

  if (
    usdcCross.eq(BN0) &&
    usdcIso.eq(BN0) &&
    spot.length === 0 &&
    perp.length === 0
  ) {
    return null;
  }

  return {
    authority: auth,
    t0Present: a0 !== undefined,
    t1Present: a1 !== undefined,
    usdcCrossDelta: usdcCross.toString(10),
    usdcIsolatedDelta: usdcIso.toString(10),
    spot,
    perp,
  };
}

const authorities = new Set<string>([
  ...Object.keys(t0.borrowLendByAuthority),
  ...Object.keys(t1.borrowLendByAuthority),
]);
console.log(`\nComparing ${authorities.size} authorities (union T0 ∪ T1)`);

const diffs: AuthorityDiff[] = [];
for (const auth of authorities) {
  const d = diffAuthority(
    auth,
    t0.borrowLendByAuthority[auth],
    t1.borrowLendByAuthority[auth],
  );
  if (d) diffs.push(d);
}
console.log(`  changed:   ${diffs.length}`);
console.log(`  unchanged: ${authorities.size - diffs.length}`);

// ---------------------------------------------------------------------------
// USD valuation for the changed set (same oracle, both sides).

function quoteToUsd6(q: BN): string {
  return new Decimal(q.toString(10)).div(1_000_000).toFixed(6);
}

const usdByAuth = new Map<string, { t0: BN; t1: BN; diff: BN }>();
if (valueOpts && valueOptsT1) {
  for (const d of diffs) {
    const a0 = t0.borrowLendByAuthority[d.authority] ?? emptyAgg();
    const a1 = t1.borrowLendByAuthority[d.authority] ?? emptyAgg();
    const priced0 = valueBorrowLendAggregate(a0, {
      ...valueOpts,
      contextLabel: `T0/${d.authority}`,
    });
    const priced1 = valueBorrowLendAggregate(a1, {
      ...valueOptsT1,
      contextLabel: `T1/${d.authority}`,
    });
    const t0Q = sumBorrowLendQuote(priced0);
    const t1Q = sumBorrowLendQuote(priced1);
    usdByAuth.set(d.authority, { t0: t0Q, t1: t1Q, diff: t1Q.sub(t0Q) });
  }
}

// Sort by |diff_usd| desc when available, else by spot+perp bucket count.
diffs.sort((a, b) => {
  if (usdByAuth.size > 0) {
    const da = usdByAuth.get(a.authority)!.diff.abs();
    const db = usdByAuth.get(b.authority)!.diff.abs();
    return db.cmp(da);
  }
  return b.spot.length + b.perp.length - (a.spot.length + a.perp.length);
});

// ---------------------------------------------------------------------------
// Write CSV.

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const cols = [
  "authority",
  "presence",
  "changed_buckets",
  "t0_usd",
  "t1_usd",
  "diff_usd",
  "components_json",
];
const lines = [cols.join(",")];

for (const d of diffs) {
  const buckets: string[] = [];
  if (d.usdcCrossDelta !== "0") buckets.push("usdc_cross");
  if (d.usdcIsolatedDelta !== "0") buckets.push("usdc_isolated");
  if (d.spot.length > 0) buckets.push(`spot[${d.spot.map((s) => s.marketIndex).join(",")}]`);
  if (d.perp.length > 0) buckets.push(`perp[${d.perp.map((p) => p.marketIndex).join(",")}]`);

  const usd = usdByAuth.get(d.authority);
  const presence =
    d.t0Present && d.t1Present
      ? "both"
      : d.t0Present
      ? "t0_only"
      : "t1_only";

  const components = {
    usdcCrossDelta: d.usdcCrossDelta,
    usdcIsolatedDelta: d.usdcIsolatedDelta,
    spot: d.spot,
    perp: d.perp,
  };

  lines.push(
    [
      d.authority,
      presence,
      csvEscape(buckets.join(" ")),
      usd ? quoteToUsd6(usd.t0) : "",
      usd ? quoteToUsd6(usd.t1) : "",
      usd ? quoteToUsd6(usd.diff) : "",
      csvEscape(JSON.stringify(components)),
    ].join(","),
  );
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join("\n") + "\n");

console.log(`\nWrote ${diffs.length} rows: ${outPath}`);

if (usdByAuth.size > 0) {
  let totalAbsDiff = BN0;
  let signedDiff = BN0;
  for (const v of usdByAuth.values()) {
    totalAbsDiff = totalAbsDiff.add(v.diff.abs());
    signedDiff = signedDiff.add(v.diff);
  }
  console.log(`\nUSD summary (oracle: ${path.basename(oracleCsv!)})`);
  console.log(`  Σ |diff|       = $${quoteToUsd6(totalAbsDiff)}`);
  console.log(`  Σ  diff (t1−t0)= $${quoteToUsd6(signedDiff)}`);
  console.log(`  top 5:`);
  for (const d of diffs.slice(0, 5)) {
    const u = usdByAuth.get(d.authority)!;
    console.log(
      `    ${d.authority}  diff=$${quoteToUsd6(u.diff)}  (t0=$${quoteToUsd6(
        u.t0,
      )} → t1=$${quoteToUsd6(u.t1)})`,
    );
  }
}
