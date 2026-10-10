import { describe, expect, it } from "vitest";
import {
  getSaxoCsvCompanionEvidence,
  getSaxoWorkbookReconciliationEvidence,
} from "../src/services/portfolioImportPipeline/saxoTransactionHistoryAdapter.ts";
import { buildPortfolioImportReconciliationPlan as buildPlan } from "../src/services/portfolioImportReconciliationService.ts";
import type { ReconciliationPlanInput } from "../src/services/portfolioImportReconciliationService.ts";
import type { PortfolioTransactionSnapshot } from "../src/repositories/portfolioImportReconciliationRepository.ts";
import { syntheticSaxoWorkbook } from "./helpers/saxoWorkbook.ts";
import {
  saxoHash,
  syntheticSaxoPrimaryRawData,
  syntheticSaxoStaging,
  syntheticSaxoCsvRecord,
  syntheticSaxoCsvStaging,
} from "./helpers/saxoReconciliation.ts";
import { loose } from "./helpers/partial.ts";

// The synthetic rows are wire-shaped: numeric BIGINT ids and partial batch,
// history and receipt rows.
const buildPortfolioImportReconciliationPlan = (
  input: Record<string, unknown>,
) => buildPlan(loose<ReconciliationPlanInput>(input));

/** A synthetic staging row, with the fields these tests rewrite or add. */
type StagingFixture = Omit<
  ReturnType<typeof syntheticSaxoStaging>,
  "fees" | "symbol_raw"
> & {
  fees: string | null;
  symbol_raw: string | null;
  error_message?: string;
  note?: string;
};

function correctionFixture() {
  const row: StagingFixture = syntheticSaxoStaging();
  const current: PortfolioTransactionSnapshot = {
    id: 40,
    investment_id: 1,
    type: "buy",
    date: row.tx_date,
    amount: "200.0000",
    units: "10.00000000",
    price_per_unit: "20.000000",
    fees: "2.0000",
    taxes: "0.0000",
    currency: "USD",
    fx_rate_to_eur: "0.9000000000",
    account_id: 7,
    note: "Keep the original note",
    dividend_amount_convention: "unknown",
    is_recurring: false,
    recurrence_interval: null,
    recurrence_end_date: null,
    import_batch_id: null,
    source_record_hash: row.source_record_hash,
    dedup_fingerprint: row.dedup_fingerprint,
    dedup_fingerprint_version: 1,
  };
  const context = {
    receipts: [
      {
        id: 4,
        batch_id: 1,
        staging_row_id: 10,
        transaction_id: 40,
        action: "adopt",
        policy: "preserve_existing",
        before_data: {},
        after_data: { ...current },
      },
    ],
    sources: [{ ...row, id: 10, batch_id: 1, status: "duplicate" }],
    batches: [{ id: 1, account_id: 7, status: "complete" }],
  };
  return { row, current, context };
}
function build(
  fixture: ReturnType<typeof correctionFixture>,
  adoptPolicy: string | null = "prefer_source",
  overrides: Record<string, unknown> = {},
) {
  return buildPortfolioImportReconciliationPlan({
    rows: [fixture.row],
    history: [fixture.current],
    batches: [{ id: 2, account_id: 7, status: "awaiting_review" }],
    adoptPolicy,
    saxoAdoptionContext: fixture.context,
    ...overrides,
  });
}

describe("literal Saxo XLSX correction evidence", () => {
  it("reparses booked account-currency principal and separate fees and taxes without inventing FX", () => {
    expect(
      getSaxoWorkbookReconciliationEvidence(syntheticSaxoPrimaryRawData()),
    ).toMatchObject({
      typeRaw: "Buy",
      sourceId: "101",
      sourceAccountIdentity: "ACC-1",
      symbolRaw: "EXM",
      units: 10,
      pricePerUnit: 18,
      amount: 180,
      fees: 1,
      taxes: 0.63,
      currency: "EUR",
      fxRateToEur: null,
    });
    expect(
      getSaxoWorkbookReconciliationEvidence(syntheticSaxoPrimaryRawData(1)),
    ).toMatchObject({
      typeRaw: "Dividend",
      amount: 10,
      taxes: 4.05,
      currency: "EUR",
      fxRateToEur: null,
    });
  });
  it.each([
    "missing",
    "duplicate",
    "orphan",
    "quote",
    "total",
    "identifier",
    "date",
  ])("rejects %s retained evidence", (kind) => {
    const envelope = JSON.parse(syntheticSaxoPrimaryRawData());
    const main = envelope.records[0];
    const execution = envelope.records[1];
    const set = (
      record: { headers: string[]; cells: unknown[] },
      header: string,
      value: unknown,
    ) => {
      record.cells[
        record.headers.findIndex(
          (item) => item.trim().replaceAll("\u00a0", " ") === header,
        )
      ] = value;
    };
    if (kind === "missing") envelope.records.splice(2);
    if (kind === "duplicate") {
      const extra = structuredClone(envelope.records[2]);
      extra.row += 100;
      envelope.records.push(extra);
    }
    if (kind === "orphan")
      set(execution, "Bk Record Id", { type: "number", raw: "999" });
    if (kind === "quote")
      set(execution, "Verhandelde waarde", { type: "number", raw: "250" });
    if (kind === "total")
      set(main, "Boekingsbedrag", { type: "number", raw: "-999" });
    if (kind === "identifier")
      set(main, "Bk Record Id", { type: "number", raw: "9007199254740993" });
    if (kind === "date")
      set(main, "Transactiedatum", { type: "date", value: "broken" });
    expect(
      getSaxoWorkbookReconciliationEvidence(JSON.stringify(envelope)),
    ).toBeUndefined();
  });
  it("accepts retained four-decimal halfway values with PostgreSQL staging precision", () => {
    const sheets = syntheticSaxoWorkbook();
    sheets[0]!.records[0]!.Boekingsbedrag = -181.63005;
    sheets[2]!.records[1]!.Boekingsbedrag = -1.00005;
    const raw = syntheticSaxoPrimaryRawData(0, sheets);
    const fixture = correctionFixture();
    fixture.row = {
      ...fixture.row,
      raw_data: raw,
      source_record_hash: saxoHash(raw),
      fees: "1.0001",
    };
    fixture.current.source_record_hash = fixture.row.source_record_hash;
    fixture.context.receipts[0]!.after_data = { ...fixture.current };
    fixture.context.sources[0] = {
      ...fixture.row,
      id: 10,
      batch_id: 1,
      status: "duplicate",
    };
    expect(build(fixture).plan.ready).toBe(true);
  });
});

describe("literal Saxo CSV companions", () => {
  it("compares typed dates and numeric cells while ignoring source owner labels", () => {
    const sheets = syntheticSaxoWorkbook();
    sheets[0]!.records[0]!.Gebruikersnaam = "Workbook owner";
    const workbook = syntheticSaxoPrimaryRawData(0, sheets);
    sheets[0]!.records[0]!.Gebruikersnaam = "CSV owner";
    const csv = syntheticSaxoCsvRecord(0, sheets);
    expect(
      getSaxoCsvCompanionEvidence(csv.raw, csv.headers, workbook),
    ).toMatchObject({
      csv: { typeRaw: "Buy", currency: "USD" },
      workbook: { typeRaw: "Buy", currency: "EUR", taxes: 0.63 },
    });
  });
  it.each(["headers", "amount", "zero", "extra", "malformed"])(
    "rejects %s source evidence",
    (kind) => {
      const sheets = syntheticSaxoWorkbook();
      const workbook = syntheticSaxoPrimaryRawData(0, sheets);
      if (kind === "amount")
        (sheets[0]!.records[0]!.Boekingsbedrag as number) -= 1;
      if (kind === "zero") sheets[0]!.records[0]!["Bk Record Id"] = 0;
      const csv = syntheticSaxoCsvRecord(0, sheets);
      if (kind === "headers") csv.headers = csv.headers.slice(1);
      if (kind === "extra") csv.raw += `\n${csv.raw}`;
      if (kind === "malformed") csv.raw = '"broken';
      expect(
        getSaxoCsvCompanionEvidence(csv.raw, csv.headers, workbook),
      ).toBeUndefined();
    },
  );
  function pair() {
    const workbook: StagingFixture = syntheticSaxoStaging({ type_raw: "Buy" });
    const csv: StagingFixture = syntheticSaxoCsvStaging();
    return { workbook, csv };
  }
  function planPair(
    { workbook, csv }: { workbook: StagingFixture; csv: StagingFixture },
    more: StagingFixture[] = [],
  ) {
    const rows = [csv, workbook, ...more];
    return buildPortfolioImportReconciliationPlan({
      rows,
      history: [],
      batches: [...new Set(rows.map((row) => row.batch_id))].map((id) => ({
        id,
        status: "awaiting_review",
        account_id: 7,
      })),
    });
  }
  it("settles foreign-currency CSV trades as source duplicates before they can insert", () => {
    const result = planPair(pair());
    expect(result.plan).toMatchObject({
      ready: true,
      summary: { insert: 1, duplicate_source: 1 },
    });
    expect(result.companions).toHaveLength(1);
    expect(
      result.plan.actions.find((action) => action.rowId === 30)!
        .duplicateOfRowId,
    ).toBe(20);
  });
  it("allows only literal unsupported net-dividend errors and keeps CSV-only errors blocked", () => {
    const raw = syntheticSaxoPrimaryRawData(1);
    const workbook = syntheticSaxoStaging({
      id: 21,
      type_raw: "Dividend",
      type: "dividend",
      source_transaction_id: "102",
      raw_data: raw,
      source_record_hash: saxoHash(raw),
      amount: "10.0000",
      units: null,
      price_per_unit: null,
      fees: "0.0000",
      taxes: "4.0500",
    });
    const csv: StagingFixture = syntheticSaxoCsvStaging(1);
    expect(planPair({ workbook, csv }).plan).toMatchObject({
      ready: true,
      summary: { insert: 1, duplicate_source: 1 },
    });
    expect(
      buildPortfolioImportReconciliationPlan({
        rows: [csv],
        history: [],
        batches: [{ id: 3, status: "awaiting_review", account_id: 7 }],
      }).plan.ready,
    ).toBe(false);
    csv.error_message = "unresolved instrument";
    expect(planPair({ workbook, csv }).plan.ready).toBe(false);
  });
  it.each(["hash", "staged", "account", "investment", "ambiguous"])(
    "blocks %s companions",
    (kind) => {
      const fixture = pair();
      if (kind === "hash") fixture.csv.source_record_hash = "e".repeat(64);
      if (kind === "staged") fixture.csv.units = "11.00000000";
      if (kind === "account") fixture.csv.account_id = 8;
      if (kind === "investment") fixture.csv.investment_id = 2;
      const extra =
        kind === "ambiguous"
          ? [{ ...fixture.workbook, id: 25, batch_id: 4 }]
          : [];
      expect(planPair(fixture, extra).plan.ready).toBe(false);
    },
  );
  it("rejects a companion whose primary cash staging gained fees or an instrument", () => {
    const raw = syntheticSaxoPrimaryRawData(2);
    const csvRecord = syntheticSaxoCsvRecord(2);
    const workbook: StagingFixture = syntheticSaxoStaging({
      id: 22,
      row_index: 2,
      type: null,
      type_raw: "Deposit",
      route: "cash",
      symbol_raw: null,
      name_raw: null,
      investment_id: null,
      source_transaction_id: "103",
      amount: "500.0000",
      units: null,
      price_per_unit: null,
      fees: null,
      taxes: null,
      raw_data: raw,
      source_record_hash: saxoHash(raw),
    });
    const csv = {
      ...workbook,
      id: 32,
      batch_id: 3,
      raw_data: csvRecord.raw,
      source_record_hash: saxoHash(csvRecord.raw),
      custom_config: {
        format: "saxo_transaction_history",
        source_columns: csvRecord.headers,
      },
    };
    expect(planPair({ workbook, csv }).plan.ready).toBe(true);
    workbook.fees = "1.0000";
    expect(planPair({ workbook, csv }).plan.ready).toBe(false);
    workbook.fees = null;
    workbook.symbol_raw = "EXM";
    expect(planPair({ workbook, csv }).plan.ready).toBe(false);
  });
});

describe("journal-bound Saxo source correction plan", () => {
  it("corrects a preserved adoption while keeping its ID, note, type and provenance", () => {
    const fixture = correctionFixture();
    const result = build(fixture);
    expect(result.plan).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 0, duplicate: 0 },
    });
    expect(result.adoptions[0]!.after).toMatchObject({
      id: 40,
      note: fixture.current.note,
      type: "buy",
      amount: "180",
      currency: "EUR",
      price_per_unit: "18",
      fees: "1",
      taxes: "0.63",
      fx_rate_to_eur: null,
      import_batch_id: null,
    });
    expect(result.adoptions[0]!.priorSaxoReceipt!.id).toBe(4);
  });
  it.each([undefined, "preserve_existing"])(
    "keeps %s reimports as duplicates",
    (policy) => {
      const result = build(
        correctionFixture(),
        policy === undefined ? null : policy,
        policy === undefined ? { adoptPolicy: undefined } : {},
      );
      expect(result.plan).toMatchObject({
        ready: true,
        summary: { adopt: 0, duplicate: 1 },
      });
      expect(result.adoptions).toHaveLength(0);
    },
  );
  it.each([
    "hash",
    "staged",
    "snapshot",
    "missing",
    "ambiguous",
    "retained",
    "account",
    "type",
    "investment",
  ])("blocks %s conflicts", (kind) => {
    const fixture = correctionFixture();
    if (kind === "hash") fixture.row.source_record_hash = "c".repeat(64);
    if (kind === "staged") fixture.row.fees = "2.0000";
    if (kind === "snapshot") fixture.current.note = "Later edit";
    if (kind === "missing") fixture.context.receipts = [];
    if (kind === "ambiguous")
      fixture.context.receipts.push({ ...fixture.context.receipts[0]!, id: 5 });
    if (kind === "retained") fixture.context.sources[0]!.raw_data += " ";
    if (kind === "account") fixture.context.sources[0]!.account_id = 8;
    if (kind === "type") fixture.context.sources[0]!.type = "sell";
    if (kind === "investment") fixture.context.sources[0]!.investment_id = 2;
    const result = build(fixture);
    expect(result.plan.ready).toBe(false);
    expect(result.adoptions).toHaveLength(0);
  });
  it("binds prior receipts and retained sources into the plan fingerprint", () => {
    const fixture = correctionFixture();
    const original = build(fixture).plan.planFingerprint;
    fixture.context.receipts[0]!.before_data = { note: "Changed context" };
    expect(build(fixture).plan.planFingerprint).not.toBe(original);
    const changed = build(fixture).plan.planFingerprint;
    fixture.context.sources[0]!.note = "Changed retained context";
    expect(build(fixture).plan.planFingerprint).not.toBe(changed);
  });
  it("does not add a receipt when corrected fields repeat, and preserves known same-currency FX", () => {
    const fixture = correctionFixture();
    fixture.current = build(fixture).adoptions[0]!.after;
    fixture.current.fx_rate_to_eur = "1.0000000000";
    const result = build(fixture);
    expect(result.plan).toMatchObject({
      ready: true,
      summary: { adopt: 0, duplicate: 1 },
    });
    expect(result.adoptions).toHaveLength(0);
  });
});
