import { BN } from "@drift-labs/sdk";
import type { ShareRowScaled, VaultComponent } from "./types.ts";

const SCALE = new BN("1000000000000000000");

function applyFraction(value: BN, fracScaled: BN): BN {
  // floor(value * frac) in raw units
  return value.mul(fracScaled).div(SCALE);
}

export function allocateComponentShares(params: {
  components: readonly VaultComponent[];
  shares: readonly ShareRowScaled[];
}): {
  rows: Array<{
    depositorAuthority: string;
    depositorAccount: string;
    isManager: boolean;
    shareSource: ShareRowScaled["shareSource"];
    componentType: VaultComponent["componentType"];
    marketIndex: number;
    vaultValue: BN;
    depositorValue: BN;
  }>;
} {
  const rows: Array<{
    depositorAuthority: string;
    depositorAccount: string;
    isManager: boolean;
    shareSource: ShareRowScaled["shareSource"];
    componentType: VaultComponent["componentType"];
    marketIndex: number;
    vaultValue: BN;
    depositorValue: BN;
  }> = [];

  for (const c of params.components) {
    for (const s of params.shares) {
      rows.push({
        depositorAuthority: s.depositorAuthority,
        depositorAccount: s.depositorAccount,
        isManager: s.isManager,
        shareSource: s.shareSource,
        componentType: c.componentType,
        marketIndex: c.marketIndex,
        vaultValue: c.value,
        depositorValue: applyFraction(c.value, s.shareFractionScaled),
      });
    }
  }

  return { rows };
}

export function computeEquityTotals(params: {
  components: readonly VaultComponent[];
  shares: readonly ShareRowScaled[];
}): {
  vaultSpotValueTotal: BN;
  vaultUnrealizedPnlValue: BN;
  vaultEquityValueTotal: BN;
  rows: Array<{
    depositorAuthority: string;
    depositorAccount: string;
    isManager: boolean;
    shareSource: ShareRowScaled["shareSource"];
    depositorEquityValue: BN;
  }>;
} {
  const vaultSpotValueTotal = params.components
    .filter((c) => c.componentType === "spot")
    .reduce((acc, c) => acc.add(c.value), new BN(0));

  const vaultUnrealizedPnlValue = params.components
    .filter((c) => c.componentType === "unrealized_pnl")
    .reduce((acc, c) => acc.add(c.value), new BN(0));

  const vaultEquityValueTotal = vaultSpotValueTotal.add(vaultUnrealizedPnlValue);

  const rows = params.shares.map((s) => ({
    depositorAuthority: s.depositorAuthority,
    depositorAccount: s.depositorAccount,
    isManager: s.isManager,
    shareSource: s.shareSource,
    depositorEquityValue: applyFraction(vaultEquityValueTotal, s.shareFractionScaled),
  }));

  return {
    vaultSpotValueTotal,
    vaultUnrealizedPnlValue,
    vaultEquityValueTotal,
    rows,
  };
}

