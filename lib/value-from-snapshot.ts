import {
  BN,
  calculatePositionPNL,
  getTokenValue,
} from "@drift-labs/sdk";
import {
  rehydratePerpMarket,
  rehydratePerpPosition,
} from "./perp-snapshot.ts";
import {
  strToBn,
  type BorrowLendAggregateSnapshot,
  type PerpMarketSnapshot,
  type SpotMarketSnapshot,
} from "./snapshot-types.ts";

const QUOTE_SPOT_MARKET_INDEX = 0;
const BN0 = new BN(0);

export type PricedBorrowLendAgg = {
  spotByMarketQuote: Map<number, BN>;
  usdcCrossQuote: BN;
  usdcIsolatedQuote: BN;
  unrealizedPnlQuote: BN;
};

export type ValueOptions = {
  spotPricesByMarket: Map<number, BN>;
  perpOracleByMarket: Map<number, BN>;
  spotMarkets: Record<number, SpotMarketSnapshot>;
  perpMarkets: Record<number, PerpMarketSnapshot>;
  requirePerpOracleCsv: boolean;
  // Used only for error messages.
  contextLabel?: string;
};

function spotDecimals(
  spotMarkets: Record<number, SpotMarketSnapshot>,
  idx: number,
): number | undefined {
  return spotMarkets[idx]?.decimals;
}

export function valueBorrowLendAggregate(
  agg: BorrowLendAggregateSnapshot,
  opts: ValueOptions,
): PricedBorrowLendAgg {
  const {
    spotPricesByMarket,
    perpOracleByMarket,
    spotMarkets,
    perpMarkets,
    requirePerpOracleCsv,
    contextLabel,
  } = opts;

  const out: PricedBorrowLendAgg = {
    spotByMarketQuote: new Map(),
    usdcCrossQuote: BN0,
    usdcIsolatedQuote: BN0,
    unrealizedPnlQuote: BN0,
  };

  // Non-quote spot positions.
  for (const [idxStr, signedStr] of Object.entries(
    agg.spotSignedTokenByMarket,
  )) {
    const idx = Number(idxStr);
    const priceBn = spotPricesByMarket.get(idx);
    if (!priceBn) continue;
    const decimals = spotDecimals(spotMarkets, idx);
    if (decimals === undefined) continue;
    const signed = strToBn(signedStr);
    if (signed.eq(BN0)) continue;
    const unsignedValue = getTokenValue(signed.abs(), decimals, {
      price: priceBn,
    });
    const signedValue = signed.isNeg() ? unsignedValue.neg() : unsignedValue;
    // Match authority-notional.ts behavior: drop entries that price to zero
    // (e.g. 1-lamport SOL balances that floor to 0 USD).
    if (signedValue.eq(BN0)) continue;
    out.spotByMarketQuote.set(idx, signedValue);
  }

  // USDC cross + isolated. USDC always priced from the spot oracle set.
  const usdcPrice = spotPricesByMarket.get(QUOTE_SPOT_MARKET_INDEX);
  const usdcDecimals = spotDecimals(spotMarkets, QUOTE_SPOT_MARKET_INDEX);

  if (usdcPrice && usdcDecimals !== undefined) {
    const cross = strToBn(agg.usdcCrossSignedToken);
    if (!cross.eq(BN0)) {
      const v = getTokenValue(cross.abs(), usdcDecimals, { price: usdcPrice });
      out.usdcCrossQuote = cross.isNeg() ? v.neg() : v;
    }
    const isolated = strToBn(agg.usdcIsolatedToken);
    if (!isolated.eq(BN0)) {
      out.usdcIsolatedQuote = getTokenValue(isolated, usdcDecimals, {
        price: usdcPrice,
      });
    }
  }

  // Perp PnL summed across positions, then converted to USDC value via the
  // spot USDC price.
  if (usdcPrice && usdcDecimals !== undefined && agg.perpPositions.length > 0) {
    let pnlQuote = BN0;
    const missing: number[] = [];
    for (const pSnap of agg.perpPositions) {
      const marketSnap = perpMarkets[pSnap.marketIndex];
      if (!marketSnap) continue;
      const perpPrice = perpOracleByMarket.get(pSnap.marketIndex);
      if (!perpPrice) {
        missing.push(pSnap.marketIndex);
        continue;
      }
      const market = rehydratePerpMarket(marketSnap);
      const position = rehydratePerpPosition(pSnap);
      pnlQuote = pnlQuote.add(
        calculatePositionPNL(market, position, true, { price: perpPrice }),
      );
    }
    if (requirePerpOracleCsv && missing.length > 0) {
      const uniq = [...new Set(missing)].sort((a, b) => a - b);
      throw new Error(
        `Missing perp oracle close for perpMarketIndex=[${uniq.join(",")}] (${contextLabel ?? "unknown"})`,
      );
    }
    if (!pnlQuote.eq(BN0)) {
      out.unrealizedPnlQuote = getTokenValue(pnlQuote, usdcDecimals, {
        price: usdcPrice,
      });
    }
  }

  return out;
}

export function sumBorrowLendQuote(p: PricedBorrowLendAgg): BN {
  let total = BN0;
  for (const v of p.spotByMarketQuote.values()) total = total.add(v);
  total = total.add(p.usdcCrossQuote);
  total = total.add(p.usdcIsolatedQuote);
  total = total.add(p.unrealizedPnlQuote);
  return total;
}
