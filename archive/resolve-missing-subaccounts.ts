/**
 * Resolve unknown Drift sub-account pubkeys (surfaced as anomalies by
 * backtrack-snapshot-perps.ts) to their on-chain authority.
 *
 * Reads sub-accounts either from --addrs (comma-separated) or from
 * out/backtrack_anomalies.log (default). Fetches each account via RPC,
 * decodes with the Drift SDK, and writes:
 *
 *   out/missing_subaccounts_resolved.csv     pubkey,authority,sub_account_id,status,note
 *
 * Surfaces fetch / decode failures so they can be triaged before being added
 * to users.json.
 *
 * Run:
 *   bun ./resolve-missing-subaccounts.ts --rpc-url <RPC_URL>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeUser, type UserAccount } from "@drift-labs/sdk";

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
const anomaliesPath =
  getFlag("--anomalies") ??
  path.resolve(__dirname, "out", "backtrack_anomalies.log");
const outPath =
  getFlag("--output") ??
  path.resolve(__dirname, "out", "missing_subaccounts_resolved.csv");

function extractFromAnomalies(filePath: string): Set<string> {
  const subs = new Set<string>();
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const [kind, , , detail] = parts;
    let m: RegExpMatchArray | null = null;
    if (kind === "trade.unknown_taker_subaccount")
      m = detail.match(/taker=([1-9A-HJ-NP-Za-km-z]{32,})/);
    else if (kind === "trade.unknown_maker_subaccount")
      m = detail.match(/maker=([1-9A-HJ-NP-Za-km-z]{32,})/);
    else if (kind === "liquidation.unknown_user")
      m = detail.match(/user=([1-9A-HJ-NP-Za-km-z]{32,})/);
    if (m) subs.add(m[1]);
  }
  return subs;
}

let subs: string[];
const explicit = getFlag("--addrs");
if (explicit) {
  subs = explicit.split(",").map((s) => s.trim()).filter(Boolean);
} else {
  subs = [...extractFromAnomalies(anomaliesPath)].sort();
}
console.log(`Resolving ${subs.length} sub-accounts via RPC...`);

const connection = new Connection(rpcUrl, "confirmed");

type Row = {
  pubkey: string;
  authority: string;
  sub_account_id: string;
  status: string;
  note: string;
};

const rows: Row[] = [];

const CHUNK = 100;
for (let i = 0; i < subs.length; i += CHUNK) {
  const chunk = subs.slice(i, i + CHUNK);
  const pks = chunk.map((s) => {
    try {
      return new PublicKey(s);
    } catch {
      return null;
    }
  });
  // Note: getMultipleAccountsInfo accepts up to 100 keys per call.
  const validIdx = pks
    .map((p, j) => (p ? j : -1))
    .filter((j) => j !== -1);
  const validPks = validIdx.map((j) => pks[j]!);

  let infos: (Awaited<
    ReturnType<typeof connection.getMultipleAccountsInfo>
  >[number])[] = [];
  try {
    infos = await connection.getMultipleAccountsInfo(validPks, {
      commitment: "confirmed",
    });
  } catch (e) {
    for (const j of validIdx) {
      rows.push({
        pubkey: chunk[j],
        authority: "",
        sub_account_id: "",
        status: "rpc_error",
        note: (e as Error).message,
      });
    }
    continue;
  }

  for (let k = 0; k < validIdx.length; k++) {
    const j = validIdx[k];
    const pubkey = chunk[j];
    const info = infos[k];
    if (!info) {
      rows.push({
        pubkey,
        authority: "",
        sub_account_id: "",
        status: "not_found",
        note: "account doesn't exist on chain",
      });
      continue;
    }
    if (!info.data || (info.data as Buffer).length === 0) {
      rows.push({
        pubkey,
        authority: "",
        sub_account_id: "",
        status: "empty_data",
        note: `owner=${info.owner.toBase58()} lamports=${info.lamports}`,
      });
      continue;
    }
    try {
      // @ts-ignore — Bun's Buffer vs node Uint8Array TS variance
      const u: UserAccount = decodeUser(Buffer.from(info.data));
      rows.push({
        pubkey,
        authority: u.authority.toBase58(),
        sub_account_id: String(u.subAccountId),
        status: "ok",
        note: "",
      });
    } catch (e) {
      rows.push({
        pubkey,
        authority: "",
        sub_account_id: "",
        status: "decode_failed",
        note: `${(e as Error).message} owner=${info.owner.toBase58()} dataLen=${(info.data as Buffer).length}`,
      });
    }
  }
  // Surface invalid pubkeys
  for (let j = 0; j < chunk.length; j++) {
    if (!pks[j]) {
      rows.push({
        pubkey: chunk[j],
        authority: "",
        sub_account_id: "",
        status: "invalid_pubkey",
        note: "",
      });
    }
  }
}

rows.sort((a, b) => a.pubkey.localeCompare(b.pubkey));

const header = "pubkey,authority,sub_account_id,status,note";
const csv =
  header +
  "\n" +
  rows
    .map((r) =>
      [r.pubkey, r.authority, r.sub_account_id, r.status, r.note.replace(/[\r\n,]/g, " ")].join(","),
    )
    .join("\n") +
  "\n";
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, csv);

const okCount = rows.filter((r) => r.status === "ok").length;
const byStatus = new Map<string, number>();
for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);

console.log(`\nResolved ${okCount}/${rows.length} sub-accounts.`);
console.log("Status breakdown:");
for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s}\t${n}`);
}
console.log(`\nWrote: ${outPath}`);

// Print any non-ok rows immediately so the user sees them.
const problems = rows.filter((r) => r.status !== "ok");
if (problems.length > 0) {
  console.log("\nNon-ok rows:");
  for (const r of problems) {
    console.log(`  ${r.pubkey}\t${r.status}\t${r.note}`);
  }
}
