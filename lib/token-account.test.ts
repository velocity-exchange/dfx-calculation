import { describe, expect, it } from "bun:test";

import { BN } from "@drift-labs/sdk";
import { type AccountInfo, PublicKey } from "@solana/web3.js";

import { parseTokenAccountAmount } from "./token-account.ts";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

const ADDRESS = new PublicKey("11111111111111111111111111111111");
const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC
const OTHER_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
); // wSOL

/**
 * Build a minimal but layout-correct SPL token account buffer:
 *   mint(32) @0, owner(32) @32, amount(u64 LE) @64, state(u8) @108.
 */
function buildTokenAccount(opts: {
  mint?: PublicKey;
  amount?: bigint;
  state?: number;
  length?: number;
}): Buffer {
  const len = opts.length ?? 165;
  const buf = Buffer.alloc(len);
  (opts.mint ?? MINT).toBuffer().copy(buf, 0);
  buf.writeBigUInt64LE(opts.amount ?? 0n, 64);
  buf[108] = opts.state ?? 1; // Initialized
  return buf;
}

function accountInfo(
  data: Buffer,
  owner: PublicKey = TOKEN_PROGRAM_ID,
): AccountInfo<Buffer> {
  return { data, owner, executable: false, lamports: 1, rentEpoch: 0 };
}

describe("parseTokenAccountAmount", () => {
  it("decodes the u64 amount for a valid token account", () => {
    const info = accountInfo(buildTokenAccount({ amount: 123_456n }));
    const amount = parseTokenAccountAmount(info, { address: ADDRESS, mint: MINT });
    expect(amount.eq(new BN(123_456))).toBe(true);
  });

  it("preserves precision above Number.MAX_SAFE_INTEGER", () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const info = accountInfo(buildTokenAccount({ amount: big }));
    const amount = parseTokenAccountAmount(info, { address: ADDRESS, mint: MINT });
    expect(amount.toString()).toBe(big.toString());
  });

  it("accepts a Token-2022 owned account", () => {
    const info = accountInfo(
      buildTokenAccount({ amount: 42n }),
      TOKEN_2022_PROGRAM_ID,
    );
    const amount = parseTokenAccountAmount(info, { address: ADDRESS, mint: MINT });
    expect(amount.eq(new BN(42))).toBe(true);
  });

  it("throws when the account is missing", () => {
    expect(() =>
      parseTokenAccountAmount(null, { address: ADDRESS, mint: MINT }),
    ).toThrow(/missing account data/);
  });

  it("throws when the owner is not a token program", () => {
    const info = accountInfo(buildTokenAccount({}), ADDRESS);
    expect(() =>
      parseTokenAccountAmount(info, { address: ADDRESS, mint: MINT }),
    ).toThrow(/not the SPL Token program/);
  });

  it("throws when the data is too short to be a token account", () => {
    const info = accountInfo(buildTokenAccount({ length: 72 }));
    expect(() =>
      parseTokenAccountAmount(info, { address: ADDRESS, mint: MINT }),
    ).toThrow(/data too short/);
  });

  it("throws when the account is uninitialized", () => {
    const info = accountInfo(buildTokenAccount({ state: 0 }));
    expect(() =>
      parseTokenAccountAmount(info, { address: ADDRESS, mint: MINT }),
    ).toThrow(/uninitialized/);
  });

  it("throws when the mint does not match the expected mint", () => {
    const info = accountInfo(buildTokenAccount({ mint: OTHER_MINT }));
    expect(() =>
      parseTokenAccountAmount(info, { address: ADDRESS, mint: MINT }),
    ).toThrow(/expected/);
  });

  it("accepts a frozen account (state 2) — it still holds a balance", () => {
    const info = accountInfo(buildTokenAccount({ amount: 7n, state: 2 }));
    const amount = parseTokenAccountAmount(info, { address: ADDRESS, mint: MINT });
    expect(amount.eq(new BN(7))).toBe(true);
  });
});
