/**
 * Full subaccount coverage for the base snapshot.
 *
 * `users.json` is derived from a spot-balances CSV, so it only lists
 * subaccounts that held a spot balance at snapshot time. A subaccount whose
 * only value is a quote-only perp position (baseAssetAmount == 0, but a
 * residual quoteAssetAmount of unsettled PnL) has no spot balance and never
 * enters that CSV — so `snapshot.ts` never fetches it and its value is lost.
 *
 * To cover every affected subaccount we expand each authority to ALL of its
 * on-chain subaccounts via `UserStats.numberOfSubAccountsCreated`, exactly the
 * way the web app's live breakdown does. These helpers are the price-independent
 * (RPC-free) pieces of that expansion; the RPC orchestration lives in
 * `snapshot.ts`.
 */

import {
  getUserAccountPublicKeySync,
  getUserStatsAccountPublicKey,
} from "@drift-labs/sdk";
import { PublicKey } from "@solana/web3.js";

/**
 * Distinct authorities to enumerate for full subaccount coverage: every CSV
 * authority in `csvAuthorityByUserAccount`, minus `excluded` (blacklisted and
 * vault authorities, which are dropped downstream in `revalue.ts` anyway).
 * Returned sorted for deterministic RPC ordering.
 */
export function coverageAuthorities(
  csvAuthorityByUserAccount: Map<string, string>,
  excluded: Set<string>,
): string[] {
  const set = new Set<string>();
  for (const authority of csvAuthorityByUserAccount.values()) {
    if (!authority || excluded.has(authority)) continue;
    set.add(authority);
  }
  return [...set].sort();
}

/** UserStats PDA for an authority — where `numberOfSubAccountsCreated` lives. */
export function userStatsPubkey(
  programId: PublicKey,
  authority: PublicKey,
): PublicKey {
  return getUserStatsAccountPublicKey(programId, authority);
}

/**
 * Every subaccount user PDA for one authority: subAccountId in [0, count).
 *
 * Drift assigns subAccountId incrementally and `numberOfSubAccountsCreated`
 * counts all ids ever created, so [0, count) covers every id ever used. A
 * deleted subaccount's id simply resolves to a non-existent account, which the
 * caller skips (info?.data is null).
 */
export function deriveSubaccountPubkeys(
  programId: PublicKey,
  authority: PublicKey,
  count: number,
): PublicKey[] {
  const out: PublicKey[] = [];
  for (let i = 0; i < count; i++) {
    out.push(getUserAccountPublicKeySync(programId, authority, i));
  }
  return out;
}

/** Dedupe pubkeys by base58, preserving first-seen order. */
export function dedupePubkeys(pubkeys: PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const pk of pubkeys) {
    const k = pk.toBase58();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(pk);
  }
  return out;
}
