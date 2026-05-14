/**
 * Run:
 *   bun ./stats.ts [--input ./out/authority_notional.csv]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

// revalue.ts writes total_notional via Decimal.toFixed(6), so every value is
// "[-]N.NNNNNN" — stripping the "." yields an exact micro-USD BigInt.
function toMicros(s: string): bigint {
  return BigInt(s.replace(".", ""));
}

function formatMicros(micros: bigint): string {
  const neg = micros < 0n;
  const abs = neg ? -micros : micros;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

const input =
  getFlag("--input") ??
  path.resolve(__dirname, "out", "authority_notional.csv");

const rows = parse(fs.readFileSync(input, "utf8"), {
  columns: true,
  skip_empty_lines: true,
}) as Array<{ total_notional: string }>;

let sumMicros = 0n;
let subDollarPositive = 0;
let negative = 0;
let atLeastOne = 0;
let zero = 0;

for (const r of rows) {
  const m = toMicros(r.total_notional);
  sumMicros += m;
  if (m < 0n) negative++;
  else if (m === 0n) zero++;
  else if (m < 1_000_000n) subDollarPositive++;
  else atLeastOne++;
}

console.log(`Input: ${input}`);
console.log(`Authorities: ${rows.length}`);
console.log(`Sum of total_notional: $${formatMicros(sumMicros)}`);
console.log(`Authorities with 0 < total < $1:    ${subDollarPositive}`);
console.log(`Authorities with total < $0:        ${negative}`);
console.log(`Authorities with total >= $1:       ${atLeastOne}`);
console.log(`Authorities with total == $0:       ${zero}`);
