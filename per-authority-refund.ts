/**
 * Per-authority refund computation from on-chain data only.
 *
 * Self-contained alternative to `run-recovery.sh` for a single authority:
 * discovers the authority's drift sub-accounts via `getProgramAccounts`,
 * fetches every transaction touching them in the attack window via RPC,
 * parses Drift events from the tx logs, runs the same per-event backtrack
 * the bulk pipeline uses (reusing exported reversal functions from
 * `backtrack-snapshot-perps.ts`), prices both sides at the same oracle CSV,
 * and prints `refund_usd` + writes a per-event audit trail.
 *
 * Use this for:
 *  - Spot-checking the refund for one authority without re-running the
 *    bulk pipeline.
 *  - Environments with RPC access but no Athena.
 *
 * Known limitations (see README):
 *  - Bankruptcy socialization not applied.
 *  - Referrer clawback only caught if the rebate appears in this user's own
 *    transactions (not applied when this user was a referrer for others).
 *  - Vault depositor share math is not included; pure own-account positions.
 *
 * Run:
 *   bun ./per-authority-refund.ts \
 *     --rpc-url <RPC_URL> \
 *     --authority <AUTHORITY_PUBKEY> \
 *     [--oracle-csv ./oracle-prices/pyth_oracle_prices-160600.csv] \
 *     [--out-dir ./out/per_authority]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Wallet } from "@coral-xyz/anchor";
import {
  BN,
  BulkAccountLoader,
  DriftClient,
  decodeUser,
  parseLogs,
} from "@drift-labs/sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  type ConfirmedSignatureInfo,
} from "@solana/web3.js";

import {
  aggregateUserPositions,
  mergeAggregate,
} from "./lib/aggregate-borrow-lend.ts";
import { AuditLog } from "./lib/audit-log.ts";
import { loadOracleCloseByMarket } from "./lib/oracle-csv.ts";
import { extractPerpMarket } from "./lib/perp-snapshot.ts";
import { adaptDriftEvents, type AnchorEvent } from "./lib/parse-drift-logs.ts";
import {
  limitConcurrency,
  RateLimiter,
  retryStats,
  withRetry,
} from "./lib/rate-limit.ts";
import {
  bnToStr,
  strToBn,
  type BorrowLendAggregateSnapshot,
  type PerpMarketSnapshot,
  type SpotMarketSnapshot,
} from "./lib/snapshot-types.ts";
import {
  sumBorrowLendQuote,
  valueBorrowLendAggregate,
} from "./lib/value-from-snapshot.ts";

import {
  Anomalies,
  emptyAuthorityState,
  exportPerpSnap,
  importPerpSnap,
  reverseFunding,
  reverseLiquidation,
  reverseSettlePnl,
  reverseSwap,
  reverseTrade,
  type AuthorityState,
} from "./backtrack-snapshot-perps.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DRIFT_PROGRAM_ID = new PublicKey(
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH",
);

// Same window as the bulk pipeline. Hard-coded; trivial to surface as a
// flag later if other incidents need it.
const CUTOFF_SLOT = 410_344_026;
const WINDOW_END_SLOT = 410_366_402;

// Anchor discriminator length; UserAccount.authority is the first 32-byte
// field after that.
const USER_AUTHORITY_OFFSET = 8;

const BN0 = new BN(0);
const QUOTE_PRECISION = new BN(1_000_000); // 6 decimals — USDC

type CliFlags = {
  rpcUrl: string;
  authority: string;
  oracleCsv: string;
  outDir: string;
  txConcurrency: number;
  sigPageSize: number;
  // Global cap on RPC requests/second across all calls (subaccount discovery,
  // signature pagination, tx fetches). Pace this conservatively below your
  // endpoint's rate limit to avoid sustained 429 backoff cycles.
  rpcQps: number;
};

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

function parseFlags(): CliFlags {
  const flags: CliFlags = {
    rpcUrl: getFlag("--rpc-url") ?? process.env.RPC_URL ?? "",
    authority: getFlag("--authority") ?? "",
    oracleCsv:
      getFlag("--oracle-csv") ??
      path.resolve(__dirname, "oracle-prices", "pyth_oracle_prices-160600.csv"),
    outDir:
      getFlag("--out-dir") ?? path.resolve(__dirname, "out", "per_authority"),
    txConcurrency: getNumFlag("--tx-concurrency", 25),
    sigPageSize: getNumFlag("--sig-page-size", 1000),
    rpcQps: getNumFlag("--rpc-qps", 15),
  };
  if (!flags.rpcUrl) {
    throw new Error("Missing --rpc-url (or set RPC_URL env var)");
  }
  if (!flags.authority) {
    throw new Error("Missing --authority <pubkey>");
  }
  try {
    new PublicKey(flags.authority);
  } catch {
    throw new Error(`Invalid --authority pubkey: ${flags.authority}`);
  }
  if (!fs.existsSync(flags.oracleCsv)) {
    throw new Error(`Oracle CSV not found: ${flags.oracleCsv}`);
  }
  fs.mkdirSync(flags.outDir, { recursive: true });
  return flags;
}

async function setupDriftClient(rpcUrl: string): Promise<{
  connection: Connection;
  driftClient: DriftClient;
}> {
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(Keypair.generate());
  const bulkAccountLoader = new BulkAccountLoader(
    // @ts-ignore — same as snapshot.ts; SDK version drift on Connection type
    connection,
    "confirmed",
    // Long poll interval — we only need the initial snapshot of market
    // accounts, not ongoing updates. Keeps the background poller from
    // competing with our per-tx fetch loop on rate-limited RPCs.
    60_000,
  );
  const driftClient = new DriftClient({
    // @ts-ignore
    connection,
    // @ts-ignore
    wallet,
    env: "mainnet-beta",
    skipLoadUsers: true,
    accountSubscription: { type: "polling", accountLoader: bulkAccountLoader },
  });
  await driftClient.subscribe();
  return { connection, driftClient };
}

function snapshotMarkets(driftClient: DriftClient): {
  spotMarkets: Record<number, SpotMarketSnapshot>;
  perpMarkets: Record<number, PerpMarketSnapshot>;
} {
  const spotMarkets: Record<number, SpotMarketSnapshot> = {};
  for (const m of driftClient.getSpotMarketAccounts()) {
    spotMarkets[m.marketIndex] = {
      marketIndex: m.marketIndex,
      decimals: m.decimals,
    };
  }
  const perpMarkets: Record<number, PerpMarketSnapshot> = {};
  for (const m of driftClient.getPerpMarketAccounts()) {
    perpMarkets[m.marketIndex] = extractPerpMarket(m);
  }
  return { spotMarkets, perpMarkets };
}

const RETRY_OPTS = { retries: 8, baseDelayMs: 1_000, maxDelayMs: 60_000 };

/**
 * Page through `getSignaturesForAddress` until we walk past the cutoff slot.
 * Returns every signature whose slot ∈ [cutoffSlot, windowEndSlot].
 */
async function fetchSignaturesInWindow(
  connection: Connection,
  subaccounts: PublicKey[],
  pageSize: number,
  limiter: RateLimiter,
): Promise<Set<string>> {
  const sigs = new Set<string>();
  for (const sub of subaccounts) {
    let before: string | undefined = undefined;
    while (true) {
      const page: ConfirmedSignatureInfo[] = await limiter.run(
        () =>
          connection.getSignaturesForAddress(
            sub,
            { limit: pageSize, before },
            "confirmed",
          ),
        RETRY_OPTS,
      );
      if (page.length === 0) break;
      let walkedPastWindow = false;
      for (const s of page) {
        if (s.slot > WINDOW_END_SLOT) continue;
        if (s.slot < CUTOFF_SLOT) {
          walkedPastWindow = true;
          continue;
        }
        sigs.add(s.signature);
      }
      // Stop if every sig in this page predates the window.
      if (walkedPastWindow && page[page.length - 1].slot < CUTOFF_SLOT) break;
      // Stop if we got a short page (no more results).
      if (page.length < pageSize) break;
      before = page[page.length - 1].signature;
    }
  }
  return sigs;
}

type FetchedTx = {
  txsig: string;
  slot: number;
  blockTime: number;
  logs: string[];
};

async function fetchTransactions(
  connection: Connection,
  txsigs: string[],
  concurrency: number,
  limiter: RateLimiter,
): Promise<FetchedTx[]> {
  let done = 0;
  const total = txsigs.length;
  const reportEvery = Math.max(100, Math.floor(total / 20));
  const tasks = txsigs.map((txsig) => async (): Promise<FetchedTx | null> => {
    const tx = await limiter.run(
      () =>
        connection.getTransaction(txsig, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        }),
      RETRY_OPTS,
    );
    done += 1;
    if (done % reportEvery === 0 || done === total) {
      console.log(
        `  tx fetch progress: ${done}/${total}` +
          (retryStats.totalRetries > 0
            ? ` (${retryStats.totalRetries} retries so far)`
            : ""),
      );
    }
    if (!tx?.meta?.logMessages) return null;
    return {
      txsig,
      slot: tx.slot,
      blockTime: tx.blockTime ?? 0,
      logs: tx.meta.logMessages,
    };
  });
  const results = await limitConcurrency(tasks, concurrency);
  return results.filter((r): r is FetchedTx => r !== null);
}

function importT1IntoState(agg: BorrowLendAggregateSnapshot): AuthorityState {
  const s = emptyAuthorityState();
  s.usdcCrossSignedToken = strToBn(agg.usdcCrossSignedToken);
  s.usdcIsolatedToken = strToBn(agg.usdcIsolatedToken);
  for (const [idxStr, vStr] of Object.entries(agg.spotSignedTokenByMarket)) {
    s.spotSignedTokenByMarket.set(Number(idxStr), strToBn(vStr));
  }
  for (const p of agg.perpPositions) {
    s.perpByMarket.set(p.marketIndex, importPerpSnap(p));
  }
  return s;
}

function exportT0FromState(state: AuthorityState): BorrowLendAggregateSnapshot {
  const spotObj: Record<number, string> = {};
  for (const [idx, v] of state.spotSignedTokenByMarket.entries()) {
    if (v.eq(BN0)) continue;
    spotObj[idx] = bnToStr(v);
  }
  const perpArr = [];
  for (const p of state.perpByMarket.values()) {
    const isAllZero =
      p.baseAssetAmount.eq(BN0) &&
      p.quoteAssetAmount.eq(BN0) &&
      p.lpShares.eq(BN0) &&
      p.isolatedPositionScaledBalance.eq(BN0) &&
      p.openOrders === 0;
    if (isAllZero && p.syntheticallyCreated) continue;
    perpArr.push(exportPerpSnap(p));
  }
  return {
    spotSignedTokenByMarket: spotObj,
    usdcCrossSignedToken: bnToStr(state.usdcCrossSignedToken),
    usdcIsolatedToken: bnToStr(state.usdcIsolatedToken),
    perpPositions: perpArr,
  };
}

function formatUsd(b: BN): string {
  // QUOTE_PRECISION = 1e6 (USDC has 6 decimals).
  const sign = b.isNeg() ? "-" : "";
  const abs = b.abs();
  const dollars = abs.div(QUOTE_PRECISION).toString(10);
  const fraction = abs
    .mod(QUOTE_PRECISION)
    .toString(10)
    .padStart(6, "0")
    .slice(0, 2);
  return `${sign}$${dollars}.${fraction}`;
}

async function main(): Promise<void> {
  const flags = parseFlags();
  console.log(`Authority: ${flags.authority}`);
  console.log(`Window: slots [${CUTOFF_SLOT}, ${WINDOW_END_SLOT}]`);
  console.log(
    `Rate limit: ${flags.rpcQps} req/s global, tx concurrency ${flags.txConcurrency}`,
  );

  // Global RPC pacing — every script-level RPC call (getProgramAccounts,
  // getSignaturesForAddress, getTransaction) goes through this. Keeps
  // sustained throughput under the endpoint's rate-limit ceiling instead
  // of bursting into 429s and incurring exponential backoff.
  const limiter = new RateLimiter(1000 / Math.max(1, flags.rpcQps));

  // DriftClient.subscribe() can transiently 429 on cold endpoints — retry
  // the entire subscribe up to a few times before giving up.
  const { connection, driftClient } = await withRetry(
    () => setupDriftClient(flags.rpcUrl),
    { retries: 3, baseDelayMs: 5_000, maxDelayMs: 60_000 },
  );
  console.log("Drift client subscribed.");

  const { spotMarkets, perpMarkets } = snapshotMarkets(driftClient);
  console.log(
    `Markets snapshot: spot=${Object.keys(spotMarkets).length} perp=${
      Object.keys(perpMarkets).length
    }`,
  );

  // 1. Discover this authority's drift sub-accounts on-chain.
  const authorityPk = new PublicKey(flags.authority);
  const gpa = await limiter.run(
    () =>
      connection.getProgramAccounts(DRIFT_PROGRAM_ID, {
        commitment: "confirmed",
        filters: [
          {
            memcmp: {
              offset: USER_AUTHORITY_OFFSET,
              bytes: authorityPk.toBase58(),
            },
          },
        ],
      }),
    RETRY_OPTS,
  );

  // The memcmp matches any drift program account whose 32 bytes at offset 8
  // equal the authority. UserStats has the same layout there but is a
  // different account type — filter by attempting to decode as UserAccount.
  const subaccountPks: PublicKey[] = [];
  const subToAuth = new Map<string, string>();
  let t1Agg: BorrowLendAggregateSnapshot | null = null;

  for (const { pubkey, account } of gpa) {
    let user;
    try {
      user = decodeUser(Buffer.from(account.data));
    } catch {
      continue; // not a UserAccount (could be UserStats etc.)
    }
    if (user.authority.toBase58() !== flags.authority) continue;
    subaccountPks.push(pubkey);
    subToAuth.set(pubkey.toBase58(), flags.authority);
    const agg = aggregateUserPositions(user, driftClient);
    t1Agg = t1Agg ? mergeAggregate(t1Agg, agg) : agg;
  }

  console.log(
    `Discovered ${subaccountPks.length} drift sub-account(s) for authority.`,
  );

  if (subaccountPks.length === 0 || !t1Agg) {
    console.log("No drift activity for this authority. refund_usd = $0.00");
    await driftClient.unsubscribe();
    return;
  }

  // We're done with DriftClient — captured all market metadata and per-user
  // aggregates. Unsubscribe NOW so the BulkAccountLoader's background poller
  // stops competing with our per-tx RPC fetch loop on rate-limited endpoints.
  // anchor `Program` is preserved via `driftClient.program` for parseLogs below.
  // @ts-ignore — program is exposed on DriftClient instance
  const program = driftClient.program;
  await driftClient.unsubscribe();

  // 2. Page tx signatures touching any sub-account in the slot window.
  console.log("Fetching tx signatures in window…");
  const txsigSet = await fetchSignaturesInWindow(
    connection,
    subaccountPks,
    flags.sigPageSize,
    limiter,
  );
  console.log(`Found ${txsigSet.size} unique txs in window.`);

  if (txsigSet.size === 0) {
    console.log("No transactions in window — nothing to reverse.");
    // T0 == T1, refund == 0.
  }

  // 3. Fetch transactions + extract logs.
  const txsigs = [...txsigSet];
  let fetched: FetchedTx[] = [];
  if (txsigs.length > 0) {
    console.log(
      `Fetching ${txsigs.length} transactions (concurrency=${flags.txConcurrency})…`,
    );
    fetched = await fetchTransactions(
      connection,
      txsigs,
      flags.txConcurrency,
      limiter,
    );
    console.log(
      `Got ${fetched.length} txs back (${
        txsigs.length - fetched.length
      } missing).`,
    );
  }

  // 4. Parse Drift events from each tx via the SDK.
  // `program` was captured before unsubscribe — passed straight into parseLogs.
  const allTrades = [];
  const allFundings = [];
  const allLiqs = [];
  const allSettles = [];
  const allSwaps = [];
  for (const tx of fetched) {
    const decoded = parseLogs(program, tx.logs) as AnchorEvent[];
    const adapted = adaptDriftEvents(decoded, {
      slot: tx.slot,
      txsig: tx.txsig,
      ts: tx.blockTime,
    });
    allTrades.push(...adapted.trades);
    allFundings.push(...adapted.fundings);
    allLiqs.push(...adapted.liquidations);
    allSettles.push(...adapted.settles);
    allSwaps.push(...adapted.swaps);
  }
  console.log(
    `Parsed events: trades=${allTrades.length} funding=${allFundings.length} ` +
      `liq=${allLiqs.length} settles=${allSettles.length} swaps=${allSwaps.length}`,
  );

  // 5. Backtrack: import T1, sort events, apply reversals.
  const states = new Map<string, AuthorityState>();
  states.set(flags.authority, importT1IntoState(t1Agg));

  const anomalies = new Anomalies();
  const audit = new AuditLog();
  const tradeCounters = { perpFills: 0, spotFills: 0, oneSidedFills: 0 };
  const liqCounters = {
    liqEvents: 0,
    ifFeeReversed: BN0.clone(),
    liquidatorFeeReversed: BN0.clone(),
  };

  const events = [
    ...allTrades,
    ...allFundings,
    ...allLiqs,
    ...allSettles,
    ...allSwaps,
  ];
  events.sort((a, b) => a.slot - b.slot || a.txsigindex - b.txsigindex);

  for (const ev of events) {
    if (ev.kind === "trade") {
      reverseTrade(ev, states, subToAuth, anomalies, audit, tradeCounters);
    } else if (ev.kind === "funding") {
      reverseFunding(ev, states, subToAuth, anomalies, audit);
    } else if (ev.kind === "liquidation") {
      reverseLiquidation(ev, states, subToAuth, anomalies, audit, liqCounters);
    } else if (ev.kind === "settlePnl") {
      reverseSettlePnl(ev, states, subToAuth, anomalies, audit);
    } else if (ev.kind === "swap") {
      reverseSwap(ev, states, subToAuth, anomalies, audit);
    }
  }

  // 6. Realign each open perp position's lastCumulativeFundingRate to the
  //    current market snapshot — same step as the bulk pipeline.
  const myState = states.get(flags.authority)!;
  for (const p of myState.perpByMarket.values()) {
    const m = perpMarkets[p.marketIndex];
    if (!m) continue;
    p.lastCumulativeFundingRate = p.baseAssetAmount.isNeg()
      ? strToBn(m.amm.cumulativeFundingRateShort)
      : strToBn(m.amm.cumulativeFundingRateLong);
  }

  // 7. Price both T0 and T1 at the same oracle CSV and diff.
  const t0Agg = exportT0FromState(myState);
  const spotPrices = loadOracleCloseByMarket(flags.oracleCsv, "spot");
  const perpPrices = loadOracleCloseByMarket(flags.oracleCsv, "perp");

  const valueOpts = {
    spotPricesByMarket: spotPrices,
    perpOracleByMarket: perpPrices,
    spotMarkets,
    perpMarkets,
    requirePerpOracleCsv: false,
  };

  const t0Priced = valueBorrowLendAggregate(t0Agg, {
    ...valueOpts,
    contextLabel: `t0 authority=${flags.authority}`,
  });
  const t1Priced = valueBorrowLendAggregate(t1Agg, {
    ...valueOpts,
    contextLabel: `t1 authority=${flags.authority}`,
  });
  const t0Total = sumBorrowLendQuote(t0Priced);
  const t1Total = sumBorrowLendQuote(t1Priced);
  const refund = t0Total.sub(t1Total);

  // 8. Warnings about per-authority scope vs bulk-pipeline parity.
  const hasLiquidationBankruptcy = allLiqs.some(
    (l) => l.perpBankruptcy || l.spotBankruptcy,
  );
  const ownReferrerRebates = allTrades.filter((t) =>
    t.referrerReward.gt(BN0),
  ).length;

  // 9. Emit audit CSV.
  const auditPath = path.join(flags.outDir, `${flags.authority}_audit.csv`);
  audit.writeCsv(auditPath);

  // 10. Summary.
  console.log("");
  console.log("=== refund ===");
  console.log(`authority         ${flags.authority}`);
  console.log(`subaccounts       ${subaccountPks.length}`);
  console.log(`events            ${events.length} total`);
  console.log(
    `                  trades=${allTrades.length} funding=${allFundings.length} liq=${allLiqs.length} settles=${allSettles.length} swaps=${allSwaps.length}`,
  );
  console.log(`t0_total          ${formatUsd(t0Total)}`);
  console.log(`t1_total          ${formatUsd(t1Total)}`);
  console.log(`refund_usd        ${formatUsd(refund)}`);
  if (refund.lt(BN0)) {
    console.log(
      "                  (negative — this user GAINED tokens during the window, owes clawback)",
    );
  } else if (refund.gt(BN0)) {
    console.log(
      "                  (positive — this user LOST tokens during the window, is owed refund)",
    );
  }
  console.log(`audit trail       ${auditPath}`);

  if (hasLiquidationBankruptcy) {
    console.log(
      "\nNOTE: at least one liquidation event in this window is a bankruptcy. " +
        "The per-authority script does NOT model bankruptcy socialization " +
        "(the small per-holder credit/debit applied across the bankrupted " +
        "market). For full parity use out/refunds.csv from run-recovery.sh.",
    );
  }
  if (ownReferrerRebates > 0) {
    console.log(
      `\nNOTE: ${ownReferrerRebates} fills in this user's txs paid a referrer reward. ` +
        "Those are captured. If this user was the REFERRER for trades on OTHER " +
        "users' txs (which the per-authority script does not fetch), that clawback " +
        "is missed. Use out/refunds.csv from run-recovery.sh for full referrer accounting.",
    );
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
