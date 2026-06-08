/**
 * Shared SPL token-account decoding with defense-in-depth validation.
 *
 * Vault balances that drive the snapshot are read straight from raw account
 * data, so a wrong / closed / substituted account must fail loudly rather than
 * yield a bogus `amount`. Before trusting the u64 at offset 64 we verify the
 * account is owned by a token program, is long enough to be a token account,
 * is initialized, and holds the mint we expect.
 */
import { BN } from "@drift-labs/sdk";
import { type AccountInfo, PublicKey } from "@solana/web3.js";

// SPL token-account layout (legacy + Token-2022 base):
//   mint   PublicKey  @ 0
//   owner  PublicKey  @ 32
//   amount u64 LE     @ 64
//   ...
//   state  u8         @ 108   (0 = Uninitialized, 1 = Initialized, 2 = Frozen)
const MINT_OFFSET = 0;
const AMOUNT_OFFSET = 64;
const STATE_OFFSET = 108;

/** Base size of an SPL token account. Token-2022 accounts are >= this (extensions follow). */
const TOKEN_ACCOUNT_BASE_LEN = 165;

// Both token programs share the same base layout, so either owner is acceptable.
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

export interface ExpectedTokenAccount {
  /** The account being read — included in errors for traceability. */
  address: PublicKey;
  /** The mint this token account must hold. */
  mint: PublicKey;
}

/**
 * Decode and validate the raw token `amount` (u64 LE) from an SPL token
 * account. Throws if `account` is missing, is not owned by a token program, is
 * too short to be a token account, is uninitialized, or holds a mint other than
 * `expected.mint`.
 *
 * Callers that legitimately tolerate a missing/closed vault (treating it as a
 * zero balance) should guard on `account` themselves before calling this.
 */
export function parseTokenAccountAmount(
  account: AccountInfo<Buffer> | null | undefined,
  expected: ExpectedTokenAccount,
): BN {
  const addr = expected.address.toBase58();

  if (!account || !account.data) {
    throw new Error(`Token account ${addr}: missing account data`);
  }

  if (
    !account.owner.equals(TOKEN_PROGRAM_ID) &&
    !account.owner.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    throw new Error(
      `Token account ${addr}: owner ${account.owner.toBase58()} is not the SPL Token program`,
    );
  }

  const buf = Buffer.from(account.data);
  if (buf.length < TOKEN_ACCOUNT_BASE_LEN) {
    throw new Error(
      `Token account ${addr}: data too short (${buf.length} bytes); not an SPL token account`,
    );
  }

  if (buf[STATE_OFFSET] === 0) {
    throw new Error(`Token account ${addr}: account is uninitialized`);
  }

  const mint = new PublicKey(buf.subarray(MINT_OFFSET, MINT_OFFSET + 32));
  if (!mint.equals(expected.mint)) {
    throw new Error(
      `Token account ${addr}: holds mint ${mint.toBase58()}, expected ${expected.mint.toBase58()}`,
    );
  }

  return new BN(buf.subarray(AMOUNT_OFFSET, AMOUNT_OFFSET + 8), "le");
}
