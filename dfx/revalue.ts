/**
 * Revalue phase: read a price-independent snapshot + two oracle CSVs (one for
 * spot prices, one for perp prices), and emit the same per-authority notional
 * CSV that authority-notional.ts produces.
 *
 * Run:
    bun ./revalue.ts \
      --snapshot ./out/base_snapshot.json \
      --spot-oracle-csv ./oracle-prices/pyth_oracle_prices-160600.csv \
      --perp-oracle-csv ./oracle-prices/pyth_oracle_prices-183100.csv \
      --output ./out/authority_notional.csv
 *
 * The same CSV path may be passed for both --spot-oracle-csv and --perp-oracle-csv.
 * USDC pricing always comes from the spot oracle set.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Decimal } from "decimal.js";
import { BN } from "@drift-labs/sdk";

import { loadOracleCloseByMarket } from "../lib/oracle-csv.ts";
import {
  stableJsonStringify,
  strToBn,
  VaultSnapshot,
  type Snapshot,
} from "../lib/snapshot-types.ts";
import {
  sumBorrowLendQuote,
  valueBorrowLendAggregate,
  type ValueOptions,
} from "../lib/value-from-snapshot.ts";
import { crystallizeVaultFees } from "../lib/vault-fees.ts";
import {
  loadSpotBalances,
  readAttackerWithdrawnQuote,
  usdToQuote,
  valueRemainingSpot,
  type RemainingSpotValue,
} from "../lib/dfx-supply.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BN0 = new BN(0);

/**
 * Protocol treasury wallet. The DFX supply that isn't attributable to any user
 * (total supply − users-owned shares) is attributed here as a borrow-lend
 * number — these are the "protocol-owned shares". See dfx/README.md.
 */
const PROTOCOL_AUTHORITY = "HVoDbY5fWufyposQrdpwsV6w8TkSEi2hS6AjAPz4HRDF";

/**
 * Fixed borrow-lend overrides for authorities whose value can't be derived from
 * the snapshot's spot positions and must be set by hand. Each override fully
 * REPLACES the authority's organic borrow-lend value (the synthetic value is
 * surfaced under `breakdownKey` so the breakdown still reconciles to the total).
 * Applied before the users-owned sum, so the supply accounting reflects them.
 *
 * - amdLor8dLQD2sTbedx8SgbKYbxWpCEtAW9iiZoz4kZX is a liquidator who liquidated
 *   the scam-token markets (62/63/64/65). Those markets are excluded everywhere
 *   else, so his position can't be priced from the snapshot; his backtracked
 *   amount is $646.69, assigned here directly.
 */
const BORROW_LEND_OVERRIDES: Record<
  string,
  { usd: string; breakdownKey: string; reason: string }
> = {
  amdLor8dLQD2sTbedx8SgbKYbxWpCEtAW9iiZoz4kZX: {
    usd: "646.69",
    breakdownKey: "liquidator_scam_token_backtrack",
    reason:
      "liquidator who liquidated the scam-token markets (62/63/64/65); backtracked amount = $646.69",
  },
};

const CSV_COLUMNS = [
  "authority",
  "total_notional",
  "borrow_lend_total",
  "borrow_lend_breakdown",
  "vaults_total",
  "vaults_breakdown",
] as const;

type CliFlags = {
  snapshot: string;
  spotOracleCsv: string;
  perpOracleCsv: string;
  output: string;
  requirePerpOracleCsv: boolean;
  attackerWithdrawals: string;
  spotBalances: string;
  protocolAuthority: string;
  supplySummaryOutput: string;
};

type BorrowLendOutput = {
  spotByMarketQuote: Map<number, BN>;
  usdcCrossQuote: BN;
  usdcIsolatedQuote: BN;
  unrealizedPnlQuote: BN;
  total: BN;
};

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

function getBoolFlag(name: string): boolean {
  return process.argv.includes(name);
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return `"${s}"`;
}

function quoteToUsdFixed6(q: BN): string {
  return new Decimal(q.toString(10)).div(new Decimal(1_000_000)).toFixed(6);
}

const setupProcess = (): { flags: CliFlags; snapshot: Snapshot } => {
  const flags: CliFlags = {
    snapshot:
      getFlag("--snapshot") ??
      path.resolve(__dirname, "out", "base_snapshot.json"),
    spotOracleCsv:
      getFlag("--spot-oracle-csv") ??
      (() => {
        throw new Error("Missing --spot-oracle-csv");
      })(),
    perpOracleCsv:
      getFlag("--perp-oracle-csv") ??
      (() => {
        throw new Error("Missing --perp-oracle-csv");
      })(),
    output:
      getFlag("--output") ??
      path.resolve(__dirname, "out", "authority_notional.csv"),
    requirePerpOracleCsv: getBoolFlag("--require-perp-oracle-csv"),
    attackerWithdrawals:
      getFlag("--attacker-withdrawals") ??
      path.resolve(__dirname, "snapshots", "attacker_withdrawals.json"),
    spotBalances:
      getFlag("--spot-balances") ??
      path.resolve(__dirname, "snapshots", "spot-balances.csv"),
    protocolAuthority: getFlag("--protocol-authority") ?? PROTOCOL_AUTHORITY,
    supplySummaryOutput:
      getFlag("--supply-summary-output") ??
      path.resolve(__dirname, "out", "dfx_supply_summary.json"),
  };

  if (!fs.existsSync(flags.snapshot)) {
    throw new Error(`Snapshot not found: ${flags.snapshot}`);
  }
  fs.mkdirSync(path.dirname(flags.output), { recursive: true });

  console.log(`Loading snapshot: ${flags.snapshot}`);
  const snapshot = JSON.parse(
    fs.readFileSync(flags.snapshot, "utf8"),
  ) as Snapshot;
  console.log(
    `  authorities=${
      Object.keys(snapshot.borrowLendByAuthority).length
    } vaults=${snapshot.vaults.length} spotMarkets=${
      Object.keys(snapshot.spotMarkets).length
    } perpMarkets=${Object.keys(snapshot.perpMarkets).length}`,
  );

  return { flags, snapshot };
};

const loadOracles = (
  flags: CliFlags,
  snapshot: Snapshot,
): Omit<ValueOptions, "contextLabel"> => {
  const spotPricesByMarket = loadOracleCloseByMarket(
    flags.spotOracleCsv,
    "spot",
  );
  const perpOracleByMarket = loadOracleCloseByMarket(
    flags.perpOracleCsv,
    "perp",
  );
  console.log(
    `Spot oracle CSV: ${flags.spotOracleCsv} (${spotPricesByMarket.size} markets)`,
  );
  console.log(
    `Perp oracle CSV: ${flags.perpOracleCsv} (${perpOracleByMarket.size} markets)`,
  );

  return {
    spotPricesByMarket,
    perpOracleByMarket,
    spotMarkets: snapshot.spotMarkets,
    perpMarkets: snapshot.perpMarkets,
    requirePerpOracleCsv: flags.requirePerpOracleCsv,
  };
};

const priceBorrowLendByAuthority = (
  borrowLendAuthoritySnapshots: Snapshot["borrowLendByAuthority"],
  valueOpts: Omit<ValueOptions, "contextLabel">,
): Map<string, BorrowLendOutput> => {
  const borrowLendByAuthority = new Map<string, BorrowLendOutput>();
  for (const [authority, agg] of Object.entries(borrowLendAuthoritySnapshots)) {
    const priced = valueBorrowLendAggregate(agg, {
      ...valueOpts,
      contextLabel: `authority=${authority}`,
    });
    borrowLendByAuthority.set(authority, {
      ...priced,
      total: sumBorrowLendQuote(priced),
    });
  }
  return borrowLendByAuthority;
};

const allocateVaultsByAuthority = (
  vaultSnapshots: VaultSnapshot[],
  valueOpts: Omit<ValueOptions, "contextLabel">,
  snapshotTsSec: number,
): Map<string, Map<string, BN>> => {
  const vaultsByAuthority = new Map<string, Map<string, BN>>();
  for (const v of vaultSnapshots) {
    if (!v.vaultUserPositions) continue;

    const priced = valueBorrowLendAggregate(v.vaultUserPositions, {
      ...valueOpts,
      contextLabel: `vault=${v.vault_pubkey}`,
    });
    const vaultEquityValueTotal = sumBorrowLendQuote(priced);
    if (vaultEquityValueTotal.eq(BN0)) continue;

    // Defensive override: when totalShares==0 (e.g. last depositor withdrew,
    // residual interest/PnL accrued), the snapshot writes
    // shareFractionScaled=0 for the derived manager row. Detect that case
    // and route the residual to the manager directly.
    const totalSharesRaw = strToBn(v.totalShares);
    if (totalSharesRaw.isZero()) {
      const managerAuth = v.manager;
      let byVault = vaultsByAuthority.get(managerAuth);
      if (!byVault) {
        byVault = new Map();
        vaultsByAuthority.set(managerAuth, byVault);
      }
      byVault.set(
        v.vault_pubkey,
        (byVault.get(v.vault_pubkey) ?? BN0).add(vaultEquityValueTotal),
      );
      continue;
    }

    const valueByAuth = crystallizeVaultFees({
      equityQuote: vaultEquityValueTotal,
      vaultSnap: v,
      snapshotTsSec,
      spotPriceByMarket: valueOpts.spotPricesByMarket,
      spotMarkets: valueOpts.spotMarkets,
      contextLabel: `vault=${v.vault_pubkey}`,
    });

    for (const [auth, value] of valueByAuth) {
      let byVault = vaultsByAuthority.get(auth);
      if (!byVault) {
        byVault = new Map();
        vaultsByAuthority.set(auth, byVault);
      }
      byVault.set(
        v.vault_pubkey,
        (byVault.get(v.vault_pubkey) ?? BN0).add(value),
      );
    }
  }
  return vaultsByAuthority;
};

/** One per-authority entry, before the protocol residual is injected. */
type AuthorityRow = {
  authority: string;
  /** Organic net value of the authority's own drift positions (quote BN). */
  borrowLendTotalQuote: BN;
  /** Value attributed via vault shares (quote BN). */
  vaultsTotalQuote: BN;
  bl?: BorrowLendOutput;
  vmap?: Map<string, BN>;
  /**
   * Protocol-owned residual attributed to this row (the protocol wallet only).
   * total DFX supply − users-owned shares; see attachProtocolResidual.
   */
  protocolResidualQuote?: BN;
  /**
   * Synthetic borrow-lend breakdown entries (USD strings) emitted instead of /
   * in addition to the organic `bl` breakdown — used by fixed overrides.
   */
  syntheticBreakdown?: Record<string, string>;
};

/**
 * Build the per-authority rows that make up the output CSV, applying the same
 * vault-authority / blacklist exclusions as before. Each row carries its
 * organic borrow-lend and vault totals; the protocol residual is layered on
 * afterwards in `attachProtocolResidual`.
 */
const buildAuthorityRows = (
  snapshot: Snapshot,
  borrowLendByAuthority: Map<string, BorrowLendOutput>,
  vaultsByAuthority: Map<string, Map<string, BN>>,
): {
  rows: AuthorityRow[];
  vaultAuthorityCount: number;
  blacklistedCount: number;
} => {
  const vaultAuthorities = new Set(snapshot.vaultAuthorities);
  const blacklistedAuthorities = new Set(snapshot.blacklistedAuthorities);

  const authorities = new Set<string>();
  for (const a of borrowLendByAuthority.keys()) authorities.add(a);
  for (const a of vaultsByAuthority.keys()) authorities.add(a);
  for (const va of vaultAuthorities) authorities.delete(va);
  for (const ba of blacklistedAuthorities) authorities.delete(ba);

  const rows = [...authorities].sort().map<AuthorityRow>((authority) => {
    const bl = borrowLendByAuthority.get(authority);
    const vmap = vaultsByAuthority.get(authority);
    const borrowLendTotalQuote = bl ? bl.total : BN0;
    const vaultsTotalQuote = vmap
      ? [...vmap.values()].reduce((acc, x) => acc.add(x), BN0)
      : BN0;
    return { authority, borrowLendTotalQuote, vaultsTotalQuote, bl, vmap };
  });

  applyBorrowLendOverrides(rows);

  return {
    rows,
    vaultAuthorityCount: vaultAuthorities.size,
    blacklistedCount: blacklistedAuthorities.size,
  };
};

/**
 * Replace the organic borrow-lend value of any authority in
 * `BORROW_LEND_OVERRIDES` with its fixed amount, creating a row if the
 * authority isn't otherwise present. Mutates `rows` in place; applied before
 * the users-owned sum so the override flows into the supply accounting.
 */
const applyBorrowLendOverrides = (rows: AuthorityRow[]): void => {
  for (const [authority, override] of Object.entries(BORROW_LEND_OVERRIDES)) {
    const quote = usdToQuote(override.usd);
    const row = findOrCreateRow(rows, authority);
    row.borrowLendTotalQuote = quote;
    row.bl = undefined; // organic breakdown no longer applies
    row.syntheticBreakdown = {
      ...(row.syntheticBreakdown ?? {}),
      [override.breakdownKey]: quoteToUsdFixed6(quote),
    };
  }
};

/** Find a row by authority, creating (and re-sorting) one if absent. */
const findOrCreateRow = (
  rows: AuthorityRow[],
  authority: string,
): AuthorityRow => {
  let row = rows.find((r) => r.authority === authority);
  if (!row) {
    row = { authority, borrowLendTotalQuote: BN0, vaultsTotalQuote: BN0 };
    rows.push(row);
    rows.sort((a, b) => a.authority.localeCompare(b.authority));
  }
  return row;
};

/** Sum of every row's organic notional — the "users-owned shares" total. */
const sumUsersOwnedQuote = (rows: AuthorityRow[]): BN =>
  rows.reduce(
    (acc, r) => acc.add(r.borrowLendTotalQuote).add(r.vaultsTotalQuote),
    BN0,
  );

type DfxSupply = {
  protocolAuthority: string;
  attackerWithdrawnQuote: BN;
  attackerWithdrawnUsd: string;
  remainingSpot: RemainingSpotValue;
  totalSupplyQuote: BN;
  usersOwnedQuote: BN;
  protocolOwnedQuote: BN;
};

/**
 * Compute the DFX total-supply accounting and attach the protocol-owned
 * residual to the protocol wallet's row (creating the row if the protocol
 * wallet has no organic positions). Returns null — leaving the CSV unchanged —
 * when either source file is absent, so plain revaluation still works.
 *
 *   total supply       = attackers_withdrawn + remaining_spot_balance   (by source)
 *   protocol-owned      = total supply − users-owned shares             (residual)
 *   total supply        = users-owned shares + protocol-owned shares    (by ownership)
 */
const attachProtocolResidual = (
  flags: CliFlags,
  rows: AuthorityRow[],
  valueOpts: Omit<ValueOptions, "contextLabel">,
): DfxSupply | null => {
  if (!fs.existsSync(flags.attackerWithdrawals)) {
    console.warn(
      `⚠ Skipping DFX supply accounting: attacker-withdrawals JSON not found ` +
        `(${flags.attackerWithdrawals}). Pass --attacker-withdrawals or generate it ` +
        `with dfx/attacker-withdrawals.ts.`,
    );
    return null;
  }
  if (!fs.existsSync(flags.spotBalances)) {
    console.warn(
      `⚠ Skipping DFX supply accounting: spot-balances CSV not found ` +
        `(${flags.spotBalances}). Pass --spot-balances or generate it with ` +
        `dfx/spot-balances.ts.`,
    );
    return null;
  }

  const { quote: attackerWithdrawnQuote, usd: attackerWithdrawnUsd } =
    readAttackerWithdrawnQuote(flags.attackerWithdrawals);
  const spotRows = loadSpotBalances(flags.spotBalances);
  const remainingSpot = valueRemainingSpot(spotRows, valueOpts.spotPricesByMarket);
  if (remainingSpot.missingPrice.length > 0) {
    console.warn(
      `⚠ No spot oracle price for remaining-balance market(s) ` +
        `[${remainingSpot.missingPrice.sort((a, b) => a - b).join(", ")}] — ` +
        `excluded from remaining_spot_balance.`,
    );
  }

  const totalSupplyQuote = attackerWithdrawnQuote.add(remainingSpot.totalQuote);
  const usersOwnedQuote = sumUsersOwnedQuote(rows);
  const protocolOwnedQuote = totalSupplyQuote.sub(usersOwnedQuote);

  if (protocolOwnedQuote.isNeg()) {
    console.warn(
      `⚠ Protocol-owned residual is NEGATIVE (${quoteToUsdFixed6(
        protocolOwnedQuote,
      )} USD): users-owned shares exceed total DFX supply. ` +
        `Verify the spot-balances / attacker-withdrawals inputs and the oracle CSV.`,
    );
  }

  // Attach the residual to the protocol wallet's row (create it if absent).
  const protocolRow = findOrCreateRow(rows, flags.protocolAuthority);
  protocolRow.protocolResidualQuote = protocolOwnedQuote;

  return {
    protocolAuthority: flags.protocolAuthority,
    attackerWithdrawnQuote,
    attackerWithdrawnUsd,
    remainingSpot,
    totalSupplyQuote,
    usersOwnedQuote,
    protocolOwnedQuote,
  };
};

const writeAuthorityNotionalCsv = (
  flags: CliFlags,
  rows: AuthorityRow[],
  vaultAuthorityCount: number,
  blacklistedCount: number,
) => {
  const outLines: string[] = [CSV_COLUMNS.map(csvEscape).join(",")];

  for (const r of rows) {
    const { authority, bl, vmap } = r;
    const residual = r.protocolResidualQuote ?? BN0;
    const hasResidual = !residual.isZero();

    const borrowLendTotalQuote = r.borrowLendTotalQuote.add(residual);
    const vaultsTotalQuote = r.vaultsTotalQuote;
    const totalQuote = borrowLendTotalQuote.add(vaultsTotalQuote);

    // Build the borrow-lend breakdown from the organic positions plus any
    // synthetic entries (fixed overrides, protocol residual) so the breakdown
    // always reconciles to borrow_lend_total.
    const breakdownObj: Record<string, unknown> = {};
    if (bl) {
      breakdownObj.spot = Object.fromEntries(
        [...bl.spotByMarketQuote.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([m, v]) => [String(m), quoteToUsdFixed6(v)]),
      );
      breakdownObj.usdc = {
        cross: quoteToUsdFixed6(bl.usdcCrossQuote),
        isolated: quoteToUsdFixed6(bl.usdcIsolatedQuote),
      };
      breakdownObj.unrealized_pnl = quoteToUsdFixed6(bl.unrealizedPnlQuote);
    }
    if (r.syntheticBreakdown) Object.assign(breakdownObj, r.syntheticBreakdown);
    if (hasResidual) {
      breakdownObj.dfx_protocol_residual = quoteToUsdFixed6(residual);
    }
    const borrowBreakdown =
      Object.keys(breakdownObj).length > 0
        ? stableJsonStringify(breakdownObj)
        : "";

    const vaultBreakdown = vmap
      ? stableJsonStringify(
          Object.fromEntries(
            [...vmap.entries()]
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([vaultPk, v]) => [vaultPk, quoteToUsdFixed6(v)]),
          ),
        )
      : "";

    const row = [
      authority,
      quoteToUsdFixed6(totalQuote),
      quoteToUsdFixed6(borrowLendTotalQuote),
      borrowBreakdown,
      quoteToUsdFixed6(vaultsTotalQuote),
      vaultBreakdown,
    ].map(csvEscape);

    outLines.push(row.join(","));
  }

  fs.writeFileSync(flags.output, outLines.join("\n") + "\n", "utf8");
  console.log(
    `Wrote ${flags.output} (${rows.length} authorities; excluded ${vaultAuthorityCount} vault authorities, ${blacklistedCount} blacklisted)`,
  );
};

const writeSupplySummary = (flags: CliFlags, supply: DfxSupply) => {
  const summary = {
    generatedAt: new Date().toISOString(),
    protocolAuthority: supply.protocolAuthority,
    totalDfxSupplyUsd: quoteToUsdFixed6(supply.totalSupplyQuote),
    bySource: {
      attackersWithdrawnUsd: quoteToUsdFixed6(supply.attackerWithdrawnQuote),
      remainingSpotBalanceUsd: quoteToUsdFixed6(supply.remainingSpot.totalQuote),
    },
    byOwnership: {
      usersOwnedUsd: quoteToUsdFixed6(supply.usersOwnedQuote),
      protocolOwnedUsd: quoteToUsdFixed6(supply.protocolOwnedQuote),
    },
    remainingSpotPerMarketUsd: Object.fromEntries(
      [...supply.remainingSpot.perMarketQuote.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([m, v]) => [String(m), quoteToUsdFixed6(v)]),
    ),
    missingSpotPriceMarkets: supply.remainingSpot.missingPrice.sort(
      (a, b) => a - b,
    ),
    inputs: {
      attackerWithdrawals: flags.attackerWithdrawals,
      spotBalances: flags.spotBalances,
    },
    note:
      "totalDfxSupplyUsd = attackersWithdrawnUsd + remainingSpotBalanceUsd " +
      "(by source) = usersOwnedUsd + protocolOwnedUsd (by ownership). " +
      "protocolOwnedUsd is the residual attributed to protocolAuthority as a " +
      "borrow-lend number in authority_notional.csv.",
  };

  fs.mkdirSync(path.dirname(flags.supplySummaryOutput), { recursive: true });
  fs.writeFileSync(
    flags.supplySummaryOutput,
    stableJsonStringify(summary, 2) + "\n",
    "utf8",
  );

  console.log(
    `\nDFX total supply: ${summary.totalDfxSupplyUsd} USD\n` +
      `  by source:    attackers_withdrawn ${summary.bySource.attackersWithdrawnUsd} + remaining_spot ${summary.bySource.remainingSpotBalanceUsd}\n` +
      `  by ownership: users_owned ${summary.byOwnership.usersOwnedUsd} + protocol_owned ${summary.byOwnership.protocolOwnedUsd}\n` +
      `  protocol_owned attributed to ${supply.protocolAuthority}\n` +
      `Wrote ${flags.supplySummaryOutput}`,
  );
};

async function main(): Promise<void> {
  const { flags, snapshot } = setupProcess();

  const valueOpts = loadOracles(flags, snapshot);

  const borrowLendByAuthority = priceBorrowLendByAuthority(
    snapshot.borrowLendByAuthority,
    valueOpts,
  );

  const snapshotTsSec = Math.floor(
    new Date(snapshot.snapshotTimestampUtc).getTime() / 1000,
  );
  // Sanity: snapshot must carry fee fields used by crystallizeVaultFees.
  const sample = snapshot.vaults[0];
  if (
    sample &&
    (sample.managementFee === undefined ||
      sample.lastFeeUpdateTs === undefined ||
      sample.profitShare === undefined)
  ) {
    throw new Error(
      `Snapshot is missing vault fee fields (managementFee, profitShare, lastFeeUpdateTs).\n` +
        `  Regenerate with the current snapshot.ts — older snapshots predate fee crystallization support.`,
    );
  }
  const vaultsByAuthority = allocateVaultsByAuthority(
    snapshot.vaults,
    valueOpts,
    snapshotTsSec,
  );

  const { rows, vaultAuthorityCount, blacklistedCount } = buildAuthorityRows(
    snapshot,
    borrowLendByAuthority,
    vaultsByAuthority,
  );

  // DFX supply accounting: total = attackers_withdrawn + remaining_spot, with
  // the protocol-owned residual (total − users-owned) attached to the protocol
  // wallet. No-op (returns null) when the source files are absent.
  const supply = attachProtocolResidual(flags, rows, valueOpts);

  writeAuthorityNotionalCsv(flags, rows, vaultAuthorityCount, blacklistedCount);

  if (supply) writeSupplySummary(flags, supply);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
