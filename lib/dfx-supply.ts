/**
 * DFX total-supply inputs.
 *
 * Total DFX supply has two equivalent decompositions:
 *
 *   by source:     total = attackers_withdrawn + remaining_spot_balance
 *   by ownership:  total = users_owned        + protocol_owned
 *
 * This module loads the two *source* terms so `revalue.ts` can compute the
 * total and, from it, the protocol-owned residual (total − users_owned) it
 * attributes to the protocol wallet:
 *
 *   - `attackers_withdrawn`     — `sumNotionalWithdrawn` from the
 *     `attacker-withdrawals.ts` JSON (already a USD figure).
 *   - `remaining_spot_balance`  — the per-market token amounts left in each
 *     spot vault (`spot-balances.ts` CSV), valued in USD against the same spot
 *     oracle set revalue prices everything else with.
 *
 * All USD figures are carried as quote BNs in `QUOTE_PRECISION` (1e6 = micro-USD),
 * matching the rest of the revalue pipeline.
 */

import fs from "node:fs";
import { BN, getTokenValue } from "@drift-labs/sdk";
import { parse } from "csv-parse/sync";
import { Decimal } from "decimal.js";

const BN0 = new BN(0);
const QUOTE_PER_USD = new Decimal(1_000_000);

/** Convert a decimal USD string (e.g. "295415654.150781") to a quote BN (micro-USD). */
export function usdToQuote(usd: string): BN {
  const d = new Decimal(usd.trim());
  if (!d.isFinite()) throw new Error(`Invalid USD amount: "${usd}"`);
  // Truncate to whole micro-USD; the source figures already carry 6 decimals.
  return new BN(d.mul(QUOTE_PER_USD).toFixed(0, Decimal.ROUND_DOWN), 10);
}

/**
 * Read `sumNotionalWithdrawn` (USD) from an attacker-withdrawals JSON report and
 * return it as a quote BN. This is the total notional the attackers withdrew,
 * already excluding the scam-token markets (63/64/65) by construction of
 * that report.
 */
export function readAttackerWithdrawnQuote(jsonPath: string): {
  quote: BN;
  usd: string;
} {
  const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const usd = report?.sumNotionalWithdrawn;
  if (typeof usd !== "string") {
    throw new Error(
      `Attacker-withdrawals JSON ${jsonPath} is missing a string ` +
        `"sumNotionalWithdrawn" field.`,
    );
  }
  return { quote: usdToQuote(usd), usd };
}

export type SpotBalanceRow = {
  marketIndex: number;
  decimals: number;
  /** Raw token units remaining in the market's deposit vault (incl. admin adj). */
  remainingRaw: BN;
};

/**
 * Load the per-market remaining balances from a `spot-balances.ts` CSV. Reads
 * `marketIndex`, `decimals`, and `remainingBalance` (raw base units); other
 * columns are ignored. Scam markets are already excluded by that script.
 */
export function loadSpotBalances(csvPath: string): SpotBalanceRow[] {
  const raw = fs.readFileSync(csvPath, "utf8");
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  const rows: SpotBalanceRow[] = [];
  for (const rec of records) {
    const marketIndex = Number.parseInt(rec.marketIndex ?? "", 10);
    const decimals = Number.parseInt(rec.decimals ?? "", 10);
    const remainingStr = (rec.remainingBalance ?? "").trim();
    if (!Number.isFinite(marketIndex) || !Number.isFinite(decimals)) continue;
    if (!/^-?\d+$/.test(remainingStr)) continue;
    rows.push({
      marketIndex,
      decimals,
      remainingRaw: new BN(remainingStr, 10),
    });
  }
  return rows;
}

export type RemainingSpotValue = {
  /** Total USD value of the remaining spot balance (quote BN, micro-USD). */
  totalQuote: BN;
  /** Per-market USD value (quote BN). */
  perMarketQuote: Map<number, BN>;
  /** Markets present in the CSV but missing a spot oracle price (skipped). */
  missingPrice: number[];
};

/**
 * Value each market's remaining token balance in USD using the spot oracle
 * prices already loaded by revalue (`PRICE_PRECISION` BNs). Markets without a
 * price are skipped and reported in `missingPrice`.
 */
export function valueRemainingSpot(
  rows: SpotBalanceRow[],
  spotPricesByMarket: Map<number, BN>,
): RemainingSpotValue {
  let totalQuote = BN0;
  const perMarketQuote = new Map<number, BN>();
  const missingPrice: number[] = [];

  for (const r of rows) {
    if (r.remainingRaw.isZero()) {
      perMarketQuote.set(r.marketIndex, BN0);
      continue;
    }
    const price = spotPricesByMarket.get(r.marketIndex);
    if (!price) {
      missingPrice.push(r.marketIndex);
      continue;
    }
    const value = getTokenValue(r.remainingRaw, r.decimals, { price });
    perMarketQuote.set(r.marketIndex, value);
    totalQuote = totalQuote.add(value);
  }

  return { totalQuote, perMarketQuote, missingPrice };
}
