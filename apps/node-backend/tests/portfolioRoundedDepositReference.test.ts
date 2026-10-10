import { describe, expect, it } from "vitest";
import { toDecimal } from "../src/lib/money.ts";
import { __computeSourceRecordHash } from "../src/services/importIdentity.ts";
import { buildPortfolioImportReconciliationPlan } from "../src/services/portfolioImportReconciliationService.ts";
import {
  portfolioPerformanceRoundedDepositIdentifiesLegacy,
  __verifiedKinesisWithdrawal as verifiedKinesisWithdrawal,
} from "../src/services/portfolioPerformanceReferenceEvidence.ts";
import {
  retainedEvent,
  retainedReference,
  retainedEvidenceRow,
} from "./fixtures/retainedPortfolioEvidence.ts";
import { loose } from "./helpers/partial.ts";
import type {
  ReconciliationBatchScopeRow,
  ReconciliationSourceRow,
} from "../src/repositories/portfolioImportReconciliationRepository.ts";
import type { HistoryImage } from "../src/services/portfolioImportReconciliationService.ts";
import type { LegacyPortfolioFacts } from "../src/services/portfolioPerformanceReferenceEvidence.ts";
import { batchConfigFields } from "../src/database/rows/portfolioImport.ts";

// The synthetic rows are wire-shaped: numeric ids where the row types carry
// BIGINT strings, and no joined batch or investment metadata columns.
type LegacyRow = LegacyPortfolioFacts & HistoryImage;

/** The reference proof `retainedEvidenceRow` stores in the raw_data envelope. */
interface ReferenceProof {
  accountId?: number;
  sourceHash: string;
  basisPolicy: string;
  literal: Record<string, unknown>;
}

interface EvidenceEnvelope {
  primaryRawData: string;
  __portfolioPerformanceReference: ReferenceProof;
}

const columns =
  "DateTime,HIN,Currency_Code,Transaction_Type,Transaction_ID,Order_ID,Currency_Pair,Amount,Trade_Price,Total,Fee,Fee_Currency,Trade_Value,Trade_Value_Currency,Starting_Balance,Starting_Balance_Currency,Closing_Balance,Closing_Balance_Currency".split(
    ",",
  );

function source() {
  const raw =
    "2025-02-01 12:00:00 UTC,KM00000001,BTC,Deposit,SYNTHETIC-DEPOSIT,,,0.01234539,,500,,,,,0,BTC,0.01234539,BTC";
  return loose<ReconciliationSourceRow>({
    id: 10,
    batch_id: 1,
    row_index: 0,
    status: "matched",
    route: "portfolio",
    investment_id: 1,
    asset_class: "crypto",
    account_id: 7,
    type: "gift",
    type_raw: "Gift",
    tx_date: "2025-02-01",
    units: "0.01234539",
    amount: "0",
    price_per_unit: null,
    fees: "0",
    taxes: "0",
    currency: "EUR",
    raw_data: raw,
    symbol_raw: "BTC",
    note: "Kinesis asset transfer in; original cost basis unavailable",
    source_transaction_id: "SYNTHETIC-DEPOSIT",
    source_account_identity: "KM00000001",
    source_record_hash: __computeSourceRecordHash(raw),
    dedup_fingerprint: "b".repeat(64),
    dedup_fingerprint_version: 1,
    custom_config: {
      format: "kinesis_transaction_history",
      source_columns: columns,
    },
    asset_transfer_details: { direction: "in", basisStatus: "unresolved" },
  });
}
const legacy = (over: Record<string, unknown> = {}) =>
  loose<LegacyRow>({
    id: 40,
    investment_id: 1,
    type: "gift",
    date: "2025-02-01",
    units: "0.01234500",
    amount: "0",
    price_per_unit: "0",
    fees: "0",
    taxes: "0",
    currency: "EUR",
    account_id: null,
    import_batch_id: null,
    source_record_hash: null,
    dedup_fingerprint: null,
    dedup_fingerprint_version: null,
    note: "Preserve synthetic gift note",
    ...over,
  });

function enriched(currency = "EUR", amount = "250") {
  const event = retainedEvent({
    securityId: "security-btc",
    date: "2025-02-01",
    shares: "0.01234539",
    currency,
    amount,
  });
  const reference = retainedReference([event]);
  // `fx_rate_to_eur: undefined` stages no FX value at all.
  return loose<ReconciliationSourceRow>(
    retainedEvidenceRow(source(), reference, event, "recorded_native", {
      currency,
      amount,
      price_per_unit: toDecimal(amount).div("0.01234539").toFixed(6),
      fx_rate_to_eur: undefined,
      asset_transfer_details: {
        direction: "in",
        basisStatus: "recorded_reference",
      },
    }),
  );
}
function plan(
  row: ReconciliationSourceRow,
  history: HistoryImage[] = [legacy()],
  policy = "prefer_source",
) {
  return buildPortfolioImportReconciliationPlan({
    rows: [row],
    history,
    batches: [
      loose<ReconciliationBatchScopeRow>({
        id: 1,
        account_id: 7,
        status: "awaiting_review",
      }),
    ],
    adoptPolicy: policy,
  });
}
function changeEnvelope<R extends ReconciliationSourceRow>(
  row: R,
  edit: (envelope: EvidenceEnvelope) => void,
) {
  const envelope: EvidenceEnvelope = JSON.parse(row.raw_data!);
  edit(envelope);
  return { ...row, raw_data: JSON.stringify(envelope) };
}

describe("bounded rounded Kinesis deposit reference identity", () => {
  it("adopts the unique original gift ID and corrects rounded quantity and missing native basis", () => {
    const row = enriched();
    expect(
      portfolioPerformanceRoundedDepositIdentifiesLegacy(row, legacy()),
    ).toBe(true);
    const result = plan(row);
    expect(result.plan).toMatchObject({
      ready: true,
      summary: { insert: 0, adopt: 1 },
    });
    expect(result.adoptions[0]!.after).toMatchObject({
      id: 40,
      units: "0.01234539",
      amount: "250",
      currency: "EUR",
      account_id: 7,
      note: "Preserve synthetic gift note",
      source_record_hash: source().source_record_hash,
    });
  });

  it("permits an exact numeric currency transcription while supplying no invented FX", () => {
    const row = enriched("USD");
    const current = legacy({
      amount: "250",
      price_per_unit: toDecimal(250)
        .div("0.012345")
        .toDecimalPlaces(6)
        .toFixed(),
    });
    const result = plan(row, [current]);
    expect(result.plan.ready).toBe(true);
    expect(result.adoptions[0]!.after).toMatchObject({
      id: 40,
      currency: "USD",
      fx_rate_to_eur: null,
    });
  });

  it("requires explicit policy and respects preservation of original values", () => {
    const row = enriched();
    const unchosen = buildPortfolioImportReconciliationPlan({
      rows: [row],
      history: [legacy()],
      batches: [
        loose<ReconciliationBatchScopeRow>({
          id: 1,
          account_id: 7,
          status: "awaiting_review",
        }),
      ],
    });
    expect(unchosen.plan.summary).toMatchObject({
      insert: 0,
      adopt: 0,
      policy_required: 1,
    });
    const preserve = plan(row, [legacy()], "preserve_existing");
    expect(preserve.adoptions[0]!.after).toMatchObject({
      units: "0.01234500",
      amount: "0",
    });
  });

  it("fails closed when two originals fit instead of assigning either or inserting a third", () => {
    const result = plan(enriched(), [legacy(), legacy({ id: 41 })]);
    expect(result.plan.ready).toBe(false);
    expect(result.plan.summary).toMatchObject({ insert: 0, adopt: 0 });
    expect(result.plan.blockers[0]!.reason).toBe("ambiguous_history");
  });

  it.each([
    ["source_record_hash", "a".repeat(64)],
    ["source_transaction_id", "OTHER-DEPOSIT"],
    ["source_account_identity", "KM00000002"],
    ["symbol_raw", "ETH"],
    ["account_id", 8],
    ["price_per_unit", "1"],
    ["fx_rate_to_eur", "0.9"],
  ])(
    "does not authorize adoption or insert beside the original when %s is altered",
    (key, value) => {
      const row = { ...enriched(), [key]: value };
      expect(
        portfolioPerformanceRoundedDepositIdentifiesLegacy(row, legacy()),
      ).toBe(false);
      const result = plan(row);
      expect(result.plan.ready).toBe(false);
      expect(result.plan.summary).toMatchObject({ insert: 0, adopt: 0 });
    },
  );

  it.each([
    (proof: ReferenceProof) => {
      delete proof.accountId;
    },
    (proof: ReferenceProof) => {
      proof.literal.sharesMinor = "1234540";
    },
    (proof: ReferenceProof) => {
      proof.literal.date = "2025-02-02T00:00";
    },
    (proof: ReferenceProof) => {
      proof.literal.type = "BUY";
    },
    (proof: ReferenceProof) => {
      proof.sourceHash = "not-a-hash";
    },
    (proof: ReferenceProof) => {
      proof.basisPolicy = "zero";
    },
  ])("rejects missing or altered secondary identity", (edit) => {
    const row = changeEnvelope(enriched(), (envelope) =>
      edit(envelope.__portfolioPerformanceReference),
    );
    expect(
      portfolioPerformanceRoundedDepositIdentifiesLegacy(row, legacy()),
    ).toBe(false);
    const result = plan(row);
    expect(result.plan.ready).toBe(false);
    expect(result.plan.summary).toMatchObject({ insert: 0, adopt: 0 });
  });

  it("requires the original exact literal deposit and original ordered header", () => {
    const row = enriched();
    const noHeader = {
      ...row,
      custom_config: { format: "kinesis_transaction_history" as const },
    };
    const wrongRaw = changeEnvelope(row, (envelope) => {
      envelope.primaryRawData = envelope.primaryRawData.replace(
        ",Deposit,",
        ",Holder's_Distribution,",
      );
    });
    const recast = {
      ...wrongRaw,
      source_record_hash: __computeSourceRecordHash(
        JSON.parse(wrongRaw.raw_data).primaryRawData,
      ),
    };
    for (const candidate of [
      noHeader,
      wrongRaw,
      recast,
      { ...row, raw_data: source().raw_data },
    ]) {
      expect(
        portfolioPerformanceRoundedDepositIdentifiesLegacy(candidate, legacy()),
      ).toBe(false);
      expect(plan(candidate).plan.summary).toMatchObject({
        insert: 0,
        adopt: 0,
      });
    }
  });

  it("rejects changed meaningful economics and nonzero fees even with valid unit proof", () => {
    const row = enriched();
    for (const current of [
      legacy({ amount: "251", price_per_unit: null }),
      legacy({ amount: "250", price_per_unit: "1" }),
      legacy({ fees: "0.01" }),
      legacy({ taxes: "0.01" }),
    ]) {
      expect(
        portfolioPerformanceRoundedDepositIdentifiesLegacy(row, current),
      ).toBe(false);
      expect(plan(row, [current]).plan.summary).toMatchObject({
        insert: 0,
        adopt: 0,
      });
    }
  });

  it("does not relax ordinary gift matching or low precision material differences", () => {
    const row = enriched();
    expect(
      portfolioPerformanceRoundedDepositIdentifiesLegacy(
        {
          ...row,
          // A format name no specialized adapter claims.
          custom_config: loose<ReconciliationSourceRow["custom_config"]>({
            ...batchConfigFields(row.custom_config),
            format: "portfolio_generic",
          }),
        },
        legacy(),
      ),
    ).toBe(false);
    for (const current of [
      legacy({ type: "buy" }),
      legacy({ investment_id: 2 }),
      legacy({ date: "2025-02-02" }),
      legacy({ units: "0.01234000" }),
      legacy({ units: "0.01234538" }),
      legacy({ account_id: 7 }),
      legacy({ import_batch_id: 2 }),
      legacy({ source_record_hash: "f".repeat(64) }),
    ])
      expect(
        portfolioPerformanceRoundedDepositIdentifiesLegacy(row, current),
      ).toBe(false);
    const small = { ...row, units: "0.00000139" };
    expect(
      portfolioPerformanceRoundedDepositIdentifiesLegacy(
        small,
        legacy({ units: "0.00000100" }),
      ),
    ).toBe(false);
  });
});

const withdrawal = () => {
  const raw =
    "2025-02-02 12:00:00 UTC,KM00000001,BTC,Withdrawal,SYNTHETIC-WITHDRAWAL,,,0.0008,,,0.0003,BTC,,,0.01234539,BTC,0.01124539,BTC";
  return {
    ...source(),
    route: "asset_transfer",
    type: null,
    type_raw: "AssetTransfer",
    tx_date: "2025-02-02",
    units: "0.00110000",
    raw_data: raw,
    source_transaction_id: "SYNTHETIC-WITHDRAWAL",
    source_record_hash: __computeSourceRecordHash(raw),
    asset_transfer_details: {
      direction: "out",
      basisStatus: "carried",
      feeUnits: "0.0003",
      receivedUnits: "0.0008",
    },
  };
};

describe("verified literal Kinesis withdrawal quantities", () => {
  it("proves received units, fee units and gross units without changing the source", () => {
    const row = withdrawal();
    const before = JSON.stringify(row);
    expect(verifiedKinesisWithdrawal(row)).toEqual({
      receivedUnits: "0.0008",
      feeUnits: "0.0003",
      grossUnits: "0.0011",
    });
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each([
    ["source_record_hash", "a".repeat(64)],
    ["source_transaction_id", "OTHER-WITHDRAWAL"],
    ["source_account_identity", "KM00000002"],
    ["symbol_raw", "ETH"],
    ["tx_date", "2025-02-03"],
    ["units", "0.00110001"],
    ["route", "portfolio"],
  ])(
    "rejects staged %s that disagrees with the literal source",
    (key, value) => {
      expect(
        verifiedKinesisWithdrawal({ ...withdrawal(), [key]: value }),
      ).toBeUndefined();
    },
  );

  it.each([
    ["receivedUnits", "0.00079999"],
    ["feeUnits", "0.00030001"],
    ["direction", "in"],
    ["basisStatus", "unresolved"],
  ])("rejects altered %s transfer details", (key, value) => {
    const row = withdrawal();
    (row.asset_transfer_details as Record<string, string>)[key] = value;
    expect(verifiedKinesisWithdrawal(row)).toBeUndefined();
  });

  it.each([
    [",0.0003,BTC,", ",0.0003,ETH,"],
    [",0.01124539,BTC", ",0.01124538,BTC"],
    [",Withdrawal,", ",Deposit,"],
    [",0.0003,BTC,", ",-0.0003,BTC,"],
  ])(
    "rejects contradictory literal fee, balance or direction despite a refreshed hash",
    (before, after) => {
      const row = withdrawal();
      row.raw_data = row.raw_data.replace(before, after);
      row.source_record_hash = __computeSourceRecordHash(row.raw_data);
      expect(verifiedKinesisWithdrawal(row)).toBeUndefined();
    },
  );

  it("requires the actual full unique source header", () => {
    const row = withdrawal();
    for (const source_columns of [
      undefined,
      columns.slice(1),
      [...columns.slice(0, -1), columns[0]!],
    ]) {
      expect(
        verifiedKinesisWithdrawal({
          ...row,
          custom_config: {
            format: "kinesis_transaction_history",
            source_columns,
          },
        }),
      ).toBeUndefined();
    }
  });
});
