/**
 * Produce out/no_restoration_needed.csv — a single audit-friendly artifact
 * listing every entity that touched the attack window but does NOT need any
 * pre-incident state restoration, with the reason and $ value involved.
 *
 * Covers:
 *   1. swap.unknown_user      — closed sub-accounts (account doesn't exist on chain;
 *                                user already withdrew before T1)
 *   2. settle_pnl.unknown_user — settle PnL on an authority whose net change is
 *                                below the diff threshold (auth exists but state empty at T1)
 *   3. liquidation.unknown_liquidator — bankruptcy resolvers with liquidator_fee=0
 *   4. liquidation.unknown_user       — zero-value liquidate events
 *   5. trade.spot_fulfillment_fee     — Phoenix DEX fees that left the Drift ecosystem
 *
 * Columns:
 *   category, identifier, reason, event_count, usd_value, sample_txsig
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const anomaliesPath = path.resolve(
  __dirname,
  "out",
  "backtrack_anomalies.changed.log",
);
const tradesPath = path.resolve(__dirname, "out", "athena", "trades.csv");
const swapsPath = path.resolve(__dirname, "out", "athena", "swap.csv");
const liqsPath = path.resolve(__dirname, "out", "athena", "liq.csv");
const settlesPath = path.resolve(__dirname, "out", "athena", "settle_pnl.csv");
const oraclePath = path.resolve(
  __dirname,
  "oracle-prices",
  "pyth_oracle_prices-160600.csv",
);
const outPath = path.resolve(__dirname, "out", "no_restoration_needed.csv");

// --- load spot oracle (we need market 33 = JLP price for the swaps)
type OracleRow = { market_index: string; market_symbol: string; oracle_price: string; market_type?: string };
const oracleText = fs.readFileSync(oraclePath, "utf8");
const oracleRows = parse(oracleText, { columns: true, skip_empty_lines: true }) as OracleRow[];
const spotPrice = new Map<number, number>(); // marketIndex → USD per token
for (const r of oracleRows) {
  if (r.market_type === "spot" || /-1$/.test(r.market_symbol)) {
    spotPrice.set(Number(r.market_index), Number(r.oracle_price));
  }
}

function usd(n: number): string {
  return n.toFixed(6);
}
function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const anomalies = fs.readFileSync(anomaliesPath, "utf8").split("\n");
function txsigsFor(kind: string): Map<string, string> {
  // txsig → detail string
  const map = new Map<string, string>();
  for (const l of anomalies) {
    const c = l.split("\t");
    if (c[0] === kind) map.set(c[2], c[3] ?? "");
  }
  return map;
}

const rows: {
  category: string;
  identifier: string;
  reason: string;
  eventCount: number;
  usdValue: number;
  sampleTxsig: string;
}[] = [];

// --- 1. swap.unknown_user (3 closed sub-accounts)
{
  const txs = txsigsFor("swap.unknown_user");
  const swaps = parse(fs.readFileSync(swapsPath, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
  }) as Record<string, string>[];
  // group by user sub-account
  const bySub = new Map<string, { value: number; txs: string[] }>();
  for (const s of swaps) {
    if (!txs.has(s.txsig)) continue;
    const inMarket = Number(s.inmarketindex);
    const inAmount = Number(s.amountin); // raw (6-dec tokens for these)
    const price = spotPrice.get(inMarket) ?? 0;
    const value = (inAmount / 1_000_000) * price;
    const e = bySub.get(s.user) ?? { value: 0, txs: [] };
    e.value += value;
    e.txs.push(s.txsig);
    bySub.set(s.user, e);
  }
  for (const [sub, e] of bySub) {
    rows.push({
      category: "closed_subaccount",
      identifier: sub,
      reason: "account doesn't exist on chain — user swapped to USDC and withdrew before T1; no T1 state to restore",
      eventCount: e.txs.length,
      usdValue: e.value,
      sampleTxsig: e.txs[0],
    });
  }
}

// --- 2. settle_pnl.unknown_user
{
  const txs = txsigsFor("settle_pnl.unknown_user");
  const settles = parse(fs.readFileSync(settlesPath, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
  }) as Record<string, string>[];
  const bySub = new Map<string, { value: number; txs: string[] }>();
  for (const s of settles) {
    if (!txs.has(s.txsig)) continue;
    const value = Math.abs(Number(s.pnl)) / 1_000_000;
    const e = bySub.get(s.user) ?? { value: 0, txs: [] };
    e.value += value;
    e.txs.push(s.txsig);
    bySub.set(s.user, e);
  }
  for (const [sub, e] of bySub) {
    rows.push({
      category: "settle_below_diff_threshold",
      identifier: sub,
      reason: "authority resolved but T1 state is empty; net PnL settle too small to affect diff set",
      eventCount: e.txs.length,
      usdValue: e.value,
      sampleTxsig: e.txs[0],
    });
  }
}

// --- 3. liquidation.unknown_liquidator (bankruptcy resolvers, fee=0)
{
  const txs = txsigsFor("liquidation.unknown_liquidator");
  const liqs = parse(fs.readFileSync(liqsPath, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
  }) as Record<string, string>[];
  const byLiq = new Map<string, { count: number; txs: string[] }>();
  for (const l of liqs) {
    if (!txs.has(l.txsig)) continue;
    const e = byLiq.get(l.liquidator) ?? { count: 0, txs: [] };
    e.count += 1;
    e.txs.push(l.txsig);
    byLiq.set(l.liquidator, e);
  }
  for (const [liq, e] of byLiq) {
    rows.push({
      category: "bankruptcy_resolver",
      identifier: liq,
      reason: "acted as liquidator on *Bankruptcy events; liquidator_fee = 0 (program-level resolution, not fee-earning liquidation)",
      eventCount: e.count,
      usdValue: 0,
      sampleTxsig: e.txs[0],
    });
  }
}

// --- 4. liquidation.unknown_user (zero-value)
{
  const txs = txsigsFor("liquidation.unknown_user");
  for (const [tx] of txs) {
    rows.push({
      category: "zero_value_liquidation",
      identifier: tx,
      reason: "liquidateSpot/liquidatePerp with all-zero transfer fields; no value moved",
      eventCount: 1,
      usdValue: 0,
      sampleTxsig: tx,
    });
  }
}

// --- 5. trade.spot_fulfillment_fee (aggregate — recipient is external)
{
  const txs = txsigsFor("trade.spot_fulfillment_fee");
  const trades = parse(fs.readFileSync(tradesPath, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
  }) as Record<string, string>[];
  let totalFee = 0;
  let count = 0;
  let sample = "";
  for (const t of trades) {
    if (!txs.has(t.txsig)) continue;
    totalFee += Number(t.spotfulfillmentmethodfee || "0") / 1_000_000;
    count += 1;
    if (!sample) sample = t.txsig;
  }
  if (count > 0) {
    rows.push({
      category: "external_dex_fee",
      identifier: "phoenix",
      reason: "Phoenix DEX fulfillment fee left Drift to an external on-chain program; taker already refunded; recipient has no Drift authority",
      eventCount: count,
      usdValue: totalFee,
      sampleTxsig: sample,
    });
  }
}

// --- write CSV
rows.sort((a, b) => b.usdValue - a.usdValue);
const lines = [
  "category,identifier,reason,event_count,usd_value,sample_txsig",
  ...rows.map((r) =>
    [
      r.category,
      r.identifier,
      csvEscape(r.reason),
      r.eventCount,
      usd(r.usdValue),
      r.sampleTxsig,
    ].join(","),
  ),
];
fs.writeFileSync(outPath, lines.join("\n") + "\n");

const total = rows.reduce((s, r) => s + r.usdValue, 0);
console.log(`Wrote ${rows.length} rows: ${outPath}`);
console.log(`\nTotal value in 'no restoration needed' bucket: $${usd(total)}`);
for (const r of rows) {
  console.log(
    `  ${r.category.padEnd(28)} ${r.identifier.slice(0, 8).padEnd(10)} $${usd(
      r.usdValue,
    ).padStart(14)}  (${r.eventCount} ev)`,
  );
}
