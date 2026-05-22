/**
 * Filter users.json + base_snapshot.json down to ONLY the authorities whose
 * positions changed between T0 and T1 (per out/snapshot_diff.csv).
 *
 * Produces a focused working set for the backtrack pipeline:
 *   - users.changed.json                 — sub-accounts mapped to in-scope authorities (+ vault sub-accounts)
 *   - out/base_snapshot.changed.json     — T1 state for those authorities only (markets, vaults preserved)
 *
 * Vault drift sub-accounts (their `user` field) are always retained so vault
 * accounting still works for in-scope depositors.
 *
 * Run:
 *   bun ./filter-to-diff-set.ts
 *
 * Then run backtrack against the filtered set:
 *   bun ./backtrack-snapshot-perps.ts \
 *     --snapshot   ./out/base_snapshot.changed.json \
 *     --users-json ./users.changed.json \
 *     --output     ./out/base_snapshot_backtracked.changed.json \
 *     --skip-referrer-clawback
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

import { stableJsonStringify, type Snapshot } from "./lib/snapshot-types.ts";
import {
  sortAccountsRecord,
  type UserAccountsPayload,
} from "./lib/pipeline-json.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

const diffCsvPath =
  getFlag("--diff-csv") ?? path.resolve(__dirname, "out", "snapshot_diff.csv");
const usersJsonPath =
  getFlag("--users-json") ?? path.resolve(__dirname, "users.json");
const snapshotPath =
  getFlag("--snapshot") ??
  path.resolve(__dirname, "out", "base_snapshot.json");
const outUsersPath =
  getFlag("--out-users") ?? path.resolve(__dirname, "users.changed.json");
const outSnapshotPath =
  getFlag("--out-snapshot") ??
  path.resolve(__dirname, "out", "base_snapshot.changed.json");

console.log(`diff csv:     ${diffCsvPath}`);
console.log(`users in:     ${usersJsonPath}`);
console.log(`snapshot in:  ${snapshotPath}`);

// --- 1. Load the diff set
const diffText = fs.readFileSync(diffCsvPath, "utf8");
const diffRows = parse(diffText, { columns: true, skip_empty_lines: true }) as {
  authority: string;
}[];
const changedAuthorities = new Set<string>(diffRows.map((r) => r.authority));
console.log(`changed authorities: ${changedAuthorities.size}`);

// --- 2. Load original users.json and snapshot
const users = JSON.parse(
  fs.readFileSync(usersJsonPath, "utf8"),
) as UserAccountsPayload;
const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as Snapshot;

const totalSubs = Object.keys(users.accounts).length;
const totalAuths = Object.keys(snap.borrowLendByAuthority).length;
console.log(`source users.json:  ${totalSubs} sub-accounts`);
console.log(`source snapshot:    ${totalAuths} authorities, ${snap.vaults.length} vaults`);

// --- 3. Build the retained authority set
//   = changed authorities + every vault authority (vault accounting needs them).
const retainedAuthorities = new Set<string>(changedAuthorities);
const vaultAuths = new Set<string>(snap.vaultAuthorities);
for (const a of vaultAuths) retainedAuthorities.add(a);
console.log(`retained authorities (changed + vaults): ${retainedAuthorities.size}`);

// --- 4. Build the retained sub-account set
//   = sub-accounts whose authority is retained + every vault's `user` field
const retainedSubs = new Set<string>();
let droppedSubs = 0;
for (const [sub, auth] of Object.entries(users.accounts)) {
  if (retainedAuthorities.has(auth)) retainedSubs.add(sub);
  else droppedSubs += 1;
}
for (const v of snap.vaults) {
  // ensure vault's drift sub-account is in users.changed.json so it resolves
  if (v.user) retainedSubs.add(v.user);
}
console.log(`retained sub-accounts: ${retainedSubs.size} (dropped ${droppedSubs})`);

// --- 5. Write filtered users.json
const filteredAccounts: Record<string, string> = {};
for (const sub of retainedSubs) {
  const auth = users.accounts[sub];
  if (auth) filteredAccounts[sub] = auth;
}
const filteredUsersDoc: UserAccountsPayload = {
  ...users,
  accounts: sortAccountsRecord(filteredAccounts),
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(outUsersPath, JSON.stringify(filteredUsersDoc, null, "\t") + "\n");
console.log(`wrote ${outUsersPath}: ${Object.keys(filteredAccounts).length} sub-accounts`);

// --- 6. Write filtered snapshot (keep markets + vaults; filter borrowLendByAuthority)
const filteredBLBA: typeof snap.borrowLendByAuthority = {};
for (const a of Object.keys(snap.borrowLendByAuthority).sort()) {
  if (changedAuthorities.has(a)) {
    filteredBLBA[a] = snap.borrowLendByAuthority[a];
  }
}
const filteredSnap: Snapshot = {
  ...snap,
  borrowLendByAuthority: filteredBLBA,
  snapshotTimestampUtc: new Date().toISOString(),
};
fs.writeFileSync(outSnapshotPath, stableJsonStringify(filteredSnap, 0));
console.log(
  `wrote ${outSnapshotPath}: ${
    Object.keys(filteredBLBA).length
  } authorities (vaults: ${filteredSnap.vaults.length} preserved)`,
);

console.log("\nNext:");
console.log(
  "  bun ./backtrack-snapshot-perps.ts \\",
  "\n    --snapshot   ./out/base_snapshot.changed.json \\",
  "\n    --users-json ./users.changed.json \\",
  "\n    --output     ./out/base_snapshot_backtracked.changed.json \\",
  "\n    --skip-referrer-clawback",
);
