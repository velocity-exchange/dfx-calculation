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

import { loadOracleCloseByMarket } from "./lib/oracle-csv.ts";
import {
  stableJsonStringify,
  strToBn,
  VaultSnapshot,
  type Snapshot,
} from "./lib/snapshot-types.ts";
import {
  sumBorrowLendQuote,
  valueBorrowLendAggregate,
  type ValueOptions,
} from "./lib/value-from-snapshot.ts";
import { crystallizeVaultFees } from "./lib/vault-fees.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BN0 = new BN(0);

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

const writeAuthorityNotionalCsv = (
  flags: CliFlags,
  snapshot: Snapshot,
  borrowLendByAuthority: Map<string, BorrowLendOutput>,
  vaultsByAuthority: Map<string, Map<string, BN>>,
) => {
  const vaultAuthorities = new Set(snapshot.vaultAuthorities);
  const blacklistedAuthorities = new Set(snapshot.blacklistedAuthorities);

  const authorities = new Set<string>();
  for (const a of borrowLendByAuthority.keys()) authorities.add(a);
  for (const a of vaultsByAuthority.keys()) authorities.add(a);
  for (const va of vaultAuthorities) authorities.delete(va);
  for (const ba of blacklistedAuthorities) authorities.delete(ba);

  const authorityList = [...authorities].sort();
  const outLines: string[] = [CSV_COLUMNS.map(csvEscape).join(",")];

  for (const authority of authorityList) {
    const bl = borrowLendByAuthority.get(authority);
    const vmap = vaultsByAuthority.get(authority);

    const borrowLendTotalQuote = bl ? bl.total : BN0;
    const vaultsTotalQuote = vmap
      ? [...vmap.values()].reduce((acc, x) => acc.add(x), BN0)
      : BN0;
    const totalQuote = borrowLendTotalQuote.add(vaultsTotalQuote);

    const borrowBreakdown = bl
      ? stableJsonStringify({
          spot: Object.fromEntries(
            [...bl.spotByMarketQuote.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([m, v]) => [String(m), quoteToUsdFixed6(v)]),
          ),
          usdc: {
            cross: quoteToUsdFixed6(bl.usdcCrossQuote),
            isolated: quoteToUsdFixed6(bl.usdcIsolatedQuote),
          },
          unrealized_pnl: quoteToUsdFixed6(bl.unrealizedPnlQuote),
        })
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
    `Wrote ${flags.output} (${authorityList.length} authorities; excluded ${vaultAuthorities.size} vault authorities, ${blacklistedAuthorities.size} blacklisted)`,
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

  writeAuthorityNotionalCsv(
    flags,
    snapshot,
    borrowLendByAuthority,
    vaultsByAuthority,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
