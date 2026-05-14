import fs from "node:fs";
import { BN, PRICE_PRECISION } from "@drift-labs/sdk";
import { parse } from "csv-parse/sync";
import { Decimal } from "decimal.js";

/**
 * Two oracle CSV schemas are supported.
 *
 * Schema A — explicit market type (preferred):
 *   market_type,market_index,oracle_price[,error]
 *   spot,0,0.99985
 *   perp,0,83.39528527
 *
 * Schema B — pyth historical export (bundled in oracle-prices/):
 *   market_index,market_symbol,oracle_price
 *   The same `market_index` appears once per market type. Type is inferred
 *   from `market_symbol`: a `-PERP` suffix means perp, otherwise spot.
 */
type OraclePriceCsvRow = {
  market_type?: string;
  market_index?: string;
  market_symbol?: string;
  oracle_price?: string;
  error?: string;
};

function inferMarketType(row: OraclePriceCsvRow): "perp" | "spot" | null {
  const explicit = (row.market_type ?? "").trim().toLowerCase();
  if (explicit === "perp" || explicit === "spot") return explicit;
  const sym = (row.market_symbol ?? "").trim().toUpperCase();
  if (!sym) return null;
  return sym.endsWith("-PERP") ? "perp" : "spot";
}

export function loadOracleCloseByMarket(
  csvPath: string,
  marketType: "perp" | "spot",
): Map<number, BN> {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Oracle CSV not found: ${csvPath}`);
  }
  const raw = fs.readFileSync(csvPath, "utf8");
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true,
  }) as OraclePriceCsvRow[];

  const priceScale = new Decimal(PRICE_PRECISION.toString(10));
  const m = new Map<number, BN>();
  for (const row of records) {
    if (inferMarketType(row) !== marketType) continue;
    if (row.error && row.error.trim().length > 0) continue;
    const idxStr = row.market_index?.trim();
    const priceStr = row.oracle_price?.trim();
    if (!idxStr || !priceStr) continue;
    const idx = Number.parseInt(idxStr, 10);
    if (!Number.isFinite(idx)) continue;
    // Pyth export uses "N/A" for missing prices; skip rather than crash.
    if (priceStr.toUpperCase() === "N/A") continue;
    const d = new Decimal(priceStr);
    if (!d.isFinite()) continue;
    const priceBn = new BN(d.mul(priceScale).floor().toFixed(0), 10);
    m.set(idx, priceBn);
  }
  return m;
}
