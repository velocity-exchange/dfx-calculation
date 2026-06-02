import { BN } from "@drift-labs/sdk";
import {
  strToBn,
  type SpotMarketSnapshot,
  type VaultSnapshot,
} from "./snapshot-types.ts";

const BN0 = new BN(0);
const SCALE_1E18 = new BN("1000000000000000000");
const PERCENTAGE_PRECISION = new BN(1_000_000);
const SECONDS_PER_YEAR = new BN(365 * 24 * 60 * 60);

/**
 * Crystallize vault management fee and profit share, redistributing equity
 * from depositors to the manager. Mirrors the on-chain effect of running
 * `apply_management_fee` followed by `apply_profit_share` per depositor.
 *
 * Inputs and outputs are in QUOTE_PRECISION (1e6 = $1).
 *
 * The mgmt fee is computed as a simple linear accrual since `lastFeeUpdateTs`
 * (vault_equity × rate × dt / year). Profit share uses the on-chain
 * high-water-mark logic: profit = depositor_value − net_deposits −
 * cumulative_profit_share_amount, taxed at `profitShare` per depositor. The
 * manager pays no profit share on their own row.
 *
 * Hurdle rate is intentionally ignored (most vaults configure hurdleRate=0
 * and the sizing showed it's not material).
 */
export function crystallizeVaultFees(args: {
  equityQuote: BN;
  vaultSnap: VaultSnapshot;
  snapshotTsSec: number;
  spotPriceByMarket: Map<number, BN>;
  spotMarkets: Record<number, SpotMarketSnapshot>;
  contextLabel?: string;
}): Map<string, BN> {
  const {
    equityQuote,
    vaultSnap,
    snapshotTsSec,
    spotPriceByMarket,
    spotMarkets,
    contextLabel,
  } = args;

  const out = new Map<string, BN>();
  if (equityQuote.lte(BN0)) return out;

  // ── 1. Management fee accrual (linear since lastFeeUpdateTs) ────────────
  const mgmtFeeRaw = strToBn(vaultSnap.managementFee); // i64, can be negative
  const dt = Math.max(0, snapshotTsSec - vaultSnap.lastFeeUpdateTs);
  // mgmtFeeQuote = equityQuote * mgmtFeeRaw * dt / (PERCENTAGE_PRECISION * SECONDS_PER_YEAR)
  let mgmtFeeQuote = equityQuote
    .mul(mgmtFeeRaw)
    .muln(dt)
    .div(PERCENTAGE_PRECISION)
    .div(SECONDS_PER_YEAR);
  // Sanity clamp: |mgmtFee| <= equity (avoids pathological values from misconfigured fees)
  if (mgmtFeeQuote.abs().gt(equityQuote)) {
    mgmtFeeQuote = mgmtFeeQuote.isNeg() ? equityQuote.neg() : equityQuote;
  }
  const equityAfterMgmt = equityQuote.sub(mgmtFeeQuote);
  if (equityAfterMgmt.lte(BN0)) {
    // Pathological case (e.g. mgmt fee swallowed the vault). All equity goes
    // to manager; nothing for depositors.
    const managerAuth = vaultSnap.manager;
    out.set(managerAuth, (out.get(managerAuth) ?? BN0).add(equityQuote));
    return out;
  }

  // ── 2. Per-row equity post-mgmt-fee + profit share ─────────────────────
  const profitShareRate = new BN(vaultSnap.profitShare);
  const spotPrice = spotPriceByMarket.get(vaultSnap.spotMarketIndex);
  const spotDec = spotMarkets[vaultSnap.spotMarketIndex]?.decimals;
  // If deposit-token pricing is unavailable we can't compute profit share in
  // USD; fall back to mgmt-fee-only redistribution rather than silently
  // mis-pricing. Active vaults always carry a usable spot oracle row.
  const canPriceTokens = spotPrice !== undefined && spotDec !== undefined;
  if (profitShareRate.gtn(0) && !canPriceTokens) {
    console.warn(
      `[vault-fees] missing spot price/decimals for market ${vaultSnap.spotMarketIndex}` +
        (contextLabel ? ` (${contextLabel})` : "") +
        ` — profit share will not be applied to vault ${vaultSnap.vault_pubkey}`,
    );
  }
  const tenPowDec = canPriceTokens
    ? new BN(10).pow(new BN(spotDec))
    : BN0;
  const tokenRawToQuote = (raw: BN): BN => {
    if (!canPriceTokens) return BN0;
    return raw.mul(spotPrice!).div(tenPowDec);
  };

  // Mgmt-fee dilution model: every row (incl. manager) is repriced against
  // equityAfterMgmt, then the manager gets the full mgmtFeeQuote on top. Net
  // effect: depositor i loses shareFraction_i * mgmtFeeQuote, manager nets
  // (1 - managerShareFraction) * mgmtFeeQuote — matching on-chain dilution.
  let managerExtra = mgmtFeeQuote;

  for (const r of vaultSnap.shareRows) {
    const auth = r.depositorAuthority;
    const shareFractionScaled = strToBn(r.shareFractionScaled);
    const rowEquity = shareFractionScaled.mul(equityAfterMgmt).div(SCALE_1E18);

    if (r.isManager) {
      // Manager's natural pro-rata of post-mgmt equity (no profit share on self).
      out.set(auth, (out.get(auth) ?? BN0).add(rowEquity));
      continue;
    }

    // Depositor: take pro-rata, then haircut for profit share.
    let depositorValue = rowEquity;

    if (profitShareRate.gtn(0) && canPriceTokens) {
      const netDepositsQuote = tokenRawToQuote(strToBn(r.netDeposits));
      const hwmQuote = tokenRawToQuote(strToBn(r.cumulativeProfitShareAmount));
      const profitQuote = depositorValue.sub(netDepositsQuote).sub(hwmQuote);
      if (profitQuote.gtn(0)) {
        const feeQuote = profitQuote
          .mul(profitShareRate)
          .div(PERCENTAGE_PRECISION);
        depositorValue = depositorValue.sub(feeQuote);
        managerExtra = managerExtra.add(feeQuote);
      }
    }

    out.set(auth, (out.get(auth) ?? BN0).add(depositorValue));
  }

  // Manager receives all crystallized fees on top of their natural pro-rata.
  if (!managerExtra.eq(BN0)) {
    const managerAuth = vaultSnap.manager;
    out.set(managerAuth, (out.get(managerAuth) ?? BN0).add(managerExtra));
  }

  return out;
}
