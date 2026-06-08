/**
 * Insurance-fund snapshot: capture, per spot market, the live IF vault token
 * balance and every staker's position, then value each stake into the token
 * amount it would currently redeem for.
 *
 * Output JSON is keyed by staker authority. Each authority maps to an array of
 * IF deposits (one per spot market they staked in), where each deposit carries
 * both the user's shares and the token amount those shares are worth. A CSV is
 * also written per spot market ({marketIndex}_{symbol}.csv) with the authority
 * and the same per-deposit attributes.
 *
 * Run:
 *   bun ./insurance-fund/snapshot.ts \
 *     --rpc-url <RPC_URL> \
 *     --output ./insurance-fund/out/if_snapshot.json
 *
 * Optional:
 *   --market-index <n>   Restrict to a single spot market (default: all).
 *   --config <path>      Vault-balance override config. Defaults to
 *                        ./insurance-fund/vault-balances.config.json if present.
 *                        Use this for vaults whose tokens were moved off-chain
 *                        (on-chain balance reads 0) so stakes can still be valued.
 *   --csv-dir <path>     Where per-market CSVs are written. Defaults to a `csv/`
 *                        subdirectory next to the JSON output.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "@coral-xyz/anchor";
import { BN, BulkAccountLoader, DriftClient } from "@drift-labs/sdk";
import { Connection, Keypair } from "@solana/web3.js";

import { withRetry } from "../lib/rate-limit.ts";
import {
  type IfConfig,
  type IfDeposit,
  type IfMarketState,
  applyBalanceOverride,
  fetchAllIfStakes,
  readIfMarketStates,
  toUi,
  valueProtocolStake,
  valueStake,
} from "./lib/insurance-fund.ts";
import { PROTOCOL_AUTHORITY } from "../lib/protocol-authority.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG_PATH = path.resolve(
  __dirname,
  "vault-balances.config.json",
);

type CliFlags = {
  rpcUrl: string;
  output: string;
  marketIndex: number | null;
  configPath: string | null;
  csvDir: string;
};

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

const RETRY_OPTS = { retries: 8, baseDelayMs: 1_000, maxDelayMs: 60_000 };

function parseFlags(): CliFlags {
  const rpcUrl = getFlag("--rpc-url") ?? process.env.RPC_URL ?? "";
  if (!rpcUrl) {
    throw new Error("Missing --rpc-url (or RPC_URL env var)");
  }
  const miFlag = getFlag("--market-index");
  // Use --config if given; otherwise the default config file if it exists.
  const explicitConfig = getFlag("--config");
  const configPath =
    explicitConfig ??
    (fs.existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : null);
  const output =
    getFlag("--output") ?? path.resolve(__dirname, "out", "if_snapshot.json");
  return {
    rpcUrl,
    output,
    marketIndex: miFlag !== undefined ? Number(miFlag) : null,
    configPath,
    // Per-market CSVs land beside the JSON in a `csv/` subdir by default.
    csvDir: getFlag("--csv-dir") ?? path.resolve(path.dirname(output), "csv"),
  };
}

function loadConfig(configPath: string | null): IfConfig | null {
  if (!configPath) return null;
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const overrides = parsed?.marketOverrides;
  if (!overrides || typeof overrides !== "object") {
    throw new Error(
      `Invalid config ${configPath}: expected a "marketOverrides" object`,
    );
  }
  for (const [mi, o] of Object.entries(overrides) as [string, any][]) {
    if (!Number.isInteger(Number(mi))) {
      throw new Error(`Invalid config: market key "${mi}" is not an integer`);
    }
    if (
      (o?.vaultBalance === undefined || o.vaultBalance === "") &&
      (o?.vaultBalanceUi === undefined || o.vaultBalanceUi === "")
    ) {
      throw new Error(
        `Invalid config: market ${mi} override needs "vaultBalance" or "vaultBalanceUi"`,
      );
    }
    if (o?.decimals !== undefined && !Number.isInteger(o.decimals)) {
      throw new Error(
        `Invalid config: market ${mi} "decimals" must be an integer`,
      );
    }
  }
  return { marketOverrides: overrides };
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

// ── JSON-serializable output shapes ─────────────────────────────────────────

type IfMarketSnapshot = {
  marketIndex: number;
  symbol: string;
  decimals: number;
  vault: string;
  /** Balance used to value stakes (override when present, else on-chain). */
  vaultBalance: string;
  vaultBalanceUi: string;
  /** "onchain" or "config" — where `vaultBalance` came from. */
  vaultBalanceSource: "onchain" | "config";
  /** Raw on-chain balance, always recorded even when overridden. */
  onchainVaultBalance: string;
  onchainVaultBalanceUi: string;
  /** Operator note from the config override, if any. */
  balanceOverrideReason?: string;
  totalIfShares: string;
  userIfShares: string;
  sharesBase: string;
  /** Number of staker deposits (with non-zero shares) in this market. */
  depositorCount: number;
};

type IfDepositSnapshot = {
  marketIndex: number;
  stakePubkey: string;
  ifShares: string;
  ifBase: string;
  effectiveShares: string;
  tokenAmount: string;
  tokenAmountUi: string;
  costBasis: string;
  lastWithdrawRequestShares: string;
  lastWithdrawRequestValue: string;
  lastWithdrawRequestTs: string;
};

type IfSnapshot = {
  snapshotTimestampUtc: string;
  rpcUrl: string;
  marketIndexFilter: number | null;
  /** Path of the vault-balance override config used (null if none). */
  configPath: string | null;
  markets: Record<number, IfMarketSnapshot>;
  byAuthority: Record<string, IfDepositSnapshot[]>;
};

function depositToSnapshot(d: IfDeposit, decimals: number): IfDepositSnapshot {
  return {
    marketIndex: d.marketIndex,
    stakePubkey: d.stakePubkey,
    ifShares: d.ifSharesRaw.toString(10),
    ifBase: d.ifBase.toString(10),
    effectiveShares: d.effectiveShares.toString(10),
    tokenAmount: d.tokenAmount.toString(10),
    tokenAmountUi: toUi(d.tokenAmount, decimals),
    costBasis: d.costBasis.toString(10),
    lastWithdrawRequestShares: d.lastWithdrawRequestShares.toString(10),
    lastWithdrawRequestValue: d.lastWithdrawRequestValue.toString(10),
    lastWithdrawRequestTs: d.lastWithdrawRequestTs.toString(10),
  };
}

// ── CSV output ───────────────────────────────────────────────────────────────

/** Columns for the per-market CSVs: authority first, then the deposit fields. */
const CSV_COLUMNS = [
  "authority",
  "marketIndex",
  "stakePubkey",
  "ifShares",
  "ifBase",
  "effectiveShares",
  "tokenAmount",
  "tokenAmountUi",
  "costBasis",
  "lastWithdrawRequestShares",
  "lastWithdrawRequestValue",
  "lastWithdrawRequestTs",
] as const;

type CsvRow = { authority: string; deposit: IfDepositSnapshot };

export function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Sanitize a market symbol for use in a filename (e.g. "USDC", "wBTC"). */
export function safeSymbol(symbol: string): string {
  const cleaned = symbol
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "UNKNOWN";
}

/**
 * Write one CSV per spot market named `{marketIndex}_{symbol}.csv`, with the
 * authority plus the same attributes carried in the JSON deposits. Rows are
 * sorted by token amount (desc) then authority for stable, useful ordering.
 */
export function writeMarketCsvs(
  csvDir: string,
  markets: IfMarketSnapshot[],
  rowsByMarket: Map<number, CsvRow[]>,
): void {
  fs.mkdirSync(csvDir, { recursive: true });
  for (const market of markets) {
    const rows = (rowsByMarket.get(market.marketIndex) ?? []).slice();
    rows.sort((a, b) => {
      const av = BigInt(a.deposit.tokenAmount);
      const bv = BigInt(b.deposit.tokenAmount);
      if (av !== bv) return av < bv ? 1 : -1; // desc
      return a.authority.localeCompare(b.authority);
    });

    const lines = [CSV_COLUMNS.join(",")];
    for (const { authority, deposit } of rows) {
      const record: Record<string, string | number> = { authority, ...deposit };
      lines.push(
        CSV_COLUMNS.map((c) => csvEscape(String(record[c] ?? ""))).join(","),
      );
    }

    const file = path.join(
      csvDir,
      `${market.marketIndex}_${safeSymbol(market.symbol)}.csv`,
    );
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  }
}

async function main(): Promise<void> {
  const flags = parseFlags();
  fs.mkdirSync(path.dirname(flags.output), { recursive: true });

  const config = loadConfig(flags.configPath);
  if (config) {
    console.log(
      `Loaded vault-balance config (${
        Object.keys(config.marketOverrides).length
      } override(s)): ${flags.configPath}`,
    );
  }

  const { connection, driftClient } = await setupDriftClient(flags.rpcUrl);

  // 1. Read live IF state per spot market (vault balance + share totals).
  const spotMarkets = driftClient
    .getSpotMarketAccounts()
    .filter(
      (m) => flags.marketIndex === null || m.marketIndex === flags.marketIndex,
    )
    .sort((a, b) => a.marketIndex - b.marketIndex);

  if (spotMarkets.length === 0) {
    throw new Error(
      `No spot markets matched (market-index filter: ${flags.marketIndex}).`,
    );
  }

  console.log(`Reading IF state for ${spotMarkets.length} spot market(s)...`);
  // Batch the IF-vault balance reads via getMultipleAccountsInfo (chunked).
  const onchainStates = await readIfMarketStates(connection, spotMarkets, {
    retry: RETRY_OPTS,
    chunkSize: 100,
  });

  const marketStates = new Map<number, IfMarketState>();
  for (const onchainState of onchainStates) {
    const mi = onchainState.marketIndex;
    const state = applyBalanceOverride(onchainState, config);
    marketStates.set(mi, state);

    if (state.vaultBalanceSource === "config") {
      const cfgDecimals = config?.marketOverrides?.[String(mi)]?.decimals;
      if (cfgDecimals !== undefined && cfgDecimals !== onchainState.decimals) {
        console.warn(
          `  ⚠ market ${mi}: config decimals (${cfgDecimals}) ` +
            `differ from on-chain decimals (${onchainState.decimals}). ` +
            `Using ${cfgDecimals} for display — verify your raw amount matches.`,
        );
      }
      console.log(
        `  market ${mi} (${state.symbol}): OVERRIDE ${toUi(
          state.vaultBalance,
          state.decimals,
        )} ` +
          `(${state.vaultBalance.toString()} raw, on-chain ${toUi(
            state.onchainVaultBalance,
            onchainState.decimals,
          )})` +
          (state.balanceOverrideReason
            ? ` — ${state.balanceOverrideReason}`
            : ""),
      );
    } else if (
      state.onchainVaultBalance.isZero() &&
      state.totalIfShares.isZero()
    ) {
      // Quiet: market with no insurance fund activity.
    } else {
      console.log(
        `  market ${mi} (${state.symbol}): vault ${toUi(
          state.vaultBalance,
          state.decimals,
        )} ` +
          `(${state.vaultBalance.toString()} raw), totalShares ${state.totalIfShares.toString()}`,
      );
      if (state.onchainVaultBalance.isZero() && !state.totalIfShares.isZero()) {
        console.warn(
          `  ⚠ market ${mi}: on-chain balance is 0 but ${state.totalIfShares.toString()} shares exist — ` +
            `add an override in the config if tokens were moved off-chain.`,
        );
      }
    }
  }

  // 2. Scan every InsuranceFundStake account on the program.
  console.log("Fetching all insurance-fund stake accounts...");
  const allStakes = await withRetry(
    () => fetchAllIfStakes(driftClient),
    RETRY_OPTS,
  );
  console.log(`Found ${allStakes.length} IF stake accounts`);

  // 3. Value each stake and group by authority (and by market, for CSVs).
  const byAuthority: Record<string, IfDepositSnapshot[]> = {};
  const depositorCountByMarket = new Map<number, number>();
  const rowsByMarket = new Map<number, CsvRow[]>();

  for (const { pubkey, stake } of allStakes) {
    const state = marketStates.get(stake.marketIndex);
    if (!state) continue; // filtered-out market

    const deposit = valueStake(stake, pubkey, state);
    if (!deposit) continue; // zero-share / closed stake

    const authority = stake.authority.toBase58();
    const depositSnap = depositToSnapshot(deposit, state.decimals);

    const list = byAuthority[authority] ?? (byAuthority[authority] = []);
    list.push(depositSnap);

    const marketRows =
      rowsByMarket.get(stake.marketIndex) ??
      rowsByMarket.set(stake.marketIndex, []).get(stake.marketIndex)!;
    marketRows.push({ authority, deposit: depositSnap });

    depositorCountByMarket.set(
      stake.marketIndex,
      (depositorCountByMarket.get(stake.marketIndex) ?? 0) + 1,
    );
  }

  // 3b. Attribute each market's protocol-owned IF slice (totalShares − userShares)
  // to PROTOCOL_AUTHORITY as a synthetic deposit, mirroring the protocol-residual
  // pattern in dfx/revalue.ts. Not counted in depositorCount (not a real staker).
  for (const state of marketStates.values()) {
    const protocolDeposit = valueProtocolStake(state);
    if (!protocolDeposit) continue;

    const depositSnap = depositToSnapshot(protocolDeposit, state.decimals);

    const list =
      byAuthority[PROTOCOL_AUTHORITY] ?? (byAuthority[PROTOCOL_AUTHORITY] = []);
    list.push(depositSnap);

    const marketRows =
      rowsByMarket.get(state.marketIndex) ??
      rowsByMarket.set(state.marketIndex, []).get(state.marketIndex)!;
    marketRows.push({ authority: PROTOCOL_AUTHORITY, deposit: depositSnap });
  }

  // Stable ordering: sort each authority's deposits by market index.
  for (const list of Object.values(byAuthority)) {
    list.sort((a, b) => a.marketIndex - b.marketIndex);
  }

  await driftClient.unsubscribe();

  // 4. Assemble + write output.
  const markets: Record<number, IfMarketSnapshot> = {};
  for (const [mi, state] of marketStates) {
    markets[mi] = {
      marketIndex: state.marketIndex,
      symbol: state.symbol,
      decimals: state.decimals,
      vault: state.vault,
      vaultBalance: state.vaultBalance.toString(10),
      vaultBalanceUi: toUi(state.vaultBalance, state.decimals),
      vaultBalanceSource: state.vaultBalanceSource,
      onchainVaultBalance: state.onchainVaultBalance.toString(10),
      onchainVaultBalanceUi: toUi(state.onchainVaultBalance, state.decimals),
      ...(state.balanceOverrideReason
        ? { balanceOverrideReason: state.balanceOverrideReason }
        : {}),
      totalIfShares: state.totalIfShares.toString(10),
      userIfShares: state.userIfShares.toString(10),
      sharesBase: state.sharesBase.toString(10),
      depositorCount: depositorCountByMarket.get(mi) ?? 0,
    };
  }

  const sortedByAuthority: Record<string, IfDepositSnapshot[]> = {};
  for (const k of Object.keys(byAuthority).sort()) {
    sortedByAuthority[k] = byAuthority[k];
  }

  const snapshot: IfSnapshot = {
    snapshotTimestampUtc: new Date().toISOString(),
    rpcUrl: flags.rpcUrl,
    marketIndexFilter: flags.marketIndex,
    configPath: flags.configPath,
    markets,
    byAuthority: sortedByAuthority,
  };

  fs.writeFileSync(flags.output, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(
    `Wrote ${flags.output} — ${
      Object.keys(sortedByAuthority).length
    } authorities, ` + `${Object.keys(markets).length} market(s)`,
  );

  // 5. Write one CSV per spot market: {marketIndex}_{symbol}.csv
  const marketList = Object.values(markets).sort(
    (a, b) => a.marketIndex - b.marketIndex,
  );
  writeMarketCsvs(flags.csvDir, marketList, rowsByMarket);
  const withRows = marketList.filter(
    (m) => (rowsByMarket.get(m.marketIndex)?.length ?? 0) > 0,
  ).length;
  console.log(
    `Wrote ${marketList.length} per-market CSV(s) to ${flags.csvDir} ` +
      `(${withRows} with depositors)`,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
