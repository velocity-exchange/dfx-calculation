import { BN } from "@drift-labs/sdk";
import {
  bnToStr,
  strToBn,
  type PerpMarketSnapshot,
  type PerpPositionSnapshot,
} from "./snapshot-types.ts";

const BN0 = new BN(0);

function bnFieldOrZero(v: unknown): string {
  if (!v) return "0";
  if (v instanceof BN) return bnToStr(v);
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") {
    return new BN(v.toString(), 10).toString(10);
  }
  return "0";
}

function numField(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  if (v instanceof BN) return (v as BN).toNumber();
  return 0;
}

export function extractPerpPosition(perp: any): PerpPositionSnapshot {
  return {
    marketIndex: numField(perp.marketIndex),
    baseAssetAmount: bnFieldOrZero(perp.baseAssetAmount),
    quoteAssetAmount: bnFieldOrZero(perp.quoteAssetAmount),
    quoteEntryAmount: bnFieldOrZero(perp.quoteEntryAmount),
    quoteBreakEvenAmount: bnFieldOrZero(perp.quoteBreakEvenAmount),
    lastCumulativeFundingRate: bnFieldOrZero(perp.lastCumulativeFundingRate),
    settledPnl: bnFieldOrZero(perp.settledPnl),
    lpShares: bnFieldOrZero(perp.lpShares),
    lastBaseAssetAmountPerLp: bnFieldOrZero(perp.lastBaseAssetAmountPerLp),
    lastQuoteAssetAmountPerLp: bnFieldOrZero(perp.lastQuoteAssetAmountPerLp),
    remainderBaseAssetAmount: numField(perp.remainderBaseAssetAmount),
    openOrders: numField(perp.openOrders),
    openBids: bnFieldOrZero(perp.openBids),
    openAsks: bnFieldOrZero(perp.openAsks),
    positionFlag: numField(perp.positionFlag),
    isolatedPositionScaledBalance: bnFieldOrZero(
      perp.isolatedPositionScaledBalance,
    ),
    perLpBase: numField(perp.perLpBase),
  };
}

export function rehydratePerpPosition(snap: PerpPositionSnapshot): any {
  return {
    marketIndex: snap.marketIndex,
    baseAssetAmount: strToBn(snap.baseAssetAmount),
    quoteAssetAmount: strToBn(snap.quoteAssetAmount),
    quoteEntryAmount: strToBn(snap.quoteEntryAmount),
    quoteBreakEvenAmount: strToBn(snap.quoteBreakEvenAmount),
    lastCumulativeFundingRate: strToBn(snap.lastCumulativeFundingRate),
    settledPnl: strToBn(snap.settledPnl),
    lpShares: strToBn(snap.lpShares),
    lastBaseAssetAmountPerLp: strToBn(snap.lastBaseAssetAmountPerLp),
    lastQuoteAssetAmountPerLp: strToBn(snap.lastQuoteAssetAmountPerLp),
    remainderBaseAssetAmount: snap.remainderBaseAssetAmount,
    openOrders: snap.openOrders,
    openBids: strToBn(snap.openBids),
    openAsks: strToBn(snap.openAsks),
    positionFlag: snap.positionFlag,
    isolatedPositionScaledBalance: strToBn(snap.isolatedPositionScaledBalance),
    perLpBase: snap.perLpBase,
  };
}

// SDK variants are objects like `{ active: {} }` / `{ settlement: {} }`. JSON
// round-trip is identity for these as long as we copy them verbatim.
function copyVariant(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) out[k] = {};
    return out;
  }
  return {};
}

export function extractPerpMarket(market: any): PerpMarketSnapshot {
  return {
    marketIndex: numField(market.marketIndex),
    status: copyVariant(market.status),
    contractType: copyVariant(market.contractType),
    expiryPrice: bnFieldOrZero(market.expiryPrice),
    quoteSpotMarketIndex: numField(market.quoteSpotMarketIndex),
    amm: {
      cumulativeFundingRateLong: bnFieldOrZero(
        market.amm?.cumulativeFundingRateLong,
      ),
      cumulativeFundingRateShort: bnFieldOrZero(
        market.amm?.cumulativeFundingRateShort,
      ),
    },
  };
}

export function rehydratePerpMarket(snap: PerpMarketSnapshot): any {
  return {
    marketIndex: snap.marketIndex,
    status: snap.status,
    contractType: snap.contractType,
    expiryPrice: strToBn(snap.expiryPrice),
    quoteSpotMarketIndex: snap.quoteSpotMarketIndex,
    amm: {
      cumulativeFundingRateLong: strToBn(snap.amm.cumulativeFundingRateLong),
      cumulativeFundingRateShort: strToBn(snap.amm.cumulativeFundingRateShort),
    },
  };
}

export const ZERO_BN = BN0;
