import { describe, expect, it, spyOn } from "bun:test";

import { BN, unstakeSharesToAmount } from "@drift-labs/sdk";

import {
  PROTOCOL_OWNED_STAKE_PUBKEY,
  type IfMarketState,
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
