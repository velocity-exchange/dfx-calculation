/**
 * Per-authority refund computation.
 *
 * Reads two `authority_notional` CSVs produced by `revalue.ts` against the
 * SAME oracle (T0 oracle for both sides) and emits per-authority:
 *
 *   refund_usd = t0_total − t1_total
 *
 * Positive → user lost value during the window, owe them.
 * Negative → user gained value during the window, claw back.
 *
 * Reading at the same oracle for both sides means price moves don't pollute
 * the diff — every dollar of refund is a balance change, not a mark.
 *
 * Run:
 *   bun ./compute-refunds.ts                      # uses defaults below
 *   bun ./compute-refunds.ts \
 *     --t0 ./out/authority_notional_t0.csv \
 *     --t1 ./out/authority_notional_t1_at_t0_oracle.csv \
 *     --output ./out/refunds.csv \
 *     --dust 0.01                                # |refund| below this is dropped
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

const t0Path =
  getFlag("--t0") ?? path.resolve(__dirname, "out", "authority_notional_t0.csv");
const t1Path =
  getFlag("--t1") ??
  path.resolve(__dirname, "out", "authority_notional_t1_at_t0_oracle.csv");
const outPath =
  getFlag("--output") ?? path.resolve(__dirname, "out", "refunds.csv");
const dust = Number(getFlag("--dust") ?? "0.01"); // $0.01 default

type Row = {
  authority: string;
  total_notional: string;
  borrow_lend_total: string;
  vaults_total: string;
};
function load(p: string): Map<string, Row> {
  const txt = fs.readFileSync(p, "utf8");
  const rows = parse(txt, { columns: true, skip_empty_lines: true }) as Row[];
  const m = new Map<string, Row>();
  for (const r of rows) m.set(r.authority, r);
  return m;
}

console.log(`T0: ${t0Path}`);
console.log(`T1: ${t1Path}`);
console.log(`dust threshold: $${dust}`);

const t0 = load(t0Path);
const t1 = load(t1Path);
const auths = new Set<string>([...t0.keys(), ...t1.keys()]);

type Out = {
  authority: string;
  presence: "both" | "t0_only" | "t1_only";
  t0_total: number;
  t1_total: number;
  refund_usd: number;
  t0_borrow_lend: number;
  t1_borrow_lend: number;
  refund_borrow_lend: number;
  t0_vaults: number;
  t1_vaults: number;
  refund_vaults: number;
};

const results: Out[] = [];
for (const a of auths) {
  const r0 = t0.get(a);
  const r1 = t1.get(a);
  const t0_total = Number(r0?.total_notional ?? "0");
  const t1_total = Number(r1?.total_notional ?? "0");
  const t0_bl = Number(r0?.borrow_lend_total ?? "0");
  const t1_bl = Number(r1?.borrow_lend_total ?? "0");
  const t0_v = Number(r0?.vaults_total ?? "0");
  const t1_v = Number(r1?.vaults_total ?? "0");
  const refund_usd = t0_total - t1_total;
  if (Math.abs(refund_usd) < dust) continue;
  results.push({
    authority: a,
    presence: r0 && r1 ? "both" : r0 ? "t0_only" : "t1_only",
    t0_total,
    t1_total,
    refund_usd,
    t0_borrow_lend: t0_bl,
    t1_borrow_lend: t1_bl,
    refund_borrow_lend: t0_bl - t1_bl,
    t0_vaults: t0_v,
    t1_vaults: t1_v,
    refund_vaults: t0_v - t1_v,
  });
}
results.sort((a, b) => Math.abs(b.refund_usd) - Math.abs(a.refund_usd));

const cols = [
  "authority",
  "presence",
  "t0_total",
  "t1_total",
  "refund_usd",
  "t0_borrow_lend",
  "t1_borrow_lend",
  "refund_borrow_lend",
  "t0_vaults",
  "t1_vaults",
  "refund_vaults",
];
const fmt = (n: number) => n.toFixed(6);
const lines = [cols.join(",")];
for (const r of results) {
  lines.push(
    [
      r.authority,
      r.presence,
      fmt(r.t0_total),
      fmt(r.t1_total),
      fmt(r.refund_usd),
      fmt(r.t0_borrow_lend),
      fmt(r.t1_borrow_lend),
      fmt(r.refund_borrow_lend),
      fmt(r.t0_vaults),
      fmt(r.t1_vaults),
      fmt(r.refund_vaults),
    ].join(","),
  );
}
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join("\n") + "\n");

// --- summary
let absSum = 0;
let signedSum = 0;
let owed = 0; // refunds we owe (positive)
let clawback = 0; // negative refunds (user gained)
let nOwed = 0;
let nClaw = 0;
for (const r of results) {
  absSum += Math.abs(r.refund_usd);
  signedSum += r.refund_usd;
  if (r.refund_usd > 0) {
    owed += r.refund_usd;
    nOwed++;
  } else {
    clawback += -r.refund_usd;
    nClaw++;
  }
}
console.log(`\nWrote ${results.length} rows: ${outPath}`);
console.log(`Σ |refund|     = $${absSum.toFixed(2)}`);
console.log(
  `Σ  refund      = $${signedSum.toFixed(2)}   (net flow — should equal IF drain)`,
);
console.log(`Owed to users  = $${owed.toFixed(2)}  (${nOwed} authorities)`);
console.log(`Clawback       = $${clawback.toFixed(2)}  (${nClaw} authorities)`);
console.log(`\nTop 10 refunds (biggest |refund|):`);
for (const r of results.slice(0, 10)) {
  console.log(
    `  ${r.authority}  refund=$${r.refund_usd.toFixed(2).padStart(13)}  t0=$${r.t0_total.toFixed(2)} → t1=$${r.t1_total.toFixed(2)}  [${r.presence}]`,
  );
}
