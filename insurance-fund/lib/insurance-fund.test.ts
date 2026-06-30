import { describe, expect, it, spyOn } from "bun:test";

import { BN, unstakeSharesToAmount } from "@drift-labs/sdk";

import {
  PROTOCOL_OWNED_STAKE_PUBKEY,
  type IfMarketState,
  type SurplusItem,
  redistributeSurplus,
  valueProtocolStake,
} from "./insurance-fund.ts";

function marketState(overrides: Partial<IfMarketState> = {}): IfMarketState {
  return {
    marketIndex: 0,
    symbol: "USDC",
    decimals: 6,
    vault: "VaultPubkey11111111111111111111111111111111",
    vaultBalance: new BN("1000000000"), // 1000 USDC
    onchainVaultBalance: new BN("1000000000"),
    vaultBalanceSource: "onchain",
    totalIfShares: new BN("1000"),
    userIfShares: new BN("600"),
    sharesBase: new BN("2"),
    ...overrides,
  };
}

describe("valueProtocolStake", () => {
  it("values the protocol slice (total - user shares) against the vault", () => {
    const state = marketState();
    const deposit = valueProtocolStake(state);

    expect(deposit).not.toBeNull();
    const protocolShares = new BN("400"); // 1000 - 600
    expect(deposit!.marketIndex).toBe(0);
    expect(deposit!.stakePubkey).toBe(PROTOCOL_OWNED_STAKE_PUBKEY);
    expect(deposit!.ifSharesRaw.toString()).toBe("400");
    expect(deposit!.effectiveShares.toString()).toBe("400");
    expect(deposit!.ifBase.toString()).toBe("2"); // sharesBase
    expect(deposit!.costBasis.toString()).toBe("0");
    expect(deposit!.lastWithdrawRequestShares.toString()).toBe("0");
    expect(deposit!.lastWithdrawRequestValue.toString()).toBe("0");
    expect(deposit!.lastWithdrawRequestTs.toString()).toBe("0");
    expect(deposit!.tokenAmount.toString()).toBe(
      unstakeSharesToAmount(
        protocolShares,
        state.totalIfShares,
        state.vaultBalance,
      ).toString(),
    );
  });

  it("returns null when there is no protocol slice (total == user)", () => {
    const state = marketState({
      totalIfShares: new BN("600"),
      userIfShares: new BN("600"),
    });
    expect(valueProtocolStake(state)).toBeNull();
  });

  it("returns null (defensively) when user shares exceed total", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const state = marketState({
      totalIfShares: new BN("600"),
      userIfShares: new BN("700"),
    });
    expect(valueProtocolStake(state)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("values against the overridden vault balance", () => {
    const small = valueProtocolStake(marketState())!;
    const big = valueProtocolStake(
      marketState({
        vaultBalance: new BN("2000000000"), // 2x balance
        vaultBalanceSource: "config",
      }),
    )!;
    // Same shares, double the backing → double the token amount.
    expect(big.tokenAmount.toString()).toBe(
      small.tokenAmount.muln(2).toString(),
    );
  });
});

describe("redistributeSurplus", () => {
  const item = (tokenAmount: string, nonRequestedShares: string): SurplusItem => ({
    tokenAmount: new BN(tokenAmount),
    nonRequestedShares: new BN(nonRequestedShares),
  });

  /** The core invariant: redistributed claims reconcile to the full vault. */
  const sumReconciles = (vault: BN, items: SurplusItem[]) => {
    const { surplusShares } = redistributeSurplus(vault, items);
    return items
      .reduce(
        (acc, it, i) => acc.add(it.tokenAmount).add(surplusShares[i]),
        new BN(0),
      )
      .toString();
  };

  it("splits surplus pro-rata by non-requested shares", () => {
    // vault 1000, claims 700 → surplus 300, nonReq 600/400 → 180/120.
    const items = [item("400", "600"), item("300", "400")];
    const { surplus, nonRequestedTotal, surplusShares } = redistributeSurplus(
      new BN("1000"),
      items,
    );
    expect(surplus.toString()).toBe("300");
    expect(nonRequestedTotal.toString()).toBe("1000");
    expect(surplusShares.map((s) => s.toString())).toEqual(["180", "120"]);
  });

  it("reconciles Σ(tokenAmount + surplusShare) to the vault balance", () => {
    expect(sumReconciles(new BN("1000"), [item("400", "600"), item("300", "400")])).toBe(
      "1000",
    );
  });

  it("assigns floor-division dust to the largest non-requested holder", () => {
    // surplus 1000 over equal thirds: 333 each (999), dust 1 → first holder.
    const { surplusShares } = redistributeSurplus(new BN("1000"), [
      item("0", "1"),
      item("0", "1"),
      item("0", "1"),
    ]);
    expect(surplusShares.map((s) => s.toString())).toEqual(["334", "333", "333"]);
  });

  it("is a no-op when there is no surplus (no open requests)", () => {
    const items = [item("600", "600"), item("400", "400")];
    const { surplus, surplusShares } = redistributeSurplus(new BN("1000"), items);
    expect(surplus.toString()).toBe("0");
    expect(surplusShares.map((s) => s.toString())).toEqual(["0", "0"]);
  });

  it("leaves surplus unassigned when every share is under request", () => {
    // nonRequestedTotal == 0: surplus exists but cannot be reattributed.
    const items = [item("400", "0"), item("300", "0")];
    const { surplus, nonRequestedTotal, surplusShares } = redistributeSurplus(
      new BN("1000"),
      items,
    );
    expect(surplus.toString()).toBe("300");
    expect(nonRequestedTotal.toString()).toBe("0");
    expect(surplusShares.map((s) => s.toString())).toEqual(["0", "0"]);
  });

  it("clamps a (rounding-induced) negative surplus to zero", () => {
    const { surplus, surplusShares } = redistributeSurplus(new BN("900"), [
      item("600", "600"),
      item("400", "400"),
    ]);
    expect(surplus.toString()).toBe("0");
    expect(surplusShares.map((s) => s.toString())).toEqual(["0", "0"]);
  });

  it("reconciles for a partial-requester mix (large realistic-ish case)", () => {
    // Some fully staked, some partial (nonReq < tokenAmount-implied), protocol slice.
    const items = [
      item("5000000", "5000"), // non-requester
      item("3000000", "1000"), // partial requester: most shares requested
      item("1234567", "1500"), // non-requester
      item("9999999", "8000"), // protocol slice
    ];
    expect(sumReconciles(new BN("20000000"), items)).toBe("20000000");
  });
});
