import { BN } from "@drift-labs/sdk";
import { IDL, VAULT_PROGRAM_ID } from "@drift-labs/vaults-sdk";
import { BorshAccountsCoder, utils } from "@coral-xyz/anchor";
import { PublicKey, type Connection } from "@solana/web3.js";

export type VaultDepositorLite = {
  pubkey: string;
  authority: string;
  vaultShares: BN;
};

function getAccountDiscriminatorBase58(accountName: string): string {
  const disc = BorshAccountsCoder.accountDiscriminator(accountName);
  return utils.bytes.bs58.encode(disc);
}

function toBN(v: unknown): BN {
  if (v instanceof BN) return v;
  return new BN((v as any)?.toString?.() ?? v);
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
 * List all `VaultDepositor` accounts for a given vault using a single program account scan.
 *
 * Filters:
 * - memcmp discriminator at offset 0 (first 8 bytes)
 * - memcmp vault pubkey at offset 8 (immediately after discriminator)
 */
export async function listDepositors(
  connection: Connection,
  vaultPubkey: PublicKey | string
): Promise<VaultDepositorLite[]> {
  const vaultPk = typeof vaultPubkey === "string" ? new PublicKey(vaultPubkey) : vaultPubkey;
  const coder = new BorshAccountsCoder(IDL as any);

  // Anchor discriminator depends on the exact IDL account name casing (often "vaultDepositor").
  const vdAccountName = idlAccountNameOrThrow("vaultdepositor");
  const vdDisc = getAccountDiscriminatorBase58(vdAccountName);

  const accounts = await connection.getProgramAccounts(VAULT_PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: vdDisc,
        },
      },
      {
        memcmp: {
          offset: 8,
          bytes: vaultPk.toBase58(),
        },
      },
    ],
  });

  const out: VaultDepositorLite[] = [];
  for (const { pubkey, account } of accounts) {
    let decoded: any;
    try {
      decoded = coder.decode(vdAccountName, account.data);
    } catch {
      continue;
    }
    out.push({
      pubkey: pubkey.toBase58(),
      authority: (decoded.authority as PublicKey).toBase58(),
      vaultShares: toBN(decoded.vaultShares),
    });
  }

  return out;
}

