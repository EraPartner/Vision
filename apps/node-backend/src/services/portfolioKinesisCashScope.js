/** Complete-source native cash chains and immutable owned ledger after-images. */
import { createHash } from "node:crypto";
import { toDecimal } from "../lib/money.ts";
import { parseCsvText } from "./importPipeline/adapters/_shared.js";
import { portfolioPrimaryRawData } from "./portfolioPerformanceReferenceEvidence.js";
import { proveKinesisAdoptionSources } from "./portfolioKinesisAdoptionScope.js";
import {
  assignImportIdentities,
  portfolioIdentityBase,
} from "./importIdentity.js";

/**
 * @typedef {import('@vision/shared-utils/money').DecimalInput} DecimalInput
 * @typedef {import('decimal.js').default} Decimal
 * @typedef {import('../repositories/portfolioImportReconciliationRepository.ts').ReconciliationSourceRow} ReconciliationSourceRow
 * @typedef {import('../repositories/portfolioImportReconciliationRepository.ts').ReconciliationBatchScopeRow} ReconciliationBatchScopeRow
 * @typedef {import('./portfolioImportPipeline/portfolioGenericAdapter.js').ParsedPortfolioRow} ParsedPortfolioRow
 */
/**
 * Proven ledger values of one native cash movement (or its funding fee).
 * @typedef {object} KinesisCashValues
 * @property {string | null} date 'YYYY-MM-DD'
 * @property {string} amount exact decimal text, signed
 * @property {string} currency
 * @property {number} accountId
 * @property {boolean} isTransfer
 * @property {string} transferSource
 * @property {null} transferPeerId
 */
/**
 * @typedef {object} KinesisCashProof
 * @property {"closed_kinesis_cash"} kind
 * @property {string} groupKey
 * @property {string} eventKey
 * @property {string} eventKind
 * @property {string} fileHash
 * @property {number} memberCount
 * @property {number} componentCount
 */
/**
 * One reparsed fiat event of a closed per-currency chain.
 * @typedef {object} KinesisCashMember
 * @property {ReconciliationSourceRow} row
 * @property {{ eventKey: string, sourceFileHash: string, parsed: ParsedPortfolioRow }} literal
 * @property {Record<string, string>} record the single original CSV record, keyed by header
 * @property {Decimal} start
 * @property {Decimal} close
 * @property {Decimal} delta
 * @property {"trade_quote" | "card_expense" | "own_account_funding"} eventKind
 * @property {KinesisCashValues} values
 * @property {KinesisCashValues | undefined} feeValues
 * @property {KinesisCashProof} [proof]
 */
/**
 * The `transactions` after-image fields (CASH_SNAPSHOT_SQL jsonb) this scope reads.
 * @typedef {object} KinesisCashLedgerImage
 * @property {number} id
 * @property {string} date 'YYYY-MM-DD'
 * @property {string} amount exact decimal text
 * @property {string | null} currency
 * @property {number | null} account_id
 * @property {boolean} is_active
 * @property {string | null} dedup_fingerprint
 * @property {number | null} dedup_fingerprint_version
 */
/**
 * @typedef {object} KinesisCashContext
 * @property {KinesisCashLedgerImage[]} ledger
 * @property {ReconciliationSourceRow[]} sources
 * @property {ReconciliationBatchScopeRow[]} batches
 * @property {{ account_id: number }[]} [statementBalances]
 */

const fiat = new Set(["AUD", "CAD", "CHF", "EUR", "GBP", "SGD", "USD"]);
/** @param {unknown} value */
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** @param {unknown} value */
const currency = (value) =>
  String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/^C1USD$/, "USD");
/** @param {DecimalInput} value */
const rounded = (value) => toDecimal(value).toDecimalPlaces(4, 4).toFixed(4);
/**
 * @param {DecimalInput} left
 * @param {DecimalInput} right
 */
const equal = (left, right) =>
  left == null || right == null
    ? left == null && right == null
    : rounded(left) === rounded(right);
/** @param {{ raw_data?: string | null }} row */
export function cashReceipt(row) {
  try {
    return JSON.parse(row.raw_data)?.portfolioCashReceipt;
  } catch {
    return undefined;
  }
}
/**
 * @param {unknown} value
 * @returns {unknown}
 */
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [
              key,
              canonical(/** @type {Record<string, unknown>} */ (value)[key]),
            ]),
        )
      : value;
/** @param {Pick<ReconciliationSourceRow, "dedup_fingerprint" | "dedup_fingerprint_version">} row */
export const cashFeeFingerprint = (row) =>
  hash({
    kind: "kinesis_funding_fee",
    version: row.dedup_fingerprint_version,
    primary: row.dedup_fingerprint,
  });
/**
 * @param {unknown} left
 * @param {unknown} right
 */
export function cashImageEqual(left, right) {
  return left == null || right == null
    ? left == null && right == null
    : hash(canonical(left)) === hash(canonical(right));
}

/** Reparse all primary events before selecting any fiat movement.
 * @param {ReconciliationSourceRow[]} rows
 * @param {ReconciliationBatchScopeRow[]} batches
 * @param {string} fundingPolicy
 */
export function proveKinesisCashSources(rows, batches, fundingPolicy) {
  const evidence = proveKinesisAdoptionSources(rows, batches);
  const blockers = [...evidence.issues];
  const groups = [];
  const proofs = new Map();
  const seen = new Set();
  for (const batch of batches) {
    /** @type {KinesisCashMember[]} */
    const members = [];
    const scoped = rows.filter(
      (row) => Number(row.batch_id) === Number(batch.id),
    );
    /**
     * @param {ReconciliationSourceRow | undefined} row
     * @param {string} reason
     */
    const issue = (row, reason) =>
      blockers.push({
        reason,
        batchId: Number(batch.id),
        rowId: Number(row?.id ?? scoped[0]?.id ?? 0),
        rowOrdinal: (row?.row_index ?? 0) + 1,
        candidateTransactionIds: [],
      });
    if (evidence.issues.some((item) => item.batchId === Number(batch.id)))
      continue;
    try {
      for (const row of scoped) {
        const literal = evidence.literalProofs.get(Number(row.id));
        if (!literal) throw new Error("cash_source_unverified");
        const raw = parseCsvText(portfolioPrimaryRawData(row.raw_data), {
          columns: batch.custom_config.source_columns,
          skip_empty_lines: true,
        });
        if (raw.length !== 1) throw new Error("cash_source_unverified");
        const record = raw[0];
        const code = currency(record.Currency_Code);
        if (!fiat.has(code)) continue;
        const parsed = literal.parsed;
        const type = String(record.Transaction_Type).trim();
        const eventKind =
          type === "Trade"
            ? "trade_quote"
            : type === "Withdrawal(Card Payment)"
              ? "card_expense"
              : ["Deposit", "Withdrawal"].includes(type)
                ? "own_account_funding"
                : undefined;
        if (
          !eventKind ||
          (eventKind === "own_account_funding" &&
            fundingPolicy !== "own_account_transfer")
        )
          throw new Error(
            eventKind
              ? "cash_funding_confirmation_required"
              : "cash_source_unverified",
          );
        const start = toDecimal(String(record.Starting_Balance).trim());
        const close = toDecimal(String(record.Closing_Balance).trim());
        const delta = close.minus(start);
        const identity = assignImportIdentities([row], (source) =>
          portfolioIdentityBase(source, { accountIdentity: "UNASSIGNED" }),
        )[0];
        if (
          currency(record.Starting_Balance_Currency) !== code ||
          currency(record.Closing_Balance_Currency) !== code ||
          delta.eq(0) ||
          (type === "Deposit" && !delta.gt(0)) ||
          (type.startsWith("Withdrawal") && !delta.lt(0)) ||
          row.route !== "cash" ||
          row.type != null ||
          row.investment_id != null ||
          row.symbol_raw ||
          row.name_raw ||
          row.type_raw !== parsed.typeRaw ||
          row.units != null ||
          row.price_per_unit != null ||
          row.fx_rate_to_eur != null ||
          row.currency !== code ||
          parsed.currency !== code ||
          !equal(row.amount, delta.abs()) ||
          !equal(row.amount, parsed.amount) ||
          !equal(row.fees, parsed.fees) ||
          !equal(row.taxes, parsed.taxes) ||
          row.note !== parsed.note ||
          row.dedup_fingerprint !== identity.fingerprint ||
          row.dedup_fingerprint_version !== identity.version ||
          Number(row.dedup_occurrence) !== identity.occurrence
        )
          throw new Error("cash_source_changed");
        if (eventKind === "trade_quote") {
          const asset = scoped.filter((candidate) => {
            const item = evidence.literalProofs.get(
              Number(candidate.id),
            )?.parsed;
            if (!item || !["Buy", "Sell"].includes(item.typeRaw)) return false;
            const other = parseCsvText(
              portfolioPrimaryRawData(candidate.raw_data),
              { columns: batch.custom_config.source_columns },
            )[0];
            return (
              other.Order_ID === record.Order_ID &&
              other.DateTime === record.DateTime &&
              other.HIN === record.HIN
            );
          });
          if (!record.Order_ID || asset.length !== 1)
            throw new Error("cash_trade_pair_unverified");
        }
        const key = `${row.account_id}:${row.dedup_fingerprint_version}:${row.dedup_fingerprint}`;
        if (seen.has(key)) throw new Error("cash_source_ambiguous");
        seen.add(key);
        /** @type {KinesisCashValues} */
        const values = {
          date: row.tx_date,
          amount: rounded(delta),
          currency: code,
          accountId: Number(row.account_id),
          isTransfer: eventKind !== "card_expense",
          transferSource: "brokerage",
          transferPeerId: null,
        };
        let feeValues;
        const fee = toDecimal(String(record.Fee || "0").trim());
        if (
          eventKind === "own_account_funding" &&
          (fee.lt(0) ||
            (fee.eq(0) &&
              !delta.abs().eq(toDecimal(String(record.Amount).trim()).abs())))
        )
          throw new Error("cash_funding_fee_unverified");
        if (eventKind === "own_account_funding" && fee.gt(0)) {
          const principal = toDecimal(String(record.Amount).trim());
          if (
            type !== "Withdrawal" ||
            !principal.gt(0) ||
            currency(record.Fee_Currency) !== code ||
            !delta.abs().eq(principal.plus(fee)) ||
            rounded(delta.abs()) !==
              rounded(toDecimal(rounded(principal)).plus(rounded(fee))) ||
            delta.abs().toDecimalPlaces(2, 4).toFixed(2) !==
              principal
                .toDecimalPlaces(2, 4)
                .plus(fee.toDecimalPlaces(2, 4))
                .toFixed(2)
          )
            throw new Error("cash_funding_fee_unverified");
          values.amount = rounded(principal.negated());
          feeValues = {
            ...values,
            amount: rounded(fee.negated()),
            isTransfer: false,
          };
        }
        members.push({
          row,
          literal,
          record,
          start,
          close,
          delta,
          eventKind,
          values,
          feeValues,
        });
      }
      /** @type {Map<string, KinesisCashMember[]>} */
      const chains = new Map();
      for (const member of members) {
        const chain = chains.get(member.values.currency) ?? [];
        chain.push(member);
        chains.set(member.values.currency, chain);
      }
      for (const chain of chains.values()) {
        chain.sort(
          (a, b) =>
            String(a.record.DateTime).localeCompare(
              String(b.record.DateTime),
            ) || a.row.row_index - b.row.row_index,
        );
        if (
          !chain[0].start.eq(0) ||
          chain.some(
            (item, index) =>
              index > 0 && !item.start.eq(chain[index - 1].close),
          ) ||
          !toDecimal(
            chain.reduce((sum, item) => sum.plus(item.delta), toDecimal(0)),
          ).eq(chain.at(-1).close) ||
          rounded(
            chain.reduce(
              (sum, item) =>
                sum.plus(item.values.amount).plus(item.feeValues?.amount ?? 0),
              toDecimal(0),
            ),
          ) !== rounded(chain.at(-1).close)
        )
          throw new Error("cash_chain_not_closed");
      }
      const groupKey = hash({
        fileHash: batch.custom_config.kinesis_source_context.source_file_hash,
        account: batch.account_id,
        fundingPolicy,
        members: members.map((item) => ({
          event: item.literal.eventKey,
          start: item.start.toFixed(),
          close: item.close.toFixed(),
          values: item.values,
          feeValues: item.feeValues,
          kind: item.eventKind,
        })),
      });
      for (const member of members) {
        member.proof = {
          kind: "closed_kinesis_cash",
          groupKey,
          eventKey: member.literal.eventKey,
          eventKind: member.eventKind,
          fileHash: member.literal.sourceFileHash,
          memberCount: members.length,
          componentCount: member.feeValues ? 2 : 1,
        };
        proofs.set(Number(member.row.id), member.literal);
      }
      if (members.length) groups.push({ groupKey, members });
    } catch (error) {
      issue(undefined, error.message);
    }
  }
  return { groups, proofs, blockers };
}

/** Every existing fingerprint needs an owned, unchanged receipt from the same original file.
 * @param {object} input
 * @param {ReconciliationSourceRow[]} input.rows
 * @param {ReconciliationBatchScopeRow[]} input.batches
 * @param {KinesisCashContext} input.context
 * @param {string} input.fundingPolicy
 * @param {{ currency: string, date: string, rate: string | number | null }[]} [input.historicalFxContext]
 */
export function classifyKinesisCash({
  rows,
  batches,
  context,
  fundingPolicy,
  historicalFxContext = [],
}) {
  const proved = proveKinesisCashSources(rows, batches, fundingPolicy);
  const retained = proveKinesisCashSources(
    context.sources,
    context.batches,
    fundingPolicy,
  );
  const selected = [],
    records = [],
    blockers = [...proved.blockers];
  for (const group of proved.groups) {
    const groupActions = [],
      groupRecords = [];
    let valid = true,
      ready = true;
    for (const member of group.members) {
      const { row, values, proof } = member;
      const matching = context.ledger.filter(
        (current) =>
          current.dedup_fingerprint === row.dedup_fingerprint &&
          current.dedup_fingerprint_version === row.dedup_fingerprint_version,
      );
      /** @param {string} reason */
      const issue = (reason) => {
        valid = false;
        blockers.push({
          reason,
          batchId: Number(row.batch_id),
          rowId: Number(row.id),
          rowOrdinal: row.row_index + 1,
          candidateTransactionIds: [],
        });
      };
      if (
        values.currency !== "EUR" &&
        !historicalFxContext.some(
          (pair) =>
            pair.currency === values.currency &&
            pair.date === values.date &&
            Number(pair.rate) > 0,
        )
      )
        ready = false;
      if (matching.length) {
        const current = matching[0];
        const owners = context.sources.filter(
          (source) => cashReceipt(source)?.after?.id === Number(current.id),
        );
        const receipt = cashReceipt(owners[0] ?? {});
        if (
          matching.length !== 1 ||
          owners.length !== 1 ||
          !current.is_active ||
          receipt?.version !== 1 ||
          owners[0].status !== "committed" ||
          Number(owners[0].committed_txn_id) !== Number(current.id) ||
          !cashImageEqual(current, receipt.after) ||
          !cashImageEqual(proof, receipt.proof) ||
          owners[0].source_record_hash !== row.source_record_hash ||
          !retained.proofs.has(Number(owners[0].id)) ||
          !cashImageEqual(values, receipt.values) ||
          !cashImageEqual(member.feeValues, receipt.feeValues) ||
          (member.feeValues &&
            (!receipt.feeAfter ||
              !cashImageEqual(
                receipt.feeAfter,
                context.ledger.find((item) => item.id === receipt.feeAfter.id),
              ) ||
              receipt.feeAfter.id === current.id ||
              receipt.feeAfter.dedup_fingerprint !== cashFeeFingerprint(row)))
        ) {
          issue("cash_receipt_changed");
          continue;
        }
        groupActions.push({
          batchId: Number(row.batch_id),
          rowId: Number(row.id),
          rowOrdinal: row.row_index + 1,
          action: ["committed", "duplicate"].includes(row.status)
            ? "settled"
            : "duplicate",
          existingTransactionId: Number(current.id),
          ...(receipt.feeAfter
            ? { existingCashFeeTransactionId: receipt.feeAfter.id }
            : {}),
          cashProof: proof,
        });
      } else {
        if (
          row.status !== "matched" ||
          cashReceipt(row) ||
          context.ledger.some(
            (current) =>
              current.is_active &&
              current.account_id === row.account_id &&
              current.date === values.date &&
              current.currency === values.currency &&
              (equal(current.amount, values.amount) ||
                (member.feeValues &&
                  equal(current.amount, member.feeValues.amount))),
          )
        ) {
          issue("cash_existing_conflict");
          continue;
        }
        groupActions.push({
          batchId: Number(row.batch_id),
          rowId: Number(row.id),
          rowOrdinal: row.row_index + 1,
          action: "cash",
          cashValues: values,
          ...(member.feeValues ? { cashFeeValues: member.feeValues } : {}),
          cashProof: proof,
        });
        groupRecords.push(member);
      }
    }
    const ownedIds = new Set(
      groupActions.flatMap((action) =>
        "existingTransactionId" in action
          ? [
              action.existingTransactionId,
              action.existingCashFeeTransactionId,
            ].filter(Boolean)
          : [],
      ),
    );
    if (
      (context.statementBalances ?? []).some(
        (reading) =>
          Number(reading.account_id) ===
          Number(group.members[0].values.accountId),
      ) ||
      context.ledger.some(
        (current) =>
          current.is_active &&
          Number(current.account_id) ===
            Number(group.members[0].values.accountId) &&
          !ownedIds.has(Number(current.id)),
      )
    ) {
      valid = false;
      const row = group.members[0].row;
      blockers.push({
        reason: "cash_account_not_empty",
        batchId: Number(row.batch_id),
        rowId: Number(row.id),
        rowOrdinal: row.row_index + 1,
        candidateTransactionIds: [],
      });
    }
    if (valid && ready) {
      selected.push(...groupActions);
      records.push(...groupRecords);
    }
  }
  return {
    ...proved,
    blockers,
    selected: blockers.length ? [] : selected,
    records: blockers.length ? [] : records,
  };
}
