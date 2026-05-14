import {
  BN,
  type DriftClient,
  getSignedTokenAmount,
  getTokenAmount,
  SpotBalanceType,
  UserAccount,
} from "@drift-labs/sdk";
import { extractPerpPosition } from "./perp-snapshot.ts";
import { bnToStr, type BorrowLendAggregateSnapshot } from "./snapshot-types.ts";

export const QUOTE_SPOT_MARKET_INDEX = 0;
const BN0 = new BN(0);

/**
 * Compute price-independent aggregate state for one decoded `UserAccount`.
 *
 * Returns null if the account has no spot positions and no perp positions
 * worth recording (lets the caller skip empty users).
 */
export function aggregateUserPositions(
  user: UserAccount,
  driftClient: DriftClient,
): BorrowLendAggregateSnapshot {
  const out: BorrowLendAggregateSnapshot = {
    spotSignedTokenByMarket: {},
    usdcCrossSignedToken: "0",
    usdcIsolatedToken: "0",
    perpPositions: [],
  };

  // Non-quote spot positions: signed token amount (price-independent).
  for (const pos of user.spotPositions) {
    if (pos.marketIndex === QUOTE_SPOT_MARKET_INDEX) continue;
    const spotMarket = driftClient.getSpotMarketAccount(pos.marketIndex);
    if (!spotMarket) continue;

    const tokenAmtUnsigned = getTokenAmount(
      pos.scaledBalance,
      spotMarket,
      pos.balanceType,
    );
    const signedToken = getSignedTokenAmount(tokenAmtUnsigned, pos.balanceType);
    if (signedToken.eq(BN0)) continue;

    out.spotSignedTokenByMarket[pos.marketIndex] = bnToStr(signedToken);
  }

  // USDC cross-margin signed token amount.
  const quoteSpot = driftClient.getSpotMarketAccount(QUOTE_SPOT_MARKET_INDEX);
  if (quoteSpot) {
    const spot0Pos = user.spotPositions.find(
      (p) => p.marketIndex === QUOTE_SPOT_MARKET_INDEX,
    );
    if (spot0Pos) {
      const unsigned = getTokenAmount(
        spot0Pos.scaledBalance,
        quoteSpot,
        spot0Pos.balanceType,
      );
      const crossSigned = getSignedTokenAmount(unsigned, spot0Pos.balanceType);
      if (!crossSigned.eq(BN0)) {
        out.usdcCrossSignedToken = bnToStr(crossSigned);
      }
    }

    // Isolated USDC collateral on perp positions whose quoteSpotMarketIndex == 0.
    let isolatedSum = BN0;
    for (const perp of user.perpPositions) {
      if (!perp.isolatedPositionScaledBalance?.gt(BN0)) continue;
      const perpMarket = driftClient.getPerpMarketAccount(perp.marketIndex);
      if (
        !perpMarket ||
        perpMarket.quoteSpotMarketIndex !== QUOTE_SPOT_MARKET_INDEX
      ) {
        continue;
      }
      isolatedSum = isolatedSum.add(
        getTokenAmount(
          perp.isolatedPositionScaledBalance,
          quoteSpot,
          SpotBalanceType.DEPOSIT,
        ),
      );
    }
    if (!isolatedSum.eq(BN0)) {
      out.usdcIsolatedToken = bnToStr(isolatedSum);
    }
  }

  // Perp positions: persist all SDK-required fields verbatim. Skip fully-empty
  // positions to keep the snapshot small.
  for (const perp of user.perpPositions) {
    const baseAssetAmount: BN = perp.baseAssetAmount ?? BN0;
    const quoteAssetAmount: BN = perp.quoteAssetAmount ?? BN0;
    const lpShares: BN = perp.lpShares ?? BN0;
    const isolated: BN = perp.isolatedPositionScaledBalance ?? BN0;
    const isAllZero =
      baseAssetAmount.eq(BN0) &&
      quoteAssetAmount.eq(BN0) &&
      lpShares.eq(BN0) &&
      isolated.eq(BN0) &&
      (perp.openOrders ?? 0) === 0;
    if (isAllZero) continue;
    out.perpPositions.push(extractPerpPosition(perp));
  }

  return out;
}

/**
 * Merge `b` into `a`. Used when multiple sub-accounts share the same authority
 * (current behavior of authority-notional.ts: pre-aggregate per authority).
 */
export function mergeAggregate(
  a: BorrowLendAggregateSnapshot,
  b: BorrowLendAggregateSnapshot,
): BorrowLendAggregateSnapshot {
  const merged: BorrowLendAggregateSnapshot = {
    spotSignedTokenByMarket: { ...a.spotSignedTokenByMarket },
    usdcCrossSignedToken: bnToStr(
      new BN(a.usdcCrossSignedToken, 10).add(
        new BN(b.usdcCrossSignedToken, 10),
      ),
    ),
    usdcIsolatedToken: bnToStr(
      new BN(a.usdcIsolatedToken, 10).add(new BN(b.usdcIsolatedToken, 10)),
    ),
    perpPositions: [...a.perpPositions, ...b.perpPositions],
  };
  for (const [idxStr, vStr] of Object.entries(b.spotSignedTokenByMarket)) {
    const idx = Number(idxStr);
    const prev = merged.spotSignedTokenByMarket[idx];
    const next = prev
      ? new BN(prev, 10).add(new BN(vStr, 10))
      : new BN(vStr, 10);
    merged.spotSignedTokenByMarket[idx] = bnToStr(next);
  }
  return merged;
}
