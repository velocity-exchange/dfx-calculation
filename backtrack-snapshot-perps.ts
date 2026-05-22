/**
 * Backtrack the trading layer of a snapshot to a pre-attack state.
 *
 *   base_snapshot.json + trade.csv + funding.csv + liquidation.csv
 *                      + settle_pnl.csv + swap.csv + funding_rate.csv
 *                                  ↓
 *   base_snapshot_backtracked.json
 *   backtrack_audit_trail.csv         (per-authority + pool counterparty rows)
 *   backtrack_reconciliation.tsv      (zero-sum invariant proof)
 *   market_state_deltas.json          (vAMM/spot-market deltas for on-chain restore)
 *   backtrack_anomalies.log
 *
 * Reverses, per affected authority:
 *   - all perp & spot fills in the attack window (positions, fees, filler reward)
 *   - all funding-payment settlements (quoteAssetAmount delta)
 *   - all liquidation-record charges (liquidator fee + IF fee, plus spot
 *     transfers, cross-market pnl transfers, and bankruptcy clawbacks)
 *   - all settle_pnl events (quote ↔ usdc cross moves)
 *   - all spot swap events (out/in spot legs)
 *   - bankruptcy socialization: per-holder credit for cumulative funding /
 *     deposit-interest deltas attributable to in-window bankruptcies
 *   - referrer reward clawback (when `--rpc-url` is provided): for every trade
 *     with non-zero referrerReward, fetches each unique taker authority's
 *     UserStats to find the referrer, then debits the referrer's USDC by the
 *     total reward they received from in-window trades.
 *
 * Every refund posts a matching pool counterparty (audit `role=pool`,
 * authority `__pool_<bucket>`) so the audit log sums to zero per asset.
 * Reconciliation TSV makes the invariant explicit:
 *   - Σ USDC deltas (usdcDelta + quoteDelta + spotDelta(market=0)) == 0
 *   - Σ perp baseDelta within each perp market           == 0
 *   - Σ spot spotDelta within each non-USDC spot market  == 0
 *
 * Deposits, withdrawals, and spot interest accrual are NOT reversed — per the
 * user instruction those are real economic activity and stand on resume.
 *
 * Limitations (surfaced in summary; see anomalies log for per-event detail):
 *   1. Snapshot is aggregated by authority. An authority with multiple
 *      sub-accounts in the same market is collapsed (summed) before reversal
 *      because the snapshot drops sub-account identity.
 *   2. `referrerreward` exists on trade rows but the referrer authority is not
 *      in the record — those rewards are NOT reversed, only counted.
 *   3. AMM `cumulativeFundingRate{Long,Short}` reset is best-effort: position
 *      `lastCumulativeFundingRate` is realigned to the market's snapshot
 *      cumulative funding rate so pending funding evaluates to zero. Restoring
 *      the true T0 AMM cumulative-funding-rate requires `update_funding_rate`
 *      event records (not in the three input tables).
 *   4. LP per-share accounting (`lastBaseAssetAmountPerLp`,
 *      `lastQuoteAssetAmountPerLp`) is left as-is. Trade records don't carry
 *      per-LP deltas; precise LP restoration needs additional event data.
 *   5. vAMM / Phoenix counterparty state isn't tracked in the snapshot, so
 *      one-sided fills (AMM, Phoenix) only mutate the user side.
 *
 * Run:
 *   bun ./backtrack-snapshot-perps.ts \
 *     --snapshot ./out/base_snapshot.json \
 *     --users-json ./users.json \
 *     --trades-csv ./out/athena/trades.csv \
 *     --funding-csv ./out/athena/funding.csv \
 *     --liquidations-csv ./out/athena/liq.csv \
 *     --cutoff-slot 410344005 \
 *     --rpc-url <RPC_URL> \
 *     --output ./out/base_snapshot_backtracked.json
 *
 * Pass `--skip-referrer-clawback` to skip the referrer step (e.g. fast
 * iteration on the reversal logic without RPC).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "@coral-xyz/anchor";
import {
  BN,
  BulkAccountLoader,
  DriftClient,
  getUserStatsAccountPublicKey,
} from "@drift-labs/sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { readUserAccountsJson } from "./lib/pipeline-json.ts";
import {
  bnToStr,
  stableJsonStringify,
  strToBn,
  type BorrowLendAggregateSnapshot,
  type PerpPositionSnapshot,
  type Snapshot,
} from "./lib/snapshot-types.ts";
import {
  loadFundingEvents,
  loadLiquidationEvents,
  loadSettlePnlEvents,
  loadSwapEvents,
  loadTradeEvents,
  type AnyEvent,
  type FundingEvent,
  type LiquidationEvent,
  type SettlePnlEvent,
  type SwapEvent,
  type TradeEvent,
} from "./lib/backtrack-events.ts";
import { AuditLog, type AuditRow } from "./lib/audit-log.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BN0 = new BN(0);

const QUOTE_SPOT_MARKET_INDEX = 0;
const DEFAULT_CUTOFF_SLOT = 410_344_005;
const DEFAULT_WINDOW_END_SLOT = 410_366_402;
const DRIFT_PROGRAM_ID = new PublicKey(
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH",
);
const ZERO_PUBKEY = PublicKey.default.toBase58();

// Forward funding payment in QUOTE_PRECISION: delta_cumFR * |base| / (FUNDING_RATE_BUFFER * AMM_RESERVE_PRECISION)
// = delta * |base| / (1e3 * 1e9) = delta * |base| / 1e12
const FUNDING_PAYMENT_DIVISOR = new BN(10).pow(new BN(12));

// Synthetic counterparty pseudo-authorities. Anything starting with `__pool_`
// is a closing-entry bucket — never written into the snapshot, only used in
// the audit log so per-asset sums close to zero. The names are sortable so
// `sort` puts them at the top of the audit CSV.
const POOL_PROTOCOL_FEE = "__pool_protocol_fee"; // net of taker/maker fees minus filler/referrer
const POOL_IF = "__pool_insurance_fund"; // IF fees + IF bankruptcy payouts
const POOL_AMM_PERP = "__pool_amm_perp"; // AMM-as-counterparty for perp fills
const POOL_AMM_SPOT = "__pool_amm_spot"; // AMM-as-counterparty for spot fills + swaps
const POOL_AMM_FUNDING = "__pool_amm_funding"; // AMM-as-counterparty for funding settlements
const POOL_PHOENIX_FEE = "__pool_phoenix_fee"; // external venue (Phoenix/Serum) spot fees
const POOL_SWAP_FEE = "__pool_swap_fee"; // swap fees
const POOL_BANKRUPTCY = "__pool_bankruptcy_socialization"; // residual unpaid socialization
const POOL_AUTHORITIES = new Set([
  POOL_PROTOCOL_FEE,
  POOL_IF,
  POOL_AMM_PERP,
  POOL_AMM_SPOT,
  POOL_AMM_FUNDING,
  POOL_PHOENIX_FEE,
  POOL_SWAP_FEE,
  POOL_BANKRUPTCY,
]);

type CliFlags = {
  snapshot: string;
  usersJson: string;
  tradesCsv: string;
  fundingCsv: string;
  liquidationsCsv: string;
  settlePnlCsv: string;
  swapCsv: string;
  fundingRateCsv: string;
  cutoffSlot: number;
  windowEndSlot: number;
  cutoffTs: number; // used only for metadata
  output: string;
  anomaliesPath: string;
  auditPath: string;
  reconciliationPath: string;
  marketStateDeltasPath: string;
  tradeMonthsLabel: string;
  rpcUrl: string;
  skipReferrerClawback: boolean;
};

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

function getNumFlag(name: string, def: number): number {
  const v = getFlag(name);
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function parseFlags(): CliFlags {
  const flags: CliFlags = {
    snapshot:
      getFlag("--snapshot") ??
      path.resolve(__dirname, "out", "base_snapshot.json"),
    usersJson:
      getFlag("--users-json") ?? path.resolve(__dirname, "users.json"),
    tradesCsv:
      getFlag("--trades-csv") ??
      path.resolve(__dirname, "out", "athena", "trades.csv"),
    fundingCsv:
      getFlag("--funding-csv") ??
      path.resolve(__dirname, "out", "athena", "funding.csv"),
    liquidationsCsv:
      getFlag("--liquidations-csv") ??
      path.resolve(__dirname, "out", "athena", "liq.csv"),
    settlePnlCsv:
      getFlag("--settle-pnl-csv") ??
      path.resolve(__dirname, "out", "athena", "settle_pnl.csv"),
    swapCsv:
      getFlag("--swap-csv") ??
      path.resolve(__dirname, "out", "athena", "swap.csv"),
    fundingRateCsv:
      getFlag("--funding-rate-csv") ??
      path.resolve(__dirname, "out", "athena", "funding_rate.csv"),
    cutoffSlot: getNumFlag("--cutoff-slot", DEFAULT_CUTOFF_SLOT),
    windowEndSlot: getNumFlag("--window-end-slot", DEFAULT_WINDOW_END_SLOT),
    cutoffTs: getNumFlag("--cutoff-ts", 0),
    output:
      getFlag("--output") ??
      path.resolve(__dirname, "out", "base_snapshot_backtracked.json"),
    anomaliesPath:
      getFlag("--anomalies") ??
      path.resolve(__dirname, "out", "backtrack_anomalies.log"),
    auditPath:
      getFlag("--audit") ??
      path.resolve(__dirname, "out", "backtrack_audit_trail.csv"),
    reconciliationPath:
      getFlag("--reconciliation") ??
      path.resolve(__dirname, "out", "backtrack_reconciliation.tsv"),
    marketStateDeltasPath:
      getFlag("--market-state-deltas") ??
      path.resolve(__dirname, "out", "market_state_deltas.json"),
    tradeMonthsLabel: getFlag("--trade-months-label") ?? "2026-04",
    rpcUrl: getFlag("--rpc-url") ?? process.env.RPC_URL ?? "",
    skipReferrerClawback: process.argv.includes("--skip-referrer-clawback"),
  };
  return flags;
}

// --- in-memory authority state ---------------------------------------------

export type AuthorityState = {
  spotSignedTokenByMarket: Map<number, BN>;
  usdcCrossSignedToken: BN;
  usdcIsolatedToken: BN;
  // (marketIndex) → mutable position. Multiple sub-account entries on the same
  // market are collapsed here; collapse counts are tracked separately.
  perpByMarket: Map<number, PerpPositionMut>;
  // Carried through but never mutated: vault-attribution etc.
};

export type PerpPositionMut = {
  marketIndex: number;
  baseAssetAmount: BN;
  quoteAssetAmount: BN;
  quoteEntryAmount: BN;
  quoteBreakEvenAmount: BN;
  // Carried-through fields (last_cum_funding rewritten at end, others left).
  lastCumulativeFundingRate: BN;
  settledPnl: BN;
  lpShares: BN;
  lastBaseAssetAmountPerLp: BN;
  lastQuoteAssetAmountPerLp: BN;
  remainderBaseAssetAmount: number;
  openOrders: number;
  openBids: BN;
  openAsks: BN;
  positionFlag: number;
  isolatedPositionScaledBalance: BN;
  perLpBase: number;
  // bookkeeping
  collapsedFromCount: number; // 1 = single sub-account; >1 = multi
  syntheticallyCreated: boolean; // true if created here because trade hit unknown authority/market
};

export function emptyPerpPos(marketIndex: number): PerpPositionMut {
  return {
    marketIndex,
    baseAssetAmount: BN0.clone(),
    quoteAssetAmount: BN0.clone(),
    quoteEntryAmount: BN0.clone(),
    quoteBreakEvenAmount: BN0.clone(),
    lastCumulativeFundingRate: BN0.clone(),
    settledPnl: BN0.clone(),
    lpShares: BN0.clone(),
    lastBaseAssetAmountPerLp: BN0.clone(),
    lastQuoteAssetAmountPerLp: BN0.clone(),
    remainderBaseAssetAmount: 0,
    openOrders: 0,
    openBids: BN0.clone(),
    openAsks: BN0.clone(),
    positionFlag: 0,
    isolatedPositionScaledBalance: BN0.clone(),
    perLpBase: 0,
    collapsedFromCount: 0,
    syntheticallyCreated: true,
  };
}

export function emptyAuthorityState(): AuthorityState {
  return {
    spotSignedTokenByMarket: new Map(),
    usdcCrossSignedToken: BN0.clone(),
    usdcIsolatedToken: BN0.clone(),
    perpByMarket: new Map(),
  };
}

export function importPerpSnap(p: PerpPositionSnapshot): PerpPositionMut {
  return {
    marketIndex: p.marketIndex,
    baseAssetAmount: strToBn(p.baseAssetAmount),
    quoteAssetAmount: strToBn(p.quoteAssetAmount),
    quoteEntryAmount: strToBn(p.quoteEntryAmount),
    quoteBreakEvenAmount: strToBn(p.quoteBreakEvenAmount),
    lastCumulativeFundingRate: strToBn(p.lastCumulativeFundingRate),
    settledPnl: strToBn(p.settledPnl),
    lpShares: strToBn(p.lpShares),
    lastBaseAssetAmountPerLp: strToBn(p.lastBaseAssetAmountPerLp),
    lastQuoteAssetAmountPerLp: strToBn(p.lastQuoteAssetAmountPerLp),
    remainderBaseAssetAmount: p.remainderBaseAssetAmount,
    openOrders: p.openOrders,
    openBids: strToBn(p.openBids),
    openAsks: strToBn(p.openAsks),
    positionFlag: p.positionFlag,
    isolatedPositionScaledBalance: strToBn(p.isolatedPositionScaledBalance),
    perLpBase: p.perLpBase,
    collapsedFromCount: 1,
    syntheticallyCreated: false,
  };
}

export function exportPerpSnap(p: PerpPositionMut): PerpPositionSnapshot {
  return {
    marketIndex: p.marketIndex,
    baseAssetAmount: bnToStr(p.baseAssetAmount),
    quoteAssetAmount: bnToStr(p.quoteAssetAmount),
    quoteEntryAmount: bnToStr(p.quoteEntryAmount),
    quoteBreakEvenAmount: bnToStr(p.quoteBreakEvenAmount),
    lastCumulativeFundingRate: bnToStr(p.lastCumulativeFundingRate),
    settledPnl: bnToStr(p.settledPnl),
    lpShares: bnToStr(p.lpShares),
    lastBaseAssetAmountPerLp: bnToStr(p.lastBaseAssetAmountPerLp),
    lastQuoteAssetAmountPerLp: bnToStr(p.lastQuoteAssetAmountPerLp),
    remainderBaseAssetAmount: p.remainderBaseAssetAmount,
    openOrders: p.openOrders,
    openBids: bnToStr(p.openBids),
    openAsks: bnToStr(p.openAsks),
    positionFlag: p.positionFlag,
    isolatedPositionScaledBalance: bnToStr(p.isolatedPositionScaledBalance),
    perLpBase: p.perLpBase,
  };
}

// --- collapse snapshot into mutable state -----------------------------------

function buildAuthorityStates(
  snap: Snapshot,
): { byAuth: Map<string, AuthorityState>; collapsedCount: number } {
  const byAuth = new Map<string, AuthorityState>();
  let collapsedCount = 0;

  for (const [auth, agg] of Object.entries(snap.borrowLendByAuthority)) {
    const s = emptyAuthorityState();
    s.usdcCrossSignedToken = strToBn(agg.usdcCrossSignedToken);
    s.usdcIsolatedToken = strToBn(agg.usdcIsolatedToken);
    for (const [idxStr, vStr] of Object.entries(agg.spotSignedTokenByMarket)) {
      s.spotSignedTokenByMarket.set(Number(idxStr), strToBn(vStr));
    }
    for (const p of agg.perpPositions) {
      const existing = s.perpByMarket.get(p.marketIndex);
      if (!existing) {
        s.perpByMarket.set(p.marketIndex, importPerpSnap(p));
      } else {
        // Collapse: sum linear fields; non-summable carried fields keep the
        // first entry's value (we don't try to be clever; lastCumFunding gets
        // realigned at the very end anyway).
        existing.baseAssetAmount = existing.baseAssetAmount.add(
          strToBn(p.baseAssetAmount),
        );
        existing.quoteAssetAmount = existing.quoteAssetAmount.add(
          strToBn(p.quoteAssetAmount),
        );
        existing.quoteEntryAmount = existing.quoteEntryAmount.add(
          strToBn(p.quoteEntryAmount),
        );
        existing.quoteBreakEvenAmount = existing.quoteBreakEvenAmount.add(
          strToBn(p.quoteBreakEvenAmount),
        );
        existing.settledPnl = existing.settledPnl.add(strToBn(p.settledPnl));
        existing.lpShares = existing.lpShares.add(strToBn(p.lpShares));
        existing.isolatedPositionScaledBalance =
          existing.isolatedPositionScaledBalance.add(
            strToBn(p.isolatedPositionScaledBalance),
          );
        existing.openOrders += p.openOrders;
        existing.openBids = existing.openBids.add(strToBn(p.openBids));
        existing.openAsks = existing.openAsks.add(strToBn(p.openAsks));
        existing.collapsedFromCount += 1;
        collapsedCount += 1;
      }
    }
    byAuth.set(auth, s);
  }
  return { byAuth, collapsedCount };
}

// --- emit collapsed state back into snapshot shape --------------------------

function exportAuthorityStates(
  states: Map<string, AuthorityState>,
): Record<string, BorrowLendAggregateSnapshot> {
  const out: Record<string, BorrowLendAggregateSnapshot> = {};
  const sortedAuths = [...states.keys()].sort();
  for (const auth of sortedAuths) {
    const s = states.get(auth)!;
    const spotObj: Record<number, string> = {};
    for (const [idx, v] of [...s.spotSignedTokenByMarket.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      if (v.eq(BN0)) continue;
      spotObj[idx] = bnToStr(v);
    }
    const perpArr: PerpPositionSnapshot[] = [];
    for (const [, p] of [...s.perpByMarket.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      const isAllZero =
        p.baseAssetAmount.eq(BN0) &&
        p.quoteAssetAmount.eq(BN0) &&
        p.lpShares.eq(BN0) &&
        p.isolatedPositionScaledBalance.eq(BN0) &&
        p.openOrders === 0;
      if (isAllZero && p.syntheticallyCreated) continue;
      perpArr.push(exportPerpSnap(p));
    }
    out[auth] = {
      spotSignedTokenByMarket: spotObj,
      usdcCrossSignedToken: bnToStr(s.usdcCrossSignedToken),
      usdcIsolatedToken: bnToStr(s.usdcIsolatedToken),
      perpPositions: perpArr,
    };
  }
  return out;
}

// --- anomaly tracking -------------------------------------------------------

export class Anomalies {
  private rows: string[] = [
    "kind\tslot\ttxsig\tdetail",
  ];
  private counts = new Map<string, number>();

  add(kind: string, slot: number, txsig: string, detail: string) {
    this.rows.push(`${kind}\t${slot}\t${txsig}\t${detail}`);
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
  }

  countsSummary(): Array<[string, number]> {
    return [...this.counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  write(filePath: string) {
    fs.writeFileSync(filePath, this.rows.join("\n") + "\n");
  }
}

// --- helpers ----------------------------------------------------------------

function getOrInitPerp(
  s: AuthorityState,
  marketIndex: number,
): PerpPositionMut {
  let p = s.perpByMarket.get(marketIndex);
  if (!p) {
    p = emptyPerpPos(marketIndex);
    s.perpByMarket.set(marketIndex, p);
  }
  return p;
}

function getOrInitSpot(s: AuthorityState, marketIndex: number): BN {
  if (marketIndex === QUOTE_SPOT_MARKET_INDEX) {
    return s.usdcCrossSignedToken;
  }
  return s.spotSignedTokenByMarket.get(marketIndex) ?? BN0.clone();
}

function addSpot(
  s: AuthorityState,
  marketIndex: number,
  delta: BN,
): void {
  if (marketIndex === QUOTE_SPOT_MARKET_INDEX) {
    s.usdcCrossSignedToken = s.usdcCrossSignedToken.add(delta);
    return;
  }
  const cur = s.spotSignedTokenByMarket.get(marketIndex) ?? BN0;
  s.spotSignedTokenByMarket.set(marketIndex, cur.add(delta));
}

// signed base delta from a fill record's direction + magnitude
function signedFromDir(magnitude: BN, dir: "long" | "short" | ""): BN {
  if (dir === "long") return magnitude;
  if (dir === "short") return magnitude.neg();
  return BN0;
}

/**
 * Emit a synthetic counterparty audit row to close conservation. Every
 * user-facing refund must be balanced by a pool entry so per-asset sums in the
 * final audit log are zero.
 */
function emitPool(
  audit: AuditLog,
  pool: string,
  kind: AuditRow["kind"],
  slot: number,
  txsig: string,
  fields: {
    marketType?: AuditRow["marketType"];
    marketIndex?: number | "";
    baseDelta?: BN | "0";
    quoteDelta?: BN | "0";
    usdcDelta?: BN | "0";
    spotMarketIndex?: number | "";
    spotDelta?: BN | "0";
    note: string;
  },
): void {
  audit.add({
    authority: pool,
    role: "pool",
    kind,
    slot,
    txsig,
    marketType: fields.marketType ?? "",
    marketIndex: fields.marketIndex ?? "",
    baseDelta: fields.baseDelta ?? "0",
    quoteDelta: fields.quoteDelta ?? "0",
    usdcDelta: fields.usdcDelta ?? "0",
    spotMarketIndex: fields.spotMarketIndex ?? "",
    spotDelta: fields.spotDelta ?? "0",
    note: fields.note,
  });
}

// --- reversal: trade --------------------------------------------------------
//
// Forward semantics (Drift `update_position_with_fill`):
//   taker side (let s = +1 long, -1 short):
//     position.base               += s * baseFilled
//     position.quote              += -s * quoteFilled
//     position.quoteEntry         += -s * quoteFilled
//     position.quoteBreakEven     += -s * quoteFilled  (then -takerFee in quote)
//   collateral (USDC cross):
//     collateral                  -= takerFee
//   maker side mirrors taker with opposite signs, fee replaced by makerFee
//   (makerFee may be negative for rebate; the math is identical).
//   filler reward and referrer reward come out of the user's quote / collateral.
//
// We apply the EXACT inverse here.
export function reverseTrade(
  ev: TradeEvent,
  states: Map<string, AuthorityState>,
  subToAuth: Map<string, string>,
  anomalies: Anomalies,
  audit: AuditLog,
  counters: { perpFills: number; spotFills: number; oneSidedFills: number },
): void {
  if (ev.action !== "fill") {
    anomalies.add(
      "trade.unhandled_action",
      ev.slot,
      ev.txsig,
      `action=${ev.action} explanation=${ev.actionExplanation}`,
    );
    return;
  }

  const base = ev.baseAssetAmountFilled;
  const quote = ev.quoteAssetAmountFilled;

  const takerAuth = ev.taker ? subToAuth.get(ev.taker) : undefined;
  const makerAuth = ev.maker ? subToAuth.get(ev.maker) : undefined;

  if (ev.taker && !takerAuth) {
    anomalies.add(
      "trade.unknown_taker_subaccount",
      ev.slot,
      ev.txsig,
      `taker=${ev.taker}`,
    );
  }
  if (ev.maker && !makerAuth) {
    anomalies.add(
      "trade.unknown_maker_subaccount",
      ev.slot,
      ev.txsig,
      `maker=${ev.maker}`,
    );
  }

  // Determine taker signed base delta and (signed) quote delta. quote delta
  // sign is OPPOSITE of base sign (long taker pays quote; short taker receives).
  // `orderFilledWithAmm` with AMM-as-taker leaves taker/takerorderdirection
  // empty — derive the implied direction from the maker side so we can still
  // reverse that maker's leg.
  let takerDir: "long" | "short" | "" = ev.takerOrderDirection;
  if (takerDir !== "long" && takerDir !== "short") {
    if (ev.makerOrderDirection === "long") takerDir = "short";
    else if (ev.makerOrderDirection === "short") takerDir = "long";
    else {
      anomalies.add(
        "trade.no_direction",
        ev.slot,
        ev.txsig,
        `takerDir=${ev.takerOrderDirection} makerDir=${ev.makerOrderDirection}`,
      );
      return;
    }
  }
  const takerBaseDelta = signedFromDir(base, takerDir);
  const takerQuoteDelta = signedFromDir(quote, takerDir).neg();

  // Taker side
  if (takerAuth) {
    const ts = ensureAuth(states, takerAuth);
    if (ev.marketType === "perp") {
      counters.perpFills += 1;
      const p = getOrInitPerp(ts, ev.marketIndex);
      const baseRev = takerBaseDelta.neg();
      const quoteRev = takerQuoteDelta.neg();
      p.baseAssetAmount = p.baseAssetAmount.add(baseRev);
      p.quoteAssetAmount = p.quoteAssetAmount.add(quoteRev);
      p.quoteEntryAmount = p.quoteEntryAmount.add(quoteRev);
      // breakEven = quoteDelta + fee for taker
      p.quoteBreakEvenAmount = p.quoteBreakEvenAmount
        .add(quoteRev)
        .add(ev.takerFee); // refund the fee leg of break-even too
      // refund taker fee to USDC cross collateral. `takerFee` is the GROSS
      // amount the taker paid; the protocol then split it into protocol fees,
      // referrer reward, filler reward, etc. The taker's economic loss is
      // `takerFee` and refunding that makes them whole — do NOT also refund
      // `referrerReward` (that came out of the protocol's share, not the
      // taker's pocket beyond `takerFee`).
      ts.usdcCrossSignedToken = ts.usdcCrossSignedToken.add(ev.takerFee);
      audit.add({
        authority: takerAuth,
        role: "taker",
        kind: "trade",
        slot: ev.slot,
        txsig: ev.txsig,
        marketType: "perp",
        marketIndex: ev.marketIndex,
        baseDelta: baseRev,
        quoteDelta: quoteRev,
        usdcDelta: ev.takerFee,
        spotMarketIndex: "",
        spotDelta: "0",
        note: ev.actionExplanation,
      });
      // Pool counterparty for taker fee — protocol gave it back.
      if (!ev.takerFee.eq(BN0)) {
        emitPool(audit, POOL_PROTOCOL_FEE, "trade", ev.slot, ev.txsig, {
          usdcDelta: ev.takerFee.neg(),
          note: "trade_taker_fee_refund",
        });
      }
      // `referrerReward` on a Fill with no referrer field means the share
      // that would have gone to a referrer stayed with the protocol — i.e.
      // it's already accounted for in `__pool_protocol_fee` via the takerFee
      // refund above. No per-user reversal required.
    } else if (ev.marketType === "spot") {
      counters.spotFills += 1;
      // base goes into market `marketIndex`, quote leaves market 0 (USDC) — and
      // vice versa for short taker.
      const baseRev = takerBaseDelta.neg();
      const quoteRev = takerQuoteDelta.neg();
      addSpot(ts, ev.marketIndex, baseRev);
      addSpot(ts, QUOTE_SPOT_MARKET_INDEX, quoteRev);
      // refund taker fee in quote (USDC)
      addSpot(ts, QUOTE_SPOT_MARKET_INDEX, ev.takerFee);
      // spot fulfillment method fee (Phoenix/Serum/etc.) — we refund to taker
      // since the fee originally left the taker's collateral.
      const totalUsdc = quoteRev.add(ev.takerFee).add(ev.spotFulfillmentMethodFee);
      if (!ev.spotFulfillmentMethodFee.eq(BN0)) {
        addSpot(ts, QUOTE_SPOT_MARKET_INDEX, ev.spotFulfillmentMethodFee);
        anomalies.add(
          "trade.spot_fulfillment_fee",
          ev.slot,
          ev.txsig,
          `taker=${ev.taker} amount=${bnToStr(ev.spotFulfillmentMethodFee)}`,
        );
      }
      audit.add({
        authority: takerAuth,
        role: "taker",
        kind: "trade",
        slot: ev.slot,
        txsig: ev.txsig,
        marketType: "spot",
        marketIndex: "",
        baseDelta: "0",
        quoteDelta: "0",
        usdcDelta: totalUsdc,
        spotMarketIndex: ev.marketIndex,
        spotDelta: baseRev,
        note: ev.actionExplanation,
      });
      // Fees: protocol gave back the taker fee; the external venue gave back
      // its method fee. Routed to the USDC dimension via spotDelta(market 0).
      // (AMM counterparty entries for the base/quote legs are emitted in the
      // maker branch or its `else` — DO NOT emit here, or we double-count.)
      if (!ev.takerFee.eq(BN0)) {
        emitPool(audit, POOL_PROTOCOL_FEE, "trade", ev.slot, ev.txsig, {
          spotMarketIndex: QUOTE_SPOT_MARKET_INDEX,
          spotDelta: ev.takerFee.neg(),
          note: "trade_spot_taker_fee_refund",
        });
      }
      if (!ev.spotFulfillmentMethodFee.eq(BN0)) {
        emitPool(audit, POOL_PHOENIX_FEE, "trade", ev.slot, ev.txsig, {
          spotMarketIndex: QUOTE_SPOT_MARKET_INDEX,
          spotDelta: ev.spotFulfillmentMethodFee.neg(),
          note: "trade_spot_venue_fee_refund",
        });
      }
    }
  }

  // Maker side. If maker is attributable, process normally. Otherwise (empty
  // pubkey → true AMM-as-maker, OR named-but-unknown sub-account), the AMM
  // pool stands in to close conservation against the taker leg. The "named
  // but unknown" case is surfaced as anomaly above.
  if (ev.maker && makerAuth) {
    const ms = ensureAuth(states, makerAuth);
    const makerBaseDelta = takerBaseDelta.neg();
    const makerQuoteDelta = takerQuoteDelta.neg();
    const baseRev = makerBaseDelta.neg();
    const quoteRev = makerQuoteDelta.neg();
    if (ev.marketType === "perp") {
      const p = getOrInitPerp(ms, ev.marketIndex);
      p.baseAssetAmount = p.baseAssetAmount.add(baseRev);
      p.quoteAssetAmount = p.quoteAssetAmount.add(quoteRev);
      p.quoteEntryAmount = p.quoteEntryAmount.add(quoteRev);
      // breakEven for maker: -makerFee (rebate is negative fee, adds back as
      // a positive number when subtracted in reversal)
      p.quoteBreakEvenAmount = p.quoteBreakEvenAmount
        .add(quoteRev)
        .add(ev.makerFee);
      ms.usdcCrossSignedToken = ms.usdcCrossSignedToken.add(ev.makerFee);
      audit.add({
        authority: makerAuth,
        role: "maker",
        kind: "trade",
        slot: ev.slot,
        txsig: ev.txsig,
        marketType: "perp",
        marketIndex: ev.marketIndex,
        baseDelta: baseRev,
        quoteDelta: quoteRev,
        usdcDelta: ev.makerFee,
        spotMarketIndex: "",
        spotDelta: "0",
        note: ev.actionExplanation,
      });
      if (!ev.makerFee.eq(BN0)) {
        emitPool(audit, POOL_PROTOCOL_FEE, "trade", ev.slot, ev.txsig, {
          usdcDelta: ev.makerFee.neg(),
          note: "trade_maker_fee_refund",
        });
      }
      // If taker leg was missing/unknown, AMM pool stands in for the missing
      // taker. Use the taker's would-be reversal directly so sum-to-zero holds
      // when added to maker's audit row.
      if (!takerAuth) {
        const takerBaseRev = takerBaseDelta.neg();
        const takerQuoteRev = takerQuoteDelta.neg();
        emitPool(audit, POOL_AMM_PERP, "trade", ev.slot, ev.txsig, {
          marketType: "perp",
          marketIndex: ev.marketIndex,
          baseDelta: takerBaseRev,
          quoteDelta: takerQuoteRev,
          note: "trade_perp_amm_as_taker",
        });
      }
    } else if (ev.marketType === "spot") {
      addSpot(ms, ev.marketIndex, baseRev);
      addSpot(ms, QUOTE_SPOT_MARKET_INDEX, quoteRev);
      addSpot(ms, QUOTE_SPOT_MARKET_INDEX, ev.makerFee);
      audit.add({
        authority: makerAuth,
        role: "maker",
        kind: "trade",
        slot: ev.slot,
        txsig: ev.txsig,
        marketType: "spot",
        marketIndex: "",
        baseDelta: "0",
        quoteDelta: "0",
        usdcDelta: quoteRev.add(ev.makerFee),
        spotMarketIndex: ev.marketIndex,
        spotDelta: baseRev,
        note: ev.actionExplanation,
      });
      if (!ev.makerFee.eq(BN0)) {
        emitPool(audit, POOL_PROTOCOL_FEE, "trade", ev.slot, ev.txsig, {
          spotMarketIndex: QUOTE_SPOT_MARKET_INDEX,
          spotDelta: ev.makerFee.neg(),
          note: "trade_spot_maker_fee_refund",
        });
      }
      if (!takerAuth) {
        const takerBaseRev = takerBaseDelta.neg();
        const takerQuoteRev = takerQuoteDelta.neg();
        emitPool(audit, POOL_AMM_SPOT, "trade", ev.slot, ev.txsig, {
          spotMarketIndex: ev.marketIndex,
          spotDelta: takerBaseRev,
          note: "trade_spot_amm_as_taker_base",
        });
        emitPool(audit, POOL_AMM_SPOT, "trade", ev.slot, ev.txsig, {
          spotMarketIndex: QUOTE_SPOT_MARKET_INDEX,
          spotDelta: takerQuoteRev,
          note: "trade_spot_amm_as_taker_quote",
        });
      }
    }
  } else {
    // Maker is empty (AMM-as-maker) OR maker is named but unknown sub-account.
    // In both cases we attribute the leg to the AMM pool to preserve audit
    // conservation. The unknown-sub-account case is surfaced as anomaly so the
    // user can resolve and re-run.
    counters.oneSidedFills += 1;
    if (takerAuth) {
      const baseRev = takerBaseDelta.neg();
      const quoteRev = takerQuoteDelta.neg();
      if (ev.marketType === "perp") {
        emitPool(audit, POOL_AMM_PERP, "trade", ev.slot, ev.txsig, {
          marketType: "perp",
          marketIndex: ev.marketIndex,
          baseDelta: baseRev.neg(),
          quoteDelta: quoteRev.neg(),
          note: ev.maker ? "trade_perp_unknown_maker_amm" : "trade_perp_amm_as_maker",
        });
      } else if (ev.marketType === "spot") {
        emitPool(audit, POOL_AMM_SPOT, "trade", ev.slot, ev.txsig, {
          spotMarketIndex: ev.marketIndex,
          spotDelta: baseRev.neg(),
          note: ev.maker ? "trade_spot_unknown_maker_amm_base" : "trade_spot_amm_as_maker_base",
        });
        emitPool(audit, POOL_AMM_SPOT, "trade", ev.slot, ev.txsig, {
          spotMarketIndex: QUOTE_SPOT_MARKET_INDEX,
          spotDelta: quoteRev.neg(),
          note: ev.maker ? "trade_spot_unknown_maker_amm_quote" : "trade_spot_amm_as_maker_quote",
        });
      }
    }
  }

  // Filler reward — protocol pool receives filler's share back.
  if (!ev.fillerReward.eq(BN0) && ev.filler) {
    const fillerAuth = subToAuth.get(ev.filler);
    if (fillerAuth) {
      const fs2 = ensureAuth(states, fillerAuth);
      fs2.usdcCrossSignedToken = fs2.usdcCrossSignedToken.sub(ev.fillerReward);
      audit.add({
        authority: fillerAuth,
        role: "filler",
        kind: "trade",
        slot: ev.slot,
        txsig: ev.txsig,
        marketType: ev.marketType,
        marketIndex: ev.marketIndex,
        baseDelta: "0",
        quoteDelta: "0",
        usdcDelta: ev.fillerReward.neg(),
        spotMarketIndex: "",
        spotDelta: "0",
        note: "filler_reward_clawback",
      });
      emitPool(audit, POOL_PROTOCOL_FEE, "trade", ev.slot, ev.txsig, {
        usdcDelta: ev.fillerReward,
        note: "filler_reward_back_to_protocol",
      });
    } else {
      anomalies.add(
        "trade.unknown_filler",
        ev.slot,
        ev.txsig,
        `filler=${ev.filler} amount=${bnToStr(ev.fillerReward)}`,
      );
    }
  }

  // `quoteAssetAmountSurplus` (AMM JIT routes) is already baked into
  // `quoteAssetAmountFilled` for both sides of the trade, so the user-side
  // accounting is complete. The surplus itself is AMM profit that routes
  // to the IF / market vault per program logic — captured in the
  // `__pool_amm_perp` / `__pool_if` synthetic counterparty totals we already
  // emit. No additional reversal required.
}

export function ensureAuth(
  states: Map<string, AuthorityState>,
  auth: string,
): AuthorityState {
  let s = states.get(auth);
  if (!s) {
    s = emptyAuthorityState();
    states.set(auth, s);
  }
  return s;
}

// --- reversal: funding ------------------------------------------------------
//
// Drift `settle_funding_payment` mutates:
//   position.quote_asset_amount    += fundingPayment
//   position.last_cum_funding_rate  = market.amm.cum_funding_rate
//
// We reverse the quote delta. The `last_cum_funding_rate` realignment is
// handled globally at the end (set to current market cum, so pending = 0).
export function reverseFunding(
  ev: FundingEvent,
  states: Map<string, AuthorityState>,
  subToAuth: Map<string, string>,
  anomalies: Anomalies,
  audit: AuditLog,
): void {
  // Prefer authority from the record itself; fall back to lookup.
  const auth = ev.userAuthority || subToAuth.get(ev.user) || "";
  if (!auth) {
    anomalies.add(
      "funding.unknown_authority",
      ev.slot,
      ev.txsig,
      `user=${ev.user}`,
    );
    return;
  }
  const s = ensureAuth(states, auth);
  const p = getOrInitPerp(s, ev.marketIndex);
  const quoteRev = ev.fundingPayment.neg();
  p.quoteAssetAmount = p.quoteAssetAmount.add(quoteRev);
  audit.add({
    authority: auth,
    role: "user",
    kind: "funding",
    slot: ev.slot,
    txsig: ev.txsig,
    marketType: "perp",
    marketIndex: ev.marketIndex,
    baseDelta: "0",
    quoteDelta: quoteRev,
    usdcDelta: "0",
    spotMarketIndex: "",
    spotDelta: "0",
    note: "settle_funding",
  });
  // Counterparty: the AMM funding pool absorbed/paid this settlement.
  if (!quoteRev.eq(BN0)) {
    emitPool(audit, POOL_AMM_FUNDING, "funding", ev.slot, ev.txsig, {
      marketType: "perp",
      marketIndex: ev.marketIndex,
      quoteDelta: quoteRev.neg(),
      note: "settle_funding_amm",
    });
  }
}

// --- reversal: settle pnl ---------------------------------------------------
//
// Forward semantics: realized PnL is moved from the position into collateral.
//   position.quote_asset_amount -= pnl     (so PnL = base*mark + quote drops by pnl)
//   position.settled_pnl       += pnl
//   collateral (USDC cross)    += pnl
//
// Reverse: + on quote, - on settledPnl, - on collateral.
export function reverseSettlePnl(
  ev: SettlePnlEvent,
  states: Map<string, AuthorityState>,
  subToAuth: Map<string, string>,
  anomalies: Anomalies,
  audit: AuditLog,
): void {
  const auth = subToAuth.get(ev.user);
  if (!auth) {
    anomalies.add("settle_pnl.unknown_user", ev.slot, ev.txsig, `user=${ev.user}`);
    return;
  }
  const s = ensureAuth(states, auth);
  const p = getOrInitPerp(s, ev.marketIndex);
  p.quoteAssetAmount = p.quoteAssetAmount.add(ev.pnl);
  p.settledPnl = p.settledPnl.sub(ev.pnl);
  s.usdcCrossSignedToken = s.usdcCrossSignedToken.sub(ev.pnl);
  audit.add({
    authority: auth,
    role: "user",
    kind: "settle_pnl",
    slot: ev.slot,
    txsig: ev.txsig,
    marketType: "perp",
    marketIndex: ev.marketIndex,
    baseDelta: "0",
    quoteDelta: ev.pnl,
    usdcDelta: ev.pnl.neg(),
    spotMarketIndex: "",
    spotDelta: "0",
    note: ev.explanation,
  });
}

// --- reversal: spot swap ----------------------------------------------------
//
// Forward semantics (Drift `swap` instruction):
//   user spot[outMarket] -= amountOut
//   user spot[inMarket]  += amountIn
//   protocol takes `fee` (asset varies by route; not in record schema)
//
// Reverse principal only. Fee surfaced — usually ≤30bps and small.
export function reverseSwap(
  ev: SwapEvent,
  states: Map<string, AuthorityState>,
  subToAuth: Map<string, string>,
  anomalies: Anomalies,
  audit: AuditLog,
): void {
  const auth = subToAuth.get(ev.user);
  if (!auth) {
    anomalies.add("swap.unknown_user", ev.slot, ev.txsig, `user=${ev.user}`);
    return;
  }
  const s = ensureAuth(states, auth);
  addSpot(s, ev.outMarketIndex, ev.amountOut);
  addSpot(s, ev.inMarketIndex, ev.amountIn.neg());
  // Two audit rows, one per leg, so each spot-side mutation is attributable.
  audit.add({
    authority: auth,
    role: "user",
    kind: "swap",
    slot: ev.slot,
    txsig: ev.txsig,
    marketType: "spot",
    marketIndex: "",
    baseDelta: "0",
    quoteDelta: "0",
    usdcDelta: "0",
    spotMarketIndex: ev.outMarketIndex,
    spotDelta: ev.amountOut,
    note: "swap_out_returned",
  });
  audit.add({
    authority: auth,
    role: "user",
    kind: "swap",
    slot: ev.slot,
    txsig: ev.txsig,
    marketType: "spot",
    marketIndex: "",
    baseDelta: "0",
    quoteDelta: "0",
    usdcDelta: "0",
    spotMarketIndex: ev.inMarketIndex,
    spotDelta: ev.amountIn.neg(),
    note: "swap_in_clawback",
  });
  // Counterparty: the swap pool (AMM/external route) absorbed both legs.
  emitPool(audit, POOL_AMM_SPOT, "swap", ev.slot, ev.txsig, {
    spotMarketIndex: ev.outMarketIndex,
    spotDelta: ev.amountOut.neg(),
    note: "swap_out_counterparty",
  });
  emitPool(audit, POOL_AMM_SPOT, "swap", ev.slot, ev.txsig, {
    spotMarketIndex: ev.inMarketIndex,
    spotDelta: ev.amountIn,
    note: "swap_in_counterparty",
  });
  if (!ev.fee.eq(BN0)) {
    // Fee asset isn't on the schema; surface and account against the swap-fee
    // pool. We can't pick a market without that info, so log without a
    // balancing entry — reconciliation will flag the residual.
    anomalies.add(
      "swap.fee",
      ev.slot,
      ev.txsig,
      `inMarket=${ev.inMarketIndex} outMarket=${ev.outMarketIndex} fee=${bnToStr(ev.fee)} (asset unknown, not reversed)`,
    );
  }
}

// --- reversal: liquidation --------------------------------------------------
//
// liquidatePerp: the base/quote transfer is recorded as a TradeRecord with
//   action="fill", explanation="liquidation" — already reversed by the trade
//   pass. We additionally refund liquidatorFee + ifFee to the user (in quote),
//   and claw back the liquidator's slice.
// liquidateSpot: a direct spot asset/liability transfer from user to
//   liquidator, plus an IF fee in the liability market.
// liquidateBorrowForPerpPnl: liquidator buys the user's positive perp PnL by
//   taking on a borrow on the user's behalf. Reverse the pnl transfer (out of
//   liquidator's perp quote, into user's perp quote) and the liability swap.
// liquidatePerpPnlForDeposit: liquidator pays a perp loss for the user by
//   taking the user's deposit. Reverse symmetrically.
// perpBankruptcy: bad debt was zeroed; cum_funding_rate_delta socialized the
//   loss across remaining positions in the market (those funding effects show
//   up in our FundingPaymentRecord stream, so reverting funding payments
//   already undoes the socialization). Here we only refund the bankrupt user's
//   negative PnL back into their quote.
// spotBankruptcy: the bad borrow was zeroed; cum_deposit_interest_delta
//   socialized it across that spot market's depositors via future interest
//   accrual. We refund the borrow back into the user's liability balance.
export function reverseLiquidation(
  ev: LiquidationEvent,
  states: Map<string, AuthorityState>,
  subToAuth: Map<string, string>,
  anomalies: Anomalies,
  audit: AuditLog,
  counters: { liqEvents: number; ifFeeReversed: BN; liquidatorFeeReversed: BN },
): void {
  counters.liqEvents += 1;
  const userAuth = ev.user ? subToAuth.get(ev.user) : undefined;
  const liqAuth = ev.liquidator ? subToAuth.get(ev.liquidator) : undefined;
  if (ev.user && !userAuth) {
    anomalies.add(
      "liquidation.unknown_user",
      ev.slot,
      ev.txsig,
      `user=${ev.user}`,
    );
  }
  if (ev.liquidator && !liqAuth) {
    anomalies.add(
      "liquidation.unknown_liquidator",
      ev.slot,
      ev.txsig,
      `liquidator=${ev.liquidator}`,
    );
  }

  // ---- liquidatePerp: fee reversal (position transfer reversed by trade pass)
  if (ev.liquidatePerp) {
    const lp = ev.liquidatePerp;
    if (userAuth) {
      const us = ensureAuth(states, userAuth);
      const p = getOrInitPerp(us, lp.marketIndex);
      // Refund liquidator fee + IF fee into user's perp quote (where they were
      // originally extracted from).
      const total = lp.liquidatorFee.add(lp.ifFee);
      p.quoteAssetAmount = p.quoteAssetAmount.add(total);
      counters.liquidatorFeeReversed = counters.liquidatorFeeReversed.add(
        lp.liquidatorFee,
      );
      counters.ifFeeReversed = counters.ifFeeReversed.add(lp.ifFee);
      audit.add({
        authority: userAuth,
        role: "user",
        kind: "liquidation",
        slot: ev.slot,
        txsig: ev.txsig,
        marketType: "perp",
        marketIndex: lp.marketIndex,
        baseDelta: "0",
        quoteDelta: total,
        usdcDelta: "0",
        spotMarketIndex: "",
        spotDelta: "0",
        note: "liquidatePerp_fees_refund",
      });
      // IF pool gave back ifFee. Conservation: user +ifFee, if_pool -ifFee.
      if (!lp.ifFee.eq(BN0)) {
        emitPool(audit, POOL_IF, "liquidation", ev.slot, ev.txsig, {
          marketType: "perp",
          marketIndex: lp.marketIndex,
          quoteDelta: lp.ifFee.neg(),
          note: "liquidatePerp_if_fee_refund",
        });
      }
    }
    if (liqAuth) {
      const ls = ensureAuth(states, liqAuth);
      const lpos = getOrInitPerp(ls, lp.marketIndex);
      // The liquidator received liquidatorFee in their perp quote.
      const quoteRev = lp.liquidatorFee.neg();
      lpos.quoteAssetAmount = lpos.quoteAssetAmount.add(quoteRev);
      audit.add({
        authority: liqAuth,
        role: "liquidator",
        kind: "liquidation",
        slot: ev.slot,
        txsig: ev.txsig,
        marketType: "perp",
        marketIndex: lp.marketIndex,
        baseDelta: "0",
        quoteDelta: quoteRev,
        usdcDelta: "0",
        spotMarketIndex: "",
        spotDelta: "0",
        note: "liquidatePerp_fee_clawback",
      });
    }
    if (!lp.lpShares.eq(BN0)) {
      anomalies.add(
        "liquidation.lp_shares",
        ev.slot,
        ev.txsig,
        `marketIndex=${lp.marketIndex} lpShares=${bnToStr(lp.lpShares)}`,
      );
    }
  }

  // ---- liquidateSpot: direct asset/liability transfer
  if (ev.liquidateSpot) {
    const ls = ev.liquidateSpot;
    if (userAuth) {
      const us = ensureAuth(states, userAuth);
      // User originally lost their asset and saw liability reduced.
      addSpot(us, ls.assetMarketIndex, ls.assetTransfer); // give back the asset
      addSpot(us, ls.liabilityMarketIndex, ls.liabilityTransfer.neg()); // restore the liability (more negative)
      audit.add({
        authority: userAuth,
        role: "user",
        kind: "liquidation",
        slot: ev.slot,
        txsig: ev.txsig,
        marketType: "spot",
        marketIndex: "",
        baseDelta: "0",
        quoteDelta: "0",
        usdcDelta: "0",
        spotMarketIndex: ls.assetMarketIndex,
        spotDelta: ls.assetTransfer,
        note: "liquidateSpot_asset_returned",
      });
      audit.add({
        authority: userAuth,
        role: "user",
        kind: "liquidation",
        slot: ev.slot,
        txsig: ev.txsig,
        marketType: "spot",
        marketIndex: "",
        baseDelta: "0",
        quoteDelta: "0",
        usdcDelta: "0",
        spotMarketIndex: ls.liabilityMarketIndex,
        spotDelta: ls.liabilityTransfer.neg(),
        note: "liquidateSpot_liability_restored",
      });
    }
    if (liqAuth) {
      const lus = ensureAuth(states, liqAuth);
      addSpot(lus, ls.assetMarketIndex, ls.assetTransfer.neg());
      addSpot(lus, ls.liabilityMarketIndex, ls.liabilityTransfer);
      audit.add({
        authority: liqAuth,
        role: "liquidator",
        kind: "liquidation",
        slot: ev.slot,
        txsig: ev.txsig,
        marketType: "spot",
        marketIndex: "",
        baseDelta: "0",
        quoteDelta: "0",
        usdcDelta: "0",
        spotMarketIndex: ls.assetMarketIndex,
        spotDelta: ls.assetTransfer.neg(),
        note: "liquidateSpot_asset_clawback",
      });
      audit.add({
        authority: liqAuth,
        role: "liquidator",
        kind: "liquidation",
        slot: ev.slot,
        txsig: ev.txsig,
        marketType: "spot",
        marketIndex: "",
        baseDelta: "0",
        quoteDelta: "0",
        usdcDelta: "0",
        spotMarketIndex: ls.liabilityMarketIndex,
        spotDelta: ls.liabilityTransfer,
        note: "liquidateSpot_liability_clawback",
      });
    }
    if (!ls.ifFee.eq(BN0)) {
      // The IF fee was paid by the user in the liability asset; refund it.
      if (userAuth) {
        const us = ensureAuth(states, userAuth);
        addSpot(us, ls.liabilityMarketIndex, ls.ifFee);
        audit.add({
          authority: userAuth,
          role: "user",
          kind: "liquidation",
          slot: ev.slot,
          txsig: ev.txsig,
          marketType: "spot",
          marketIndex: "",
          baseDelta: "0",
          quoteDelta: "0",
          usdcDelta: "0",
          spotMarketIndex: ls.liabilityMarketIndex,
          spotDelta: ls.ifFee,
          note: "liquidateSpot_if_fee_refund",
        });
        emitPool(audit, POOL_IF, "liquidation", ev.slot, ev.txsig, {
          spotMarketIndex: ls.liabilityMarketIndex,
          spotDelta: ls.ifFee.neg(),
          note: "liquidateSpot_if_fee_refund_pool",
        });
      }
    }
  }

  // ---- liquidateBorrowForPerpPnl
  if (ev.liquidateBorrowForPerpPnl) {
    const x = ev.liquidateBorrowForPerpPnl;
    if (userAuth) {
      const us = ensureAuth(states, userAuth);
      const p = getOrInitPerp(us, x.perpMarketIndex);
      // User's positive perp pnl was transferred out, in exchange for new
      // liability. Reverse both legs.
      p.quoteAssetAmount = p.quoteAssetAmount.add(x.pnlTransfer);
      addSpot(us, x.liabilityMarketIndex, x.liabilityTransfer);
      audit.add({
        authority: userAuth, role: "user", kind: "liquidation",
        slot: ev.slot, txsig: ev.txsig,
        marketType: "perp", marketIndex: x.perpMarketIndex,
        baseDelta: "0", quoteDelta: x.pnlTransfer, usdcDelta: "0",
        spotMarketIndex: x.liabilityMarketIndex, spotDelta: x.liabilityTransfer,
        note: "liquidateBorrowForPerpPnl_user",
      });
    }
    if (liqAuth) {
      const lus = ensureAuth(states, liqAuth);
      const p = getOrInitPerp(lus, x.perpMarketIndex);
      p.quoteAssetAmount = p.quoteAssetAmount.sub(x.pnlTransfer);
      addSpot(lus, x.liabilityMarketIndex, x.liabilityTransfer.neg());
      audit.add({
        authority: liqAuth, role: "liquidator", kind: "liquidation",
        slot: ev.slot, txsig: ev.txsig,
        marketType: "perp", marketIndex: x.perpMarketIndex,
        baseDelta: "0", quoteDelta: x.pnlTransfer.neg(), usdcDelta: "0",
        spotMarketIndex: x.liabilityMarketIndex, spotDelta: x.liabilityTransfer.neg(),
        note: "liquidateBorrowForPerpPnl_liquidator",
      });
    }
  }

  // ---- liquidatePerpPnlForDeposit
  if (ev.liquidatePerpPnlForDeposit) {
    const x = ev.liquidatePerpPnlForDeposit;
    if (userAuth) {
      const us = ensureAuth(states, userAuth);
      const p = getOrInitPerp(us, x.perpMarketIndex);
      // User's negative pnl was reduced (toward zero) in exchange for handing
      // over a deposit. Reverse: re-add the pnl loss, return the deposit.
      p.quoteAssetAmount = p.quoteAssetAmount.sub(x.pnlTransfer);
      addSpot(us, x.assetMarketIndex, x.assetTransfer);
      audit.add({
        authority: userAuth, role: "user", kind: "liquidation",
        slot: ev.slot, txsig: ev.txsig,
        marketType: "perp", marketIndex: x.perpMarketIndex,
        baseDelta: "0", quoteDelta: x.pnlTransfer.neg(), usdcDelta: "0",
        spotMarketIndex: x.assetMarketIndex, spotDelta: x.assetTransfer,
        note: "liquidatePerpPnlForDeposit_user",
      });
    }
    if (liqAuth) {
      const lus = ensureAuth(states, liqAuth);
      const p = getOrInitPerp(lus, x.perpMarketIndex);
      p.quoteAssetAmount = p.quoteAssetAmount.add(x.pnlTransfer);
      addSpot(lus, x.assetMarketIndex, x.assetTransfer.neg());
      audit.add({
        authority: liqAuth, role: "liquidator", kind: "liquidation",
        slot: ev.slot, txsig: ev.txsig,
        marketType: "perp", marketIndex: x.perpMarketIndex,
        baseDelta: "0", quoteDelta: x.pnlTransfer, usdcDelta: "0",
        spotMarketIndex: x.assetMarketIndex, spotDelta: x.assetTransfer.neg(),
        note: "liquidatePerpPnlForDeposit_liquidator",
      });
    }
  }

  // ---- perpBankruptcy
  if (ev.perpBankruptcy) {
    const pb = ev.perpBankruptcy;
    // Sign: pb.pnl is the loss magnitude (positive); the user's quote was
    // forgiven this much by the protocol's combination of IF payout +
    // socialization-via-cumulative-funding-rate-delta. To rewind, we charge
    // user.quote back by |pnl|, credit the IF pool by ifPayment, and credit
    // the bankruptcy_socialization pool by the residual.
    const lossMag = pb.pnl.abs();
    const ifPmt = pb.ifPayment.abs();
    const residual = lossMag.sub(ifPmt);
    if (userAuth) {
      const us = ensureAuth(states, userAuth);
      const p = getOrInitPerp(us, pb.marketIndex);
      const quoteRev = lossMag.neg();
      p.quoteAssetAmount = p.quoteAssetAmount.add(quoteRev);
      audit.add({
        authority: userAuth, role: "user", kind: "liquidation",
        slot: ev.slot, txsig: ev.txsig,
        marketType: "perp", marketIndex: pb.marketIndex,
        baseDelta: "0", quoteDelta: quoteRev, usdcDelta: "0",
        spotMarketIndex: "", spotDelta: "0",
        note: "perpBankruptcy_restore_pnl",
      });
      // IF pool gets its payout back (in quote units of this market).
      if (!ifPmt.eq(BN0)) {
        emitPool(audit, POOL_IF, "liquidation", ev.slot, ev.txsig, {
          marketType: "perp", marketIndex: pb.marketIndex,
          quoteDelta: ifPmt,
          note: "perpBankruptcy_if_payback",
        });
      }
      // Socialization residual: the cumulativeFundingRateDelta will push this
      // onto remaining holders via future funding settlements. Per-holder
      // distribution is applied in applyBankruptcySocialization() — here we
      // open the obligation with a pool credit; the per-holder pass closes it.
      if (!residual.eq(BN0)) {
        emitPool(audit, POOL_BANKRUPTCY, "liquidation", ev.slot, ev.txsig, {
          marketType: "perp", marketIndex: pb.marketIndex,
          quoteDelta: residual,
          note: "perpBankruptcy_socialization_open",
        });
      }
    }
    if (!pb.cumulativeFundingRateDelta.eq(BN0)) {
      anomalies.add(
        "liquidation.perp_bankruptcy_amm_delta",
        ev.slot,
        ev.txsig,
        `market=${pb.marketIndex} delta=${bnToStr(pb.cumulativeFundingRateDelta)} (per-holder reversed in applyBankruptcySocialization)`,
      );
    }
  }

  // ---- spotBankruptcy
  if (ev.spotBankruptcy) {
    const sb = ev.spotBankruptcy;
    const borrowMag = sb.borrowAmount.abs();
    const ifPmt = sb.ifPayment.abs();
    const residual = borrowMag.sub(ifPmt);
    if (userAuth) {
      const us = ensureAuth(states, userAuth);
      const spotRev = borrowMag.neg();
      addSpot(us, sb.marketIndex, spotRev);
      audit.add({
        authority: userAuth, role: "user", kind: "liquidation",
        slot: ev.slot, txsig: ev.txsig,
        marketType: "spot", marketIndex: "",
        baseDelta: "0", quoteDelta: "0", usdcDelta: "0",
        spotMarketIndex: sb.marketIndex, spotDelta: spotRev,
        note: "spotBankruptcy_restore_borrow",
      });
      if (!ifPmt.eq(BN0)) {
        emitPool(audit, POOL_IF, "liquidation", ev.slot, ev.txsig, {
          spotMarketIndex: sb.marketIndex,
          spotDelta: ifPmt,
          note: "spotBankruptcy_if_payback",
        });
      }
      if (!residual.eq(BN0)) {
        emitPool(audit, POOL_BANKRUPTCY, "liquidation", ev.slot, ev.txsig, {
          spotMarketIndex: sb.marketIndex,
          spotDelta: residual,
          note: "spotBankruptcy_socialization_open",
        });
      }
    }
    if (!sb.cumulativeDepositInterestDelta.eq(BN0)) {
      anomalies.add(
        "liquidation.spot_bankruptcy_interest_delta",
        ev.slot,
        ev.txsig,
        `market=${sb.marketIndex} delta=${bnToStr(sb.cumulativeDepositInterestDelta)} (depositor socialization applied via applyBankruptcySocialization)`,
      );
    }
  }
}

// --- bankruptcy socialization reversal (P0.3) -------------------------------
//
// Forward semantics:
//   - perpBankruptcy: cumulative_funding_rate_long += cumFRDelta;
//                     cumulative_funding_rate_short -= cumFRDelta. Each future
//                     funding settlement charges remaining holders for the
//                     bankrupt loss. Per-holder forward charge:
//                       payment = cumFRDelta * |base| / (1e3 * 1e9)   (QUOTE units)
//                     (longs pay because cum_long went up; shorts pay because
//                     the negation of cum_short delta × negative base also
//                     yields positive payment.)
//   - spotBankruptcy: cumulative_deposit_interest -= cumDepInterestDelta.
//                     Each depositor's resolved token balance is reduced
//                     proportionally. We approximate the per-depositor share
//                     using their *current* (post-reversal) positive balance
//                     as a pro-rata weight.
//
// We apply per-holder reversals (CREDIT to holders / DEBIT to the bankruptcy
// pool, which closes the obligation opened in reverseLiquidation).
type BankruptcyStats = {
  perpMarketsCovered: number;
  spotMarketsCovered: number;
  perpHoldersCredited: number;
  spotDepositorsCredited: number;
  totalPerpResidualReversed: BN;
  totalSpotResidualReversed: BN;
  perpMarketDeltas: Map<number, BN>;
  spotMarketResiduals: Map<number, BN>;
  spotMarketInterestDeltas: Map<number, BN>;
};

function applyBankruptcySocialization(
  liqs: LiquidationEvent[],
  states: Map<string, AuthorityState>,
  audit: AuditLog,
): BankruptcyStats {
  const perpDeltaByMarket = new Map<number, BN>();
  const spotResidualByMarket = new Map<number, BN>();
  const spotInterestDeltaByMarket = new Map<number, BN>();
  const perpBankrupcySlotByMarket = new Map<number, number>();
  const spotBankrupcySlotByMarket = new Map<number, number>();
  const perpBankrupcyTxByMarket = new Map<number, string>();
  const spotBankrupcyTxByMarket = new Map<number, string>();

  for (const ev of liqs) {
    if (ev.perpBankruptcy && !ev.perpBankruptcy.cumulativeFundingRateDelta.eq(BN0)) {
      const m = ev.perpBankruptcy.marketIndex;
      perpDeltaByMarket.set(
        m,
        (perpDeltaByMarket.get(m) ?? BN0.clone()).add(
          ev.perpBankruptcy.cumulativeFundingRateDelta,
        ),
      );
      perpBankrupcySlotByMarket.set(m, ev.slot);
      perpBankrupcyTxByMarket.set(m, ev.txsig);
    }
    if (ev.spotBankruptcy) {
      const m = ev.spotBankruptcy.marketIndex;
      const residual = ev.spotBankruptcy.borrowAmount
        .abs()
        .sub(ev.spotBankruptcy.ifPayment.abs());
      if (!residual.eq(BN0)) {
        spotResidualByMarket.set(
          m,
          (spotResidualByMarket.get(m) ?? BN0.clone()).add(residual),
        );
        spotBankrupcySlotByMarket.set(m, ev.slot);
        spotBankrupcyTxByMarket.set(m, ev.txsig);
      }
      if (!ev.spotBankruptcy.cumulativeDepositInterestDelta.eq(BN0)) {
        spotInterestDeltaByMarket.set(
          m,
          (spotInterestDeltaByMarket.get(m) ?? BN0.clone()).add(
            ev.spotBankruptcy.cumulativeDepositInterestDelta,
          ),
        );
      }
    }
  }

  const stats: BankruptcyStats = {
    perpMarketsCovered: perpDeltaByMarket.size,
    spotMarketsCovered: spotResidualByMarket.size,
    perpHoldersCredited: 0,
    spotDepositorsCredited: 0,
    totalPerpResidualReversed: BN0.clone(),
    totalSpotResidualReversed: BN0.clone(),
    perpMarketDeltas: perpDeltaByMarket,
    spotMarketResiduals: spotResidualByMarket,
    spotMarketInterestDeltas: spotInterestDeltaByMarket,
  };

  if (perpDeltaByMarket.size === 0 && spotResidualByMarket.size === 0) {
    return stats;
  }

  // --- Perp socialization: per-holder, credit = delta * |base| / divisor.
  for (const [marketIdx, delta] of perpDeltaByMarket) {
    const slot = perpBankrupcySlotByMarket.get(marketIdx) ?? 0;
    const txsig = perpBankrupcyTxByMarket.get(marketIdx) ?? "";
    for (const [auth, s] of states) {
      if (POOL_AUTHORITIES.has(auth)) continue;
      const p = s.perpByMarket.get(marketIdx);
      if (!p) continue;
      if (p.baseAssetAmount.eq(BN0)) continue;
      const credit = delta
        .mul(p.baseAssetAmount.abs())
        .div(FUNDING_PAYMENT_DIVISOR);
      if (credit.eq(BN0)) continue;
      p.quoteAssetAmount = p.quoteAssetAmount.add(credit);
      stats.totalPerpResidualReversed = stats.totalPerpResidualReversed.add(
        credit,
      );
      stats.perpHoldersCredited += 1;
      audit.add({
        authority: auth,
        role: "user",
        kind: "bankruptcy_socialize",
        slot,
        txsig,
        marketType: "perp",
        marketIndex: marketIdx,
        baseDelta: "0",
        quoteDelta: credit,
        usdcDelta: "0",
        spotMarketIndex: "",
        spotDelta: "0",
        note: `perp_socialize delta=${bnToStr(delta)} base=${bnToStr(p.baseAssetAmount)}`,
      });
      emitPool(audit, POOL_BANKRUPTCY, "bankruptcy_socialize", slot, txsig, {
        marketType: "perp",
        marketIndex: marketIdx,
        quoteDelta: credit.neg(),
        note: `perp_socialize_close to=${auth}`,
      });
    }
  }

  // --- Spot socialization: pro-rata depositor approximation.
  // We sum depositor balances first (post-reversal), then distribute residual
  // proportionally. This approximates per-depositor scaled_balance × interest
  // delta — exact only at the bankruptcy moment, which may differ from
  // post-reversal state by in-window deposit/withdraw activity.
  for (const [marketIdx, residual] of spotResidualByMarket) {
    if (residual.eq(BN0)) continue;
    const slot = spotBankrupcySlotByMarket.get(marketIdx) ?? 0;
    const txsig = spotBankrupcyTxByMarket.get(marketIdx) ?? "";
    let totalDeposits = BN0.clone();
    const depositors: Array<{ auth: string; balance: BN }> = [];
    for (const [auth, s] of states) {
      if (POOL_AUTHORITIES.has(auth)) continue;
      const bal =
        marketIdx === QUOTE_SPOT_MARKET_INDEX
          ? s.usdcCrossSignedToken
          : s.spotSignedTokenByMarket.get(marketIdx) ?? BN0;
      if (bal.gt(BN0)) {
        depositors.push({ auth, balance: bal });
        totalDeposits = totalDeposits.add(bal);
      }
    }
    if (totalDeposits.eq(BN0)) {
      // No depositors found → leave residual open; reconciliation will surface.
      continue;
    }
    let distributed = BN0.clone();
    for (let i = 0; i < depositors.length; i++) {
      const d = depositors[i];
      // Last depositor gets the rounding remainder so sum is exact.
      const credit =
        i === depositors.length - 1
          ? residual.sub(distributed)
          : residual.mul(d.balance).div(totalDeposits);
      if (credit.eq(BN0)) continue;
      const s = states.get(d.auth)!;
      if (marketIdx === QUOTE_SPOT_MARKET_INDEX) {
        s.usdcCrossSignedToken = s.usdcCrossSignedToken.add(credit);
      } else {
        const cur = s.spotSignedTokenByMarket.get(marketIdx) ?? BN0;
        s.spotSignedTokenByMarket.set(marketIdx, cur.add(credit));
      }
      distributed = distributed.add(credit);
      stats.spotDepositorsCredited += 1;
      audit.add({
        authority: d.auth,
        role: "user",
        kind: "bankruptcy_socialize",
        slot,
        txsig,
        marketType: "spot",
        marketIndex: "",
        baseDelta: "0",
        quoteDelta: "0",
        usdcDelta: "0",
        spotMarketIndex: marketIdx,
        spotDelta: credit,
        note: `spot_socialize prorata balance=${bnToStr(d.balance)} of=${bnToStr(totalDeposits)}`,
      });
      emitPool(audit, POOL_BANKRUPTCY, "bankruptcy_socialize", slot, txsig, {
        spotMarketIndex: marketIdx,
        spotDelta: credit.neg(),
        note: `spot_socialize_close to=${d.auth}`,
      });
    }
    stats.totalSpotResidualReversed = stats.totalSpotResidualReversed.add(
      distributed,
    );
  }

  return stats;
}

// --- audit reconciliation (P0.1 zero-sum invariant) -------------------------
//
// Invariant: across all rows of the audit log, signed deltas in each asset
// "slot" sum to zero. USDC has multiple slots that are all in USDC dimension:
//   - usdcDelta column
//   - quoteDelta column (perp quote is USDC denominated)
//   - spotDelta where spotMarketIndex == QUOTE_SPOT_MARKET_INDEX (spot[0])
// Per-market perp baseDelta and per-spot-market non-USDC spotDelta should each
// sum to zero in their own dimensions.

type Reconciliation = {
  totalUsdc: BN;
  perpBaseByMarket: Map<number, BN>;
  spotByMarket: Map<number, BN>; // includes market 0 (USDC) for completeness
  imbalanced: boolean;
};

function reconcileAudit(audit: AuditLog): Reconciliation {
  const recon: Reconciliation = {
    totalUsdc: BN0.clone(),
    perpBaseByMarket: new Map(),
    spotByMarket: new Map(),
    imbalanced: false,
  };
  for (const r of audit.all()) {
    if (r.usdcDelta !== "0") recon.totalUsdc = recon.totalUsdc.add(r.usdcDelta);
    if (r.quoteDelta !== "0")
      recon.totalUsdc = recon.totalUsdc.add(r.quoteDelta);
    if (
      r.spotMarketIndex !== "" &&
      r.spotMarketIndex === QUOTE_SPOT_MARKET_INDEX &&
      r.spotDelta !== "0"
    ) {
      recon.totalUsdc = recon.totalUsdc.add(r.spotDelta);
    }
    if (r.marketType === "perp" && r.marketIndex !== "" && r.baseDelta !== "0") {
      const cur = recon.perpBaseByMarket.get(r.marketIndex) ?? BN0.clone();
      recon.perpBaseByMarket.set(r.marketIndex, cur.add(r.baseDelta));
    }
    // Per-spot-market check: only for non-USDC markets. Market 0 (USDC) is
    // already covered by totalUsdc and isn't a distinct asset dimension.
    if (
      r.spotMarketIndex !== "" &&
      r.spotMarketIndex !== QUOTE_SPOT_MARKET_INDEX &&
      r.spotDelta !== "0"
    ) {
      const cur = recon.spotByMarket.get(r.spotMarketIndex) ?? BN0.clone();
      recon.spotByMarket.set(r.spotMarketIndex, cur.add(r.spotDelta));
    }
  }
  if (!recon.totalUsdc.eq(BN0)) recon.imbalanced = true;
  for (const v of recon.perpBaseByMarket.values()) {
    if (!v.eq(BN0)) recon.imbalanced = true;
  }
  for (const v of recon.spotByMarket.values()) {
    if (!v.eq(BN0)) recon.imbalanced = true;
  }
  return recon;
}

function writeReconciliation(
  recon: Reconciliation,
  filePath: string,
): void {
  const rows: string[] = ["dimension\tkey\tsigned_total"];
  rows.push(`usdc_all_slots\t-\t${bnToStr(recon.totalUsdc)}`);
  for (const [m, v] of [...recon.perpBaseByMarket.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    rows.push(`perp_base\tmarket=${m}\t${bnToStr(v)}`);
  }
  for (const [m, v] of [...recon.spotByMarket.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    rows.push(`spot_token\tmarket=${m}\t${bnToStr(v)}`);
  }
  fs.writeFileSync(filePath, rows.join("\n") + "\n");
}

// --- market-state companion (P0.4) ------------------------------------------
//
// User-state reversal alone is not enough to restore on-chain — market state
// (vAMM cumulative funding, spot market cumulative interest) was mutated in
// the window too. This emits a companion JSON: for each affected market, the
// signed cumulative deltas that must be REVERSED on-chain alongside the user
// snapshot.
//
// Sources of cumulative state change in the window:
//   - Per-funding-tick on perp markets (`eventtype_fundingraterecord`):
//     each tick advances `cumulative_funding_rate_{long,short}`.
//   - PerpBankruptcy events: cum_funding_long += delta, cum_funding_short -= delta.
//   - SpotBankruptcy events: cum_deposit_interest -= delta.
//   - Continuous spot interest accrual: minor; not in our event set.
//
// If `out/athena/funding_rate.csv` is present, those deltas are aggregated.
// Otherwise the file is written with a `missing: ["funding_rate"]` flag so
// the gap is surfaced rather than silently zero.

type FundingRateRow = {
  slot: number;
  marketIndex: number;
  fundingRateLong?: BN;
  fundingRateShort?: BN;
  cumulativeFundingRateLong?: BN;
  cumulativeFundingRateShort?: BN;
};

function loadFundingRateCsv(filePath: string): FundingRateRow[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  // Use csv-parse since Athena's output is quote-wrapped.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parse } = require("csv-parse/sync") as typeof import("csv-parse/sync");
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
  }) as Record<string, string>[];
  return rows.map((r) => ({
    slot: Number(r.slot) || 0,
    marketIndex: Number(r.marketindex) || 0,
    fundingRateLong: r.fundingratelong ? new BN(r.fundingratelong, 10) : undefined,
    fundingRateShort: r.fundingrateshort ? new BN(r.fundingrateshort, 10) : undefined,
    cumulativeFundingRateLong: r.cumulativefundingratelong
      ? new BN(r.cumulativefundingratelong, 10)
      : undefined,
    cumulativeFundingRateShort: r.cumulativefundingrateshort
      ? new BN(r.cumulativefundingrateshort, 10)
      : undefined,
  }));
}

function buildMarketStateDeltas(opts: {
  fundingRateRows: FundingRateRow[];
  bankruptcy: BankruptcyStats;
  cutoffSlot: number;
  windowEndSlot: number;
  outputPath: string;
}): { perpMarkets: number; spotMarkets: number; missing: string[] } {
  const perpMarkets = new Map<
    number,
    {
      cumulativeFundingRateLong_delta_to_subtract: BN;
      cumulativeFundingRateShort_delta_to_subtract: BN;
      bankruptcyDelta: BN;
      fundingRateRecordCount: number;
      lastSeenCumLong: BN | null;
      lastSeenCumShort: BN | null;
      firstSeenCumLong: BN | null;
      firstSeenCumShort: BN | null;
    }
  >();
  const spotMarkets = new Map<
    number,
    {
      cumulativeDepositInterest_delta_to_add: BN;
      borrowRedistributedToDepositors_tokens: BN;
    }
  >();

  // --- funding rate accruals ---
  // We use first/last cumulative values per market in the window; the diff is
  // what was added to cum during the window and is what we'd subtract to
  // rewind.
  for (const row of opts.fundingRateRows.sort((a, b) => a.slot - b.slot)) {
    if (row.slot < opts.cutoffSlot || row.slot > opts.windowEndSlot) continue;
    if (
      row.cumulativeFundingRateLong === undefined ||
      row.cumulativeFundingRateShort === undefined
    )
      continue;
    let m = perpMarkets.get(row.marketIndex);
    if (!m) {
      m = {
        cumulativeFundingRateLong_delta_to_subtract: BN0.clone(),
        cumulativeFundingRateShort_delta_to_subtract: BN0.clone(),
        bankruptcyDelta: BN0.clone(),
        fundingRateRecordCount: 0,
        lastSeenCumLong: null,
        lastSeenCumShort: null,
        firstSeenCumLong: null,
        firstSeenCumShort: null,
      };
      perpMarkets.set(row.marketIndex, m);
    }
    m.fundingRateRecordCount += 1;
    if (m.firstSeenCumLong === null) {
      m.firstSeenCumLong = row.cumulativeFundingRateLong.clone();
      m.firstSeenCumShort = row.cumulativeFundingRateShort.clone();
    }
    m.lastSeenCumLong = row.cumulativeFundingRateLong.clone();
    m.lastSeenCumShort = row.cumulativeFundingRateShort.clone();
  }
  for (const [, m] of perpMarkets) {
    if (m.lastSeenCumLong && m.firstSeenCumLong) {
      m.cumulativeFundingRateLong_delta_to_subtract = m.lastSeenCumLong.sub(
        m.firstSeenCumLong,
      );
    }
    if (m.lastSeenCumShort && m.firstSeenCumShort) {
      m.cumulativeFundingRateShort_delta_to_subtract = m.lastSeenCumShort.sub(
        m.firstSeenCumShort,
      );
    }
  }

  // --- bankruptcy market deltas ---
  for (const [marketIdx, delta] of opts.bankruptcy.perpMarketDeltas) {
    let m = perpMarkets.get(marketIdx);
    if (!m) {
      m = {
        cumulativeFundingRateLong_delta_to_subtract: BN0.clone(),
        cumulativeFundingRateShort_delta_to_subtract: BN0.clone(),
        bankruptcyDelta: BN0.clone(),
        fundingRateRecordCount: 0,
        lastSeenCumLong: null,
        lastSeenCumShort: null,
        firstSeenCumLong: null,
        firstSeenCumShort: null,
      };
      perpMarkets.set(marketIdx, m);
    }
    m.bankruptcyDelta = m.bankruptcyDelta.add(delta);
  }
  for (const [marketIdx, interestDelta] of opts.bankruptcy
    .spotMarketInterestDeltas) {
    let s = spotMarkets.get(marketIdx);
    if (!s) {
      s = {
        cumulativeDepositInterest_delta_to_add: BN0.clone(),
        borrowRedistributedToDepositors_tokens: BN0.clone(),
      };
      spotMarkets.set(marketIdx, s);
    }
    s.cumulativeDepositInterest_delta_to_add = s.cumulativeDepositInterest_delta_to_add.add(
      interestDelta,
    );
  }
  for (const [marketIdx, residual] of opts.bankruptcy.spotMarketResiduals) {
    let s = spotMarkets.get(marketIdx);
    if (!s) {
      s = {
        cumulativeDepositInterest_delta_to_add: BN0.clone(),
        borrowRedistributedToDepositors_tokens: BN0.clone(),
      };
      spotMarkets.set(marketIdx, s);
    }
    s.borrowRedistributedToDepositors_tokens = s.borrowRedistributedToDepositors_tokens.add(
      residual,
    );
  }

  // --- serialize ---
  const perpOut: Record<string, unknown> = {};
  for (const [m, v] of [...perpMarkets.entries()].sort((a, b) => a[0] - b[0])) {
    perpOut[String(m)] = {
      cumulativeFundingRateLong_delta_to_subtract: bnToStr(
        v.cumulativeFundingRateLong_delta_to_subtract,
      ),
      cumulativeFundingRateShort_delta_to_subtract: bnToStr(
        v.cumulativeFundingRateShort_delta_to_subtract,
      ),
      bankruptcyDelta_socialized: bnToStr(v.bankruptcyDelta),
      fundingRateRecordCount: v.fundingRateRecordCount,
    };
  }
  const spotOut: Record<string, unknown> = {};
  for (const [m, v] of [...spotMarkets.entries()].sort((a, b) => a[0] - b[0])) {
    spotOut[String(m)] = {
      cumulativeDepositInterest_delta_to_add: bnToStr(
        v.cumulativeDepositInterest_delta_to_add,
      ),
      borrowRedistributedToDepositors_tokens: bnToStr(
        v.borrowRedistributedToDepositors_tokens,
      ),
    };
  }
  const missing: string[] = [];
  if (opts.fundingRateRows.length === 0) {
    missing.push("funding_rate (run Athena query on eventtype_fundingraterecord)");
  }
  const doc = {
    generatedAt: new Date().toISOString(),
    cutoffSlot: opts.cutoffSlot,
    windowEndSlot: opts.windowEndSlot,
    missing,
    notes: [
      "Apply these deltas BEFORE restoring user state on-chain.",
      "Perp: market.amm.cumulative_funding_rate_long -= cumulativeFundingRateLong_delta_to_subtract; same for short.",
      "Perp: bankruptcyDelta_socialized is already counted in the above; surfaced separately to explain magnitude.",
      "Spot: market.cumulative_deposit_interest += cumulativeDepositInterest_delta_to_add (reverses the bankruptcy decrement).",
      "Spot: borrowRedistributedToDepositors_tokens is the bankruptcy residual that was socialized; pre-window depositors should NOT see it.",
    ],
    perpMarkets: perpOut,
    spotMarkets: spotOut,
  };
  fs.writeFileSync(opts.outputPath, JSON.stringify(doc, null, 2) + "\n");
  return {
    perpMarkets: perpMarkets.size,
    spotMarkets: spotMarkets.size,
    missing,
  };
}

// --- referrer reward clawback ----------------------------------------------
//
// Forward semantics:
//   taker pays `takerFee` total → `referrerReward` of that goes to the
//   referrer's USDC spot balance, rest to protocol/filler.
//
// The backtrack already refunds `takerFee` to the taker (so they're whole).
// To undo the referrer's gain we need the referrer authority, which lives on
// the taker's UserStats account, not on TradeRecord. We fetch UserStats once
// per unique taker authority and emit one audit row per (trade, referrer).

type ReferrerClawbackStats = {
  trades: number;
  takerAuthorities: number;
  uniqueReferrers: number;
  noStats: number;
  noReferrer: number;
  referrersInSnapshot: number;
  referrersAddedNegative: number;
  totalClawback: BN;
};

async function applyReferrerClawback(
  trades: TradeEvent[],
  states: Map<string, AuthorityState>,
  subToAuth: Map<string, string>,
  audit: AuditLog,
  rpcUrl: string,
): Promise<ReferrerClawbackStats> {
  const stats: ReferrerClawbackStats = {
    trades: 0,
    takerAuthorities: 0,
    uniqueReferrers: 0,
    noStats: 0,
    noReferrer: 0,
    referrersInSnapshot: 0,
    referrersAddedNegative: 0,
    totalClawback: BN0.clone(),
  };

  type Reward = { taker: string; takerAuth: string; slot: number; txsig: string; reward: BN };
  const rewards: Reward[] = [];
  const takerAuthSet = new Set<string>();
  for (const t of trades) {
    if (t.referrerReward.eq(BN0)) continue;
    if (!t.taker) continue;
    const auth = subToAuth.get(t.taker);
    if (!auth) continue;
    rewards.push({
      taker: t.taker,
      takerAuth: auth,
      slot: t.slot,
      txsig: t.txsig,
      reward: t.referrerReward,
    });
    takerAuthSet.add(auth);
  }
  stats.trades = rewards.length;
  stats.takerAuthorities = takerAuthSet.size;
  if (rewards.length === 0) {
    console.log("referrer clawback: no trades with referrer reward in window");
    return stats;
  }

  console.log(
    `referrer clawback: ${rewards.length} trades from ${takerAuthSet.size} taker authorities — fetching UserStats...`,
  );

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(Keypair.generate());
  const bulkAccountLoader = new BulkAccountLoader(
    // @ts-ignore
    connection,
    "confirmed",
    2000,
  );
  const driftClient = new DriftClient({
    // @ts-ignore
    connection,
    // @ts-ignore
    wallet,
    env: "mainnet-beta",
    skipLoadUsers: true,
    accountSubscription: { type: "polling", accountLoader: bulkAccountLoader },
  });
  await driftClient.subscribe();

  const takerAuthorities = [...takerAuthSet];
  const statsPubkeys = takerAuthorities.map((a) =>
    getUserStatsAccountPublicKey(DRIFT_PROGRAM_ID, new PublicKey(a)),
  );
  const referrerByTakerAuth = new Map<string, string | null>();
  const CHUNK = 100;
  for (let i = 0; i < statsPubkeys.length; i += CHUNK) {
    const slice = statsPubkeys.slice(i, i + CHUNK);
    const decoded = await driftClient.program.account.userStats.fetchMultiple(
      slice as unknown as PublicKey[],
    );
    for (let j = 0; j < slice.length; j++) {
      const auth = takerAuthorities[i + j];
      const acct = decoded[j] as unknown as { referrer: PublicKey } | null;
      if (!acct) {
        referrerByTakerAuth.set(auth, null);
        stats.noStats += 1;
        continue;
      }
      const ref = acct.referrer.toBase58();
      if (ref === ZERO_PUBKEY) {
        referrerByTakerAuth.set(auth, null);
        stats.noReferrer += 1;
      } else {
        referrerByTakerAuth.set(auth, ref);
      }
    }
  }
  await driftClient.unsubscribe();

  // Aggregate per referrer + emit per-trade audit rows.
  const referrerTotals = new Map<string, BN>();
  for (const r of rewards) {
    const ref = referrerByTakerAuth.get(r.takerAuth);
    if (!ref) continue; // no UserStats or no referrer set — surfaced in stats
    referrerTotals.set(
      ref,
      (referrerTotals.get(ref) ?? BN0.clone()).add(r.reward),
    );
    audit.add({
      authority: ref,
      role: "referrer",
      kind: "referrer_clawback",
      slot: r.slot,
      txsig: r.txsig,
      marketType: "",
      marketIndex: "",
      baseDelta: "0",
      quoteDelta: "0",
      usdcDelta: r.reward.neg(),
      spotMarketIndex: "",
      spotDelta: "0",
      note: `from_taker=${r.takerAuth}`,
    });
    // Protocol pool re-receives the referrer share (protocol then paid it out
    // to the taker as part of takerFee refund — matches the symmetric protocol
    // pool entries emitted in reverseTrade).
    audit.add({
      authority: POOL_PROTOCOL_FEE,
      role: "pool",
      kind: "referrer_clawback",
      slot: r.slot,
      txsig: r.txsig,
      marketType: "",
      marketIndex: "",
      baseDelta: "0",
      quoteDelta: "0",
      usdcDelta: r.reward,
      spotMarketIndex: "",
      spotDelta: "0",
      note: `referrer_share_back_to_protocol from=${ref}`,
    });
  }
  stats.uniqueReferrers = referrerTotals.size;

  for (const [ref, total] of referrerTotals) {
    stats.totalClawback = stats.totalClawback.add(total);
    const s = states.get(ref);
    if (s) {
      s.usdcCrossSignedToken = s.usdcCrossSignedToken.sub(total);
      stats.referrersInSnapshot += 1;
    } else {
      const fresh = emptyAuthorityState();
      fresh.usdcCrossSignedToken = total.neg();
      states.set(ref, fresh);
      stats.referrersAddedNegative += 1;
      console.warn(
        `  referrer ${ref} not in snapshot — added entry with negative USDC ${bnToStr(total.neg())}`,
      );
    }
  }

  return stats;
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseFlags();

  // Load snapshot
  console.log(`Reading snapshot: ${flags.snapshot}`);
  const snap = JSON.parse(fs.readFileSync(flags.snapshot, "utf8")) as Snapshot;

  // Load subaccount → authority
  console.log(`Reading users JSON: ${flags.usersJson}`);
  const { csvAuthorityByUserAccount } = readUserAccountsJson(flags.usersJson);
  const subToAuth: Map<string, string> = csvAuthorityByUserAccount;
  console.log(`  ${subToAuth.size} sub-account → authority mappings`);

  // Build mutable authority state
  const { byAuth: states, collapsedCount } = buildAuthorityStates(snap);
  console.log(
    `Loaded ${states.size} authorities; collapsed ${collapsedCount} duplicate-market perp entries`,
  );

  // Load events
  console.log(`Reading trades: ${flags.tradesCsv}`);
  const trades = loadTradeEvents(flags.tradesCsv).filter(
    (t) => t.slot >= flags.cutoffSlot,
  );
  console.log(`  ${trades.length} trade events in window`);

  console.log(`Reading funding: ${flags.fundingCsv}`);
  const fundings = loadFundingEvents(flags.fundingCsv).filter(
    (t) => t.slot >= flags.cutoffSlot,
  );
  console.log(`  ${fundings.length} funding events in window`);

  console.log(`Reading liquidations: ${flags.liquidationsCsv}`);
  const liqs = loadLiquidationEvents(flags.liquidationsCsv).filter(
    (t) => t.slot >= flags.cutoffSlot,
  );
  console.log(`  ${liqs.length} liquidation events in window`);

  const settles = fs.existsSync(flags.settlePnlCsv)
    ? loadSettlePnlEvents(flags.settlePnlCsv).filter((t) => t.slot >= flags.cutoffSlot)
    : [];
  console.log(`Reading settle_pnl: ${flags.settlePnlCsv} — ${settles.length} events`);

  const swaps = fs.existsSync(flags.swapCsv)
    ? loadSwapEvents(flags.swapCsv).filter((t) => t.slot >= flags.cutoffSlot)
    : [];
  console.log(`Reading swaps: ${flags.swapCsv} — ${swaps.length} events`);

  // Merge + sort chronologically. Order does not affect correctness (all
  // operations are commutative add/subtract), but a stable order keeps the
  // anomalies log deterministic.
  const events: AnyEvent[] = [...trades, ...fundings, ...liqs, ...settles, ...swaps];
  events.sort(
    (a, b) => a.slot - b.slot || a.txsigindex - b.txsigindex,
  );

  // Apply reversals
  const anomalies = new Anomalies();
  const audit = new AuditLog();
  const tradeCounters = { perpFills: 0, spotFills: 0, oneSidedFills: 0 };
  const liqCounters = {
    liqEvents: 0,
    ifFeeReversed: BN0.clone(),
    liquidatorFeeReversed: BN0.clone(),
  };

  for (const ev of events) {
    if (ev.kind === "trade") {
      reverseTrade(ev, states, subToAuth, anomalies, audit, tradeCounters);
    } else if (ev.kind === "funding") {
      reverseFunding(ev, states, subToAuth, anomalies, audit);
    } else if (ev.kind === "liquidation") {
      reverseLiquidation(ev, states, subToAuth, anomalies, audit, liqCounters);
    } else if (ev.kind === "settlePnl") {
      reverseSettlePnl(ev, states, subToAuth, anomalies, audit);
    } else if (ev.kind === "swap") {
      reverseSwap(ev, states, subToAuth, anomalies, audit);
    }
  }

  // Optional: referrer reward clawback (requires RPC for UserStats lookup).
  let referrerStats: ReferrerClawbackStats | null = null;
  if (!flags.skipReferrerClawback && flags.rpcUrl) {
    referrerStats = await applyReferrerClawback(
      trades,
      states,
      subToAuth,
      audit,
      flags.rpcUrl,
    );
  } else if (!flags.skipReferrerClawback) {
    console.log(
      "Skipping referrer clawback: no --rpc-url provided (set RPC_URL or pass --skip-referrer-clawback to silence).",
    );
  }

  // P0.3: per-holder bankruptcy socialization reversal.
  // Applied after all event reversals so the holder set approximates the
  // pre-window membership of each market. Closes the residual opened by the
  // bankruptcy events against POOL_BANKRUPTCY.
  const bankruptcy = applyBankruptcySocialization(liqs, states, audit);
  console.log(
    `bankruptcy socialization: perp_markets=${bankruptcy.perpMarketsCovered} ` +
      `holders=${bankruptcy.perpHoldersCredited} perp_quote_reversed=${bnToStr(bankruptcy.totalPerpResidualReversed)}; ` +
      `spot_markets=${bankruptcy.spotMarketsCovered} depositors=${bankruptcy.spotDepositorsCredited} ` +
      `spot_token_reversed=${bnToStr(bankruptcy.totalSpotResidualReversed)}`,
  );

  // Realign every (now-)open perp position's lastCumulativeFundingRate to the
  // market's snapshot cumulative funding rate, so calculatePositionPNL sees
  // zero pending funding. See header for the caveat re: AMM cum reset.
  let realignedPositions = 0;
  for (const [, s] of states) {
    for (const [, p] of s.perpByMarket) {
      const m = snap.perpMarkets[p.marketIndex];
      if (!m) continue;
      const target = p.baseAssetAmount.isNeg()
        ? strToBn(m.amm.cumulativeFundingRateShort)
        : strToBn(m.amm.cumulativeFundingRateLong);
      p.lastCumulativeFundingRate = target;
      realignedPositions += 1;
    }
  }

  // Serialize
  const backtrackedBorrowLend = exportAuthorityStates(states);
  const out: Snapshot = {
    ...snap,
    snapshotTimestampUtc: new Date().toISOString(),
    borrowLendByAuthority: backtrackedBorrowLend,
    perpBacktrackCutoffTs: flags.cutoffTs || flags.cutoffSlot,
    perpBacktrackSourceSnapshot: path.relative(__dirname, flags.snapshot),
    perpBacktrackTradeMonthsLabel: flags.tradeMonthsLabel,
  };
  fs.mkdirSync(path.dirname(flags.output), { recursive: true });
  fs.writeFileSync(flags.output, stableJsonStringify(out, 0));
  console.log(`Wrote backtracked snapshot: ${flags.output}`);

  // Anomalies + audit trail + summary
  anomalies.write(flags.anomaliesPath);
  console.log(`Wrote anomalies log: ${flags.anomaliesPath}`);
  const auditStats = audit.writeCsv(flags.auditPath);
  console.log(
    `Wrote audit trail: ${flags.auditPath} (${auditStats.totalRows} rows across ${auditStats.uniqueAuthorities} authorities)`,
  );

  // P0.1: zero-sum reconciliation.
  const recon = reconcileAudit(audit);
  writeReconciliation(recon, flags.reconciliationPath);
  if (recon.imbalanced) {
    console.warn(
      `RECONCILIATION IMBALANCED — see ${flags.reconciliationPath}. ` +
        `usdc_residual=${bnToStr(recon.totalUsdc)}`,
    );
  } else {
    console.log(
      `reconciliation: ZERO-SUM PASSED across ${audit.all().length} audit rows`,
    );
  }
  console.log(`Wrote reconciliation report: ${flags.reconciliationPath}`);

  // P0.4: market-state companion (apply before on-chain restore).
  const fundingRateRows = loadFundingRateCsv(flags.fundingRateCsv);
  const msStats = buildMarketStateDeltas({
    fundingRateRows,
    bankruptcy,
    cutoffSlot: flags.cutoffSlot,
    windowEndSlot: flags.windowEndSlot,
    outputPath: flags.marketStateDeltasPath,
  });
  console.log(
    `Wrote market-state deltas: ${flags.marketStateDeltasPath} (perp=${msStats.perpMarkets} spot=${msStats.spotMarkets} missing=${msStats.missing.length})`,
  );
  if (msStats.missing.length > 0) {
    console.warn(`  market-state missing: ${msStats.missing.join("; ")}`);
  }

  console.log("\n=== summary ===");
  console.log(
    `events: trades=${trades.length} funding=${fundings.length} liquidations=${liqs.length} settles=${settles.length} swaps=${swaps.length}`,
  );
  console.log(
    `trade pass: perpFills=${tradeCounters.perpFills} spotFills=${tradeCounters.spotFills} oneSidedFills=${tradeCounters.oneSidedFills}`,
  );
  console.log(
    `liq pass: events=${liqCounters.liqEvents} liquidatorFeeReversed=${bnToStr(liqCounters.liquidatorFeeReversed)} ifFeeReversed=${bnToStr(liqCounters.ifFeeReversed)}`,
  );
  console.log(`positions realigned (lastCumFunding): ${realignedPositions}`);
  console.log(`collapsed multi-subaccount perp entries: ${collapsedCount}`);
  if (referrerStats) {
    console.log(
      `referrer clawback: ${referrerStats.trades} trades, ${referrerStats.uniqueReferrers} referrers debited, ` +
        `total=${bnToStr(referrerStats.totalClawback)} (no_stats=${referrerStats.noStats} no_referrer=${referrerStats.noReferrer})`,
    );
  }
  const acounts = anomalies.countsSummary();
  if (acounts.length === 0) {
    console.log("anomalies: none");
  } else {
    console.log("anomalies (top categories):");
    for (const [k, n] of acounts.slice(0, 20)) console.log(`  ${k}\t${n}`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
