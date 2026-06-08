# authority-notional

Deterministic accounting tools for Drift Protocol, built on a shared library.
The repo holds three self-contained pipelines plus the common `lib/` they
import from.

| directory                            | what it does                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| [`dfx/`](dfx/README.md)              | **DFX recovery accounting** — total DFX supply + per-user DFX entitlement.   |
| [`insurance-fund/`](insurance-fund/README.md) | Per-staker **insurance-fund** valuation (shares → token amount, per market). |
| [`archive/`](archive/README.md)      | Archived post-incident **recovery / backtracking** pipeline (refunds).       |
| `lib/`                               | Shared helpers imported by all three (see below).                            |

## Run

Requires [Bun](https://bun.sh). Run all commands from the repo root.

```sh
bun install

# DFX recovery accounting (see dfx/README.md)
bun run snapshot   # phase 1 — fetch on-chain state → dfx/out/base_snapshot.json
bun run revalue    # phase 2 — price snapshot       → dfx/out/authority_notional.csv

# insurance-fund snapshot (see insurance-fund/README.md)
bun ./insurance-fund/snapshot.ts --rpc-url <RPC_URL>

# typecheck everything
bun run typecheck
```

Each pipeline's flags, inputs, and outputs are documented in its own README:

- **DFX recovery accounting** → [`dfx/README.md`](dfx/README.md)
- **Insurance fund** → [`insurance-fund/README.md`](insurance-fund/README.md)
- **Recovery (archived)** → [`archive/README.md`](archive/README.md) and
  [`archive/METHODOLOGY.md`](archive/METHODOLOGY.md)

## Layout

```
authority-notional/
├── dfx/                       # DFX recovery accounting (self-contained)
├── insurance-fund/            # insurance-fund snapshot (self-contained)
├── archive/                   # archived post-incident recovery pipeline
└── lib/                       # shared library (imported by dfx/, insurance-fund/, archive/)
    ├── pipeline-json.ts       # users.json reader
    ├── rate-limit.ts          # withRetry, limitConcurrency, sleep
    ├── vault.ts               # discover vaults, list depositors, share rows
    ├── types.ts               # ShareRowScaled
    ├── aggregate-borrow-lend.ts # price-independent per-user aggregation
    ├── perp-snapshot.ts       # perp market + position JSON (de)serializers
    ├── snapshot-types.ts      # Snapshot, BN<->string helpers, stable JSON
    ├── oracle-csv.ts          # loadOracleCloseByMarket (both schemas)
    ├── value-from-snapshot.ts # snapshot + oracle prices → priced totals
    └── vault-fees.ts          # crystallize management/profit-share fees
```

Outputs (`dfx/out/`, `insurance-fund/out/`, root `out/`) are gitignored.
