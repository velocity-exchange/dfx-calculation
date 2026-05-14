import { BN } from "@drift-labs/sdk";
import { IDL, VAULT_PROGRAM_ID, decodeName } from "@drift-labs/vaults-sdk";
import { BorshAccountsCoder, utils } from "@coral-xyz/anchor";
import type { Connection, PublicKey } from "@solana/web3.js";

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

function getAccountDiscriminatorBase58(accountName: string): string {
  const disc = BorshAccountsCoder.accountDiscriminator(accountName);
  return utils.bytes.bs58.encode(disc);
}

function toPubkey(v: PublicKey | string): string {
  return typeof v === "string" ? v : v.toBase58();
}

function toBN(v: unknown): BN {
  // Anchor decoders return BN (bn.js). Drift SDK BN is compatible, but we normalize.
  if (v instanceof BN) return v;
  return new BN((v as any)?.toString?.() ?? v);
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
  const accounts = (IDL as any)?.accounts as Array<{ name: string }> | undefined;
  const match = accounts?.find((a) => String(a?.name ?? "").toLowerCase() === targetLower);
  if (!match?.name) {
    throw new Error(`Vaults IDL missing account name for "${targetLower}"`);
  }
  return match.name;
}

/**
 * Discover all Drift Vaults on mainnet by scanning the Vaults program accounts and decoding `Vault`.
 * Uses a single `getProgramAccounts` call with a discriminator memcmp filter.
 */
export async function discoverVaults(connection: Connection): Promise<DiscoveredVault[]> {
  const coder = new BorshAccountsCoder(IDL as any);
  // Anchor discriminator depends on the exact IDL account name casing (often "vault", not "Vault").
  const vaultAccountName = idlAccountNameOrThrow("vault");
  const vaultDisc = getAccountDiscriminatorBase58(vaultAccountName);

  const accounts = await connection.getProgramAccounts(VAULT_PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: vaultDisc,
        },
      },
    ],
  });

  const out: DiscoveredVault[] = [];
  for (const { pubkey, account } of accounts) {
    let decoded: any;
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

