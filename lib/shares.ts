import { BN } from "@drift-labs/sdk";

export type ShareSource = "vault_depositor" | "vault_manager_derived";

export type VaultDepositorLite = {
  authority: string;
  pubkey: string;
  vaultShares: BN;
};

export type ShareRow = {
  depositorAuthority: string;
  depositorAccount: string; // empty for derived manager row
  isManager: boolean;
  shareSource: ShareSource;
  sharesRaw: BN;
  totalSharesRaw: BN;
  shareFraction: string; // decimal string in [0,1]
};

export type ShareSanity = {
  totalShares: BN;
  userShares: BN;
  managerShares: BN;
  sumDepositorShares: BN;
};

export type ShareRows = ShareRow[] & { sanity: ShareSanity };

function fractionString(numer: BN, denom: BN): string {
  if (denom.isZero()) return "0";

  // High precision ratio as a decimal string using integer division scaling (1e18).
  const SCALE = new BN("1000000000000000000");
  const scaled = numer.mul(SCALE).div(denom);
  const s = scaled.toString(10).padStart(19, "0");
  const whole = s.slice(0, -18);
  const frac = s.slice(-18).replace(/0+$/, "") || "0";
  return `${whole}.${frac}`;
}

export function computeShareRows(params: {
  vaultTotalShares: BN;
  vaultUserShares: BN;
  vaultManagerAuthority: string;
  vaultDepositors: VaultDepositorLite[];
}): ShareRows {
  const { vaultTotalShares, vaultUserShares, vaultManagerAuthority, vaultDepositors } = params;

  const sumDepositorShares = vaultDepositors.reduce((acc, vd) => acc.add(vd.vaultShares), new BN(0));

  // IMPORTANT: userShares is aggregate non-manager shares.
  // managerShares MUST be derived as totalShares - userShares.
  const managerShares = vaultTotalShares.sub(vaultUserShares);

  // When totalShares == 0 the vault still may hold residual notional value
  // (e.g. the last depositor withdrew but lending interest accrued positively
  // afterward). That residual is attributed to the manager: depositor rows
  // get fraction 0, the manager row gets fraction 1.
  const managerFraction = vaultTotalShares.isZero()
    ? "1"
    : fractionString(managerShares, vaultTotalShares);

  const rows: ShareRow[] = [
    ...vaultDepositors.map((vd): ShareRow => ({
      depositorAuthority: vd.authority,
      depositorAccount: vd.pubkey,
      isManager: false,
      shareSource: "vault_depositor",
      sharesRaw: vd.vaultShares,
      totalSharesRaw: vaultTotalShares,
      shareFraction: fractionString(vd.vaultShares, vaultTotalShares),
    })),
    {
      depositorAuthority: vaultManagerAuthority,
      depositorAccount: "",
      isManager: true,
      shareSource: "vault_manager_derived",
      sharesRaw: managerShares,
      totalSharesRaw: vaultTotalShares,
      shareFraction: managerFraction,
    },
  ];

  const out = rows as ShareRows;
  out.sanity = {
    totalShares: vaultTotalShares,
    userShares: vaultUserShares,
    managerShares,
    sumDepositorShares,
  };
  return out;
}

