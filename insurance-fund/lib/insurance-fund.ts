/**
 * Insurance-fund snapshot helpers.
 *
 * Drift runs one Insurance Fund (IF) per spot market. Each IF holds tokens in a
 * PDA token account (`spotMarket.insuranceFund.vault`) and tracks outstanding
 * shares via `insuranceFund.totalShares`. A staker's position lives in an
 * `InsuranceFundStake` account holding `ifShares` (raw) and `ifBase` (the
 * rebase exponent in effect when the shares were last touched).
 *
 * To value a stake today we must:
 *   1. rebase `ifShares` to the market's current `sharesBase`, and
 *   2. convert the rebased shares to a token amount using the live vault
 *      balance and total shares.
 */

import {
  BN,
  type DriftClient,
  type SpotMarketAccount,
  decodeName,
  unstakeSharesToAmount,
  unstakeSharesToAmountWithOpenRequest,
} from "@drift-labs/sdk";
import { type Connection, PublicKey } from "@solana/web3.js";

import { withRetry } from "../../lib/rate-limit.ts";
import { parseTokenAccountAmount } from "../../lib/token-account.ts";

const ZERO = new BN(0);
const TEN = new BN(10);

/** Sentinel `stakePubkey` for the synthetic protocol-owned IF deposit (no real stake account exists). */
export const PROTOCOL_OWNED_STAKE_PUBKEY = "protocol_owned";

type RetryOpts = { retries: number; baseDelayMs: number; maxDelayMs: number };

/** On-chain `InsuranceFundStake` shape we care about (decoded by the anchor program). */
export type DecodedIfStake = {
  authority: PublicKey;
  marketIndex: number;
  ifShares: BN;
  ifBase: BN;
  costBasis: BN;
  lastWithdrawRequestShares: BN;
  lastWithdrawRequestValue: BN;
  lastWithdrawRequestTs: BN;
};

export type IfMarketState = {
  marketIndex: number;
  /** Decoded market name / symbol (e.g. "USDC", "SOL"). */
  symbol: string;
  decimals: number;
  /** IF vault token account (PDA). */
  vault: string;
  /** Balance used to value stakes (raw units). Equals the config override when
   * one is present for this market, otherwise the on-chain balance. */
  vaultBalance: BN;
  /** Raw on-chain token balance of the IF vault, before any override. */
  onchainVaultBalance: BN;
  /** Whether `vaultBalance` came from the on-chain account or a config override. */
  vaultBalanceSource: "onchain" | "config";
  /** Operator note explaining the override (config only). */
  balanceOverrideReason?: string;
  /** Outstanding total IF shares for this market. */
  totalIfShares: BN;
  /** Shares attributable to users (i.e. excluding protocol-owned). */
  userIfShares: BN;
  /** Current rebase exponent for this market's IF shares. */
  sharesBase: BN;
};

/**
 * Per-market vault-balance override. Some IF vaults had their tokens moved out
 * administratively, so the on-chain token account reads 0 (or a stale value)
 * even though stakers are still owed against the true backing. The override
 * supplies that true balance so stakes can still be valued.
 *
 * Provide the balance one of two ways:
 *   - `vaultBalance`     raw base units, an INTEGER (e.g. "15595120840000").
 *   - `vaultBalanceUi`   a human/decimal token amount (e.g. "15595120.84"),
 *                        scaled to base units by `decimals`.
 *
 * `decimals` is the market's base-unit decimals (USDC=6, SOL=9). It is optional
 * and defaults to the on-chain market decimals; it scales `vaultBalanceUi` and
 * controls how amounts are displayed for this market. `reason` is audit-only.
 */
export type VaultBalanceOverride = {
  vaultBalance?: string;
  vaultBalanceUi?: string;
  decimals?: number;
  reason?: string;
};

export type IfConfig = {
  /** Keyed by spot-market index (as a string, e.g. "0" for USDC, "1" for SOL). */
  marketOverrides: Record<string, VaultBalanceOverride>;
};

export type IfDeposit = {
  marketIndex: number;
  stakePubkey: string;
  /** Raw `ifShares` stored on the stake account, before rebasing. */
  ifSharesRaw: BN;
  ifBase: BN;
  /** `ifShares` rebased to the market's current `sharesBase`. */
  effectiveShares: BN;
  /** Token amount the staker would receive for `effectiveShares` at the snapshot. */
  tokenAmount: BN;
  costBasis: BN;
  lastWithdrawRequestShares: BN;
  lastWithdrawRequestValue: BN;
  lastWithdrawRequestTs: BN;
};

/**
 * Rebase a stake's raw `ifShares` to the market's current `sharesBase`.
 *
 * Mirrors the on-chain `InsuranceFundStake::checked_if_shares`: when the stake
 * was last touched at a smaller `ifBase` than the market's current
 * `sharesBase`, shares are divided by `10^(sharesBase - ifBase)`.
 */
export function rebaseShares(
  ifSharesRaw: BN,
  ifBase: BN,
  marketSharesBase: BN,
): BN {
  if (ifBase.eq(marketSharesBase)) return ifSharesRaw;
  if (ifBase.gt(marketSharesBase)) {
    // Should never happen on-chain (a stake's base only ever catches up to the
    // market's). Treat defensively as already current rather than inflating.
    return ifSharesRaw;
  }
  const expoDiff = marketSharesBase.sub(ifBase);
  const rebaseDivisor = TEN.pow(expoDiff);
  return ifSharesRaw.div(rebaseDivisor);
}

/** Build an IF market state from a decoded spot market and its vault balance. */
function buildMarketState(
  market: SpotMarketAccount,
  onchainBalance: BN,
): IfMarketState {
  return {
    marketIndex: market.marketIndex,
    symbol: decodeName(market.name).trim(),
    decimals: market.decimals,
    vault: market.insuranceFund.vault.toBase58(),
    vaultBalance: onchainBalance,
    onchainVaultBalance: onchainBalance,
    vaultBalanceSource: "onchain",
    totalIfShares: market.insuranceFund.totalShares,
    userIfShares: market.insuranceFund.userShares,
    sharesBase: market.insuranceFund.sharesBase,
  };
}

/** Read the live IF state for a single spot market. */
export async function readIfMarketState(
  connection: Connection,
  market: SpotMarketAccount,
): Promise<IfMarketState> {
  const bal = await connection.getTokenAccountBalance(
    market.insuranceFund.vault,
    "confirmed",
  );
  return buildMarketState(market, new BN(bal.value.amount));
}

/**
 * Read IF state for many spot markets, batching the IF-vault token-account
 * reads through `getMultipleAccountsInfo` (chunked) instead of one RPC call
 * per market. A missing/closed vault account is treated as 0 only when the
 * market has no outstanding shares; if totalIfShares > 0, throws so stakers
 * are not silently valued against a zero balance.
 */
export async function readIfMarketStates(
  connection: Connection,
  markets: SpotMarketAccount[], 
  opts: { retry: RetryOpts; chunkSize?: number },
): Promise<IfMarketState[]> {
  const chunkSize = opts.chunkSize ?? 100;
  const vaults = markets.map((m) => m.insuranceFund.vault);

  const balanceByVault = new Map<string, BN>();
  for (let i = 0; i < vaults.length; i += chunkSize) {
    const chunk = vaults.slice(i, i + chunkSize);
    const infos = await withRetry(
      () =>
        connection.getMultipleAccountsInfo(chunk, { commitment: "confirmed" }),
      opts.retry,
    );
    for (let j = 0; j < chunk.length; j++) {
      const info = infos[j];
      const vaultKey = chunk[j].toBase58();
      if (!info?.data) {
        const market = markets[i + j];
        if (market.insuranceFund.totalShares.gt(ZERO)) {
          const symbol = decodeName(market.name).trim();
          throw new Error(
            `Market ${market.marketIndex} (${symbol}): IF vault ${vaultKey} is missing or closed on-chain ` +
              `but totalIfShares=${market.insuranceFund.totalShares.toString()} — refusing to value stakes against 0. ` +
              `Add a vault-balance override in the config if tokens were moved off-chain.`,
          );
        }
        balanceByVault.set(vaultKey, ZERO);
      } else {
        balanceByVault.set(
          vaultKey,
          parseTokenAccountAmount(info, {
            address: chunk[j],
            mint: markets[i + j].mint,
          }),
        );
      }
    }
  }

  return markets.map((m) =>
    buildMarketState(
      m,
      balanceByVault.get(m.insuranceFund.vault.toBase58()) ?? ZERO,
    ),
  );
}

/**
 * Resolve an override to a raw base-unit balance.
 *
 * `vaultBalance` (raw integer) takes precedence over `vaultBalanceUi` (decimal).
 * `marketDecimals` is the fallback used to scale `vaultBalanceUi` when the
 * override doesn't carry its own `decimals`.
 */
export function resolveOverrideRaw(
  override: VaultBalanceOverride,
  marketDecimals: number,
): BN {
  const decimals = override.decimals ?? marketDecimals;
  if (override.vaultBalance !== undefined && override.vaultBalance !== "") {
    const raw = override.vaultBalance.trim();
    if (!/^-?\d+$/.test(raw)) {
      throw new Error(
        `vaultBalance "${override.vaultBalance}" must be an integer number of base units ` +
          `(no decimal point). For a decimal token amount use "vaultBalanceUi" instead.`,
      );
    }
    return new BN(raw, 10);
  }
  if (override.vaultBalanceUi !== undefined && override.vaultBalanceUi !== "") {
    return fromUi(override.vaultBalanceUi, decimals);
  }
  throw new Error(
    "Vault balance override must specify `vaultBalance` (raw base units) or `vaultBalanceUi` (decimal)",
  );
}

/**
 * Return a copy of `state` with the config override applied when one exists for
 * the market. The on-chain balance is preserved in `onchainVaultBalance`, and
 * the override's `decimals` (if given) becomes the market's display decimals.
 */
export function applyBalanceOverride(
  state: IfMarketState,
  config: IfConfig | null,
): IfMarketState {
  const override = config?.marketOverrides?.[String(state.marketIndex)];
  if (!override) return state;
  return {
    ...state,
    decimals: override.decimals ?? state.decimals,
    vaultBalance: resolveOverrideRaw(override, state.decimals),
    vaultBalanceSource: "config",
    balanceOverrideReason: override.reason,
  };
}

/**
 * Convert a decoded IF stake into a valued deposit using the market state.
 * Returns null when the stake has no shares (an empty/closed position).
 */
export function valueStake(
  stake: DecodedIfStake,
  stakePubkey: string,
  marketState: IfMarketState,
): IfDeposit | null {
  const effectiveShares = rebaseShares(
    stake.ifShares,
    stake.ifBase,
    marketState.sharesBase,
  );
  if (effectiveShares.lte(ZERO)) return null;

  // Mirror the Drift UI (fetchInsuranceFundData): when a staker has an open
  // unstake request, the requested portion is valued at the amount locked in at
  // request time (capped against current value), not at the live share price.
  // Valuing everything at the live price otherwise overstates appreciated stakes.
  const hasOpenRequest = stake.lastWithdrawRequestShares.gt(ZERO);
  const tokenAmount = hasOpenRequest
    ? unstakeSharesToAmountWithOpenRequest(
        effectiveShares,
        rebaseShares(
          stake.lastWithdrawRequestShares,
          stake.ifBase,
          marketState.sharesBase,
        ),
        stake.lastWithdrawRequestValue,
        marketState.totalIfShares,
        marketState.vaultBalance,
      )
    : unstakeSharesToAmount(
        effectiveShares,
        marketState.totalIfShares,
        marketState.vaultBalance,
      );

  return {
    marketIndex: stake.marketIndex,
    stakePubkey,
    ifSharesRaw: stake.ifShares,
    ifBase: stake.ifBase,
    effectiveShares,
    tokenAmount,
    costBasis: stake.costBasis,
    lastWithdrawRequestShares: stake.lastWithdrawRequestShares,
    lastWithdrawRequestValue: stake.lastWithdrawRequestValue,
    lastWithdrawRequestTs: stake.lastWithdrawRequestTs,
  };
}

/**
 * Value the protocol-owned slice of a market's Insurance Fund as a synthetic
 * deposit. The protocol slice is `totalIfShares − userIfShares` — shares
 * tracked directly on the market with no `InsuranceFundStake` account. Mirrors
 * dfx/revalue.ts's protocol residual.
 *
 * The returned deposit carries `stakePubkey = PROTOCOL_OWNED_STAKE_PUBKEY` as a
 * marker (no real stake account exists). Attributing it to the protocol wallet
 * is the caller's job (it keys the deposit under the protocol authority).
 *
 * Returns null when the slice is <= 0. A strictly negative slice cannot occur
 * on-chain (user shares never exceed total); if it does, warn and skip rather
 * than emit a negative claim.
 */
export function valueProtocolStake(
  marketState: IfMarketState,
): IfDeposit | null {
  const protocolShares = marketState.totalIfShares.sub(
    marketState.userIfShares,
  );
  if (protocolShares.lte(ZERO)) {
    if (protocolShares.isNeg()) {
      console.warn(
        `  ⚠ market ${marketState.marketIndex} (${marketState.symbol}): ` +
          `userIfShares (${marketState.userIfShares.toString()}) exceed ` +
          `totalIfShares (${marketState.totalIfShares.toString()}) — ` +
          `skipping protocol-owned claim.`,
      );
    }
    return null;
  }

  const tokenAmount = unstakeSharesToAmount(
    protocolShares,
    marketState.totalIfShares,
    marketState.vaultBalance,
  );

  return {
    marketIndex: marketState.marketIndex,
    stakePubkey: PROTOCOL_OWNED_STAKE_PUBKEY,
    ifSharesRaw: protocolShares,
    ifBase: marketState.sharesBase,
    effectiveShares: protocolShares,
    tokenAmount,
    costBasis: ZERO,
    lastWithdrawRequestShares: ZERO,
    lastWithdrawRequestValue: ZERO,
    lastWithdrawRequestTs: ZERO,
  };
}

/** One deposit's inputs to surplus redistribution. */
export type SurplusItem = {
  /** The deposit's snapshot value (capped at the locked amount for open requests). */
  tokenAmount: BN;
  /**
   * Shares NOT under an open withdraw request: `effectiveShares −
   * rebased(lastWithdrawRequestShares)`. Equals `effectiveShares` for stakers
   * with no open request and for the protocol slice.
   */
  nonRequestedShares: BN;
};

export type SurplusRedistribution = {
  /** `vaultBalance − Σ tokenAmount`: the forfeited appreciation pooled in the vault. */
  surplus: BN;
  /** `Σ nonRequestedShares` (= `totalShares − Σ requestedShares`). */
  nonRequestedTotal: BN;
  /**
   * Per-item surplus allocation, in the same order as `items`. Sums exactly to
   * `surplus` when `nonRequestedTotal > 0`; all zeros otherwise.
   */
  surplusShares: BN[];
};

/**
 * Redistribute a market's vault surplus pro-rata across all non-requested shares.
 *
 * When a staker with an open withdraw request unstakes, the on-chain program
 * pays `min(currentValue, lockedValue)` yet burns the full requested shares
 * (`remove_insurance_fund_stake`): the forfeited appreciation stays in the vault
 * and accrues to the holders who remain. This reproduces that end state — the
 * surplus (`vaultBalance − Σ capped claims`) is split across the shares that are
 * NOT under request (other stakers, the un-requested portion of partial
 * requesters, and the protocol slice), weighted by those shares.
 *
 * Floor-division dust is assigned to the largest non-requested holder so the
 * allocation sums exactly to `surplus`. If every share is under request
 * (`nonRequestedTotal == 0`) the surplus cannot be reattributed and all
 * allocations are zero (the caller should surface this).
 */
export function redistributeSurplus(
  vaultBalance: BN,
  items: SurplusItem[],
): SurplusRedistribution {
  const totalClaims = items.reduce((acc, it) => acc.add(it.tokenAmount), new BN(0));
  // Claims never exceed the vault (each is capped at its proportional value);
  // clamp defensively so rounding can't produce a negative surplus.
  let surplus = vaultBalance.sub(totalClaims);
  if (surplus.isNeg()) surplus = new BN(0);

  const nonRequestedTotal = items.reduce(
    (acc, it) => acc.add(it.nonRequestedShares),
    new BN(0),
  );

  const surplusShares = items.map(() => new BN(0));
  if (surplus.lte(ZERO) || nonRequestedTotal.lte(ZERO)) {
    return { surplus, nonRequestedTotal, surplusShares };
  }

  let allocated = new BN(0);
  let largestIdx = 0;
  for (let i = 0; i < items.length; i++) {
    const share = surplus.mul(items[i].nonRequestedShares).div(nonRequestedTotal);
    surplusShares[i] = share;
    allocated = allocated.add(share);
    if (items[i].nonRequestedShares.gt(items[largestIdx].nonRequestedShares)) {
      largestIdx = i;
    }
  }
  // Floor division leaves a few base units short; give the remainder to the
  // largest non-requested holder so Σ(surplusShares) == surplus exactly.
  const dust = surplus.sub(allocated);
  if (dust.gt(ZERO)) {
    surplusShares[largestIdx] = surplusShares[largestIdx].add(dust);
  }

  return { surplus, nonRequestedTotal, surplusShares };
}

/**
 * Fetch every `InsuranceFundStake` account on the program via a single
 * discriminator-filtered `getProgramAccounts` scan (anchor's `.all()`).
 */
export async function fetchAllIfStakes(
  driftClient: DriftClient,
): Promise<Array<{ pubkey: string; stake: DecodedIfStake }>> {
  const all = await driftClient.program.account.insuranceFundStake.all();
  return all.map((a: { publicKey: PublicKey; account: unknown }) => {
    const acct = a.account as DecodedIfStake;
    return {
      pubkey: a.publicKey.toBase58(),
      stake: {
        authority: acct.authority,
        marketIndex: Number(acct.marketIndex),
        ifShares: acct.ifShares,
        ifBase: acct.ifBase,
        costBasis: acct.costBasis,
        lastWithdrawRequestShares: acct.lastWithdrawRequestShares,
        lastWithdrawRequestValue: acct.lastWithdrawRequestValue,
        lastWithdrawRequestTs: acct.lastWithdrawRequestTs,
      },
    };
  });
}

/** Format a raw token amount as a human-readable decimal string. */
export function toUi(raw: BN, decimals: number): string {
  const neg = raw.isNeg();
  const abs = raw
    .abs()
    .toString()
    .padStart(decimals + 1, "0");
  const whole = abs.slice(0, abs.length - decimals) || "0";
  const frac = decimals > 0 ? abs.slice(abs.length - decimals) : "";
  const trimmedFrac = frac.replace(/0+$/, "");
  const body = trimmedFrac ? `${whole}.${trimmedFrac}` : whole;
  return neg ? `-${body}` : body;
}

/** Parse a human-readable decimal string into raw token units (inverse of `toUi`). */
export function fromUi(ui: string, decimals: number): BN {
  const s = ui.trim();
  const neg = s.startsWith("-");
  const unsigned = neg ? s.slice(1) : s;
  const [whole = "", frac = ""] = unsigned.split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) {
    throw new Error(`Invalid UI amount: "${ui}"`);
  }
  if (frac.length > decimals) {
    throw new Error(
      `UI amount "${ui}" has more fractional digits than the market's ${decimals} decimals`,
    );
  }
  const combined = (whole || "0") + frac.padEnd(decimals, "0");
  const bn = new BN(combined.replace(/^0+(?=\d)/, ""), 10);
  return neg ? bn.neg() : bn;
}
