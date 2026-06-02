/**
 * Per-authority audit trail of every reversal applied during the backtrack.
 *
 * One row per (authority, event, mutation). The signed deltas describe the
 * REVERSAL applied to the authority's state, so the row is directly
 * verifiable against the source event (trade / funding / liquidation /
 * referrer-clawback) on chain via the txsig.
 *
 * Schema (CSV, one file):
 *   authority,role,kind,slot,txsig,market_type,market_index,
 *   base_delta,quote_delta,usdc_delta,spot_market_index,spot_delta,note
 *
 * - kind: trade | funding | liquidation | referrer_clawback
 * - role: taker | maker | filler | user | liquidator | referrer
 * - All deltas are signed strings (BN.toString); empty = "0"/N/A
 * - market_type: perp | spot | "" (when not applicable)
 * - market_index: perp market index ("" if not applicable)
 * - spot_market_index: spot market index ("" if not applicable)
 * - note: optional human-readable hint (e.g. action_explanation, liquidation
 *   subkind, "if_fee_perp", "amm_surplus")
 */

import fs from "node:fs";
import type { BN } from "@drift-labs/sdk";

export type AuditRow = {
  authority: string;
  role:
    | "taker"
    | "maker"
    | "filler"
    | "user"
    | "liquidator"
    | "referrer"
    | "pool";
  kind:
    | "trade"
    | "funding"
    | "liquidation"
    | "referrer_clawback"
    | "settle_pnl"
    | "swap"
    | "bankruptcy_socialize";
  slot: number;
  txsig: string;
  marketType: "perp" | "spot" | "";
  marketIndex: number | "";
  baseDelta: BN | "0";
  quoteDelta: BN | "0";
  usdcDelta: BN | "0";
  spotMarketIndex: number | "";
  spotDelta: BN | "0";
  note: string;
};

export class AuditLog {
  private rows: AuditRow[] = [];

  add(row: AuditRow): void {
    this.rows.push(row);
  }

  /** Read-only access for reconciliation passes. */
  all(): readonly AuditRow[] {
    return this.rows;
  }

  /**
   * Write a single sorted CSV. Sorted by authority then slot then txsig so
   * `grep <authority>` returns that user's reversal history in chronological
   * order.
   */
  writeCsv(filePath: string): { totalRows: number; uniqueAuthorities: number } {
    this.rows.sort((a, b) => {
      if (a.authority !== b.authority)
        return a.authority.localeCompare(b.authority);
      if (a.slot !== b.slot) return a.slot - b.slot;
      return a.txsig.localeCompare(b.txsig);
    });

    const header =
      "authority,role,kind,slot,txsig,market_type,market_index,base_delta,quote_delta,usdc_delta,spot_market_index,spot_delta,note";
    const lines = [header];
    const auths = new Set<string>();
    for (const r of this.rows) {
      auths.add(r.authority);
      lines.push(
        [
          r.authority,
          r.role,
          r.kind,
          r.slot,
          r.txsig,
          r.marketType,
          r.marketIndex === "" ? "" : r.marketIndex,
          asString(r.baseDelta),
          asString(r.quoteDelta),
          asString(r.usdcDelta),
          r.spotMarketIndex === "" ? "" : r.spotMarketIndex,
          asString(r.spotDelta),
          r.note.replace(/[\r\n,]/g, " "),
        ].join(","),
      );
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    return { totalRows: this.rows.length, uniqueAuthorities: auths.size };
  }

  /**
   * Append to an existing CSV (preserves prior rows from earlier scripts).
   * No re-sort; caller should sort by authority externally if needed.
   */
  appendCsv(filePath: string): { appendedRows: number; uniqueAuthorities: number } {
    const auths = new Set<string>();
    const exists = fs.existsSync(filePath);
    const lines: string[] = [];
    if (!exists) {
      lines.push(
        "authority,role,kind,slot,txsig,market_type,market_index,base_delta,quote_delta,usdc_delta,spot_market_index,spot_delta,note",
      );
    }
    for (const r of this.rows) {
      auths.add(r.authority);
      lines.push(
        [
          r.authority,
          r.role,
          r.kind,
          r.slot,
          r.txsig,
          r.marketType,
          r.marketIndex === "" ? "" : r.marketIndex,
          asString(r.baseDelta),
          asString(r.quoteDelta),
          asString(r.usdcDelta),
          r.spotMarketIndex === "" ? "" : r.spotMarketIndex,
          asString(r.spotDelta),
          r.note.replace(/[\r\n,]/g, " "),
        ].join(","),
      );
    }
    fs.appendFileSync(filePath, lines.join("\n") + "\n");
    return { appendedRows: this.rows.length, uniqueAuthorities: auths.size };
  }
}

function asString(v: BN | "0"): string {
  if (v === "0") return "0";
  return v.toString(10);
}
