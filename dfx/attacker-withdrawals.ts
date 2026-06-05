/**
 * Tally how much each attacker wallet withdrew, using the Drift data API
 * (not the on-chain cumulative `totalWithdraws`, which is inflated by scam-token
 * deposits/withdrawals priced at absurd oracle values).
 *
 * The attacker wallets are *authorities* — each can own multiple Drift user
 * sub-accounts. For every authority we:
 *   1. find all UserAccounts created by that authority (getProgramAccounts,
 *      memcmp on the authority field at offset 8 + the fixed User dataSize),
 *   2. fetch each user account's deposit/withdraw records from the data API
 *      (https://data.api.drift.trade/user/{accountId}/deposits/{year}/{month}),
 *   3. keep only `withdraw` records, aggregate token amount per spot market and
 *      compute notional = amount * oraclePrice (both already human-readable).
 *
 * Spot markets 62/63/64/65 are scam tokens — their withdrawals are excluded
 * from the totals and reported separately under `scamWithdrawals`.
 *
 * Output: a JSON breakdown per authority / per user account / per token, plus
 * the grand-total notional withdrawn across all attacker wallets.
 *
 * Run:
 *   bun ./dfx/attacker-withdrawals.ts \
 *     --rpc-url <RPC_URL> \
 *     --year 2026 --month 4 \
 *     --output ./dfx/out/attacker_withdrawals.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DRIFT_PROGRAM_ID, decodeUser } from "@drift-labs/sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { Decimal } from "decimal.js";

import { withRetry } from "../lib/rate-limit.ts";
import { stableJsonStringify } from "../lib/snapshot-types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Attacker wallets (authorities). Mirrors the attacker entries in
// BLACKLISTED_AUTHORITIES in snapshot.ts.
const ATTACKER_AUTHORITIES: string[] = [
  "9sG4XYicGtMKe7nSFEkRuAMKJMVb3QPSqKvxBGpb1Rbn",
  "3apA2d235ZZpzNuwBbDh1tbmSmDDmKesRchzmXuvdera",
  "Gew3grkVGP5k2gJpyeEukbXkYHN9RwNyKohFA4XCHMmN",
  "55udxhScWQxM7cC9d1NPBQoEDC7B38w81EWKPZsM7ZCW",
  "EEaX5aVopMn2nnb4dgbmXi3RJH9URLLkpfKMyiWpbinb",
];

// Spot markets flagged as scam tokens — excluded from withdrawal totals.
const SCAM_MARKET_INDEXES = new Set([62, 63, 64, 65]);

const DATA_API_BASE = "https://data.api.drift.trade";

// Drift User account: 8-byte anchor discriminator, then `authority` (Pubkey).
const USER_AUTHORITY_OFFSET = 8;
const USER_ACCOUNT_SIZE = 4376;

const RETRY_OPTS = { retries: 8, baseDelayMs: 1_000, maxDelayMs: 60_000 };

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

function getNumFlag(name: string, def: number): number {
  const v = getFlag(name);
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

type DepositRecord = {
  ts: number;
  amount: string;
  oraclePrice: string;
  direction: string;
  marketIndex: number;
  symbol: string;
};

type ApiResponse = {
  success: boolean;
  records: DepositRecord[];
  meta: { totalPages: number; currentPage: number; nextPage: number | null };
};

async function fetchAllDepositRecords(
  accountId: string,
  year: number,
  month: number,
): Promise<DepositRecord[]> {
  const records: DepositRecord[] = [];
  let page = 1;
  while (true) {
    const url = `${DATA_API_BASE}/user/${accountId}/deposits/${year}/${month}?page=${page}`;
    const data = await withRetry(async () => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return (await res.json()) as ApiResponse;
    }, RETRY_OPTS);

    if (!data.success)
      throw new Error(`data API returned success=false for ${url}`);
    records.push(...data.records);

    const next = data.meta?.nextPage;
    if (!next || next <= page) break;
    page = next;
  }
  return records;
}

async function findUserAccountsForAuthority(
  connection: Connection,
  programId: PublicKey,
  authority: string,
): Promise<Array<{ userAccount: string; subAccountId: number }>> {
  const accounts = await withRetry(
    () =>
      connection.getProgramAccounts(programId, {
        commitment: "confirmed",
        filters: [
          { dataSize: USER_ACCOUNT_SIZE },
          { memcmp: { offset: USER_AUTHORITY_OFFSET, bytes: authority } },
        ],
      }),
    RETRY_OPTS,
  );

  const out: Array<{ userAccount: string; subAccountId: number }> = [];
  for (const { pubkey, account } of accounts) {
    try {
      const user = decodeUser(account.data);
      if (user.authority.toBase58() !== authority) continue;
      out.push({
        userAccount: pubkey.toBase58(),
        subAccountId: user.subAccountId,
      });
    } catch {
      console.error(`  Failed to decode user: ${pubkey.toBase58()}`);
    }
  }
  out.sort((a, b) => a.subAccountId - b.subAccountId);
  return out;
}

type TokenWithdrawal = {
  marketIndex: number;
  symbol: string;
  amountWithdrawn: string;
  notionalWithdrawn: string;
  withdrawCount: number;
};

type ScamWithdrawal = {
  marketIndex: number;
  symbol: string;
  amountWithdrawn: string;
  withdrawCount: number;
  label: "scam token";
};

type UserAccountBreakdown = {
  userAccount: string;
  subAccountId: number;
  withdrawCount: number;
  notionalWithdrawn: string;
  tokens: TokenWithdrawal[];
  scamWithdrawals: ScamWithdrawal[];
};

type AuthorityBreakdown = {
  authority: string;
  notionalWithdrawn: string;
  userAccounts: UserAccountBreakdown[];
};

const fmt = (d: Decimal): string => d.toFixed(6);

function aggregateUserAccount(
  userAccount: string,
  subAccountId: number,
  records: DepositRecord[],
): UserAccountBreakdown {
  // marketIndex -> aggregate (real tokens)
  const tokenAgg = new Map<
    number,
    { symbol: string; amount: Decimal; notional: Decimal; count: number }
  >();
  const scamAgg = new Map<
    number,
    { symbol: string; amount: Decimal; count: number }
  >();

  for (const r of records) {
    if (r.direction !== "withdraw") continue;
    const amount = new Decimal(r.amount);

    if (SCAM_MARKET_INDEXES.has(r.marketIndex)) {
      const cur = scamAgg.get(r.marketIndex) ?? {
        symbol: r.symbol,
        amount: new Decimal(0),
        count: 0,
      };
      cur.amount = cur.amount.add(amount);
      cur.count += 1;
      scamAgg.set(r.marketIndex, cur);
      continue;
    }

    const notional = amount.mul(new Decimal(r.oraclePrice));
    const cur = tokenAgg.get(r.marketIndex) ?? {
      symbol: r.symbol,
      amount: new Decimal(0),
      notional: new Decimal(0),
      count: 0,
    };
    cur.amount = cur.amount.add(amount);
    cur.notional = cur.notional.add(notional);
    cur.count += 1;
    tokenAgg.set(r.marketIndex, cur);
  }

  const tokens: TokenWithdrawal[] = [...tokenAgg.entries()]
    .sort(([a], [b]) => a - b)
    .map(([marketIndex, v]) => ({
      marketIndex,
      symbol: v.symbol,
      amountWithdrawn: v.amount.toString(),
      notionalWithdrawn: fmt(v.notional),
      withdrawCount: v.count,
    }));

  const scamWithdrawals: ScamWithdrawal[] = [...scamAgg.entries()]
    .sort(([a], [b]) => a - b)
    .map(([marketIndex, v]) => ({
      marketIndex,
      symbol: v.symbol,
      amountWithdrawn: v.amount.toString(),
      withdrawCount: v.count,
      label: "scam token" as const,
    }));

  const notional = tokens.reduce(
    (s, t) => s.add(new Decimal(t.notionalWithdrawn)),
    new Decimal(0),
  );
  const withdrawCount = tokens.reduce((s, t) => s + t.withdrawCount, 0);

  return {
    userAccount,
    subAccountId,
    withdrawCount,
    notionalWithdrawn: fmt(notional),
    tokens,
    scamWithdrawals,
  };
}

async function main(): Promise<void> {
  const rpcUrl = getFlag("--rpc-url") ?? process.env.RPC_URL ?? "";
  const year = getNumFlag("--year", 2026);
  const month = getNumFlag("--month", 4);
  const output =
    getFlag("--output") ??
    path.resolve(__dirname, "out", "attacker_withdrawals.json");

  if (!rpcUrl) throw new Error("Missing --rpc-url (or RPC_URL env var)");
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const connection = new Connection(rpcUrl, "confirmed");
  const programId = new PublicKey(DRIFT_PROGRAM_ID);

  const breakdown: AuthorityBreakdown[] = [];
  let grandTotal = new Decimal(0);

  for (const authority of ATTACKER_AUTHORITIES) {
    console.log(`Authority ${authority}: discovering user accounts...`);
    const userAccounts = await findUserAccountsForAuthority(
      connection,
      programId,
      authority,
    );

    const perUser: UserAccountBreakdown[] = [];
    let authorityTotal = new Decimal(0);

    for (const { userAccount, subAccountId } of userAccounts) {
      const records = await fetchAllDepositRecords(userAccount, year, month);
      const agg = aggregateUserAccount(userAccount, subAccountId, records);
      perUser.push(agg);
      authorityTotal = authorityTotal.add(new Decimal(agg.notionalWithdrawn));
      console.log(
        `  ${userAccount} (sub ${subAccountId}): ${agg.withdrawCount} withdrawal(s), notional = ${agg.notionalWithdrawn}` +
          (agg.scamWithdrawals.length
            ? ` [${agg.scamWithdrawals.length} scam-token market(s) excluded]`
            : ""),
      );
    }

    grandTotal = grandTotal.add(authorityTotal);
    breakdown.push({
      authority,
      notionalWithdrawn: fmt(authorityTotal),
      userAccounts: perUser,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dataApiBase: DATA_API_BASE,
    period: `${year}/${month}`,
    driftProgramId: DRIFT_PROGRAM_ID,
    scamMarketIndexes: [...SCAM_MARKET_INDEXES].sort((a, b) => a - b),
    note: "notionalWithdrawn = sum over withdraw records of amount * oraclePrice (both human-readable from the data API). Spot markets 62/63/64/65 are scam tokens, excluded from totals and listed under scamWithdrawals.",
    attackerAuthorities: ATTACKER_AUTHORITIES,
    sumNotionalWithdrawn: fmt(grandTotal),
    breakdown,
  };

  fs.writeFileSync(output, stableJsonStringify(report, 2) + "\n", "utf8");
  console.log(
    `\nWrote ${output}\nSum notional withdrawn across ${
      ATTACKER_AUTHORITIES.length
    } attacker wallets (excl. scam tokens): ${fmt(grandTotal)}`,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
