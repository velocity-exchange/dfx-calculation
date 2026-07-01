import { describe, expect, it } from "bun:test";

import { DRIFT_PROGRAM_ID } from "@drift-labs/sdk";
import { PublicKey } from "@solana/web3.js";

import {
  coverageAuthorities,
  deriveSubaccountPubkeys,
  dedupePubkeys,
} from "./subaccount-coverage.ts";

const DRIFT = new PublicKey(DRIFT_PROGRAM_ID);

describe("coverageAuthorities", () => {
  it("dedupes authorities, drops excluded/empty, and sorts", () => {
    const map = new Map<string, string>([
      ["userA", "authZ"],
      ["userB", "authA"],
      ["userC", "authZ"], // same authority as userA
      ["userD", "blacklisted"],
      ["userE", ""], // no authority
    ]);
    const excluded = new Set(["blacklisted"]);
    expect(coverageAuthorities(map, excluded)).toEqual(["authA", "authZ"]);
  });
});

describe("deriveSubaccountPubkeys", () => {
  const authority = new PublicKey(
    "CksYhws4jNNzs8jszgjhuNvAqRNk33MU8hRE6vNfTkrD",
  );

  it("derives one PDA per subAccountId in [0, count)", () => {
    expect(deriveSubaccountPubkeys(DRIFT, authority, 0)).toHaveLength(0);
    expect(deriveSubaccountPubkeys(DRIFT, authority, 5)).toHaveLength(5);
  });

  // Regression: the orphan quote-only subaccount that was missing from
  // users.json is subAccountId 1. Enumerating [0, count) must reproduce it, so
  // the snapshot would now fetch and attribute its +$248 of unsettled ETH-PERP
  // PnL instead of dropping the whole subaccount.
  it("reproduces the orphan subaccount PDA at id 1", () => {
    const pdas = deriveSubaccountPubkeys(DRIFT, authority, 3).map((p) =>
      p.toBase58(),
    );
    expect(pdas).toEqual([
      "2JEC5adUthcP6x2rPDc7q3BKRNMHuUsgGGQVLFX29hsi", // id 0 (in users.json)
      "AAoLWsf12mUP7ZUSGxom5heKiJeB1TkWjdzJCiSAoYwi", // id 1 (ORPHAN — was missing)
      "aeohMrn3HFU9FknMK1F3djAAhVrauzek61sT5csqyNm", // id 2 (in users.json)
    ]);
  });
});

describe("dedupePubkeys", () => {
  it("removes duplicates by base58, preserving first-seen order", () => {
    const a = new PublicKey("2JEC5adUthcP6x2rPDc7q3BKRNMHuUsgGGQVLFX29hsi");
    const b = new PublicKey("AAoLWsf12mUP7ZUSGxom5heKiJeB1TkWjdzJCiSAoYwi");
    const out = dedupePubkeys([a, b, new PublicKey(a.toBase58()), b]);
    expect(out.map((p) => p.toBase58())).toEqual([a.toBase58(), b.toBase58()]);
  });
});
