import { BN } from "@drift-labs/sdk";

// SDK contract type variants (status, contractType, contractTier, ammDirection, marginCalculationMode etc.)
// are encoded as `{ [variantName]: {} }`. We persist them verbatim as JSON-friendly objects.
export type SdkVariant = Record<string, unknown>;

export type PerpPositionSnapshot = {
  marketIndex: number;
  baseAssetAmount: string;
  quoteAssetAmount: string;
  quoteEntryAmount: string;
  quoteBreakEvenAmount: string;
  lastCumulativeFundingRate: string;
  settledPnl: string;
  lpShares: string;
  lastBaseAssetAmountPerLp: string;
  lastQuoteAssetAmountPerLp: string;
  remainderBaseAssetAmount: number;
  openOrders: number;
  openBids: string;
  openAsks: string;
  positionFlag: number;
  isolatedPositionScaledBalance: string;
  perLpBase: number;
};

export type PerpMarketAmmSnapshot = {
  cumulativeFundingRateLong: string;
  cumulativeFundingRateShort: string;
};

export type PerpMarketSnapshot = {
  marketIndex: number;
  status: SdkVariant;
  contractType: SdkVariant;
  expiryPrice: string;
  quoteSpotMarketIndex: number;
  amm: PerpMarketAmmSnapshot;
};

export type SpotMarketSnapshot = {
  marketIndex: number;
  decimals: number;
};

export type BorrowLendAggregateSnapshot = {
  // Per-market signed token amount, decimal BN string. Excludes USDC (market 0).
  spotSignedTokenByMarket: Record<number, string>;
  // Signed USDC (market 0) cross-margin token amount.
  usdcCrossSignedToken: string;
  // Sum of unsigned USDC tokens held as isolated collateral on perp positions
  // whose quoteSpotMarketIndex == 0. Always >= 0.
  usdcIsolatedToken: string;
  perpPositions: PerpPositionSnapshot[];
};

export type ShareRowSnapshot = {
  depositorAuthority: string;
  depositorAccount: string;
  isManager: boolean;
  shareSource: "vault_depositor" | "vault_manager_derived";
  sharesRaw: string;
  totalSharesRaw: string;
  shareFractionScaled: string;
};

export type VaultSnapshot = {
  vault_pubkey: string;
  manager: string;
  user: string;
  totalShares: string;
  userShares: string;
  spotMarketIndex: number;
  shareRows: ShareRowSnapshot[];
  // null when the vault's drift user account couldn't be fetched/decoded.
  vaultUserPositions: BorrowLendAggregateSnapshot | null;
};

export type Snapshot = {
  snapshotTimestampUtc: string;
  rpcUrl: string;
  usersJsonPath: string;
  spotMarkets: Record<number, SpotMarketSnapshot>;
  perpMarkets: Record<number, PerpMarketSnapshot>;
  borrowLendByAuthority: Record<string, BorrowLendAggregateSnapshot>;
  vaults: VaultSnapshot[];
  vaultAuthorities: string[];
  blacklistedAuthorities: string[];
  /** Set when this file was produced by backtrack_snapshot_perps.ts */
  perpBacktrackCutoffTs?: number;
  /** Absolute or repo-relative path to the input snapshot JSON */
  perpBacktrackSourceSnapshot?: string;
  /** Serialized trade month window, e.g. "2026-04" or "2026-03,2026-04" */
  perpBacktrackTradeMonthsLabel?: string;
  /** True when output was written mid-run (error or signal) before all authorities finished */
  perpBacktrackIncomplete?: boolean;
  /** Why the checkpoint was written (e.g. SIGINT, uncaught error message) */
  perpBacktrackCheckpointNote?: string;
  /** Progress when incomplete: authorities scanned in the work list */
  perpBacktrackProgressScanned?: number;
  /** Progress when incomplete: total authorities in the work list */
  perpBacktrackProgressTotal?: number;
};

export function bnToStr(b: BN): string {
  return b.toString(10);
}

export function strToBn(s: string): BN {
  return new BN(s, 10);
}

export function stableJsonStringify(value: unknown, indent?: number): string {
  const sortKeys = (v: any): any => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object" && !(v instanceof Array)) {
      const out: any = {};
      for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value), null, indent);
}
