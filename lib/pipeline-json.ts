/**
 * JSON formats produced by extract-* scripts and consumed by snapshot-onchain.ts
 */

import fs from "fs";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export const ORACLE_PRICES_JSON_VERSION = 1 as const;
export const USER_ACCOUNTS_JSON_VERSION = 2 as const;

export type OraclePricesPayload = {
  version: typeof ORACLE_PRICES_JSON_VERSION;
  sourceCsv: string;
  generatedAt: string;
  /** Drift PRICE_PRECISION as decimal string (e.g. "1000000") */
  pricePrecision: string;
  markets: Array<{
    marketIndex: number;
    /** Median oracle price in fixed-point (string for JSON bigint safety) */
    oraclePrice: string;
    sampleCount: number;
  }>;
};

export type UserAccountsPayload = {
  version: typeof USER_ACCOUNTS_JSON_VERSION;
  sourceCsv: string;
  generatedAt: string;
  /**
   * User account pubkey (base58) -> authority pubkey (base58), from CSV.
   * Last row wins if the same user_account appears with different authorities (should be rare).
   */
  accounts: Record<string, string>;
};

export type LoadedUserAccounts = {
  userAccountPubkeys: PublicKey[];
  /** CSV authority (base58) by user account (base58); use on-chain authority in snapshot output when decoded. */
  csvAuthorityByUserAccount: Map<string, string>;
};

export function readOraclePricesJson(filePath: string): Map<number, BN> {
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw) as OraclePricesPayload;
  if (data.version !== ORACLE_PRICES_JSON_VERSION) {
    throw new Error(`Unsupported oracles JSON version: ${data.version}`);
  }
  const map = new Map<number, BN>();
  for (const m of data.markets) {
    map.set(m.marketIndex, new BN(m.oraclePrice, 10));
  }
  return map;
}

export function readUserAccountsJson(filePath: string): LoadedUserAccounts {
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw) as UserAccountsPayload;
  if (data.version !== USER_ACCOUNTS_JSON_VERSION) {
    throw new Error(
      `Unsupported users JSON version: ${data.version} (expected ${USER_ACCOUNTS_JSON_VERSION}). Re-run: bun ./extract-users-from-csv.ts`,
    );
  }
  if (!data.accounts || typeof data.accounts !== "object") {
    throw new Error('Invalid users JSON: missing "accounts" map');
  }

  const csvAuthorityByUserAccount = new Map<string, string>();
  const userAccountPubkeys: PublicKey[] = [];

  const sortedUserKeys = Object.keys(data.accounts).sort();
  for (const userStr of sortedUserKeys) {
    const authStr = data.accounts[userStr];
    if (!authStr) continue;
    try {
      userAccountPubkeys.push(new PublicKey(userStr));
      csvAuthorityByUserAccount.set(userStr, authStr);
    } catch {
      /* skip invalid pubkey */
    }
  }

  return { userAccountPubkeys, csvAuthorityByUserAccount };
}

export function writeJsonPretty(filePath: string, payload: unknown): void {
  fs.writeFileSync(
    filePath,
    JSON.stringify(payload, null, "\t") + "\n",
    "utf8",
  );
}

/** Stable key order for user `accounts` object (sorted by user account pubkey). */
export function sortAccountsRecord(
  accounts: Record<string, string>,
): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(accounts).sort()) {
    sorted[k] = accounts[k];
  }
  return sorted;
}
