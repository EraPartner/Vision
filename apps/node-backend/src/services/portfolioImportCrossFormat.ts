/**
 * One broker event can reach Vision through more than one export (ADR-236
 * amendment): Saxo's CSV and detailed XLSX transaction histories, IBKR's
 * Transaction History CSV and its funding workbook, or an entry the owner
 * typed by hand. This module decides, purely over pre-read rows, which staged
 * row is already recorded by another source so that no combination or order
 * of imports counts an event twice.
 *
 * - Saxo: both exports carry the booking record id of the same account. That
 *   pair is the cross-format source identity; the workbook row is preferred.
 * - IBKR funding: the formats share no id. A CSV deposit or withdrawal and a
 *   workbook movement are one event when account, direction, date and amount
 *   (workbook amount times the CSV exchange rate) agree. The workbook keeps
 *   the movement's own currency, so it is preferred, and it corrects a base
 *   currency deposit that an earlier CSV import recorded.
 * - Manual cash: an active cash transaction that no import owns, on the same
 *   account with the same currency and signed amount, is adopted instead of
 *   duplicated.
 *
 * Rows that several candidates could explain are blocked for review instead
 * of being paired by guess; indistinguishable rows pair by count.
 */
import { parse } from "csv-parse/sync";
import { Decimal, toDecimal } from "../lib/money.ts";
import type { DecimalInput } from "../lib/money.ts";
import { batchConfigFields } from "../database/rows/portfolioImport.ts";
import { classifyBrokerageRow } from "./importPipeline/brokerageRouting.ts";
import { ibkrNumber } from "./portfolioImportPipeline/ibkrTransactionHistoryAdapter.ts";
import { ibkrFundingFactsFromRawData } from "./portfolioImportPipeline/ibkrFundingHistoryAdapter.ts";
import type { IbkrFundingFacts } from "./portfolioImportPipeline/ibkrFundingHistoryAdapter.ts";
import type {
  CrossFormatLedgerSourceRow,
  ManualCashCandidateRow,
  ReconciliationSourceRow,
} from "../repositories/portfolioImportReconciliationRepository.ts";

/** The pre-read ledger evidence the decisions are pure over. */
export interface CrossFormatContext {
  /** settled rows of other batches whose ledger event still exists */
  ledgerSources: CrossFormatLedgerSourceRow[];
  /** `version:fingerprint` identities an active cash transaction carries */
  cashFingerprints: Set<string>;
  /** identities of base-currency rows a funding correction replaced */
  correctedAliases: Set<string>;
  /** active cash transactions on the selected accounts that no import owns */
  manualCash: ManualCashCandidateRow[];
  /** identities an earlier review settled as recorded by another export */
  settledIdentities: Set<string>;
}

export type CashAdoptionPolicy = "exact" | "preserve_existing" | "prefer_source";

/** What one staged row becomes because another source already holds it. */
export type CrossFormatDecision =
  | {
      kind: "duplicate_source";
      duplicateOfRowId: number;
      /** set when the owner paired a near match */
      policy?: "prefer_source";
    }
  | {
      kind: "duplicate";
      existingTransactionId: number;
      policy?: "prefer_source";
    }
  | {
      kind: "adopt_cash";
      reason: "ibkr_native_funding" | "manual_cash";
      transactionId: number;
      policy: CashAdoptionPolicy;
      existing: { date: string; amount: string; currency: string };
      /** the corrected amount and currency (unchanged for manual cash) */
      after: { amount: string; currency: string };
      /** the committed staging row whose transaction is corrected */
      original?: { batchId: number; stagingRowId: number };
    }
  | {
      kind: "policy_required";
      transactionId: number;
      existing: { date: string; amount: string; currency: string };
    }
  | { kind: "blocked"; reason: string; candidateTransactionIds: number[] }
  /**
   * The owner chose to keep this row apart from its near match: it imports
   * through the ordinary path, which must not offer these ledger
   * transactions as its likely copy again.
   */
  | { kind: "kept_apart"; transactionIds: number[] };

const SAXO = "saxo_transaction_history";
const IBKR_CSV = "ibkr_transaction_history";
const IBKR_FUNDING = "ibkr_funding_history";
/** Manual entries within this many days may record the same movement. */
const MANUAL_CASH_DAYS = 7;
/**
 * A CSV funding movement this many days outside its workbook twin's request
 * and completion dates, with the same value, may still be the same movement.
 * Such a near match is never paired or kept apart without the owner's choice.
 */
const NEAR_FUNDING_DAYS = 10;

type StagedRow = ReconciliationSourceRow;

const formatOf = (row: Pick<StagedRow, "custom_config">) =>
  batchConfigFields(row.custom_config)?.format;
const identityOf = (
  row: Pick<StagedRow, "dedup_fingerprint" | "dedup_fingerprint_version">,
) =>
  row.dedup_fingerprint
    ? `${row.dedup_fingerprint_version}:${row.dedup_fingerprint}`
    : undefined;
const text = (value: unknown) =>
  String(value ?? "")
    .trim()
    .replace(/^-$/, "")
    .toUpperCase();
const sameNumber = (left: DecimalInput, right: DecimalInput, places: number) =>
  left != null &&
  right != null &&
  toDecimal(left)
    .toDecimalPlaces(places)
    .eq(toDecimal(right).toDecimalPlaces(places));
const days = (left: string, right: string) =>
  Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) /
  86400000;

/** The ledger sign of a cash row: deposits and income in, the rest out. */
export function signedCashAmount(
  row: Pick<StagedRow, "type" | "type_raw" | "amount">,
): Decimal {
  const { direction } = classifyBrokerageRow({
    kind: row.type ?? row.type_raw,
    hasInstrument: false,
  });
  return toDecimal(row.amount ?? 0)
    .abs()
    .times(direction ?? 1);
}

/**
 * Pair rows with candidates one to one. Rows whose candidate sets coincide
 * and are matched back by exactly those rows are indistinguishable: they pair
 * in order, up to the smaller count. Any partial overlap is ambiguous.
 */
function pairUnique<L, R>(
  left: readonly L[],
  right: readonly R[],
  match: (l: L, r: R) => boolean,
) {
  const candidates = left.map((l) => right.filter((r) => match(l, r)));
  const back = new Map<R, L[]>(
    right.map((r) => [r, left.filter((_l, index) => candidates[index]!.includes(r))]),
  );
  const pairs: Array<[L, R]> = [];
  const ambiguous = new Set<L>();
  const ambiguousRight = new Set<R>();
  const groups = new Map<string, { rows: L[]; candidates: R[] }>();
  left.forEach((l, index) => {
    const set = candidates[index]!;
    if (set.length === 0) return;
    const key = set.map((r) => right.indexOf(r)).join(",");
    const group = groups.get(key) ?? { rows: [], candidates: set };
    group.rows.push(l);
    groups.set(key, group);
  });
  for (const group of groups.values()) {
    const exact = group.candidates.every((r) => {
      const owners = back.get(r) ?? [];
      return (
        owners.length === group.rows.length &&
        owners.every((owner) => group.rows.includes(owner))
      );
    });
    if (!exact) {
      group.rows.forEach((row) => ambiguous.add(row));
      group.candidates.forEach((candidate) => ambiguousRight.add(candidate));
      continue;
    }
    const count = Math.min(group.rows.length, group.candidates.length);
    for (let index = 0; index < count; index++)
      pairs.push([group.rows[index]!, group.candidates[index]!]);
  }
  return { pairs, ambiguous, ambiguousRight };
}

// ── Saxo ──────────────────────────────────────────────────────────────────

function isSaxoWorkbookRow(row: Pick<StagedRow, "raw_data">): boolean {
  return (
    typeof row.raw_data === "string" &&
    row.raw_data.startsWith('{"format":"saxo_xlsx_v1"')
  );
}

/**
 * The row's literal `Bk Record Id`. The workbook joins its sheets on it, so
 * its source id is always that record. A CSV row falls back to `Transactie-ID`
 * or `Booking Id` for its own identity when the record id is blank; those ids
 * are not the workbook's, so only the literal CSV cell counts here.
 */
function saxoBookingRecord(row: StagedRow | CrossFormatLedgerSourceRow) {
  if (isSaxoWorkbookRow(row)) return text(row.source_transaction_id);
  const columns = batchConfigFields(row.custom_config)?.source_columns;
  if (!Array.isArray(columns) || typeof row.raw_data !== "string") return "";
  try {
    const records: string[][] = parse(row.raw_data, {
      relax_column_count: true,
      relax_quotes: true,
    });
    // \s covers the byte-order mark and the no-break spaces Saxo writes.
    const column = columns.findIndex(
      (header) => String(header).replace(/\s/g, " ").trim() === "Bk Record Id",
    );
    if (records.length !== 1 || column < 0) return "";
    const record = text(records[0]?.[column]);
    return /^0+$/.test(record) ? "" : record;
  } catch {
    return "";
  }
}

/**
 * The source id of a Saxo CSV row from a batch that kept no source columns,
 * keyed like {@link saxoKey}. Such a row cannot show which column its id came
 * from: the adapter takes `Bk Record Id`, else `Transactie-ID`, else
 * `Booking Id`. It is the booking record only once a workbook row proves it
 * (see {@link saxoWorkbookRecordIsOwnId}).
 */
function saxoLegacyCsvKey(row: StagedRow | CrossFormatLedgerSourceRow) {
  if (
    formatOf(row) !== SAXO ||
    isSaxoWorkbookRow(row) ||
    row.account_id == null ||
    Array.isArray(batchConfigFields(row.custom_config)?.source_columns)
  )
    return undefined;
  const account = text(row.source_account_identity);
  const record = text(row.source_transaction_id);
  return account && record && !/^0+$/.test(record)
    ? `${row.account_id}\u0000${account}\u0000${record}`
    : undefined;
}

/**
 * Whether a workbook row's booking record id is none of its own
 * `Transactie-ID` or `Booking Id` values. Then a CSV row of the same event
 * whose id equals that record id can only have taken it from `Bk Record Id`.
 */
function saxoWorkbookRecordIsOwnId(row: StagedRow): boolean {
  if (!isSaxoWorkbookRow(row)) return false;
  const record = text(row.source_transaction_id);
  try {
    const provenance = JSON.parse(String(row.raw_data)) as {
      records?: Array<{ headers?: unknown; cells?: unknown }>;
    };
    if (!Array.isArray(provenance.records) || provenance.records.length === 0)
      return false;
    const others = new Set<string>();
    for (const item of provenance.records) {
      if (!Array.isArray(item.headers) || !Array.isArray(item.cells))
        return false;
      item.headers.forEach((header, index) => {
        const name = String(header).replace(/\s/g, " ").trim();
        if (name === "Transactie-ID" || name === "Booking Id")
          others.add(text((item.cells as unknown[])[index]));
      });
    }
    return !!record && !others.has(record);
  } catch {
    return false;
  }
}

/** The booking record of one Saxo account, whichever export staged it. */
function saxoKey(row: StagedRow | CrossFormatLedgerSourceRow) {
  if (formatOf(row) !== SAXO || row.account_id == null) return undefined;
  const account = text(row.source_account_identity);
  const record = saxoBookingRecord(row);
  return account && record
    ? `${row.account_id}\u0000${account}\u0000${record}`
    : undefined;
}

/** A Saxo cash movement's direction: 1 in, -1 out, undefined otherwise. */
function saxoCashDirection(row: Pick<StagedRow, "type" | "type_raw">) {
  return classifyBrokerageRow({
    kind: row.type ?? row.type_raw,
    hasInstrument: false,
  }).direction;
}

/** Facts both Saxo exports state identically for one booking record. */
function saxoConsistent(
  row: StagedRow,
  other: StagedRow | CrossFormatLedgerSourceRow,
): boolean {
  if (row.tx_date !== other.tx_date) return false;
  if (row.route && other.route && row.route !== other.route) return false;
  if (row.type && other.type && row.type !== other.type) return false;
  if (
    row.investment_id != null &&
    other.investment_id != null &&
    Number(row.investment_id) !== Number(other.investment_id)
  )
    return false;
  if (row.units != null && other.units != null)
    return sameNumber(row.units, other.units, 8);
  if (row.route === "cash" && other.route === "cash")
    return (
      row.currency === other.currency &&
      sameNumber(
        toDecimal(row.amount ?? 0).abs(),
        toDecimal(other.amount ?? 0).abs(),
        4,
      )
    );
  return true;
}

// ── IBKR funding ─────────────────────────────────────────────────────────

interface IbkrCsvFunding {
  type: "deposit" | "withdrawal";
  date: string;
  account: string;
  currency: string;
  base: Decimal;
  rate: Decimal;
}

/** A Transaction History deposit or withdrawal, re-read from its literal record. */
function ibkrCsvFunding(
  row: StagedRow | CrossFormatLedgerSourceRow,
): IbkrCsvFunding | undefined {
  if (formatOf(row) !== IBKR_CSV || row.route !== "cash" || !row.tx_date)
    return undefined;
  const columns = batchConfigFields(row.custom_config)?.source_columns;
  if (!Array.isArray(columns) || typeof row.raw_data !== "string")
    return undefined;
  try {
    const records: string[][] = parse(row.raw_data, {
      relax_column_count: true,
      relax_quotes: true,
    });
    const values = records[0];
    if (
      records.length !== 1 ||
      values?.[0] !== "Transaction History" ||
      values[1] !== "Data"
    )
      return undefined;
    const field = (name: string) =>
      String(values[columns.indexOf(name) + 2] ?? "")
        .trim()
        .replace(/^-$/, "");
    const kind = field("Transaction Type");
    const gross = ibkrNumber(field("Gross Amount")) ?? NaN;
    const rate = ibkrNumber(field("Exchange Rate")) ?? NaN;
    if (
      (kind !== "Deposit" && kind !== "Withdrawal") ||
      !Number.isFinite(gross) ||
      gross === 0 ||
      !Number.isFinite(rate) ||
      rate <= 0 ||
      !row.currency
    )
      return undefined;
    return {
      type: kind === "Deposit" ? "deposit" : "withdrawal",
      date: row.tx_date,
      account: field("Account"),
      currency: row.currency,
      base: toDecimal(gross).abs(),
      rate: toDecimal(rate),
    };
  } catch {
    return undefined;
  }
}

function ibkrFunding(
  row: StagedRow | CrossFormatLedgerSourceRow,
): IbkrFundingFacts | undefined {
  return formatOf(row) === IBKR_FUNDING && row.route === "cash"
    ? ibkrFundingFactsFromRawData(row.raw_data)
    : undefined;
}

/** Full account equality, or a masked account with at least four literal digits. */
function ibkrAccountsMatch(left: string, right: string): boolean {
  const a = text(left);
  const b = text(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const masked = (mask: string, full: string) => {
    if (!/^[UX*]+\d{4,}$/.test(mask) || !/[X*]/.test(mask) || !/^U\d+$/.test(full))
      return false;
    const suffix = /\d+$/.exec(mask)?.[0];
    return !!suffix && full.endsWith(suffix);
  };
  return masked(a, b) || masked(b, a);
}

/** Same direction, account and value (workbook amount at the CSV rate). */
function ibkrSameValue(csv: IbkrCsvFunding, funding: IbkrFundingFacts): boolean {
  if (
    csv.type !== funding.type ||
    !ibkrAccountsMatch(csv.account, funding.sourceAccount)
  )
    return false;
  const expected = toDecimal(funding.amount).times(
    funding.currency === csv.currency ? 1 : csv.rate,
  );
  const tolerance = Decimal.max("0.01", csv.base.times("0.0001"));
  return expected.minus(csv.base).abs().lte(tolerance);
}

/** One movement: same value, dated within its request and completion. */
function ibkrSameMovement(
  csv: IbkrCsvFunding,
  funding: IbkrFundingFacts,
): boolean {
  return (
    csv.date >= funding.date &&
    csv.date <= funding.completedDate &&
    ibkrSameValue(csv, funding)
  );
}

/** Same value, dated outside the request and completion but close to them. */
function ibkrNearMovement(
  csv: IbkrCsvFunding,
  funding: IbkrFundingFacts,
): boolean {
  const outside =
    csv.date < funding.date
      ? days(csv.date, funding.date)
      : csv.date > funding.completedDate
        ? days(csv.date, funding.completedDate)
        : 0;
  return (
    outside > 0 && outside <= NEAR_FUNDING_DAYS && ibkrSameValue(csv, funding)
  );
}

// ── Decisions ─────────────────────────────────────────────────────────────

export function planCrossFormatSources({
  rows,
  context,
  policyOf,
  rowChoiceOf = () => undefined,
}: {
  rows: readonly StagedRow[];
  context: CrossFormatContext;
  policyOf: (row: StagedRow) => string | undefined;
  /** the owner's answer for one row (`row_choices`) */
  rowChoiceOf?: (row: StagedRow) => "keep_both" | "same_transaction" | undefined;
}): Map<number, CrossFormatDecision> {
  const decisions = new Map<number, CrossFormatDecision>();
  const decide = (row: StagedRow, decision: CrossFormatDecision) => {
    if (!decisions.has(Number(row.id))) decisions.set(Number(row.id), decision);
  };
  const open = rows.filter(
    (row) => !["committed", "duplicate"].includes(row.status),
  );
  const inCashLedger = (row: StagedRow) => {
    const identity = identityOf(row);
    return (
      identity !== undefined &&
      (context.cashFingerprints.has(identity) ||
        context.correctedAliases.has(identity))
    );
  };
  const ledgerIdentities = new Set(
    context.ledgerSources.map(identityOf).filter((identity) => identity),
  );
  /**
   * The owner's choice for a near match, which no source fact settles:
   * `prefer_source` records the two rows as one event, `preserve_existing`
   * keeps both. A row an earlier review already settled keeps that pairing.
   * Differing statement policies, or none, leave the pair blocked.
   */
  const choiceOf = (...pair: StagedRow[]): "pair" | "keep" | undefined => {
    if (
      pair.some((row) => {
        const identity = identityOf(row);
        return identity !== undefined && context.settledIdentities.has(identity);
      })
    )
      return "pair";
    const chosen = new Set(
      pair
        .map(policyOf)
        .filter(
          (policy) => policy === "prefer_source" || policy === "preserve_existing",
        ),
    );
    if (chosen.size !== 1) return undefined;
    return chosen.has("prefer_source") ? "pair" : "keep";
  };
  /**
   * The owner's choice for a Saxo pair that only lacks a booking record id.
   * Keeping both could count one event twice, so the statement-wide
   * `preserve_existing` never decides it: only a per-row answer does
   * (`same_transaction` pairs, `keep_both` keeps both), or `prefer_source`,
   * which records the pair once. A per-row answer outranks the statement
   * policy; answers that disagree across the pair leave it blocked.
   */
  const identityChoiceOf = (
    ...pair: StagedRow[]
  ): { kind: "pair"; policy?: "prefer_source" } | { kind: "keep" } | undefined => {
    const answers = new Set(
      pair.map(rowChoiceOf).filter((answer) => answer !== undefined),
    );
    if (answers.size === 0)
      return choiceOf(...pair) === "pair"
        ? { kind: "pair", policy: "prefer_source" }
        : undefined;
    if (answers.size !== 1) return undefined;
    return answers.has("same_transaction") ? { kind: "pair" } : { kind: "keep" };
  };
  /** Rows the owner chose to keep apart from their near match. */
  const kept = new Map<number, number[]>();
  const keep = (row: StagedRow, transactionIds: number[] = []) =>
    kept.set(Number(row.id), [...(kept.get(Number(row.id)) ?? []), ...transactionIds]);
  const undecided = (row: StagedRow) =>
    !decisions.has(Number(row.id)) && !kept.has(Number(row.id));

  // Saxo: one booking record, whichever export staged it.
  const workbooks = new Map<string, StagedRow>();
  for (const row of open) {
    const key = saxoKey(row);
    if (key && isSaxoWorkbookRow(row) && !workbooks.has(key))
      workbooks.set(key, row);
  }
  const saxoLedger = new Map<string, CrossFormatLedgerSourceRow[]>();
  const saxoLegacyLedger = new Map<string, CrossFormatLedgerSourceRow[]>();
  for (const source of context.ledgerSources) {
    const key = saxoKey(source);
    if (key) saxoLedger.set(key, [...(saxoLedger.get(key) ?? []), source]);
    const legacyKey = saxoLegacyCsvKey(source);
    if (legacyKey)
      saxoLegacyLedger.set(legacyKey, [
        ...(saxoLegacyLedger.get(legacyKey) ?? []),
        source,
      ]);
  }
  for (const row of open) {
    const key = saxoKey(row);
    if (!key) continue;
    const primary = workbooks.get(key);
    if (primary && primary !== row && !isSaxoWorkbookRow(row)) {
      decide(
        row,
        saxoConsistent(row, primary)
          ? { kind: "duplicate_source", duplicateOfRowId: Number(primary.id) }
          : {
              kind: "blocked",
              reason: "cross_format_source_conflict",
              candidateTransactionIds: [],
            },
      );
      continue;
    }
    const proven = saxoLedger.get(key) ?? [];
    // A CSV recorded before batches kept their source columns counts only
    // when this workbook row proves its id is the booking record. Otherwise
    // it stays a keyless twin below.
    const recorded =
      proven.length === 0 && saxoWorkbookRecordIsOwnId(row)
        ? (saxoLegacyLedger.get(key) ?? [])
        : proven;
    // The same export repeated keeps its ordinary fingerprint duplicate path.
    if (
      recorded.length === 0 ||
      recorded.some((source) => identityOf(source) === identityOf(row))
    )
      continue;
    const [first] = recorded;
    decide(
      row,
      recorded.every((source) => saxoConsistent(row, source))
        ? { kind: "duplicate", existingTransactionId: first!.transaction_id }
        : {
            kind: "blocked",
            reason: "cross_format_source_conflict",
            candidateTransactionIds: [
              ...new Set(recorded.map((source) => source.transaction_id)),
            ],
          },
    );
  }

  // Saxo rows without a booking record id cannot be paired by identity. An
  // otherwise identical CSV and workbook row is still one event unless the
  // owner says otherwise, so it blocks for that choice instead of importing
  // twice (the CSV books instrument currency, the workbook account currency,
  // so their fingerprints differ).
  const saxoTwins = (
    left: StagedRow,
    right: StagedRow | CrossFormatLedgerSourceRow,
  ) =>
    formatOf(left) === SAXO &&
    formatOf(right) === SAXO &&
    isSaxoWorkbookRow(left) !== isSaxoWorkbookRow(right) &&
    (!saxoKey(left) || !saxoKey(right)) &&
    left.account_id != null &&
    Number(left.account_id) === Number(right.account_id) &&
    text(left.source_account_identity) === text(right.source_account_identity) &&
    identityOf(left) !== identityOf(right) &&
    !!left.route &&
    left.route === right.route &&
    // Deposits and withdrawals carry no portfolio type: pair them by direction.
    (left.route === "cash"
      ? saxoCashDirection(left) !== undefined &&
        saxoCashDirection(left) === saxoCashDirection(right)
      : !!left.type && left.type === right.type) &&
    (left.route !== "portfolio" ||
      (left.investment_id != null && right.investment_id != null)) &&
    (left.units == null) === (right.units == null) &&
    saxoConsistent(left, right);
  const saxoUnpaired = open.filter(
    (row) =>
      formatOf(row) === SAXO &&
      row.status === "matched" &&
      undecided(row) &&
      !ledgerIdentities.has(identityOf(row) ?? ""),
  );
  const saxoInPlan = pairUnique(
    saxoUnpaired.filter((row) => !isSaxoWorkbookRow(row)),
    saxoUnpaired.filter(isSaxoWorkbookRow),
    saxoTwins,
  );
  for (const [csvRow, workbookRow] of saxoInPlan.pairs) {
    const choice = identityChoiceOf(csvRow, workbookRow);
    if (choice?.kind === "pair")
      decide(csvRow, {
        kind: "duplicate_source",
        duplicateOfRowId: Number(workbookRow.id),
        ...(choice.policy ? { policy: choice.policy } : {}),
      });
    else if (choice?.kind === "keep") {
      keep(csvRow);
      keep(workbookRow);
    } else
      for (const row of [csvRow, workbookRow])
        decide(row, {
          kind: "blocked",
          reason: "cross_format_identity_missing",
          candidateTransactionIds: [],
        });
  }
  // With several look-alikes only keeping the row apart is a clear answer.
  for (const row of [...saxoInPlan.ambiguous, ...saxoInPlan.ambiguousRight])
    if (rowChoiceOf(row) === "keep_both") keep(row);
    else
      decide(row, {
        kind: "blocked",
        reason: "cross_format_identity_missing",
        candidateTransactionIds: [],
      });
  const saxoLedgerRows = context.ledgerSources.filter(
    (source, index, all) =>
      formatOf(source) === SAXO &&
      all.findIndex(
        (other) =>
          other.ledger === source.ledger &&
          other.transaction_id === source.transaction_id,
      ) === index,
  );
  const saxoToLedger = pairUnique(
    saxoUnpaired.filter(undecided),
    saxoLedgerRows,
    saxoTwins,
  );
  for (const [row, source] of saxoToLedger.pairs) {
    const choice = identityChoiceOf(row);
    if (choice?.kind === "pair")
      decide(row, {
        kind: "duplicate",
        existingTransactionId: source.transaction_id,
        ...(choice.policy ? { policy: choice.policy } : {}),
      });
    else if (choice?.kind === "keep") keep(row, [source.transaction_id]);
    else
      decide(row, {
        kind: "blocked",
        reason: "cross_format_identity_missing",
        candidateTransactionIds: [source.transaction_id],
      });
  }
  for (const row of saxoToLedger.ambiguous) {
    const candidates = [...saxoToLedger.ambiguousRight].map(
      (source) => source.transaction_id,
    );
    if (rowChoiceOf(row) === "keep_both") keep(row, candidates);
    else
      decide(row, {
        kind: "blocked",
        reason: "cross_format_identity_missing",
        candidateTransactionIds: candidates,
      });
  }

  // IBKR funding: CSV base-currency movements and native workbook movements.
  type CsvItem = { row: StagedRow; facts: IbkrCsvFunding };
  type FundingItem = { row: StagedRow; facts: IbkrFundingFacts };
  const csv: CsvItem[] = [];
  const funding: FundingItem[] = [];
  for (const row of open) {
    if (decisions.has(Number(row.id)) || row.status !== "matched") continue;
    if (inCashLedger(row)) continue;
    const csvFacts = ibkrCsvFunding(row);
    if (csvFacts) csv.push({ row, facts: csvFacts });
    const fundingFacts = ibkrFunding(row);
    if (fundingFacts) funding.push({ row, facts: fundingFacts });
  }
  const sameAccount = (left: { account_id: unknown }, right: { account_id: unknown }) =>
    left.account_id != null && Number(left.account_id) === Number(right.account_id);
  const blockAll = (items: Iterable<{ row: StagedRow }>, ids: number[] = []) => {
    for (const item of items)
      decide(item.row, {
        kind: "blocked",
        reason: "ambiguous_funding_history",
        candidateTransactionIds: ids,
      });
  };
  const inPlan = pairUnique(
    csv,
    funding,
    (left, right) =>
      sameAccount(left.row, right.row) && ibkrSameMovement(left.facts, right.facts),
  );
  for (const [left, right] of inPlan.pairs)
    decide(left.row, {
      kind: "duplicate_source",
      duplicateOfRowId: Number(right.row.id),
    });
  blockAll(inPlan.ambiguous);
  blockAll(inPlan.ambiguousRight);
  const distinctLedger = <T extends CrossFormatLedgerSourceRow>(items: T[]) =>
    items.filter(
      (item, index) =>
        items.findIndex((other) => other.transaction_id === item.transaction_id) ===
        index,
    );
  const ledgerFunding = distinctLedger(
    context.ledgerSources.filter((source) => source.ledger === "cash"),
  )
    .map((source) => ({ source, facts: ibkrFunding(source) }))
    .filter(
      (item): item is { source: CrossFormatLedgerSourceRow; facts: IbkrFundingFacts } =>
        item.facts !== undefined,
    );
  const remainingCsv = csv.filter((item) => !decisions.has(Number(item.row.id)));
  const toLedger = pairUnique(remainingCsv, ledgerFunding, (left, right) =>
    sameAccount(left.row, right.source) &&
    ibkrSameMovement(left.facts, right.facts),
  );
  for (const [left, right] of toLedger.pairs)
    decide(left.row, {
      kind: "duplicate",
      existingTransactionId: right.source.transaction_id,
    });
  blockAll(
    toLedger.ambiguous,
    [...toLedger.ambiguousRight].map((item) => item.source.transaction_id),
  );
  // A base-currency deposit that an earlier CSV import recorded and that no
  // funding correction has replaced yet.
  const ledgerCsv = distinctLedger(
    context.ledgerSources.filter((source) => source.ledger === "cash"),
  )
    .map((source) => ({ source, facts: ibkrCsvFunding(source) }))
    .filter(
      (item): item is { source: CrossFormatLedgerSourceRow; facts: IbkrCsvFunding } =>
        item.facts !== undefined,
    );
  // The ledger still shows what the CSV said; anything else was edited since.
  const unedited = (item: (typeof ledgerCsv)[number]) =>
    item.source.ledger_currency === item.facts.currency &&
    sameNumber(
      item.source.ledger_amount,
      item.facts.base.times(item.facts.type === "withdrawal" ? -1 : 1),
      4,
    );
  const remainingFunding = funding.filter(
    (item) => !decisions.has(Number(item.row.id)),
  );
  const corrections = pairUnique(remainingFunding, ledgerCsv, (left, right) =>
    sameAccount(left.row, right.source) &&
    ibkrSameMovement(right.facts, left.facts),
  );
  for (const [left, right] of corrections.pairs)
    if (!unedited(right))
      // Neither overwrite the edit nor record the movement a second time.
      decide(left.row, {
        kind: "blocked",
        reason: "cross_format_source_conflict",
        candidateTransactionIds: [right.source.transaction_id],
      });
    else decide(left.row, {
      kind: "adopt_cash",
      reason: "ibkr_native_funding",
      transactionId: right.source.transaction_id,
      policy: "prefer_source",
      existing: {
        date: right.source.ledger_date ?? right.facts.date,
        amount: String(right.source.ledger_amount),
        currency: String(right.source.ledger_currency),
      },
      after: {
        amount: toDecimal(left.facts.amount)
          .times(left.facts.type === "withdrawal" ? -1 : 1)
          .toFixed(),
        currency: left.facts.currency,
      },
      original: {
        batchId: Number(right.source.batch_id),
        stagingRowId: Number(right.source.id),
      },
    });
  blockAll(
    corrections.ambiguous,
    [...corrections.ambiguousRight].map((item) => item.source.transaction_id),
  );

  // Near matches: the same value, but the CSV date lies just outside the
  // workbook's request and completion dates. They are never imported twice
  // or merged silently; the owner's statement policy decides (choiceOf).
  const pairedFunding = new Set(inPlan.pairs.map(([, right]) => right));
  const claimedFunding = new Set(toLedger.pairs.map(([, right]) => right));
  const claimedCsv = new Set(corrections.pairs.map(([, right]) => right));
  const nearMismatch = (row: StagedRow, ids: number[] = []) =>
    decide(row, {
      kind: "blocked",
      reason: "funding_date_mismatch",
      candidateTransactionIds: ids,
    });
  const nearCsv = () =>
    csv.filter((item) => undecided(item.row));
  const nearInPlan = pairUnique(
    nearCsv(),
    funding.filter(
      (item) => undecided(item.row) && !pairedFunding.has(item),
    ),
    (left, right) =>
      sameAccount(left.row, right.row) &&
      ibkrNearMovement(left.facts, right.facts),
  );
  for (const [left, right] of nearInPlan.pairs) {
    const choice = choiceOf(left.row, right.row);
    if (choice === "pair")
      decide(left.row, {
        kind: "duplicate_source",
        duplicateOfRowId: Number(right.row.id),
        policy: "prefer_source",
      });
    else if (choice === "keep") {
      keep(left.row);
      keep(right.row);
    } else {
      nearMismatch(left.row);
      nearMismatch(right.row);
    }
  }
  blockAll(nearInPlan.ambiguous);
  blockAll(nearInPlan.ambiguousRight);
  const nearToLedger = pairUnique(
    nearCsv(),
    ledgerFunding.filter((item) => !claimedFunding.has(item)),
    (left, right) =>
      sameAccount(left.row, right.source) &&
      ibkrNearMovement(left.facts, right.facts),
  );
  for (const [left, right] of nearToLedger.pairs) {
    const choice = choiceOf(left.row);
    if (choice === "pair")
      decide(left.row, {
        kind: "duplicate",
        existingTransactionId: right.source.transaction_id,
        policy: "prefer_source",
      });
    else if (choice === "keep") keep(left.row, [right.source.transaction_id]);
    else nearMismatch(left.row, [right.source.transaction_id]);
  }
  blockAll(
    nearToLedger.ambiguous,
    [...nearToLedger.ambiguousRight].map((item) => item.source.transaction_id),
  );
  const nearCorrections = pairUnique(
    funding.filter((item) => undecided(item.row) && !pairedFunding.has(item)),
    ledgerCsv.filter((item) => !claimedCsv.has(item)),
    (left, right) =>
      sameAccount(left.row, right.source) &&
      ibkrNearMovement(right.facts, left.facts),
  );
  for (const [left, right] of nearCorrections.pairs) {
    const choice = choiceOf(left.row);
    if (choice === "keep") keep(left.row, [right.source.transaction_id]);
    else if (choice === undefined)
      nearMismatch(left.row, [right.source.transaction_id]);
    else if (!unedited(right))
      decide(left.row, {
        kind: "blocked",
        reason: "cross_format_source_conflict",
        candidateTransactionIds: [right.source.transaction_id],
      });
    else
      decide(left.row, {
        kind: "adopt_cash",
        reason: "ibkr_native_funding",
        transactionId: right.source.transaction_id,
        policy: "prefer_source",
        existing: {
          date: right.source.ledger_date ?? right.facts.date,
          amount: String(right.source.ledger_amount),
          currency: String(right.source.ledger_currency),
        },
        after: {
          amount: toDecimal(left.facts.amount)
            .times(left.facts.type === "withdrawal" ? -1 : 1)
            .toFixed(),
          currency: left.facts.currency,
        },
        original: {
          batchId: Number(right.source.batch_id),
          stagingRowId: Number(right.source.id),
        },
      });
  }
  blockAll(
    nearCorrections.ambiguous,
    [...nearCorrections.ambiguousRight].map((item) => item.source.transaction_id),
  );

  // Manual cash: an unowned transaction with the same signed money.
  const cashRows = open.filter(
    (row) =>
      row.route === "cash" &&
      row.status === "matched" &&
      row.amount != null &&
      row.currency != null &&
      row.tx_date != null &&
      row.dedup_fingerprint != null &&
      !decisions.has(Number(row.id)) &&
      !inCashLedger(row),
  );
  const manual = pairUnique(cashRows, context.manualCash, (row, candidate) =>
    sameAccount(row, candidate) &&
    candidate.currency === row.currency &&
    sameNumber(candidate.amount, signedCashAmount(row), 4) &&
    days(candidate.date, row.tx_date!) <= MANUAL_CASH_DAYS,
  );
  for (const [row, candidate] of manual.pairs) {
    const existing = {
      date: candidate.date,
      amount: candidate.amount,
      currency: candidate.currency,
    };
    const policy =
      candidate.date === row.tx_date ? "exact" : policyOf(row);
    if (policy !== "exact" && policy !== "preserve_existing" && policy !== "prefer_source") {
      decide(row, {
        kind: "policy_required",
        transactionId: candidate.id,
        existing,
      });
      continue;
    }
    decide(row, {
      kind: "adopt_cash",
      reason: "manual_cash",
      transactionId: candidate.id,
      policy,
      existing,
      after: { amount: candidate.amount, currency: candidate.currency },
    });
  }
  for (const row of manual.ambiguous)
    decide(row, {
      kind: "blocked",
      reason: "ambiguous_cash_history",
      candidateTransactionIds: context.manualCash
        .filter(
          (candidate) =>
            sameAccount(row, candidate) &&
            candidate.currency === row.currency &&
            sameNumber(candidate.amount, signedCashAmount(row), 4) &&
            days(candidate.date, row.tx_date!) <= MANUAL_CASH_DAYS,
        )
        .map((candidate) => candidate.id),
    });
  for (const [rowId, transactionIds] of kept)
    if (!decisions.has(rowId))
      decisions.set(rowId, { kind: "kept_apart", transactionIds });
  return decisions;
}
