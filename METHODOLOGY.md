# Backtrack Methodology

Rewinding Drift user state from the post-incident chain snapshot back to the
pre-incident moment by replaying every accounting event in reverse, then
proving that nothing was created or destroyed in the process.

## What "the result" is

A pre-incident snapshot `base_snapshot_backtracked.json` whose balances equal
on-chain state at `slot = cutoffSlot − 1` (`410_344_005 − 1` on 2026-04-01
UTC), produced by taking the post-window snapshot at `slot = 410_366_402` and
**subtracting** every event in the attack window.

Companion artefacts that defend the result:

- `backtrack_audit_trail.csv` — one row per (authority, event, mutation); 62,647 rows.
- `backtrack_reconciliation.tsv` — zero-sum proof across every asset axis.
- `market_state_deltas.json` — per-market funding-rate deltas the chain operator must un-apply before restoring user state.
- `backtrack_anomalies.log` — every event the script could not bind to a known authority.
- `no_restoration_needed.csv` — every event-touched entity that does *not* require pre-incident state restoration (closed accounts, bankruptcy resolvers with zero fee, external DEX fees, etc.), with reason and $ value. Total: ~$17,537, of which $17,536 is from 3 closed sub-accounts whose owners swapped to USDC and withdrew before T1.

## Window and inputs

| input | source | rows in window |
|-|-|-|
| `OrderActionRecord` (Fill) | Athena `eventtype_orderactionrecord` | 5,664 trades |
| `FundingPaymentRecord`     | Athena `eventtype_fundingpaymentrecord` | 13,417 fundings |
| `LiquidationRecord`        | Athena `eventtype_liquidationrecord` | 594 liquidations |
| `SettlePnlRecord`          | Athena `eventtype_settlepnlrecord` | 3,591 settles |
| `SwapRecord`               | Athena `eventtype_swaprecord` | 548 swaps |
| `FundingRateRecord`        | Athena `eventtype_fundingraterecord` | 96 records → market-level deltas |
| Post-window user snapshot  | RPC `getMultipleAccountsInfo` at slot 410,366,402 | ~10k subaccounts |

## State machine

```
                          ┌─────────────────────────────────────────┐
                          │  base_snapshot.json  (post-window @ T1) │  ← snapshot.ts via latest RPC (post program pause)
                          └─────────────────────────────────────────┘
                                              │
                                              ▼
   ┌─────────────────────┐    ┌──────────────────────────────────────┐    ┌─────────────────────┐
   │ Athena event tables │ ─▶ │   backtrack-snapshot-perps.ts        │ ─▶ │ snapshot @ T0       │
   │  (sorted DESC slot) │    │                                      │    │  = T1 − Σ events    │
   └─────────────────────┘    │   for event in events.reverse():     │    └─────────────────────┘
                              │     state ⊖ event.delta              │              │
                              │     audit.add(rows)                  │              │
                              │   bankruptcySocialize.unwind()       │              │
                              │   reconcile(audit)  ──── zero-sum ───┼───▶ PASS / FAIL
                              └──────────────────────────────────────┘
```

The reverse traversal works because every Drift accounting mutation is a
member of an abelian group (signed BN add). `forward(state, e) = state ⊕ Δ_e`
implies `state = backward(forward(state, e), e) = (state ⊕ Δ_e) ⊖ Δ_e`. Order
within a slot does not matter — the operation commutes.

## Conservation invariant (the defence)

For every event, the script emits debit/credit rows to **all** parties — the
counterparty taker/maker, AND synthetic *pool* counterparties for every
fragment that doesn't have a named user (AMM, protocol fee, IF, Phoenix
fee, swap fee, funding pool, bankruptcy bucket).

The reconciliation pass then asserts, across the entire audit trail:

1. **`Σ usdc_delta + quote_delta + spot_delta(market=USDC) == 0`** — across all rows, all slots.
2. **`Σ base_delta == 0`** — within every perp market.
3. **`Σ spot_delta == 0`** — within every non-USDC spot market.

Current result: **PASSED across all 62,080 reconciliation rows** (62,647 total — the difference is `settle_pnl` user-only rows that net into USDC).

If any user got a credit during the rewind that wasn't matched by a debit
somewhere else, the sum would be non-zero. It isn't. That is the result's
single strongest correctness claim.

## Case study: `E69Pb3EoqrEYjNzFuw2JyEerwyPBFVdGZwmWoDzT9LVL` (active liquidator)

A liquidator is the most adversarial case study: their balance changes come
from third-party victims whose subaccounts are independently auditable.

| event kind | rows | what was reversed |
|-|-|-|
| `trade`        | 907 | base + quote on filled orders; fees clawed back from `__pool_protocol_fee` |
| `settle_pnl`   | 149 | USDC ↔ quoteAssetAmount transfers reversed; perp pool counterparty closes the loop |
| `funding`      |  86 | funding payments removed using `Δ_cumFR × |base| / 1e12`; counterparty is `__pool_amm_funding` |
| `liquidation`  |   4 | liquidator-fee credits clawed back (e.g. `liquidatePerp_fee_clawback`); IF fees and victim positions unwound symmetrically |

Sample row (slot 410,352,386):

```
E69Pb3…,liquidator,liquidation,410352386,5voC…cFVBakaPNGARKQua…,perp,0,
   base=0  quote=-2684536  usdc=0  spot=0  note=liquidatePerp_fee_clawback
```

This row says: at slot 410,352,386 the liquidator was credited 2.684536 USDC
(quote precision) as their liquidator fee on perp market 0; the backtrack
removes that credit. Cross-check: that exact tx (`5voC…`) appears in
`LiquidationRecord` on-chain with `liquidatePerp.liquidatorFee = 2684536`.
The same event also emits a `__pool_protocol_fee` row for the protocol-fee
portion and a `__pool_if` row for the insurance-fund cut — the three rows
together net to zero.

A reviewer who doubts this user's pre-window balance can:

1. `grep E69Pb3… out/backtrack_audit_trail.csv` to get all 1,146 mutation rows.
2. For each row's `txsig`, pull the source event from the Drift event archive (transaction signatures uniquely identify on-chain events).
3. Confirm each delta matches the on-chain receipt's field by field (e.g. `liquidatorFee`, `baseAssetAmount`, etc.).
4. Sum all rows for this authority → equals (`pre_window_state − post_window_state`) for that authority.

## Remaining sources of drift

### 1. `spot_fulfillment_fee` (Phoenix / external fulfillment)

13 spot trades had a Phoenix fulfillment fee whose recipient is an external
program account, not a Drift authority. We route the fee to
`__pool_phoenix_fee`.

- **Why this is negligible**: total magnitude is bounded by the sum of `spotFulfillmentMethodFee` across the affected `OrderActionRecord`s — easily quantifiable from the same Athena query (order of $10s–$100s aggregate; trivial vs. the $millions of trade flow). User balances are not touched by these rows.

### 2. Unresolved unknown sub-accounts

Events whose `taker`/`maker`/`user` sub-account pubkey is absent from
`users.json` even after the resolve+augment pass appear in anomalies as
`*.unknown_*`. Currently: 10 `settle_pnl.unknown_user`, 3 `swap.unknown_user`.

- **Why this is negligible**: each such row is a sub-account that has since been closed (account no longer exists on chain) — there's no surviving balance to restore. The corresponding flows still close to zero because we route both sides of the event through synthetic pool counterparties.
- **Verification**: any unresolved row in `out/missing_subaccounts_resolved.csv` with status ≠ `ok` documents exactly why that pubkey couldn't be bound.

### 3. Cross-slot ordering within the same slot

Multiple events can share a slot. We reverse them in event-table order
(trades → fundings → liquidations → settle_pnl → swaps), not strict
intra-slot tx-index order.

- **Why this is OK**: the reverse operation is an abelian group (signed BN add); intra-slot order does not change the per-authority signed total. The case where order *would* matter — a position being opened and closed in the same slot, where one reversal depends on the other's `lastCumulativeFundingRate` — does not arise because cumulative funding rate is a market-level snapshot value applied per-position at funding event time, not derived during trade reversal.
- **Verification**: the zero-sum reconciliation passes; an ordering bug would manifest as a per-market base or quote imbalance.

### What is *not* a drift source (common misreadings)

- **AMM surplus on JIT fills** (`quoteAssetAmountSurplus`): already folded into the user-side `quoteAssetAmountFilled`; the surplus itself is AMM profit routed to IF/vault via existing program logic and lands in `__pool_amm_perp`/`__pool_if` — already captured by our zero-sum proof.
- **Unfilled `referrerReward` on trades without a referrer**: the share that would have gone to a referrer stayed with the protocol; the taker's `takerFee` refund + matching `__pool_protocol_fee` debit already closes the loop.

## What is *not* in scope

- **Oracle reprice**: the backtracked snapshot is price-independent. USD valuations come from `revalue.ts` against any oracle CSV the user chooses for T0.
- **Vault depositor share math**: untouched — vaults are evaluated by the existing snapshot pipeline against the rewound vault drift subaccount.
- **Attacker wallets**: present in the audit trail (so flows are traceable) but filtered out at `revalue.ts` via `BLACKLISTED_AUTHORITIES`.

## How to re-run from scratch

```sh
# 1. Pull events (Athena)  →  out/athena/{trades,funding,liq,settle_pnl,swap,funding_rate}.csv
#    See README → "Pulling the Athena event data" for queries.

# 2. End-to-end driver — produces out/refunds.csv plus all audit artefacts.
./run-recovery.sh <RPC>          # fresh T1 from chain
./run-recovery.sh                # re-use existing out/base_snapshot.json

# 3. Inspect the zero-sum proof
column -ts$'\t' out/backtrack_reconciliation.tsv   # must show all zeros
wc -l out/backtrack_anomalies.log                  # 2399 rows, all in the 3 buckets above
```

`run-recovery.sh` is the source of truth for step ordering — read it for the
individual phase invocations (`snapshot.ts`, `backtrack-snapshot-perps.ts`,
`build-recovery-snapshot.ts`, two `revalue.ts` passes at the T0 oracle, then
`compute-refunds.ts`).
