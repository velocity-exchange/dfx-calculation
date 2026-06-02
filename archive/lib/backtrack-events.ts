/**
 * CSV-row → typed event parsers for the three Athena dumps used to backtrack
 * the trading layer (trade fills, funding payments, liquidations).
 *
 * All numeric on-chain quantities are kept as BN — the dumped values are
 * fixed-point integers already (lamport-scaled), so no floating-point ever
 * touches the math.
 */

import { BN } from "@drift-labs/sdk";
import { parse } from "csv-parse/sync";
import fs from "node:fs";

const BN0 = new BN(0);

function bnOrZero(s: string | undefined | null): BN {
  if (s === undefined || s === null || s === "") return BN0;
  return new BN(s, 10);
}

function strOrEmpty(s: string | undefined | null): string {
  return s ?? "";
}

function intOrZero(s: string | undefined | null): number {
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export type Direction = "long" | "short";

export type TradeEvent = {
  kind: "trade";
  slot: number;
  txsigindex: number;
  ts: number;
  action: string;
  actionExplanation: string;
  marketIndex: number;
  marketType: "perp" | "spot";
  // Pubkeys; may be empty string for AMM/Phoenix counterparties.
  filler: string;
  fillerReward: BN;
  fillRecordId: string;
  baseAssetAmountFilled: BN;
  quoteAssetAmountFilled: BN;
  takerFee: BN;
  makerFee: BN; // can be NEGATIVE (rebate)
  referrerReward: BN;
  quoteAssetAmountSurplus: BN;
  spotFulfillmentMethodFee: BN;
  taker: string;
  takerOrderDirection: Direction | "";
  maker: string;
  makerOrderDirection: Direction | "";
  oraclePrice: BN;
  txsig: string;
};

export type FundingEvent = {
  kind: "funding";
  slot: number;
  txsigindex: number;
  ts: number;
  userAuthority: string;
  user: string;
  marketIndex: number;
  fundingPayment: BN; // signed
  baseAssetAmount: BN; // signed; position size at settle
  userLastCumulativeFunding: BN;
  ammCumulativeFundingLong: BN;
  ammCumulativeFundingShort: BN;
  txsig: string;
};

export type LiquidatePerpSub = {
  marketIndex: number;
  oraclePrice: BN;
  baseAssetAmount: BN;
  quoteAssetAmount: BN;
  lpShares: BN;
  fillRecordId: string;
  liquidatorFee: BN;
  ifFee: BN;
};

export type LiquidateSpotSub = {
  assetMarketIndex: number;
  assetPrice: BN;
  assetTransfer: BN;
  liabilityMarketIndex: number;
  liabilityPrice: BN;
  liabilityTransfer: BN;
  ifFee: BN;
};

export type LiquidateBorrowForPerpPnlSub = {
  perpMarketIndex: number;
  marketOraclePrice: BN;
  pnlTransfer: BN;
  liabilityMarketIndex: number;
  liabilityPrice: BN;
  liabilityTransfer: BN;
};

export type LiquidatePerpPnlForDepositSub = {
  perpMarketIndex: number;
  marketOraclePrice: BN;
  pnlTransfer: BN;
  assetMarketIndex: number;
  assetPrice: BN;
  assetTransfer: BN;
};

export type PerpBankruptcySub = {
  marketIndex: number;
  pnl: BN;
  ifPayment: BN;
  clawbackUser: string | null;
  clawbackUserPayment: BN;
  cumulativeFundingRateDelta: BN;
};

export type SpotBankruptcySub = {
  marketIndex: number;
  borrowAmount: BN;
  ifPayment: BN;
  cumulativeDepositInterestDelta: BN;
};

export type LiquidationEvent = {
  kind: "liquidation";
  slot: number;
  txsigindex: number;
  ts: number;
  liquidationType: string;
  user: string;
  liquidator: string;
  bankrupt: boolean;
  liquidatePerp: LiquidatePerpSub | null;
  liquidateSpot: LiquidateSpotSub | null;
  liquidateBorrowForPerpPnl: LiquidateBorrowForPerpPnlSub | null;
  liquidatePerpPnlForDeposit: LiquidatePerpPnlForDepositSub | null;
  perpBankruptcy: PerpBankruptcySub | null;
  spotBankruptcy: SpotBankruptcySub | null;
  txsig: string;
};

export type SettlePnlEvent = {
  kind: "settlePnl";
  slot: number;
  txsigindex: number;
  ts: number;
  user: string;
  marketIndex: number;
  pnl: BN; // signed; amount moved from position quote → collateral
  baseAssetAmount: BN;
  quoteAssetAmountAfter: BN;
  quoteEntryAmount: BN;
  settlePrice: BN;
  explanation: string;
  txsig: string;
};

export type SwapEvent = {
  kind: "swap";
  slot: number;
  txsigindex: number;
  ts: number;
  user: string;
  amountOut: BN;
  amountIn: BN;
  outMarketIndex: number;
  inMarketIndex: number;
  outOraclePrice: BN;
  inOraclePrice: BN;
  fee: BN;
  txsig: string;
};

export type AnyEvent =
  | TradeEvent
  | FundingEvent
  | LiquidationEvent
  | SettlePnlEvent
  | SwapEvent;

function loadCsv(filePath: string): Record<string, string>[] {
  const raw = fs.readFileSync(filePath, "utf8");
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
  }) as Record<string, string>[];
}

// --- struct JSON unpackers (liquidation sub-records) ---
// Athena's CAST(... AS JSON) wraps the struct as a JSON string. Numeric fields
// inside are themselves stringified (Drift uses string-encoded i128/u128).

type StructJson = Record<string, string | number | null>;

function parseSub<T>(raw: string | null | undefined): StructJson | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StructJson;
  } catch {
    return null;
  }
}

// A sub-struct is "active" iff at least one numeric field is non-zero.
function subActive(o: StructJson | null): boolean {
  if (!o) return false;
  for (const v of Object.values(o)) {
    if (v === null) continue;
    if (typeof v === "number" && v !== 0) return true;
    if (typeof v === "string" && v !== "" && v !== "0") return true;
  }
  return false;
}

export function loadTradeEvents(path: string): TradeEvent[] {
  const rows = loadCsv(path);
  const out: TradeEvent[] = [];
  for (const r of rows) {
    out.push({
      kind: "trade",
      slot: intOrZero(r.slot),
      txsigindex: intOrZero(r.txsigindex),
      ts: intOrZero(r.ts),
      action: strOrEmpty(r.action),
      actionExplanation: strOrEmpty(r.actionexplanation),
      marketIndex: intOrZero(r.marketindex),
      marketType: (strOrEmpty(r.markettype) || "perp") as "perp" | "spot",
      filler: strOrEmpty(r.filler),
      fillerReward: bnOrZero(r.fillerreward),
      fillRecordId: strOrEmpty(r.fillrecordid),
      baseAssetAmountFilled: bnOrZero(r.baseassetamountfilled),
      quoteAssetAmountFilled: bnOrZero(r.quoteassetamountfilled),
      takerFee: bnOrZero(r.takerfee),
      makerFee: bnOrZero(r.makerfee),
      referrerReward: bnOrZero(r.referrerreward),
      quoteAssetAmountSurplus: bnOrZero(r.quoteassetamountsurplus),
      spotFulfillmentMethodFee: bnOrZero(r.spotfulfillmentmethodfee),
      taker: strOrEmpty(r.taker),
      takerOrderDirection: (strOrEmpty(r.takerorderdirection) ||
        "") as Direction | "",
      maker: strOrEmpty(r.maker),
      makerOrderDirection: (strOrEmpty(r.makerorderdirection) ||
        "") as Direction | "",
      oraclePrice: bnOrZero(r.oracleprice),
      txsig: strOrEmpty(r.txsig),
    });
  }
  return out;
}

export function loadFundingEvents(path: string): FundingEvent[] {
  const rows = loadCsv(path);
  const out: FundingEvent[] = [];
  for (const r of rows) {
    out.push({
      kind: "funding",
      slot: intOrZero(r.slot),
      txsigindex: intOrZero(r.txsigindex),
      ts: intOrZero(r.ts),
      userAuthority: strOrEmpty(r.userauthority),
      user: strOrEmpty(r.user),
      marketIndex: intOrZero(r.marketindex),
      fundingPayment: bnOrZero(r.fundingpayment),
      baseAssetAmount: bnOrZero(r.baseassetamount),
      userLastCumulativeFunding: bnOrZero(r.userlastcumulativefunding),
      ammCumulativeFundingLong: bnOrZero(r.ammcumulativefundinglong),
      ammCumulativeFundingShort: bnOrZero(r.ammcumulativefundingshort),
      txsig: strOrEmpty(r.txsig),
    });
  }
  return out;
}

export function loadSettlePnlEvents(path: string): SettlePnlEvent[] {
  const rows = loadCsv(path);
  return rows.map((r) => ({
    kind: "settlePnl" as const,
    slot: intOrZero(r.slot),
    txsigindex: intOrZero(r.txsigindex),
    ts: intOrZero(r.ts),
    user: strOrEmpty(r.user),
    marketIndex: intOrZero(r.marketindex),
    pnl: bnOrZero(r.pnl),
    baseAssetAmount: bnOrZero(r.baseassetamount),
    quoteAssetAmountAfter: bnOrZero(r.quoteassetamountafter),
    quoteEntryAmount: bnOrZero(r.quoteentryamount),
    settlePrice: bnOrZero(r.settleprice),
    explanation: strOrEmpty(r.explanation),
    txsig: strOrEmpty(r.txsig),
  }));
}

export function loadSwapEvents(path: string): SwapEvent[] {
  const rows = loadCsv(path);
  return rows.map((r) => ({
    kind: "swap" as const,
    slot: intOrZero(r.slot),
    txsigindex: intOrZero(r.txsigindex),
    ts: intOrZero(r.ts),
    user: strOrEmpty(r.user),
    amountOut: bnOrZero(r.amountout),
    amountIn: bnOrZero(r.amountin),
    outMarketIndex: intOrZero(r.outmarketindex),
    inMarketIndex: intOrZero(r.inmarketindex),
    outOraclePrice: bnOrZero(r.outoracleprice),
    inOraclePrice: bnOrZero(r.inoracleprice),
    fee: bnOrZero(r.fee),
    txsig: strOrEmpty(r.txsig),
  }));
}

export function loadLiquidationEvents(path: string): LiquidationEvent[] {
  const rows = loadCsv(path);
  const out: LiquidationEvent[] = [];
  for (const r of rows) {
    const lp = parseSub(r.liquidateperp);
    const ls = parseSub(r.liquidatespot);
    const lbfp = parseSub(r.liquidateborrowforperppnl);
    const lpfd = parseSub(r.liquidateperppnlfordeposit);
    const pb = parseSub(r.perpbankruptcy);
    const sb = parseSub(r.spotbankruptcy);

    out.push({
      kind: "liquidation",
      slot: intOrZero(r.slot),
      txsigindex: intOrZero(r.txsigindex),
      ts: intOrZero(r.ts),
      liquidationType: strOrEmpty(r.liquidationtype),
      user: strOrEmpty(r.user),
      liquidator: strOrEmpty(r.liquidator),
      bankrupt: r.bankrupt === "true",
      liquidatePerp: subActive(lp)
        ? {
            marketIndex: intOrZero(lp!.marketindex as string),
            oraclePrice: bnOrZero(lp!.oracleprice as string),
            baseAssetAmount: bnOrZero(lp!.baseassetamount as string),
            quoteAssetAmount: bnOrZero(lp!.quoteassetamount as string),
            lpShares: bnOrZero(lp!.lpshares as string),
            fillRecordId: String(lp!.fillrecordid ?? ""),
            liquidatorFee: bnOrZero(lp!.liquidatorfee as string),
            ifFee: bnOrZero(lp!.iffee as string),
          }
        : null,
      liquidateSpot: subActive(ls)
        ? {
            assetMarketIndex: intOrZero(ls!.assetmarketindex as string),
            assetPrice: bnOrZero(ls!.assetprice as string),
            assetTransfer: bnOrZero(ls!.assettransfer as string),
            liabilityMarketIndex: intOrZero(
              ls!.liabilitymarketindex as string,
            ),
            liabilityPrice: bnOrZero(ls!.liabilityprice as string),
            liabilityTransfer: bnOrZero(ls!.liabilitytransfer as string),
            ifFee: bnOrZero(ls!.iffee as string),
          }
        : null,
      liquidateBorrowForPerpPnl: subActive(lbfp)
        ? {
            perpMarketIndex: intOrZero(lbfp!.perpmarketindex as string),
            marketOraclePrice: bnOrZero(lbfp!.marketoracleprice as string),
            pnlTransfer: bnOrZero(lbfp!.pnltransfer as string),
            liabilityMarketIndex: intOrZero(
              lbfp!.liabilitymarketindex as string,
            ),
            liabilityPrice: bnOrZero(lbfp!.liabilityprice as string),
            liabilityTransfer: bnOrZero(lbfp!.liabilitytransfer as string),
          }
        : null,
      liquidatePerpPnlForDeposit: subActive(lpfd)
        ? {
            perpMarketIndex: intOrZero(lpfd!.perpmarketindex as string),
            marketOraclePrice: bnOrZero(lpfd!.marketoracleprice as string),
            pnlTransfer: bnOrZero(lpfd!.pnltransfer as string),
            assetMarketIndex: intOrZero(lpfd!.assetmarketindex as string),
            assetPrice: bnOrZero(lpfd!.assetprice as string),
            assetTransfer: bnOrZero(lpfd!.assettransfer as string),
          }
        : null,
      perpBankruptcy: subActive(pb)
        ? {
            marketIndex: intOrZero(pb!.marketindex as string),
            pnl: bnOrZero(pb!.pnl as string),
            ifPayment: bnOrZero(pb!.ifpayment as string),
            clawbackUser:
              pb!.clawbackuser === null || pb!.clawbackuser === undefined
                ? null
                : String(pb!.clawbackuser),
            clawbackUserPayment: bnOrZero(pb!.clawbackuserpayment as string),
            cumulativeFundingRateDelta: bnOrZero(
              pb!.cumulativefundingratedelta as string,
            ),
          }
        : null,
      spotBankruptcy: subActive(sb)
        ? {
            marketIndex: intOrZero(sb!.marketindex as string),
            borrowAmount: bnOrZero(sb!.borrowamount as string),
            ifPayment: bnOrZero(sb!.ifpayment as string),
            cumulativeDepositInterestDelta: bnOrZero(
              sb!.cumulativedepositinterestdelta as string,
            ),
          }
        : null,
      txsig: strOrEmpty(r.txsig),
    });
  }
  return out;
}
