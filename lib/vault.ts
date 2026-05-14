import { BN } from "@drift-labs/sdk";
import {
  IDL,
  VAULT_PROGRAM_ID,
  decodeName,
  type Vault,
  type VaultDepositor,
} from "@drift-labs/vaults-sdk";
import { BorshAccountsCoder, utils } from "@coral-xyz/anchor";
import { PublicKey, type Connection } from "@solana/web3.js";
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
};

export type DiscoveredVault = {
  vault_pubkey: string;
  name: string | null;
  manager: string;
  user: string; // Drift user account pubkey
  totalShares: BN;
  userShares: BN;
  spotMarketIndex: number;
  permissioned: boolean;
};

function toBN(v: unknown): BN {
  if (v instanceof BN) return v;
  return new BN((v as any)?.toString?.() ?? v);
}

function toPubkey(v: PublicKey | string): string {
  return typeof v === "string" ? v : v.toBase58();
}

function decodeVaultName(nameField: unknown): string | null {
  try {
    if (!Array.isArray(nameField)) return null;
    if (nameField.length === 0) return null;
    return decodeName(nameField as number[]);
  } catch {
    return null;
  }
}

function idlAccountNameOrThrow(targetLower: string): string {
  const accounts = (IDL as any)?.accounts as
    | Array<{ name: string }>
    | undefined;
  const match = accounts?.find(
    (a) => String(a?.name ?? "").toLowerCase() === targetLower,
  );
  if (!match?.name) {
    throw new Error(`Vaults IDL missing account name for "${targetLower}"`);
  }
  return match.name;
}

function getAccountDiscriminatorBase58(accountName: string): string {
  return utils.bytes.bs58.encode(
    BorshAccountsCoder.accountDiscriminator(accountName),
  );
}

/**
 * Discover all Drift Vaults on mainnet by scanning the Vaults program accounts and decoding `Vault`.
 * Uses a single `getProgramAccounts` call with a discriminator memcmp filter.
 */
export async function discoverVaults(
  connection: Connection,
): Promise<DiscoveredVault[]> {
  const coder = new BorshAccountsCoder(IDL as any);
  // Anchor discriminator depends on the exact IDL account name casing (often "vault", not "Vault").
  const vaultAccountName = idlAccountNameOrThrow("vault");
  const vaultDisc = getAccountDiscriminatorBase58(vaultAccountName);

  const accounts = await connection.getProgramAccounts(VAULT_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: vaultDisc } }],
  });

  const out: DiscoveredVault[] = [];
  for (const { pubkey, account } of accounts) {
    let decoded: Vault;
    try {
      decoded = coder.decode(vaultAccountName, account.data);
    } catch {
      continue;
    }

    out.push({
      vault_pubkey: pubkey.toBase58(),
      name: decodeVaultName(decoded.name),
      manager: toPubkey(decoded.manager),
      user: toPubkey(decoded.user),
      totalShares: toBN(decoded.totalShares),
      userShares: toBN(decoded.userShares),
      spotMarketIndex: Number(decoded.spotMarketIndex),
      permissioned: Boolean(decoded.permissioned),
    });
  }

  return out;
}

/**
 * List all `VaultDepositor` accounts for a given vault using a single program account scan.
 *
 * Filters:
 * - memcmp discriminator at offset 0 (first 8 bytes)
 * - memcmp vault pubkey at offset 8 (immediately after discriminator)
 */
export async function listDepositors(
  connection: Connection,
  vaultPubkey: PublicKey | string,
): Promise<VaultDepositorLite[]> {
  const vaultPk =
    typeof vaultPubkey === "string" ? new PublicKey(vaultPubkey) : vaultPubkey;
  const coder = new BorshAccountsCoder(IDL);

  // Anchor discriminator depends on the exact IDL account name casing (often "vaultDepositor").
  const vdAccountName = idlAccountNameOrThrow("vaultdepositor");
  const vdDisc = getAccountDiscriminatorBase58(vdAccountName);

  const accounts = await connection.getProgramAccounts(VAULT_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: vdDisc } },
      { memcmp: { offset: 8, bytes: vaultPk.toBase58() } },
    ],
  });

  const out: VaultDepositorLite[] = [];
  for (const { pubkey, account } of accounts) {
    let decoded: VaultDepositor;
    try {
      decoded = coder.decode(vdAccountName, account.data);
    } catch {
      continue;
    }
    out.push({
      pubkey: pubkey.toBase58(),
      authority: decoded.authority.toBase58(),
      vaultShares: toBN(decoded.vaultShares),
    });
  }

  return out;
}

export function computeShareRows(params: {
  vaultTotalShares: BN;
  vaultUserShares: BN;
  vaultManagerAuthority: string;
  vaultDepositors: VaultDepositorLite[];
}): ShareRow[] {
  const {
    vaultTotalShares,
    vaultUserShares,
    vaultManagerAuthority,
    vaultDepositors,
  } = params;

  // vault.userShares is aggregate non-manager shares, so the manager's share
  // count must be derived as totalShares - userShares.
  const managerShares = vaultTotalShares.sub(vaultUserShares);

  return [
    ...vaultDepositors.map(
      (vd): ShareRow => ({
        depositorAuthority: vd.authority,
        depositorAccount: vd.pubkey,
        isManager: false,
        shareSource: "vault_depositor",
        sharesRaw: vd.vaultShares,
        totalSharesRaw: vaultTotalShares,
      }),
    ),
    {
      depositorAuthority: vaultManagerAuthority,
      depositorAccount: "",
      isManager: true,
      shareSource: "vault_manager_derived",
      sharesRaw: managerShares,
      totalSharesRaw: vaultTotalShares,
    },
  ];
}
