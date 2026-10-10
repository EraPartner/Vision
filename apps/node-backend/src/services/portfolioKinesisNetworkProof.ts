/** Literal native wallet operations supplement a complete broker statement. */
import { createHash } from "node:crypto";
import { toDecimal } from "../lib/money.ts";
import {
  parseCsvText,
  parseDateWithFormat,
  parseCustomAmount,
} from "./importPipeline/adapters/_shared.ts";
import { parsedDateToYmd } from "../lib/importDates.ts";
import {
  portfolioPrimaryRawData,
  recordedPortfolioPerformanceBasis,
  requiredStagedValue,
} from "./portfolioPerformanceReferenceEvidence.ts";
import type { PortfolioPerformanceUnit } from "./portfolioPerformanceReferenceEvidence.ts";
import { proveKinesisCorrectionSources } from "./portfolioKinesisAdoptionScope.ts";
import {
  assignImportIdentities,
  portfolioIdentityBase,
} from "./importIdentity.ts";

import { kinesisYieldReferenceDigest as hash } from "./portfolioKinesisYieldGroups.ts";
import type {
  KinesisBatchRow,
  KinesisSourceIssue,
  KinesisSourceRow,
} from "./portfolioKinesisAdoptionScope.ts";
import type {
  ReconciliationAdjustmentEvent,
  ReconciliationContext,
  ReconciliationHistoryEvent,
  ReconciliationReceiptContext,
  ReconciliationTransferEvent,
} from "../repositories/portfolioImportReconciliationRepository.ts";
import type { DecimalInput } from "../lib/money.ts";
import { batchConfigFields } from "../database/rows/portfolioImport.ts";
/** A Horizon transaction record as embedded in a receipt (validated before use). */
export interface HorizonTransaction {
  hash: string;
  successful: boolean;
  created_at: string;
  source_account: string;
  fee_account: string;
  fee_charged: string | number;
  operation_count: number;
  paging_token: string;
}
/**
 * A transaction record read from an untrusted history page. The typed fields
 * are the ones {@link operationFor} requires; the rest are only compared.
 */
interface HorizonHistoryTransaction {
  hash: string;
  successful: boolean;
  operation_count: number;
  fee_charged: string | number;
  created_at?: unknown;
  source_account?: unknown;
  fee_account?: unknown;
  paging_token?: unknown;
}
/** One fetched Horizon page; `body` is the literal untrusted response JSON. */
export interface HorizonPage {
  url: string;
  body: unknown;
}
export interface HorizonAccount {
  account_id: string;
  balances?: { asset_type: string; balance: string }[];
}
/** Portfolio Performance basis witness attached to a native gift receipt. */
export interface RecordedBasisWitness {
  id: string;
  date: string;
  sourceHash: string;
  literal: {
    date: string;
    type: string;
    transactionId: string;
    securityId: string;
    amountMinor: string;
    sharesMinor: string;
    currency: string;
    units: PortfolioPerformanceUnit[];
  };
}
/** Native wallet receipt as supplied in the generic source's Receipt_JSON cell. */
export interface KinesisNetworkReceipt {
  version: number;
  network: string;
  asset: string;
  transaction: HorizonTransaction;
  sourceHistoryPages: HorizonPage[];
  sourceAccount?: HorizonAccount;
  destinationAccount?: HorizonAccount;
  operation?: unknown;
  recordedBasisWitness?: RecordedBasisWitness;
}
export interface NativeGiftGroupProof {
  kind: string;
  memberSourceIds: string[];
  nativeReceiptHashes: string[];
  basisWitnessIds: string[];
  preservedTransactionId: number;
  associatedSourceId: string;
  preservedBefore: ReconciliationHistoryEvent;
  groupKey?: string;
}
/** `asset_transfer_details.nativeGiftGroupReceipt` as retained at commit. */
export interface NativeGiftGroupReceipt {
  version: number;
  proof: NativeGiftGroupProof;
  after: ReconciliationHistoryEvent[];
}
/** Exact witness binding recorded on a projected incoming custody row. */
export interface KinesisNetworkBinding {
  version: number;
  witnessRowId: number;
  witnessBatchId: number;
  witnessSourceHash: string | null | undefined;
  witnessFingerprint: string | null | undefined;
  receiptHash: string;
  originAccountId: number;
  destinationAccountId: number;
  primarySourceHash: string | null | undefined;
  primaryFingerprint: string | null | undefined;
  principal: string;
  feeUnits: string;
}
export interface KinesisNetworkBindingPlan {
  before: KinesisSourceRow;
  after: KinesisSourceRow;
  binding: KinesisNetworkBinding;
  witness: KinesisSourceRow;
}
export interface NativeGiftGroup {
  proof: NativeGiftGroupProof;
  members: KinesisSourceRow[];
}

// Decimal comparison throws on a NULL right side, as the JS original did.
const equal = (a: DecimalInput, b: DecimalInput) =>
  toDecimal(a).eq(requiredStagedValue(b));
const HOST_ASSETS: Record<string, string | undefined> = {
  "kau-mainnet.kinesisgroup.io": "KAU",
  "kag-mainnet.kinesisgroup.io": "KAG",
};
const hostAsset = (url: string) => HOST_ASSETS[new URL(url).hostname];
const day = (value: string | undefined) =>
  value !== undefined &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value))
    ? value.slice(0, 10)
    : undefined;
/** `value?.[key]` on untrusted JSON: a member of an object, else undefined. */
const member = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
// The fields operationFor needs before it can accept a history record.
const isHorizonHistoryTransaction = (
  value: unknown,
): value is HorizonHistoryTransaction =>
  isJsonRecord(value) &&
  typeof value.hash === "string" &&
  value.successful === true &&
  value.operation_count === 1 &&
  (typeof value.fee_charged === "string" ||
    typeof value.fee_charged === "number");
// String.prototype.localeCompare on the left side, as the original sort did.
const compareText = (a: unknown, b: unknown) => {
  if (typeof a !== "string") throw new Error("network_history_incomplete");
  return a.localeCompare(String(b));
};
// toDecimal(a).comparedTo(b) for paging tokens; other JSON types throw.
const comparePagingTokens = (a: unknown, b: unknown) => {
  if (
    (a !== null &&
      a !== undefined &&
      typeof a !== "string" &&
      typeof a !== "number") ||
    (typeof b !== "string" && typeof b !== "number")
  )
    throw new Error("network_history_incomplete");
  return toDecimal(a).comparedTo(b);
};
const financialTransaction = (tx: HorizonHistoryTransaction) => [
  tx.hash,
  tx.successful,
  tx.created_at,
  tx.source_account,
  tx.fee_account,
  String(tx.fee_charged),
  tx.operation_count,
];

function operationFor(
  transaction: HorizonHistoryTransaction,
  pages: HorizonPage[],
  asset: string,
) {
  const matches = pages.filter((page) => {
    const url = new URL(page.url);
    return (
      hostAsset(page.url) === asset &&
      url.pathname === `/transactions/${transaction.hash}/operations`
    );
  });
  if (
    matches.length !== 1 ||
    transaction.successful !== true ||
    transaction.operation_count !== 1 ||
    !/^[a-f0-9]{64}$/.test(transaction.hash) ||
    !/^\d+$/.test(String(transaction.fee_charged))
  )
    throw new Error("network_operation_unverified");
  const operations = member(member(matches[0]!.body, "_embedded"), "records");
  if (!Array.isArray(operations) || operations.length !== 1)
    throw new Error("network_operation_unverified");
  const op: unknown = operations[0];
  if (
    !isJsonRecord(op) ||
    op.transaction_successful !== true ||
    op.transaction_hash !== transaction.hash ||
    op.created_at !== transaction.created_at ||
    op.source_account !== transaction.source_account
  )
    throw new Error("network_operation_unverified");
  const principal =
    op.type === "payment" && op.asset_type === "native"
      ? op.amount
      : op.type === "create_account"
        ? op.starting_balance
        : undefined;
  const source = op.type === "payment" ? op.from : op.funder;
  const destination = op.type === "payment" ? op.to : op.account;
  if (
    !principal ||
    (typeof principal !== "string" && typeof principal !== "number") ||
    !toDecimal(principal).gt(0) ||
    !toDecimal(principal).times(10000000).isInteger() ||
    source !== op.source_account ||
    !destination ||
    source === destination
  )
    throw new Error("network_operation_unverified");
  return {
    op,
    principal: toDecimal(principal).toFixed(7),
    source,
    destination,
    fee: toDecimal(transaction.fee_charged).div(10000000).toFixed(7),
  };
}

/** Check exhausted native history, exact account balance, operation and fee payer. */
export function verifyKinesisNetworkReceipt(
  receipt: KinesisNetworkReceipt,
  kind: string,
) {
  if (
    receipt?.version !== 1 ||
    receipt.network !== "kinesis" ||
    !["KAU", "KAG"].includes(receipt.asset) ||
    !Array.isArray(receipt.sourceHistoryPages)
  )
    throw new Error("network_receipt_unverified");
  const { transaction: tx, sourceHistoryPages: pages, asset } = receipt;
  const account =
    kind === "gift" ? receipt.destinationAccount : receipt.sourceAccount;
  if (
    !account?.account_id ||
    !day(tx?.created_at) ||
    (kind === "gift"
      ? account.account_id === tx.source_account ||
        tx.fee_account === account.account_id
      : account.account_id !== tx.source_account ||
        tx.fee_account !== account.account_id)
  )
    throw new Error("network_fee_payer_unverified");
  const native = account.balances?.filter(
    (balance) => balance.asset_type === "native",
  );
  const [nativeBalance] = native ?? [];
  if (
    native?.length !== 1 ||
    !nativeBalance ||
    !toDecimal(nativeBalance.balance).isFinite() ||
    toDecimal(nativeBalance.balance).lt(0) ||
    !toDecimal(nativeBalance.balance).times(10000000).isInteger()
  )
    throw new Error("network_account_unverified");
  const starts = pages.filter((page) => {
    const url = new URL(page.url);
    return (
      hostAsset(page.url) === asset &&
      url.pathname === `/accounts/${account.account_id}/transactions` &&
      url.searchParams.get("order") === "desc" &&
      !url.searchParams.get("cursor")
    );
  });
  if (starts.length !== 1) throw new Error("network_history_incomplete");
  const seenPages = new Set<string>(),
    transactions: unknown[] = [];
  let page: HorizonPage | undefined = starts[0];
  while (page) {
    if (seenPages.has(page.url)) throw new Error("network_history_incomplete");
    seenPages.add(page.url);
    const records: unknown = member(member(page.body, "_embedded"), "records");
    if (!Array.isArray(records)) throw new Error("network_history_incomplete");
    if (!records.length) break;
    transactions.push(...(records as unknown[]));
    // An absent link makes `new URL` throw, which rejects the history.
    const next = String(
      member(member(member(page.body, "_links"), "next"), "href"),
    );
    const url = new URL(next);
    if (
      hostAsset(next) !== asset ||
      url.pathname !== `/accounts/${account.account_id}/transactions` ||
      url.searchParams.get("cursor") !==
        String(member(records.at(-1), "paging_token")) ||
      url.searchParams.get("order") !== "desc"
    )
      throw new Error("network_history_incomplete");
    const nextPages: HorizonPage[] = pages.filter(
      (candidate) => candidate.url === next,
    );
    if (nextPages.length !== 1) throw new Error("network_history_incomplete");
    page = nextPages[0];
  }
  if (
    !transactions.length ||
    new Set(transactions.map((item) => member(item, "hash"))).size !==
      transactions.length
  )
    throw new Error("network_history_incomplete");
  let balance = toDecimal(0);
  const operations = transactions.map((transaction) => {
    if (!isHorizonHistoryTransaction(transaction))
      throw new Error("network_operation_unverified");
    return { transaction, ...operationFor(transaction, pages, asset) };
  });
  const ordered = [...operations].sort(
    (a, b) =>
      compareText(a.transaction.created_at, b.transaction.created_at) ||
      comparePagingTokens(
        a.transaction.paging_token,
        b.transaction.paging_token,
      ),
  );
  const [opening] = ordered;
  if (
    !opening ||
    opening.op.type !== "create_account" ||
    opening.destination !== account.account_id
  )
    throw new Error("network_opening_unverified");
  for (const item of ordered) {
    if (item.destination === account.account_id)
      balance = balance.plus(item.principal);
    else if (item.source === account.account_id)
      balance = balance.minus(item.principal);
    else throw new Error("network_account_unverified");
    if (item.transaction.fee_account === account.account_id)
      balance = balance.minus(item.fee);
    if (balance.lt(0)) throw new Error("network_history_overdraw");
  }
  if (!balance.eq(nativeBalance.balance))
    throw new Error("network_balance_unverified");
  const listed = operations.filter((item) => item.transaction.hash === tx.hash);
  const [item] = listed;
  if (
    listed.length !== 1 ||
    !item ||
    JSON.stringify(financialTransaction(item.transaction)) !==
      JSON.stringify(financialTransaction(tx)) ||
    JSON.stringify(item.op) !== JSON.stringify(receipt.operation)
  )
    throw new Error("network_operation_unverified");
  if (
    kind === "gift"
      ? item.destination !== account.account_id ||
        item.source === account.account_id
      : item.source !== account.account_id ||
        !toDecimal(item.fee).gt(0) ||
        (kind === "asset_fee" && item.op.type !== "payment")
  )
    throw new Error("network_fee_payer_unverified");
  if (kind === "asset_fee") {
    const destination = receipt.destinationAccount;
    if (
      !destination?.account_id ||
      destination.account_id !== item.destination ||
      !destination.balances?.some((entry) => entry.asset_type === "native")
    )
      throw new Error("network_internal_destination_unverified");
  }
  return {
    asset,
    hash: tx.hash,
    date: day(tx.created_at),
    sourceAddress: item.source,
    destinationAddress: item.destination,
    units: kind === "asset_fee" ? item.fee : item.principal,
    principal: item.principal,
    feeUnits: kind === "gift" ? "0.0000000" : item.fee,
    receiptHash: hash(receipt),
  };
}

/** Re-read generic literal source rather than trusting mutable staging metadata. */
export function verifiedKinesisNetworkRow(row: KinesisSourceRow) {
  try {
    const config = batchConfigFields(row.custom_config) || {};
    const columns = config.source_columns;
    if (!Array.isArray(columns)) return undefined;
    const records = parseCsvText(
      portfolioPrimaryRawData(requiredStagedValue(row.raw_data)),
      {
        columns,
        skip_empty_lines: true,
      },
    );
    const [record] = records;
    if (records.length !== 1 || !record) return undefined;
    const mapping = config.column_mapping || {};
    // Every failure in this try, thrown or returned, rejects the row alike.
    const cell = (column: string | undefined) =>
      column === undefined ? undefined : record[column];
    const kind = cell(mapping.type);
    if (kind !== "asset_fee" && kind !== "asset_transfer_witness")
      return undefined;
    if (record.Receipt_JSON === undefined) return undefined;
    const receipt: KinesisNetworkReceipt = JSON.parse(record.Receipt_JSON);
    const proof = verifyKinesisNetworkReceipt(receipt, kind);
    const number = (field: keyof typeof mapping) => {
      const column = mapping[field];
      return column && record[column] !== ""
        ? parseCustomAmount(record[column], config.number_format, {
            rowNumber: 1,
            column,
          })
        : 0;
    };
    const dateCell = cell(mapping.date);
    if (dateCell === undefined || config.date_format === undefined)
      return undefined;
    if (
      cell(mapping.currency) !== proof.asset ||
      cell(mapping.symbol) !== proof.asset ||
      cell(mapping.source_id) !== proof.hash ||
      cell(mapping.source_account) !== proof.sourceAddress ||
      parsedDateToYmd(parseDateWithFormat(dateCell, config.date_format)) !==
        proof.date ||
      !equal(number("units"), proof.units) ||
      (["amount", "price", "fees", "taxes", "fx_rate"] as const).some(
        (field) => !toDecimal(number(field)).eq(0),
      ) ||
      (row.fx_rate_to_eur != null && !toDecimal(row.fx_rate_to_eur).eq(0))
    )
      return undefined;
    const [identity] = assignImportIdentities(
      [row],
      (source: KinesisSourceRow) =>
        portfolioIdentityBase(source, { accountIdentity: "UNASSIGNED" }),
    );
    if (
      !identity ||
      row.currency !== proof.asset ||
      row.dedup_fingerprint !== identity.fingerprint ||
      row.dedup_fingerprint_version !== identity.version ||
      Number(row.dedup_occurrence) !== identity.occurrence ||
      row.source_record_hash !==
        createHash("sha256")
          .update(portfolioPrimaryRawData(requiredStagedValue(row.raw_data)))
          .digest("hex") ||
      row.source_transaction_id !== proof.hash ||
      row.source_account_identity !== proof.sourceAddress ||
      row.symbol_raw !== proof.asset ||
      row.tx_date !== proof.date ||
      !equal(row.units, proof.units) ||
      (["amount", "price_per_unit", "fees", "taxes"] as const).some(
        (field) => !toDecimal(row[field] ?? 0).eq(0),
      )
    )
      return undefined;
    const details =
      kind === "asset_fee"
        ? row.asset_adjustment_details
        : row.asset_transfer_details;
    if (
      !details?.networkReceipt ||
      hash(details.networkReceipt) !== proof.receiptHash ||
      (kind === "asset_fee"
        ? row.route !== "asset_adjustment" ||
          details.kind !== "asset_fee" ||
          details.basisPolicy !== "carried"
        : row.route !== "account_internal" ||
          row.type != null ||
          row.type_raw !== "InternalMovement" ||
          details.direction !== "internal")
    )
      return undefined;
    return { proof, receipt, kind };
  } catch {
    return undefined;
  }
}

/** Exact native outbound witnesses identify one broker incoming custody event. */
export function proveKinesisNetworkBindings(
  rows: KinesisSourceRow[],
  batches: KinesisBatchRow[],
  history: ReconciliationHistoryEvent[],
  context: ReconciliationContext = { sources: [], batches: [] },
) {
  const overrides = new Map<number, KinesisSourceRow>(),
    bindings: KinesisNetworkBindingPlan[] = [],
    blockers: KinesisSourceIssue[] = [];
  const selected = rows.filter(
    (row) =>
      row.asset_transfer_details?.networkReceipt ||
      row.asset_adjustment_details?.networkReceipt,
  );
  const witnesses = [
    ...selected,
    ...context.sources.filter(
      (row) => row.asset_transfer_details?.networkReceipt,
    ),
  ];
  const kmsBatches = batches.filter(
    (batch) =>
      batchConfigFields(batch.custom_config)?.format ===
      "kinesis_transaction_history",
  );
  const ids = new Set(kmsBatches.map((batch) => Number(batch.id)));
  const primaryRows = rows.filter((row) => ids.has(Number(row.batch_id)));
  const evidence = proveKinesisCorrectionSources(primaryRows, kmsBatches);
  const incoming = primaryRows.filter(
    (row) =>
      evidence.literalProofs.get(Number(row.id))?.parsed.assetTransfer
        ?.direction === "in" &&
      /^[a-f0-9]{64}$/.test(row.source_transaction_id ?? ""),
  );
  const issue = (row: KinesisSourceRow, reason: string) =>
    blockers.push({
      reason,
      rowId: Number(row.id),
      batchId: Number(row.batch_id),
      rowOrdinal: row.row_index + 1,
      candidateTransactionIds: [],
    });
  for (const row of selected) {
    const verified = verifiedKinesisNetworkRow(row);
    if (!verified) {
      issue(row, "network_receipt_unverified");
      continue;
    }
    if (verified.kind === "asset_fee") {
      const matches = history.filter(
        (current) =>
          current.dedup_fingerprint === row.dedup_fingerprint &&
          current.dedup_fingerprint_version === row.dedup_fingerprint_version,
      );
      const [match] = matches;
      if (
        match &&
        (matches.length !== 1 ||
          match.type !== "asset_adjustment" ||
          (match as ReconciliationAdjustmentEvent).adjustment_kind !==
            "asset_fee" ||
          Number(match.account_id) !== Number(row.account_id) ||
          Number(match.investment_id) !== Number(row.investment_id) ||
          match.date !== row.tx_date ||
          !equal(match.units, row.units) ||
          match.source_record_hash !== row.source_record_hash)
      )
        issue(row, "network_receipt_changed");
    }
  }
  for (const row of incoming) {
    const proof = evidence.literalProofs.get(Number(row.id));
    const matches = witnesses.filter(
      (witness) =>
        witness.source_transaction_id === row.source_transaction_id &&
        witness.route === "account_internal",
    );
    // Every incoming row was selected for its literal proof.
    if (!proof || !matches.length) continue;
    // Internal documentary rows intentionally skip instrument matching. Only
    // one verified broker event may supply that missing instrument binding.
    const peers = incoming.filter(
      (peer) => peer.source_transaction_id === row.source_transaction_id,
    );
    if (peers.length !== 1) {
      issue(row, "network_witness_ambiguous");
      continue;
    }
    const unique = [
      ...new Map(
        matches.map((witness) => [
          `${witness.account_id}:${witness.investment_id}:${witness.source_record_hash}:${witness.dedup_fingerprint}`,
          witness,
        ]),
      ).values(),
    ];
    const [witness] = unique;
    if (unique.length !== 1 || !witness) {
      issue(row, "network_witness_ambiguous");
      continue;
    }
    const verified = verifiedKinesisNetworkRow(witness);
    const retainedWitness = context.sources.some(
      (item) => Number(item.id) === Number(witness.id),
    );
    const witnessBatch = [...context.batches, ...batches].find(
      (item) => Number(item.id) === Number(witness.batch_id),
    );
    if (
      retainedWitness &&
      (witness.status !== "duplicate" ||
        (witnessBatch != null &&
          ["aborted", "failed"].includes(witnessBatch.status)))
    ) {
      issue(row, "network_receipt_changed");
      continue;
    }
    if (
      !verified ||
      verified.kind !== "asset_transfer_witness" ||
      Number(witness.account_id) <= 0 ||
      Number(witness.account_id) === Number(row.account_id) ||
      (batchConfigFields(row.custom_config)?.transfer_origin_account_id !=
        null &&
        Number(
          batchConfigFields(row.custom_config)!.transfer_origin_account_id,
        ) !== Number(witness.account_id)) ||
      !Number.isSafeInteger(Number(row.investment_id)) ||
      Number(row.investment_id) <= 0 ||
      (witness.investment_id == null &&
        (!Number.isSafeInteger(Number(row.resolved_investment_id)) ||
          Number(row.resolved_investment_id) <= 0 ||
          Number(row.resolved_investment_id) !== Number(row.investment_id))) ||
      (row.user_override_investment_id != null &&
        Number(row.user_override_investment_id) !==
          Number(row.resolved_investment_id)) ||
      (witness.investment_id != null &&
        Number(witness.investment_id) !== Number(row.investment_id)) ||
      verified.proof.asset !== row.symbol_raw ||
      verified.proof.date !== row.tx_date ||
      !equal(verified.proof.principal, proof.parsed.units) ||
      evidence.issues.length
    ) {
      issue(row, "network_witness_unverified");
      continue;
    }
    const binding: KinesisNetworkBinding = {
      version: 1,
      witnessRowId: Number(witness.id),
      witnessBatchId: Number(witness.batch_id),
      witnessSourceHash: witness.source_record_hash,
      witnessFingerprint: witness.dedup_fingerprint,
      receiptHash: verified.proof.receiptHash,
      originAccountId: Number(witness.account_id),
      destinationAccountId: Number(row.account_id),
      primarySourceHash: row.source_record_hash,
      primaryFingerprint: row.dedup_fingerprint,
      principal: verified.proof.principal,
      feeUnits: verified.proof.feeUnits,
    };
    const details = {
      direction: "in",
      basisStatus: "carried",
      feeUnits: verified.proof.feeUnits,
      networkBinding: binding,
    };
    const projected: KinesisSourceRow = {
      ...row,
      route: "asset_transfer",
      type: null,
      type_raw: "AssetTransfer",
      units: toDecimal(binding.principal).plus(binding.feeUnits).toFixed(8),
      // A primary row of a Kinesis batch, so its config is an object.
      custom_config: {
        ...batchConfigFields(row.custom_config),
        transfer_origin_account_id: binding.originAccountId,
      },
      asset_transfer_details: details,
    };
    const owners = context.sources.filter(
      (owner) =>
        owner.asset_transfer_details?.networkBinding?.primaryFingerprint ===
        row.dedup_fingerprint,
    );
    const canonical = history.filter(
      (current) =>
        current.dedup_fingerprint === row.dedup_fingerprint &&
        current.dedup_fingerprint_version === row.dedup_fingerprint_version,
    );
    if (owners.length || canonical.length) {
      const [owner] = owners,
        [current] = canonical;
      if (
        owners.length !== 1 ||
        canonical.length !== 1 ||
        !owner ||
        !current ||
        owner.status !== "committed" ||
        owner.source_record_hash !== row.source_record_hash ||
        // The owners filter matched this binding, so the details are present.
        hash(owner.asset_transfer_details!.networkBinding) !== hash(binding) ||
        current.type !== "asset_transfer" ||
        Number((current as ReconciliationTransferEvent).staging_row_id) !==
          Number(owner.id) ||
        Number(current.import_batch_id) !== Number(owner.batch_id) ||
        Number((current as ReconciliationTransferEvent).source_account_id) !==
          binding.originAccountId ||
        Number(
          (current as ReconciliationTransferEvent).destination_account_id,
        ) !== binding.destinationAccountId ||
        Number(current.investment_id) !== Number(row.investment_id) ||
        current.date !== row.tx_date ||
        !equal(current.units, projected.units) ||
        !equal(
          (current as ReconciliationTransferEvent).fee_units,
          binding.feeUnits,
        ) ||
        current.source_record_hash !== row.source_record_hash
      ) {
        issue(row, "network_receipt_changed");
        continue;
      }
    }
    overrides.set(Number(row.id), projected);
    if (row.status === "matched" && !canonical.length)
      bindings.push({ before: row, after: projected, binding, witness });
  }
  return { overrides, bindings, blockers };
}

function verifiedNativeGiftRow(row: KinesisSourceRow) {
  try {
    if (row.route !== "portfolio" || row.type !== "gift") return undefined;
    const config = batchConfigFields(row.custom_config) ?? {},
      mapping = config.column_mapping ?? {};
    const records = parseCsvText(
      portfolioPrimaryRawData(requiredStagedValue(row.raw_data)),
      {
        columns: config.source_columns,
        skip_empty_lines: true,
      },
    );
    const [raw] = records;
    // Every failure in this try, thrown or returned, rejects the row alike.
    const cell = (column: string | undefined) =>
      column === undefined ? undefined : raw?.[column];
    if (
      records.length !== 1 ||
      !raw ||
      cell(mapping.type) !== "gift" ||
      !raw.Receipt_JSON
    )
      return undefined;
    const receipt: KinesisNetworkReceipt = JSON.parse(raw.Receipt_JSON),
      proof = verifyKinesisNetworkReceipt(receipt, "gift");
    const witness = receipt.recordedBasisWitness,
      literal = witness?.literal;
    if (
      !witness ||
      !literal ||
      !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/.test(
        literal.date ?? "",
      ) ||
      !Number.isFinite(Date.parse(literal.date)) ||
      witness.date !== literal.date.slice(0, 10) ||
      literal.type !== "DELIVERY_INBOUND" ||
      witness.id !== literal.transactionId ||
      !literal.securityId ||
      !/^[a-f0-9]{64}$/.test(witness.sourceHash ?? "") ||
      !/^\d+$/.test(literal.amountMinor ?? "") ||
      !/^\d+$/.test(literal.sharesMinor ?? "") ||
      !Array.isArray(literal.units)
    )
      return undefined;
    const basis = recordedPortfolioPerformanceBasis({
      amount: toDecimal(literal.amountMinor).div(100).toString(),
      currency: literal.currency,
      units: literal.units,
    });
    const [identity] = assignImportIdentities(
      [row],
      (source: KinesisSourceRow) =>
        portfolioIdentityBase(source, { accountIdentity: "UNASSIGNED" }),
    );
    const number = (field: keyof typeof mapping) => {
      const column = mapping[field];
      return column && raw[column] !== ""
        ? parseCustomAmount(raw[column], config.number_format, {
            rowNumber: 1,
            column,
          })
        : 0;
    };
    const dateCell = cell(mapping.date);
    if (!identity || dateCell === undefined || config.date_format === undefined)
      return undefined;
    if (
      !basis ||
      !toDecimal(basis.amount).gt("0.01") ||
      basis.currency !== row.currency ||
      !equal(row.amount, basis.amount) ||
      !equal(toDecimal(literal.sharesMinor).div(100000000), proof.principal) ||
      cell(mapping.currency) !== basis.currency ||
      cell(mapping.symbol) !== proof.asset ||
      cell(mapping.source_id) !== proof.hash ||
      cell(mapping.source_account) !== proof.sourceAddress ||
      parsedDateToYmd(parseDateWithFormat(dateCell, config.date_format)) !==
        proof.date ||
      !equal(number("units"), proof.principal) ||
      !equal(number("amount"), basis.amount) ||
      (["fees", "taxes", "fx_rate"] as const).some(
        (field) => !toDecimal(number(field)).eq(0),
      ) ||
      row.source_record_hash !==
        createHash("sha256")
          .update(portfolioPrimaryRawData(requiredStagedValue(row.raw_data)))
          .digest("hex") ||
      row.dedup_fingerprint !== identity.fingerprint ||
      row.dedup_fingerprint_version !== identity.version ||
      Number(row.dedup_occurrence) !== identity.occurrence ||
      row.source_transaction_id !== proof.hash ||
      row.source_account_identity !== proof.sourceAddress ||
      row.symbol_raw !== proof.asset ||
      row.tx_date !== proof.date ||
      !equal(row.units, proof.principal) ||
      !toDecimal(row.fees ?? 0).eq(0) ||
      !toDecimal(row.taxes ?? 0).eq(0) ||
      row.fx_rate_to_eur != null ||
      (row.price_per_unit != null && !toDecimal(row.price_per_unit).eq(0)) ||
      !toDecimal(number("price")).eq(0) ||
      row.note !== String(cell(mapping.note) ?? "").trim()
    )
      return undefined;
    return { row, receipt, proof, witness, basis };
  } catch {
    return undefined;
  }
}

export type NativeGiftMember = NonNullable<
  ReturnType<typeof verifiedNativeGiftRow>
>;

/**
 * One literal history operation that delivered this gift's principal to the
 * gift account. A record the original optional-chain reads would fault on
 * (a missing record, a non-text date, a non-numeric amount) throws instead,
 * which rejects the whole group as before.
 */
function isOriginalIncomingGift(
  item: unknown,
  date: string | undefined,
  account: string | undefined,
  principal: string,
): item is Record<string, unknown> {
  if (item === null || item === undefined)
    throw new Error("network_gift_receipt_changed");
  if (!isJsonRecord(item) || !item.transaction_hash) return false;
  const created = item.created_at;
  if (typeof created !== "string") {
    if (created == null || Array.isArray(created)) return false;
    throw new Error("network_gift_receipt_changed");
  }
  if (created.slice(0, 10) !== date || (item.to ?? item.account) !== account)
    return false;
  const amount = item.amount ?? item.starting_balance;
  if (
    amount != null &&
    typeof amount !== "string" &&
    typeof amount !== "number"
  )
    throw new Error("network_gift_receipt_changed");
  return equal(amount, principal);
}

/** Closed cardinality associates equivalent daily gifts; it does not infer an individual legacy identity. */
export function proveKinesisNativeGiftGroups(
  rows: KinesisSourceRow[],
  batches: KinesisBatchRow[],
  history: ReconciliationHistoryEvent[],
  context: ReconciliationReceiptContext = {
    receipts: [],
    sources: [],
    batches: [],
  },
) {
  const candidates = new Map<number, ReconciliationHistoryEvent[]>(),
    groups: NativeGiftGroup[] = [],
    blockers: KinesisSourceIssue[] = [];
  const selected = rows.filter(
    (row) =>
      row.type === "gift" &&
      batchConfigFields(row.custom_config)?.column_mapping &&
      batchConfigFields(row.custom_config)?.source_columns?.includes(
        "Receipt_JSON",
      ),
  );
  const issue = (row: KinesisSourceRow, reason: string) =>
    blockers.push({
      reason,
      rowId: Number(row.id),
      batchId: Number(row.batch_id),
      rowOrdinal: row.row_index + 1,
      candidateTransactionIds: [],
    });
  const grouped = new Map<string, NativeGiftMember[]>();
  for (const row of selected) {
    const member = verifiedNativeGiftRow(row);
    if (!member) {
      issue(row, "network_gift_unverified");
      continue;
    }
    const key = [
      member.proof.asset,
      member.proof.date,
      member.proof.principal,
      row.account_id,
      row.investment_id,
      member.basis.currency,
      member.basis.amount,
    ].join(":");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(member);
  }
  for (const members of grouped.values()) {
    try {
      members.sort(
        (a, b) =>
          a.receipt.transaction.created_at.localeCompare(
            b.receipt.transaction.created_at,
          ) || a.proof.hash.localeCompare(b.proof.hash),
      );
      // A group holds at least the member that created it.
      const first = members[0]!,
        batch = batches.find(
          (item) => Number(item.id) === Number(first.row.batch_id),
        );
      const originalIncoming = first.receipt.sourceHistoryPages
        .flatMap(
          (page): unknown =>
            member(member(page.body, "_embedded"), "records") ?? [],
        )
        .filter((item) =>
          isOriginalIncomingGift(
            item,
            first.proof.date,
            // verifyKinesisNetworkReceipt required this gift account.
            first.receipt.destinationAccount?.account_id,
            first.proof.principal,
          ),
        );
      const memberIds = members.map((member) => member.proof.hash);
      if (
        members.length !== 2 ||
        new Set(memberIds).size !== 2 ||
        new Set(members.map((member) => member.witness.id)).size !== 2 ||
        new Set(members.map((member) => member.witness.literal.securityId))
          .size !== 1 ||
        new Set(members.map((member) => member.witness.sourceHash)).size !==
          1 ||
        new Set(members.map((member) => member.witness.literal.date)).size !==
          1 ||
        new Set(originalIncoming.map((item) => item.transaction_hash)).size !==
          2 ||
        originalIncoming.some(
          (item) => !memberIds.some((id) => id === item.transaction_hash),
        ) ||
        !batch ||
        Number(batch.rows_total) !==
          rows.filter((row) => Number(row.batch_id) === Number(batch.id))
            .length ||
        batchConfigFields(batch.custom_config)?.included_symbols?.length ||
        members.some(
          (member) =>
            Number(member.row.batch_id) !== Number(batch.id) ||
            hash(member.receipt.destinationAccount) !==
              hash(first.receipt.destinationAccount),
        )
      ) {
        for (const member of members)
          issue(member.row, "network_gift_group_incomplete");
        continue;
      }
      const matching = (current: ReconciliationHistoryEvent) =>
        current.type === "gift" &&
        current.date === first.proof.date &&
        Number(current.investment_id) === Number(first.row.investment_id) &&
        Number(current.account_id) === Number(first.row.account_id) &&
        current.currency === first.basis.currency &&
        equal(current.amount, first.basis.amount) &&
        equal(current.units, first.proof.principal) &&
        toDecimal(current.fees ?? 0).eq(0) &&
        toDecimal(current.taxes ?? 0).eq(0) &&
        !current.is_recurring &&
        current.recurrence_interval == null &&
        current.recurrence_end_date == null;
      const owned = members.flatMap((member) =>
        history
          .filter(
            (current) =>
              current.dedup_fingerprint === member.row.dedup_fingerprint &&
              current.dedup_fingerprint_version ===
                member.row.dedup_fingerprint_version,
          )
          .map((current) => ({ member, current })),
      );
      const manuals = history.filter(
        (current) =>
          matching(current) &&
          current.import_batch_id == null &&
          current.source_record_hash == null &&
          current.dedup_fingerprint == null,
      );
      if (
        (!owned.length && manuals.length !== 1) ||
        (owned.length && owned.length !== 2) ||
        manuals.length > 1 ||
        owned.some(
          ({ member, current }) =>
            !matching(current) ||
            current.source_record_hash !== member.row.source_record_hash,
        ) ||
        new Set(owned.map((item) => Number(item.current.id))).size !==
          owned.length ||
        (owned.length && manuals.length)
      ) {
        for (const member of members)
          issue(member.row, "network_gift_group_contested");
        continue;
      }
      let preserved = manuals[0];
      let manifest: NativeGiftGroupReceipt | undefined;
      for (const { member, current } of owned) {
        const owners = context.sources.filter(
          (source) =>
            source.dedup_fingerprint === member.row.dedup_fingerprint &&
            source.dedup_fingerprint_version ===
              member.row.dedup_fingerprint_version &&
            source.source_record_hash === member.row.source_record_hash,
        );
        const owner = owners[0],
          receipt: NativeGiftGroupReceipt | undefined =
            owner?.asset_transfer_details?.nativeGiftGroupReceipt;
        const ownerBatch = context.batches.find(
          (item) => Number(item.id) === Number(owner?.batch_id),
        );
        if (
          owners.length !== 1 ||
          !owner ||
          !ownerBatch ||
          !["complete", "complete_with_errors"].includes(ownerBatch.status) ||
          receipt?.version !== 1 ||
          receipt.proof?.kind !== "closed_native_gift_cardinality" ||
          !Array.isArray(receipt.proof.memberSourceIds) ||
          hash(receipt.proof.memberSourceIds) !== hash(memberIds) ||
          !Array.isArray(receipt.after) ||
          receipt.after.length !== 2 ||
          receipt.after.some(
            (image) => !image || !Number.isSafeInteger(Number(image.id)),
          ) ||
          new Set(receipt.after.map((image) => Number(image.id))).size !== 2 ||
          receipt.after.some((image) => {
            const actual = owned.find(
              (item) => Number(item.current.id) === Number(image.id),
            );
            return !actual || hash(actual.current) !== hash(image);
          }) ||
          !receipt.proof.preservedBefore ||
          !matching(receipt.proof.preservedBefore) ||
          Number(receipt.proof.preservedTransactionId) !==
            Number(receipt.proof.preservedBefore.id) ||
          receipt.proof.associatedSourceId !== first.proof.hash ||
          portfolioPrimaryRawData(owner.raw_data) !==
            portfolioPrimaryRawData(member.row.raw_data) ||
          hash(batchConfigFields(owner.custom_config)?.column_mapping) !==
            hash(batchConfigFields(member.row.custom_config)?.column_mapping) ||
          hash(batchConfigFields(owner.custom_config)?.source_columns) !==
            hash(batchConfigFields(member.row.custom_config)?.source_columns) ||
          hash(batchConfigFields(owner.custom_config)?.number_format) !==
            hash(batchConfigFields(member.row.custom_config)?.number_format) ||
          hash(batchConfigFields(owner.custom_config)?.date_format) !==
            hash(batchConfigFields(member.row.custom_config)?.date_format) ||
          (manifest && hash(manifest) !== hash(receipt))
        )
          throw new Error("network_gift_receipt_changed");
        manifest = receipt;
        preserved = receipt.proof.preservedBefore;
        if (current.import_batch_id != null) {
          if (
            owner.status !== "committed" ||
            Number(owner.committed_txn_id) !== Number(current.id) ||
            Number(owner.batch_id) !== Number(current.import_batch_id)
          )
            throw new Error("network_gift_receipt_changed");
        } else {
          const receipts = context.receipts.filter(
            (item) =>
              Number(item.transaction_id) === Number(current.id) &&
              Number(item.batch_id) === Number(owner.batch_id) &&
              Number(item.staging_row_id) === Number(owner.id),
          );
          const [adoption] = receipts;
          if (
            receipts.length !== 1 ||
            !adoption ||
            adoption.policy !== "prefer_source" ||
            owner.status !== "duplicate" ||
            hash(adoption.after_data) !== hash(current) ||
            hash(adoption.before_data) !== hash(preserved)
          )
            throw new Error("network_gift_receipt_changed");
        }
      }
      // Unowned groups have exactly one manual; owned ones set it above.
      if (!preserved) throw new Error("network_gift_receipt_changed");
      const proof: NativeGiftGroupProof = {
        kind: "closed_native_gift_cardinality",
        memberSourceIds: memberIds,
        nativeReceiptHashes: members.map((member) => member.proof.receiptHash),
        basisWitnessIds: members.map((member) => member.witness.id),
        preservedTransactionId: Number(preserved.id),
        associatedSourceId: first.proof.hash,
        preservedBefore: preserved,
      };
      proof.groupKey = hash(proof);
      if (manifest && hash(manifest.proof) !== hash(proof))
        throw new Error("network_gift_receipt_changed");
      for (const member of members)
        candidates.set(
          Number(member.row.id),
          !owned.length && member === first ? [preserved] : [],
        );
      if (!owned.length)
        groups.push({ proof, members: members.map((member) => member.row) });
    } catch {
      for (const member of members)
        issue(member.row, "network_gift_receipt_changed");
    }
  }
  return { candidates, groups, blockers };
}
