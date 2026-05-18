/**
 * Augment users.json + base_snapshot.json with sub-accounts that were missing
 * from the initial pipeline (resolved via resolve-missing-subaccounts.ts).
 *
 * For each row in out/missing_subaccounts_resolved.csv with status="ok":
 *   1. Add sub_account_pubkey → authority into users.json's `accounts` map.
 *   2. Fetch the sub-account from chain, aggregate via the same code path
 *      snapshot.ts uses, merge into base_snapshot.json's
 *      `borrowLendByAuthority` (combining with any pre-existing entry under
 *      the same authority).
 *
 * Writes back in place to users.json and base_snapshot.json (creates .bak
 * copies first).
 *
 * Run:
 *   bun ./augment-snapshot.ts --rpc-url <RPC_URL>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "@coral-xyz/anchor";
import {
  BulkAccountLoader,
  DriftClient,
  decodeUser,
  type UserAccount,
} from "@drift-labs/sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import {
  aggregateUserPositions,
  mergeAggregate,
} from "./lib/aggregate-borrow-lend.ts";
import {
  sortAccountsRecord,
  type UserAccountsPayload,
} from "./lib/pipeline-json.ts";
import {
  stableJsonStringify,
  type Snapshot,
} from "./lib/snapshot-types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

const rpcUrl = getFlag("--rpc-url") ?? process.env.RPC_URL ?? "";
if (!rpcUrl) {
  console.error("ERROR: pass --rpc-url <URL> or set RPC_URL env var.");
  process.exit(1);
}

const resolvedCsv =
  getFlag("--resolved-csv") ??
  path.resolve(__dirname, "out", "missing_subaccounts_resolved.csv");
const usersJsonPath =
  getFlag("--users-json") ?? path.resolve(__dirname, "users.json");
const snapshotPath =
  getFlag("--snapshot") ??
  path.resolve(__dirname, "out", "base_snapshot.json");

// --- read resolved CSV
type ResolvedRow = {
  pubkey: string;
  authority: string;
  status: string;
};
function readResolvedCsv(filePath: string): ResolvedRow[] {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  const header = lines[0].split(",");
  const idx = {
    pubkey: header.indexOf("pubkey"),
    authority: header.indexOf("authority"),
    status: header.indexOf("status"),
  };
  const rows: ResolvedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    rows.push({
      pubkey: cols[idx.pubkey],
      authority: cols[idx.authority],
      status: cols[idx.status],
    });
  }
  return rows;
}

const resolved = readResolvedCsv(resolvedCsv).filter((r) => r.status === "ok");
console.log(`Loaded ${resolved.length} ok rows from ${resolvedCsv}`);

// --- update users.json
console.log(`Updating ${usersJsonPath}`);
const usersDoc = JSON.parse(
  fs.readFileSync(usersJsonPath, "utf8"),
) as UserAccountsPayload;
fs.copyFileSync(usersJsonPath, `${usersJsonPath}.bak`);
let added = 0;
let overwritten = 0;
for (const r of resolved) {
  const prev = usersDoc.accounts[r.pubkey];
  if (!prev) {
    added += 1;
  } else if (prev !== r.authority) {
    overwritten += 1;
    console.warn(
      `  overwriting users.json ${r.pubkey}: ${prev} → ${r.authority}`,
    );
  }
  usersDoc.accounts[r.pubkey] = r.authority;
}
usersDoc.accounts = sortAccountsRecord(usersDoc.accounts);
usersDoc.generatedAt = new Date().toISOString();
fs.writeFileSync(usersJsonPath, JSON.stringify(usersDoc, null, "\t") + "\n");
console.log(
  `  users.json: added ${added} new mappings, overwrote ${overwritten} (.bak saved)`,
);

// --- spin up Drift client
console.log("Subscribing DriftClient...");
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
console.log("  ready");

// --- fetch and decode sub-accounts
const pubkeys = resolved.map((r) => new PublicKey(r.pubkey));
console.log(`Fetching ${pubkeys.length} sub-accounts...`);
const infos = await connection.getMultipleAccountsInfo(pubkeys, {
  commitment: "confirmed",
});

// --- aggregate per authority
import type { BorrowLendAggregateSnapshot } from "./lib/snapshot-types.ts";

const newByAuthority = new Map<string, BorrowLendAggregateSnapshot>();
const decodeFailures: string[] = [];
const notFound: string[] = [];

for (let i = 0; i < resolved.length; i++) {
  const row = resolved[i];
  const info = infos[i];
  if (!info) {
    notFound.push(row.pubkey);
    continue;
  }
  let user: UserAccount;
  try {
    // @ts-ignore
    user = decodeUser(Buffer.from(info.data));
  } catch (e) {
    decodeFailures.push(`${row.pubkey}: ${(e as Error).message}`);
    continue;
  }
  const auth = user.authority.toBase58();
  if (auth !== row.authority) {
    console.warn(
      `  ${row.pubkey} authority mismatch: csv=${row.authority} chain=${auth} — using chain value`,
    );
  }
  const agg = aggregateUserPositions(user, driftClient);
  const existing = newByAuthority.get(auth);
  newByAuthority.set(auth, existing ? mergeAggregate(existing, agg) : agg);
}

console.log(
  `  ${newByAuthority.size} unique authorities; failures: not_found=${notFound.length} decode=${decodeFailures.length}`,
);
if (notFound.length > 0) console.log("  not_found:", notFound);
if (decodeFailures.length > 0) console.log("  decode_failures:", decodeFailures);

await driftClient.unsubscribe();

// --- merge into snapshot
console.log(`Merging into ${snapshotPath}`);
const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as Snapshot;
fs.copyFileSync(snapshotPath, `${snapshotPath}.bak`);

let mergedExisting = 0;
let mergedNew = 0;
for (const [auth, agg] of newByAuthority) {
  const prior = snap.borrowLendByAuthority[auth];
  if (prior) {
    snap.borrowLendByAuthority[auth] = mergeAggregate(prior, agg);
    mergedExisting += 1;
  } else {
    snap.borrowLendByAuthority[auth] = agg;
    mergedNew += 1;
  }
}

// re-sort for stable ordering
const sortedKeys = Object.keys(snap.borrowLendByAuthority).sort();
const sortedAuths: typeof snap.borrowLendByAuthority = {};
for (const k of sortedKeys) sortedAuths[k] = snap.borrowLendByAuthority[k];
snap.borrowLendByAuthority = sortedAuths;
snap.snapshotTimestampUtc = new Date().toISOString();

fs.writeFileSync(snapshotPath, stableJsonStringify(snap, 0));
console.log(
  `  snapshot: merged ${mergedExisting} into existing authorities, added ${mergedNew} new (.bak saved)`,
);

console.log("\nDone. Re-run backtrack-snapshot-perps.ts.");
