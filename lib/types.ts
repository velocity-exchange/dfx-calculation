import { BN } from "@drift-labs/sdk";

export type VaultComponent = {
  componentType: "spot" | "unrealized_pnl";
  marketIndex: number;
  balance: string; // human string (already signed where applicable)
  value: BN; // raw quote units
};

export type ShareRowScaled = {
  depositorAuthority: string;
  depositorAccount: string;
  isManager: boolean;
  shareSource: "vault_depositor" | "vault_manager_derived";
  sharesRaw: BN;
  totalSharesRaw: BN;
  shareFractionScaled: BN; // 1e18-scaled
};

