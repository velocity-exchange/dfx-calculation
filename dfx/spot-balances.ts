/**
 * Spot-market balance snapshot for DFX total-supply accounting.
 *
 * For each spot market this captures, from Drift's own books (not the raw token
 * vault), the value still recognized by the protocol:
 *
 *   net_deposits   = depositTokenAmount − borrowTokenAmount   (what depositors are net owed)
 *   revenue_pool   = getTokenAmount(revenuePool.scaledBalance) (accrued interest-rate spread)
 *   remaining      = net_deposits + revenue_pool               ← the figure revalue.ts values
 *
 * The raw on-chain vault balance is also recorded, along with the `unaccounted`
 * remainder (`vault − net_deposits − revenue_pool`). That unaccounted slice —
 * tokens sitting in the vault PDA that Drift's accounting doesn't track, e.g.
 * direct/recovery transfers — is **deliberately excluded** from `remaining`, so
 * the DFX supply counts only protocol-recognized depositor claims + revenue.
 *
 * Because `net_deposits` already reflects depositor liabilities even when a
 * vault was emptied administratively (the deposit balances persist), markets
 * like USDC-1 (vault reads 0, but ~472,842 USDC-1 still owed) are valued
 * correctly with no manual adjustment.
 *
 * Scam-token markets (63/64/65) are excluded entirely.
 *
 * Output: a CSV with one row per (non-scam) spot market. `revalue.ts` values the
 * `remainingBalance` column against the spot oracle CSV.
 *
 * Run:
 *   bun ./dfx/spot-balances.ts \
 *     --rpc-url <RPC_URL> \
 *     --output ./dfx/snapshots/spot-balances.csv
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "@coral-xyz/anchor";
import {
  BN,
  BulkAccountLoader,
  DriftClient,
  SpotBalanceType,
  type SpotMarketAccount,
  decodeName,
  getTokenAmount,
} from "@drift-labs/sdk";
import { Connection, Keypair } from "@solana/web3.js";

import { withRetry } from "../lib/rate-limit.ts";
import { parseTokenAccountAmount } from "../lib/token-account.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ZERO = new BN(0);

/** Spot markets flagged as scam tokens — excluded from the snapshot entirely. */
const SCAM_MARKET_INDEXES = new Set([63, 64, 65]);

const RETRY_OPTS = { retries: 8, baseDelayMs: 1_000, maxDelayMs: 60_000 };

type CliFlags = {
  rpcUrl: string;
  output: string;
};

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

function parseFlags(): CliFlags {
  const rpcUrl = getFlag("--rpc-url") ?? process.env.RPC_URL ?? "";
  if (!rpcUrl) {
    throw new Error("Missing --rpc-url (or RPC_URL env var)");
  }
  const output =
    getFlag("--output") ??
    path.resolve(__dirname, "snapshots", "spot-balances.csv");
  return { rpcUrl, output };
}

// ── token helpers (generic, kept local so this pipeline is self-contained) ─────

/** Format a raw token amount as a human-readable decimal string. */
function toUi(raw: BN, decimals: number): string {
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

function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const setupDriftClient = async (
  rpcUrl: string,
): Promise<{ connection: Connection; driftClient: DriftClient }> => {
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(Keypair.generate());
  const bulkAccountLoader = new BulkAccountLoader(
    // @ts-ignore — web3.js version skew between SDK and app, same as snapshot.ts
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

/**
 * Read the live token balance of each spot market's main deposit vault,
 * batching the reads through `getMultipleAccountsInfo` (chunks of 100) rather
 * than one RPC call per market. A missing/closed vault is treated as 0.
 */
async function readVaultBalances(
  connection: Connection,
  markets: SpotMarketAccount[],
): Promise<Map<number, BN>> {
  const chunkSize = 100;
  const balanceByMarket = new Map<number, BN>();
  for (let i = 0; i < markets.length; i += chunkSize) {
    const chunk = markets.slice(i, i + chunkSize);
    const infos = await withRetry(
      () =>
        connection.getMultipleAccountsInfo(
          chunk.map((m) => m.vault),
          { commitment: "confirmed" },
        ),
      RETRY_OPTS,
    );
    for (let j = 0; j < chunk.length; j++) {
      const info = infos[j];
      balanceByMarket.set(
        chunk[j].marketIndex,
        info?.data
          ? parseTokenAccountAmount(info, {
              address: chunk[j].vault,
              mint: chunk[j].mint,
            })
          : ZERO,
      );
    }
  }
  return balanceByMarket;
}

type SpotBalanceRow = {
  marketIndex: number;
  symbol: string;
  decimals: number;
  vault: string;
  /** Raw on-chain vault token balance (audit/reference only). */
  onchainBalance: BN;
  /** depositTokenAmount − borrowTokenAmount (what depositors are net owed). */
  netDeposits: BN;
  /** revenuePool token amount (accrued interest-rate spread). */
  revenuePool: BN;
  /** onchainBalance − netDeposits − revenuePool (excluded from `remaining`). */
  unaccounted: BN;
  /** netDeposits + revenuePool — the figure revalue.ts values into USD. */
  remainingBalance: BN;
};

const CSV_COLUMNS = [
  "marketIndex",
  "symbol",
  "decimals",
  "vault",
  "onchainBalance",
  "onchainBalanceUi",
  "netDeposits",
  "netDepositsUi",
  "revenuePool",
  "revenuePoolUi",
  "unaccounted",
  "unaccountedUi",
  "remainingBalance",
  "remainingBalanceUi",
] as const;

function rowToRecord(r: SpotBalanceRow): Record<string, string | number> {
  return {
    marketIndex: r.marketIndex,
    symbol: r.symbol,
    decimals: r.decimals,
    vault: r.vault,
    onchainBalance: r.onchainBalance.toString(10),
    onchainBalanceUi: toUi(r.onchainBalance, r.decimals),
    netDeposits: r.netDeposits.toString(10),
    netDepositsUi: toUi(r.netDeposits, r.decimals),
    revenuePool: r.revenuePool.toString(10),
    revenuePoolUi: toUi(r.revenuePool, r.decimals),
    unaccounted: r.unaccounted.toString(10),
    unaccountedUi: toUi(r.unaccounted, r.decimals),
    remainingBalance: r.remainingBalance.toString(10),
    remainingBalanceUi: toUi(r.remainingBalance, r.decimals),
  };
}

function writeCsv(output: string, rows: SpotBalanceRow[]): void {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    const record = rowToRecord(r);
    lines.push(
      CSV_COLUMNS.map((c) => csvEscape(String(record[c] ?? ""))).join(","),
    );
  }
  fs.writeFileSync(output, lines.join("\n") + "\n", "utf8");
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const { connection, driftClient } = await setupDriftClient(flags.rpcUrl);

  const allMarkets = driftClient
    .getSpotMarketAccounts()
    .sort((a, b) => a.marketIndex - b.marketIndex);

  const markets = allMarkets.filter(
    (m) => !SCAM_MARKET_INDEXES.has(m.marketIndex),
  );
  const excluded = allMarkets.length - markets.length;
  console.log(
    `Found ${allMarkets.length} spot markets; excluding ${excluded} scam market(s) ` +
      `(${[...SCAM_MARKET_INDEXES].sort((a, b) => a - b).join(", ")}).`,
  );

  console.log(`Reading vault balances for ${markets.length} spot market(s)...`);
  const balanceByMarket = await readVaultBalances(connection, markets);

  await driftClient.unsubscribe();

  const rows: SpotBalanceRow[] = markets.map((m) => {
    const deposits = getTokenAmount(
      m.depositBalance,
      m,
      SpotBalanceType.DEPOSIT,
    );
    const borrows = getTokenAmount(m.borrowBalance, m, SpotBalanceType.BORROW);
    const revenuePool = getTokenAmount(
      m.revenuePool.scaledBalance,
      m,
      SpotBalanceType.DEPOSIT,
    );
    const netDeposits = deposits.sub(borrows);
    const remainingBalance = netDeposits.add(revenuePool);
    const onchainBalance = balanceByMarket.get(m.marketIndex) ?? ZERO;

    return {
      marketIndex: m.marketIndex,
      symbol: decodeName(m.name).trim(),
      decimals: m.decimals,
      vault: m.vault.toBase58(),
      onchainBalance,
      netDeposits,
      revenuePool,
      unaccounted: onchainBalance.sub(netDeposits).sub(revenuePool),
      remainingBalance,
    };
  });

  writeCsv(flags.output, rows);
  console.log(
    `Wrote ${flags.output} — ${rows.length} spot market(s) ` +
      `(remaining = net_deposits + revenue_pool; unaccounted recorded but excluded).`,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
