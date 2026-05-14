import { BN } from "@drift-labs/sdk";

export type ShareRowScaled = {
  depositorAuthority: string;
  depositorAccount: string;
  isManager: boolean;
  shareSource: "vault_depositor" | "vault_manager_derived";
  sharesRaw: BN;
  totalSharesRaw: BN;
  shareFractionScaled: BN; // 1e18-scaled
};

