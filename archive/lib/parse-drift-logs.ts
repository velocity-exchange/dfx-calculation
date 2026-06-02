/**
 * Adapt anchor-decoded Drift events from transaction logs into the same shape
 * `lib/backtrack-events.ts` produces from the Athena CSVs.
 *
 * Athena's tables are a flattened, lowercase-keyed dump of the on-chain event
 * structs. When parsing logs directly via `@drift-labs/sdk` `parseLogs`, the
 * event data is a (camelCase, typed) object with `BN`s and `PublicKey`s. This
 * module renames + coerces those into the existing `TradeEvent` / etc. types
 * so the rest of the pipeline can be reused verbatim.
 *
 * `slot` and `txsig` come from the source transaction (the on-chain event
 * itself doesn't carry them). `txsigindex` is the index of the same-kind
 * event within that transaction — matching how Athena assigns the field for
 * multi-event transactions.
 */

import { BN } from "@drift-labs/sdk";
import { PublicKey } from "@solana/web3.js";

import type {
  Direction,
  FundingEvent,
  LiquidateBorrowForPerpPnlSub,
  LiquidatePerpPnlForDepositSub,
  LiquidatePerpSub,
  LiquidateSpotSub,
  LiquidationEvent,
  PerpBankruptcySub,
  SettlePnlEvent,
  SpotBankruptcySub,
  SwapEvent,
  TradeEvent,
} from "./backtrack-events.ts";

/** Anchor decoded event surface: `{ name, data }` where data fields are
 * already typed (BN / PublicKey / SDK variants). */
export type AnchorEvent = { name: string; data: Record<string, unknown> };

export type TxMeta = { slot: number; txsig: string; ts: number };

export type AdaptedEvents = {
  trades: TradeEvent[];
  fundings: FundingEvent[];
  liquidations: LiquidationEvent[];
  settles: SettlePnlEvent[];
  swaps: SwapEvent[];
};

const BN0 = new BN(0);

function bnOrZero(v: unknown): BN {
  if (v === null || v === undefined) return BN0;
  if (BN.isBN(v)) return v;
  if (typeof v === "bigint") return new BN(v.toString(10));
  if (typeof v === "number") return new BN(v);
  if (typeof v === "string") return new BN(v, 10);
  return BN0;
}

function pkOrEmpty(pk: unknown): string {
  if (!pk) return "";
  if (typeof pk === "string") return pk;
  if (pk instanceof PublicKey) return pk.toBase58();
  if (typeof (pk as { toBase58?: () => string }).toBase58 === "function") {
    return (pk as { toBase58: () => string }).toBase58();
  }
  return String(pk);
}

/** Anchor encodes Rust enums as `{ [variantName]: {} }`. Return the first
 * key lowercased, "" if none. */
function variantName(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  const keys = Object.keys(v as object);
  return keys.length > 0 ? keys[0].toLowerCase() : "";
}

function directionFromVariant(v: unknown): Direction | "" {
  const k = variantName(v);
  return k === "long" || k === "short" ? k : "";
}

function marketTypeFromVariant(v: unknown): "perp" | "spot" {
  // Drift only has perp + spot. Default to perp on unrecognised input — the
  // reversal pass already handles unknown market types defensively.
  return variantName(v) === "spot" ? "spot" : "perp";
}

/** A sub-struct is "active" iff at least one BN/numeric field is non-zero
 * or contains a non-empty pubkey. Mirrors `subActive` in `backtrack-events.ts`. */
function subActive(o: unknown): boolean {
  if (!o || typeof o !== "object") return false;
  for (const v of Object.values(o as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (BN.isBN(v)) {
      if (!(v as BN).eq(BN0)) return true;
      continue;
    }
    if (typeof v === "number" && v !== 0) return true;
    if (typeof v === "string" && v !== "" && v !== "0") return true;
    if (v instanceof PublicKey) return true;
  }
  return false;
}

function toLiquidatePerpSub(o: Record<string, unknown>): LiquidatePerpSub {
  return {
    marketIndex: Number(o.marketIndex ?? 0),
    oraclePrice: bnOrZero(o.oraclePrice),
    baseAssetAmount: bnOrZero(o.baseAssetAmount),
    quoteAssetAmount: bnOrZero(o.quoteAssetAmount),
    lpShares: bnOrZero(o.lpShares),
    fillRecordId: bnOrZero(o.fillRecordId).toString(10),
    liquidatorFee: bnOrZero(o.liquidatorFee),
    ifFee: bnOrZero(o.ifFee),
  };
}

function toLiquidateSpotSub(o: Record<string, unknown>): LiquidateSpotSub {
  return {
    assetMarketIndex: Number(o.assetMarketIndex ?? 0),
    assetPrice: bnOrZero(o.assetPrice),
    assetTransfer: bnOrZero(o.assetTransfer),
    liabilityMarketIndex: Number(o.liabilityMarketIndex ?? 0),
    liabilityPrice: bnOrZero(o.liabilityPrice),
    liabilityTransfer: bnOrZero(o.liabilityTransfer),
    ifFee: bnOrZero(o.ifFee),
  };
}

function toLiquidateBorrowForPerpPnlSub(
  o: Record<string, unknown>,
): LiquidateBorrowForPerpPnlSub {
  return {
    perpMarketIndex: Number(o.perpMarketIndex ?? 0),
    marketOraclePrice: bnOrZero(o.marketOraclePrice),
    pnlTransfer: bnOrZero(o.pnlTransfer),
    liabilityMarketIndex: Number(o.liabilityMarketIndex ?? 0),
    liabilityPrice: bnOrZero(o.liabilityPrice),
    liabilityTransfer: bnOrZero(o.liabilityTransfer),
  };
}

function toLiquidatePerpPnlForDepositSub(
  o: Record<string, unknown>,
): LiquidatePerpPnlForDepositSub {
  return {
    perpMarketIndex: Number(o.perpMarketIndex ?? 0),
    marketOraclePrice: bnOrZero(o.marketOraclePrice),
    pnlTransfer: bnOrZero(o.pnlTransfer),
    assetMarketIndex: Number(o.assetMarketIndex ?? 0),
    assetPrice: bnOrZero(o.assetPrice),
    assetTransfer: bnOrZero(o.assetTransfer),
  };
}

function toPerpBankruptcySub(o: Record<string, unknown>): PerpBankruptcySub {
  const clawbackUser = o.clawbackUser;
  return {
    marketIndex: Number(o.marketIndex ?? 0),
    pnl: bnOrZero(o.pnl),
    ifPayment: bnOrZero(o.ifPayment),
    clawbackUser:
      clawbackUser === null || clawbackUser === undefined
        ? null
        : pkOrEmpty(clawbackUser),
    clawbackUserPayment: bnOrZero(o.clawbackUserPayment),
    cumulativeFundingRateDelta: bnOrZero(o.cumulativeFundingRateDelta),
  };
}

function toSpotBankruptcySub(o: Record<string, unknown>): SpotBankruptcySub {
  return {
    marketIndex: Number(o.marketIndex ?? 0),
    borrowAmount: bnOrZero(o.borrowAmount),
    ifPayment: bnOrZero(o.ifPayment),
    cumulativeDepositInterestDelta: bnOrZero(o.cumulativeDepositInterestDelta),
  };
}

/**
 * Convert anchor-decoded Drift events from one tx into the shape the existing
 * backtrack reversal functions consume.
 */
export function adaptDriftEvents(
  events: AnchorEvent[],
  meta: TxMeta,
): AdaptedEvents {
  const out: AdaptedEvents = {
    trades: [],
    fundings: [],
    liquidations: [],
    settles: [],
    swaps: [],
  };
  let tradeIdx = 0;
  let fundingIdx = 0;
  let liqIdx = 0;
  let settleIdx = 0;
  let swapIdx = 0;

  for (const e of events) {
    const d = e.data;

    if (e.name === "OrderActionRecord") {
      // OrderActionRecord covers place/cancel/trigger/fill — backtrack only
      // reverses fills.
      const action = variantName(d.action);
      if (action !== "fill") continue;
      out.trades.push({
        kind: "trade",
        slot: meta.slot,
        txsigindex: tradeIdx++,
        ts: meta.ts,
        action,
        actionExplanation: variantName(d.actionExplanation),
        marketIndex: Number(d.marketIndex ?? 0),
        marketType: marketTypeFromVariant(d.marketType),
        filler: pkOrEmpty(d.filler),
        fillerReward: bnOrZero(d.fillerReward),
        fillRecordId: bnOrZero(d.fillRecordId).toString(10),
        baseAssetAmountFilled: bnOrZero(d.baseAssetAmountFilled),
        quoteAssetAmountFilled: bnOrZero(d.quoteAssetAmountFilled),
        takerFee: bnOrZero(d.takerFee),
        makerFee: bnOrZero(d.makerFee),
        referrerReward: bnOrZero(d.referrerReward),
        quoteAssetAmountSurplus: bnOrZero(d.quoteAssetAmountSurplus),
        spotFulfillmentMethodFee: bnOrZero(d.spotFulfillmentMethodFee),
        taker: pkOrEmpty(d.taker),
        takerOrderDirection: directionFromVariant(d.takerOrderDirection),
        maker: pkOrEmpty(d.maker),
        makerOrderDirection: directionFromVariant(d.makerOrderDirection),
        oraclePrice: bnOrZero(d.oraclePrice),
        txsig: meta.txsig,
      });
      continue;
    }

    if (e.name === "FundingPaymentRecord") {
      out.fundings.push({
        kind: "funding",
        slot: meta.slot,
        txsigindex: fundingIdx++,
        ts: meta.ts,
        userAuthority: pkOrEmpty(d.userAuthority),
        user: pkOrEmpty(d.user),
        marketIndex: Number(d.marketIndex ?? 0),
        fundingPayment: bnOrZero(d.fundingPayment),
        baseAssetAmount: bnOrZero(d.baseAssetAmount),
        userLastCumulativeFunding: bnOrZero(d.userLastCumulativeFunding),
        ammCumulativeFundingLong: bnOrZero(d.ammCumulativeFundingLong),
        ammCumulativeFundingShort: bnOrZero(d.ammCumulativeFundingShort),
        txsig: meta.txsig,
      });
      continue;
    }

    if (e.name === "LiquidationRecord") {
      const lp = d.liquidatePerp as Record<string, unknown> | null;
      const ls = d.liquidateSpot as Record<string, unknown> | null;
      const lbfp = d.liquidateBorrowForPerpPnl as Record<string, unknown> | null;
      const lpfd = d.liquidatePerpPnlForDeposit as Record<string, unknown> | null;
      const pb = d.perpBankruptcy as Record<string, unknown> | null;
      const sb = d.spotBankruptcy as Record<string, unknown> | null;
      out.liquidations.push({
        kind: "liquidation",
        slot: meta.slot,
        txsigindex: liqIdx++,
        ts: meta.ts,
        liquidationType: variantName(d.liquidationType),
        user: pkOrEmpty(d.user),
        liquidator: pkOrEmpty(d.liquidator),
        bankrupt: Boolean(d.bankrupt),
        liquidatePerp: subActive(lp) ? toLiquidatePerpSub(lp!) : null,
        liquidateSpot: subActive(ls) ? toLiquidateSpotSub(ls!) : null,
        liquidateBorrowForPerpPnl: subActive(lbfp)
          ? toLiquidateBorrowForPerpPnlSub(lbfp!)
          : null,
        liquidatePerpPnlForDeposit: subActive(lpfd)
          ? toLiquidatePerpPnlForDepositSub(lpfd!)
          : null,
        perpBankruptcy: subActive(pb) ? toPerpBankruptcySub(pb!) : null,
        spotBankruptcy: subActive(sb) ? toSpotBankruptcySub(sb!) : null,
        txsig: meta.txsig,
      });
      continue;
    }

    if (e.name === "SettlePnlRecord") {
      out.settles.push({
        kind: "settlePnl",
        slot: meta.slot,
        txsigindex: settleIdx++,
        ts: meta.ts,
        user: pkOrEmpty(d.user),
        marketIndex: Number(d.marketIndex ?? 0),
        pnl: bnOrZero(d.pnl),
        baseAssetAmount: bnOrZero(d.baseAssetAmount),
        quoteAssetAmountAfter: bnOrZero(d.quoteAssetAmountAfter),
        quoteEntryAmount: bnOrZero(d.quoteEntryAmount),
        settlePrice: bnOrZero(d.settlePrice),
        explanation: variantName(d.explanation),
        txsig: meta.txsig,
      });
      continue;
    }

    if (e.name === "SwapRecord") {
      out.swaps.push({
        kind: "swap",
        slot: meta.slot,
        txsigindex: swapIdx++,
        ts: meta.ts,
        user: pkOrEmpty(d.user),
        amountOut: bnOrZero(d.amountOut),
        amountIn: bnOrZero(d.amountIn),
        outMarketIndex: Number(d.outMarketIndex ?? 0),
        inMarketIndex: Number(d.inMarketIndex ?? 0),
        outOraclePrice: bnOrZero(d.outOraclePrice),
        inOraclePrice: bnOrZero(d.inOraclePrice),
        fee: bnOrZero(d.fee),
        txsig: meta.txsig,
      });
      continue;
    }
  }

  return out;
}
