/**
 * Snapshot phase: produce a price-independent JSON dump of all per-authority
 * borrow/lend state, vault discovery + share rows, and per-vault drift-user
 * position state. The exchange is paused, so this is a one-shot capture; later
 * runs of `revalue.ts` consume this snapshot with arbitrary oracle prices.
 *
 * Run:
 *   bun ./snapshot.ts \
 *     --rpc-url <RPC_URL> \
 *     --users-json ./users.json \
 *     --output ./out/base_snapshot.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "@coral-xyz/anchor";
import {
  BN,
  BulkAccountLoader,
  DriftClient,
  UserAccount,
  decodeUser,
} from "@drift-labs/sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { readUserAccountsJson } from "../lib/pipeline-json.ts";
import { withRetry, limitConcurrency, sleep } from "../lib/rate-limit.ts";
import {
  type DiscoveredVault,
  computeShareRows,
  discoverVaults,
  listDepositors,
} from "../lib/vault.ts";

import {
  aggregateUserPositions,
  mergeAggregate,
} from "../lib/aggregate-borrow-lend.ts";
import { extractPerpMarket } from "../lib/perp-snapshot.ts";
import {
  bnToStr,
  stableJsonStringify,
  type BorrowLendAggregateSnapshot,
  type PerpMarketSnapshot,
  type ShareRowSnapshot,
  type Snapshot,
  type SpotMarketSnapshot,
  type VaultSnapshot,
} from "../lib/snapshot-types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCALE_1E18 = new BN("1000000000000000000");
const BN0 = new BN(0);

const BLACKLISTED_AUTHORITIES: string[] = [
  // attacker's wallets
  "9sG4XYicGtMKe7nSFEkRuAMKJMVb3QPSqKvxBGpb1Rbn",
  "3apA2d235ZZpzNuwBbDh1tbmSmDDmKesRchzmXuvdera",
  "Gew3grkVGP5k2gJpyeEukbXkYHN9RwNyKohFA4XCHMmN",
  "55udxhScWQxM7cC9d1NPBQoEDC7B38w81EWKPZsM7ZCW",
  "EEaX5aVopMn2nnb4dgbmXi3RJH9URLLkpfKMyiWpbinb",
  // faris vault
  "7wRJqVeZJhBinwLbPbnFNBsCzbzWseZuWoAGWsbyS5i2",
  // faris vault depositors
  "Dj2zz5KJ1QczXg9D1SxvJyVMBC2LpybqV361MoYGFvQN",
  "61HH4P3TQ4sF4LaAUReHoRfJ2TRaJZTDaziqiZhJanqn",
  "D5pUcRBKHW6z32rohpU7KAxzpPpFptdFfnkLBBqy63fm",
  "kJpDz42i7WGazgHJ6V6ch3zavfYaxmRcBikF5GoMBw8",
];

type CliFlags = {
  rpcUrl: string;
  usersJson: string;
  output: string;
  chunkSize: number;
  concurrency: number;
  retries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  requestDelayMs: number;
  vaultDelayMs: number;
  pauseMs: number;
  chunksBeforePause: number;
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

function shareFractionScaledFromShares(
  sharesRaw: BN,
  totalSharesRaw: BN,
  isManager: boolean,
): BN {
  if (totalSharesRaw.isZero()) {
    // Residual vault value with no outstanding shares belongs to the manager.
    return isManager ? SCALE_1E18 : BN0;
  }
  return sharesRaw.mul(SCALE_1E18).div(totalSharesRaw);
}

const setupProcess = () => {
  const flags: CliFlags = {
    rpcUrl: getFlag("--rpc-url") ?? process.env.RPC_URL ?? "",
    usersJson: getFlag("--users-json") ?? path.resolve(__dirname, "users.json"),
    output:
      getFlag("--output") ??
      path.resolve(__dirname, "out", "base_snapshot.json"),
    chunkSize: getNumFlag("--chunk-size", 100),
    concurrency: getNumFlag("--concurrency", 1),
    retries: getNumFlag("--retries", 8),
    retryBaseDelayMs: getNumFlag("--retry-base-delay-ms", 1_000),
    retryMaxDelayMs: getNumFlag("--retry-max-delay-ms", 60_000),
    requestDelayMs: getNumFlag("--request-delay-ms", 0),
    vaultDelayMs: getNumFlag("--vault-delay-ms", 250),
    pauseMs: getNumFlag("--pause-ms", 10_000),
    chunksBeforePause: getNumFlag("--chunks-before-pause", 5),
  };

  if (!fs.existsSync(flags.usersJson)) {
    throw new Error(`Users JSON not found: ${flags.usersJson}`);
  }
  fs.mkdirSync(path.dirname(flags.output), { recursive: true });

  const { userAccountPubkeys } = readUserAccountsJson(flags.usersJson);
  console.log(
    `Loaded ${userAccountPubkeys.length} user accounts from ${flags.usersJson}`,
  );

  return {
    flags,
    userAccountPubkeys,
  };
};

const setupDriftClient = async (
  rpcUrl: string,
): Promise<{ connection: Connection; driftClient: DriftClient }> => {
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(Keypair.generate());
  const bulkAccountLoader = new BulkAccountLoader(
    // @ts-ignore
    connection,
    "confirmed",
    2000,
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
  console.log("DriftClient subscribed");

  return { connection, driftClient };
};

const snapshotMarkets = (
  driftClient: DriftClient,
): {
  spotMarkets: Record<number, SpotMarketSnapshot>;
  perpMarkets: Record<number, PerpMarketSnapshot>;
} => {
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

  console.log(
    `Snapshotted ${Object.keys(spotMarkets).length} spot markets, ${
      Object.keys(perpMarkets).length
    } perp markets`,
  );

  return { spotMarkets, perpMarkets };
};

/**
 * Aggregate borrow/lend state (read spot balances) by authority, across all its user accounts.
 */
const aggregateBorrowLendByAuthority = async (
  connection: Connection,
  driftClient: DriftClient,
  userAccountPubkeys: PublicKey[],
  flags: CliFlags,
  retryOpts: {
    retries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  },
  vaultAuthorities: Set<string>,
): Promise<Map<string, BorrowLendAggregateSnapshot>> => {
  const borrowLendByAuthority = new Map<string, BorrowLendAggregateSnapshot>();
  const vaultAuthorityUserCount = new Map<string, number>(); // for sanity check that each vault authority has only one drift user subaccount

  const userChunks: PublicKey[][] = [];
  for (let i = 0; i < userAccountPubkeys.length; i += flags.chunkSize) {
    userChunks.push(userAccountPubkeys.slice(i, i + flags.chunkSize));
  }
  const totalBatches = Math.ceil(userChunks.length / flags.chunksBeforePause);
  console.log(
    `Processing ${userAccountPubkeys.length} users in ${userChunks.length} chunks (${totalBatches} batches)`,
  );

  let usersProcessed = 0;
  for (
    let batchStart = 0;
    batchStart < userChunks.length;
    batchStart += flags.chunksBeforePause
  ) {
    const batchEnd = Math.min(
      batchStart + flags.chunksBeforePause,
      userChunks.length,
    );
    const batch = userChunks.slice(batchStart, batchEnd);

    const tasks = batch.map((chunk) => {
      return async () => {
        if (flags.requestDelayMs > 0) await sleep(flags.requestDelayMs);
        const infos = await withRetry(
          () =>
            connection.getMultipleAccountsInfo(chunk, {
              commitment: "confirmed",
            }),
          retryOpts,
        );

        for (let j = 0; j < chunk.length; j++) {
          const info = infos[j];
          if (!info?.data) continue;

          let user: UserAccount;
          try {
            user = decodeUser(Buffer.from(info.data));
          } catch {
            console.error(`Failed to decode user: ${chunk[j].toBase58()}`);
            continue;
          }

          const authority = user.authority.toBase58();

          if (vaultAuthorities.has(authority)) {
            vaultAuthorityUserCount.set(
              authority,
              (vaultAuthorityUserCount.get(authority) ?? 0) + 1,
            );
          }

          const userAgg = aggregateUserPositions(user, driftClient);
          const prev = borrowLendByAuthority.get(authority);
          borrowLendByAuthority.set(
            authority,
            prev ? mergeAggregate(prev, userAgg) : userAgg,
          );
        }
      };
    });

    await limitConcurrency(tasks, flags.concurrency);
    usersProcessed += batch.reduce((sum, chunk) => sum + chunk.length, 0);
    const batchNum = Math.floor(batchStart / flags.chunksBeforePause) + 1;
    console.log(
      `  Batch ${batchNum}/${totalBatches} done — ${usersProcessed}/${userAccountPubkeys.length} users (${borrowLendByAuthority.size} authorities)`,
    );
    if (batchEnd < userChunks.length && flags.pauseMs > 0) {
      await sleep(flags.pauseMs);
    }
  }
  console.log(
    `Borrow/lend aggregation complete: ${borrowLendByAuthority.size} authorities`,
  );

  // Sanity Check: vault authorities should not have more than 1 drift user subaccount.
  const badVaultAuthorities = [...vaultAuthorityUserCount.entries()].filter(
    ([, n]) => n > 1,
  );
  if (badVaultAuthorities.length > 0) {
    badVaultAuthorities.sort((a, b) => a[0].localeCompare(b[0]));
    const msg = badVaultAuthorities.map(([a, n]) => `${a}(${n})`).join(", ");
    throw new Error(`Vault authority subaccount sanity failed: ${msg}`);
  }

  return borrowLendByAuthority;
};

/**
 * Snapshot each vault and their depositors' shares.
 */
const processVaultSnapshots = async (
  connection: Connection,
  driftClient: DriftClient,
  vaults: DiscoveredVault[],
  flags: CliFlags,
  retryOpts: {
    retries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  },
) => {
  const vaultSnapshots: VaultSnapshot[] = [];
  console.log(`Processing ${vaults.length} vaults...`);

  for (let i = 0; i < vaults.length; i++) {
    const v = vaults[i];
    const vaultPk = new PublicKey(v.vault_pubkey);
    const driftUserPk = new PublicKey(v.user);

    console.log(`  Vault ${i + 1}/${vaults.length}: ${v.vault_pubkey}`);
    if (flags.requestDelayMs > 0) await sleep(flags.requestDelayMs);
    const vaultDepositors = await withRetry(
      () => listDepositors(connection, vaultPk),
      retryOpts,
    );

    const shareRows = computeShareRows({
      vaultTotalShares: v.totalShares,
      vaultUserShares: v.userShares,
      vaultManagerAuthority: v.manager,
      vaultManagerNetDeposits: v.managerNetDeposits,
      vaultDepositors,
    });

    const shareRowsSnap: ShareRowSnapshot[] = shareRows.map((r) => ({
      depositorAuthority: r.depositorAuthority,
      depositorAccount: r.depositorAccount,
      isManager: r.isManager,
      shareSource: r.shareSource,
      sharesRaw: bnToStr(r.sharesRaw),
      totalSharesRaw: bnToStr(r.totalSharesRaw),
      shareFractionScaled: bnToStr(
        shareFractionScaledFromShares(
          r.sharesRaw,
          r.totalSharesRaw,
          r.isManager,
        ),
      ),
      netDeposits: bnToStr(r.netDeposits),
      cumulativeProfitShareAmount: bnToStr(r.cumulativeProfitShareAmount),
      profitShareFeePaid: bnToStr(r.profitShareFeePaid),
    }));

    let vaultUserPositions: BorrowLendAggregateSnapshot | null = null;
    if (flags.requestDelayMs > 0) await sleep(flags.requestDelayMs);
    const info = await withRetry(
      () => connection.getAccountInfo(driftUserPk, { commitment: "confirmed" }),
      retryOpts,
    );
    if (info?.data) {
      try {
        const decoded = decodeUser(Buffer.from(info.data));
        vaultUserPositions = aggregateUserPositions(decoded, driftClient);
      } catch {
        vaultUserPositions = null;
      }
    }

    vaultSnapshots.push({
      vault_pubkey: v.vault_pubkey,
      manager: v.manager,
      user: v.user,
      totalShares: bnToStr(v.totalShares),
      userShares: bnToStr(v.userShares),
      spotMarketIndex: v.spotMarketIndex,
      managementFee: bnToStr(v.managementFee),
      profitShare: v.profitShare,
      hurdleRate: v.hurdleRate,
      lastFeeUpdateTs: v.lastFeeUpdateTs,
      sharesBase: v.sharesBase,
      managerNetDeposits: bnToStr(v.managerNetDeposits),
      shareRows: shareRowsSnap,
      vaultUserPositions,
    });

    if (flags.vaultDelayMs > 0) await sleep(flags.vaultDelayMs);
  }

  return vaultSnapshots;
};

const writeSnapshot = (
  flags: CliFlags,
  spotMarkets: Record<number, SpotMarketSnapshot>,
  perpMarkets: Record<number, PerpMarketSnapshot>,
  borrowLendByAuthorityMap: Map<string, BorrowLendAggregateSnapshot>,
  vaultSnapshots: VaultSnapshot[],
  vaultAuthorities: Set<string>,
) => {
  const snapshot: Snapshot = {
    snapshotTimestampUtc: new Date().toISOString(),
    rpcUrl: flags.rpcUrl,
    usersJsonPath: flags.usersJson,
    spotMarkets,
    perpMarkets,
    borrowLendByAuthority: Object.fromEntries(
      [...borrowLendByAuthorityMap.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
    vaults: vaultSnapshots.sort((a, b) =>
      a.vault_pubkey.localeCompare(b.vault_pubkey),
    ),
    vaultAuthorities: [...vaultAuthorities].sort(),
    blacklistedAuthorities: [...BLACKLISTED_AUTHORITIES].sort(),
  };

  fs.writeFileSync(flags.output, stableJsonStringify(snapshot, 0), "utf8");
  console.log(
    `Wrote ${flags.output} (${
      Object.keys(snapshot.borrowLendByAuthority).length
    } authorities, ${snapshot.vaults.length} vaults)`,
  );
};

async function main(): Promise<void> {
  const { flags, userAccountPubkeys } = setupProcess();
  const { connection, driftClient } = await setupDriftClient(flags.rpcUrl);

  const { spotMarkets, perpMarkets } = snapshotMarkets(driftClient);

  const retryOpts = {
    retries: flags.retries,
    baseDelayMs: flags.retryBaseDelayMs,
    maxDelayMs: flags.retryMaxDelayMs,
  };

  console.log("Discovering vaults...");
  const vaults = await withRetry(() => discoverVaults(connection), retryOpts);
  const vaultAuthorities = new Set(vaults.map((v) => v.vault_pubkey));
  console.log(`Found ${vaults.length} vaults`);

  const borrowLendByAuthorityMap = await aggregateBorrowLendByAuthority(
    connection,
    driftClient,
    userAccountPubkeys,
    flags,
    retryOpts,
    vaultAuthorities,
  );

  const vaultSnapshots = await processVaultSnapshots(
    connection,
    driftClient,
    vaults,
    flags,
    retryOpts,
  );

  await driftClient.unsubscribe();

  writeSnapshot(
    flags,
    spotMarkets,
    perpMarkets,
    borrowLendByAuthorityMap,
    vaultSnapshots,
    vaultAuthorities,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
