/**
 * Verify the filter logic for out/base_snapshot.changed.json.
 *
 * Assertion under test:
 *   "Every authority that appears in any Athena record (as taker / maker /
 *    filler / user / liquidator / authority) should be present in
 *    out/base_snapshot.changed.json's borrowLendByAuthority."
 *
 * Procedure:
 *   1. Walk each Athena CSV; collect every sub-account pubkey + every direct
 *      authority pubkey appearing in any column.
 *   2. Resolve sub-accounts → authorities via the ORIGINAL users.json.
 *   3. Diff that set against the keys of borrowLendByAuthority in
 *      base_snapshot.changed.json.
 *   4. Report any missing authorities (with the event row that surfaced them).
 *
 * Caveats it surfaces, doesn't enforce:
 *   - Referrer authorities are NOT in the CSV (they live on the on-chain
 *     UserStats account). With --skip-referrer-clawback, they were never
 *     pulled in. This is logged for completeness.
 *   - Sub-accounts not in users.json are reported as "unresolved" — they
 *     wouldn't have been touched by the backtrack either.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { type Snapshot } from "./lib/snapshot-types.ts";
import { type UserAccountsPayload } from "./lib/pipeline-json.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CUTOFF_SLOT = 410_344_005;
const WINDOW_END = 410_366_402;

const usersAll = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "users.json"), "utf8"),
) as UserAccountsPayload;
const snap = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "out", "base_snapshot.changed.json"),
    "utf8",
  ),
) as Snapshot;

const subToAuth = usersAll.accounts;
const snapAuths = new Set(Object.keys(snap.borrowLendByAuthority));
const vaultAuths = new Set(snap.vaultAuthorities);

function inWindow(slot: number): boolean {
  return slot >= CUTOFF_SLOT && slot <= WINDOW_END;
}

type Hit = { source: string; row: number; key: string; pubkey: string };
const requiredAuths = new Set<string>();
const unresolved: Hit[] = [];
const directAuthRows: Hit[] = [];

function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, "utf8");
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
  }) as Record<string, string>[];
}

function strip(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/^"+|"+$/g, "").trim();
}

function maybeAddSub(
  source: string,
  rowIdx: number,
  column: string,
  pubkey: string,
): void {
  if (!pubkey) return;
  if (pubkey === "11111111111111111111111111111111") return; // PublicKey::default
  const auth = subToAuth[pubkey];
  if (auth) {
    requiredAuths.add(auth);
  } else {
    unresolved.push({ source, row: rowIdx, key: column, pubkey });
  }
}

function maybeAddAuth(
  source: string,
  rowIdx: number,
  column: string,
  pubkey: string,
): void {
  if (!pubkey) return;
  if (pubkey === "11111111111111111111111111111111") return;
  requiredAuths.add(pubkey);
  directAuthRows.push({ source, row: rowIdx, key: column, pubkey });
}

// --- trades.csv: taker, maker, filler are sub-account pubkeys
{
  const rows = readCsv(path.resolve(__dirname, "out", "athena", "trades.csv"));
  let included = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!inWindow(Number(strip(r.slot)))) continue;
    included += 1;
    for (const c of ["taker", "maker", "filler"]) {
      maybeAddSub("trades", i, c, strip(r[c]));
    }
  }
  console.log(`trades:      ${included} rows in window`);
}

// --- funding.csv: userauthority is an authority pubkey; user is a sub-account
{
  const rows = readCsv(path.resolve(__dirname, "out", "athena", "funding.csv"));
  let included = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!inWindow(Number(strip(r.slot)))) continue;
    included += 1;
    maybeAddAuth("funding", i, "userauthority", strip(r.userauthority));
    maybeAddSub("funding", i, "user", strip(r.user));
  }
  console.log(`funding:     ${included} rows in window`);
}

// --- liq.csv: user, liquidator are sub-account pubkeys
{
  const rows = readCsv(path.resolve(__dirname, "out", "athena", "liq.csv"));
  let included = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!inWindow(Number(strip(r.slot)))) continue;
    included += 1;
    for (const c of ["user", "liquidator"]) {
      maybeAddSub("liq", i, c, strip(r[c]));
    }
  }
  console.log(`liq:         ${included} rows in window`);
}

// --- settle_pnl.csv: user is a sub-account
{
  const rows = readCsv(
    path.resolve(__dirname, "out", "athena", "settle_pnl.csv"),
  );
  let included = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!inWindow(Number(strip(r.slot)))) continue;
    included += 1;
    maybeAddSub("settle_pnl", i, "user", strip(r.user));
  }
  console.log(`settle_pnl:  ${included} rows in window`);
}

// --- swap.csv: user is a sub-account
{
  const rows = readCsv(path.resolve(__dirname, "out", "athena", "swap.csv"));
  let included = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!inWindow(Number(strip(r.slot)))) continue;
    included += 1;
    maybeAddSub("swap", i, "user", strip(r.user));
  }
  console.log(`swap:        ${included} rows in window`);
}

console.log(`\nRequired authorities (resolved): ${requiredAuths.size}`);
console.log(`Unresolved sub-account hits:     ${unresolved.length}`);
console.log(`Snapshot authorities:            ${snapAuths.size}`);
console.log(`Vault authorities:               ${vaultAuths.size}`);

// --- assertion: every required authority should be in the snapshot OR a vault
const missing: string[] = [];
const missingButVault: string[] = [];
for (const a of requiredAuths) {
  if (snapAuths.has(a)) continue;
  if (vaultAuths.has(a)) {
    missingButVault.push(a);
    continue;
  }
  missing.push(a);
}

console.log(`\n=== Verification ===`);
console.log(`Missing from snapshot (and NOT a vault): ${missing.length}`);
console.log(`Missing but is a vault authority:        ${missingButVault.length} (expected — vaults excluded from borrowLendByAuthority by design)`);

if (missing.length > 0) {
  console.log(`\nFirst 20 missing authorities:`);
  for (const a of missing.slice(0, 20)) {
    console.log(`  ${a}`);
  }
  const outPath = path.resolve(__dirname, "out", "verify_missing.txt");
  fs.writeFileSync(outPath, missing.join("\n") + "\n");
  console.log(`\nFull list: ${outPath}`);
}

if (unresolved.length > 0) {
  // dedupe by pubkey
  const uniq = new Map<string, Hit>();
  for (const h of unresolved) if (!uniq.has(h.pubkey)) uniq.set(h.pubkey, h);
  console.log(`\nUnresolved sub-accounts (not in users.json): ${uniq.size} unique`);
  console.log(`These would not have been backtracked. Examples:`);
  let n = 0;
  for (const h of uniq.values()) {
    console.log(`  ${h.pubkey}  (${h.source} row=${h.row} col=${h.key})`);
    if (++n >= 10) break;
  }
}

// --- referrer caveat
console.log(`\nReferrer note: referrer authorities are not in the Athena CSVs.`);
console.log(`They live on on-chain UserStats accounts and are fetched only by`);
console.log(`the referrer-clawback step (--skip-referrer-clawback was used here).`);
console.log(`Trades with non-zero referrerReward but no referrer field route the`);
console.log(`share to __pool_protocol_fee (no per-user reversal needed) — see`);
console.log(`METHODOLOGY.md "What is *not* a drift source".`);
