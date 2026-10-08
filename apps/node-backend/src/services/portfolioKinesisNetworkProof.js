/** Literal native wallet operations supplement a complete broker statement. */
import { createHash } from "node:crypto";
import { toDecimal } from "../lib/money.ts";
import {
  parseCsvText,
  parseDateWithFormat,
  parseCustomAmount,
} from "./importPipeline/adapters/_shared.js";
import { parsedDateToYmd } from "../lib/importDates.ts";
import {
  portfolioPrimaryRawData,
  recordedPortfolioPerformanceBasis,
} from "./portfolioPerformanceReferenceEvidence.js";
import { proveKinesisCorrectionSources } from "./portfolioKinesisAdoptionScope.js";
import {
  assignImportIdentities,
  portfolioIdentityBase,
} from "./importIdentity.js";

import { kinesisYieldReferenceDigest as hash } from "./portfolioKinesisYieldGroups.js";
const equal = (a, b) => toDecimal(a).eq(b);
const hostAsset = (url) =>
  ({
    "kau-mainnet.kinesisgroup.io": "KAU",
    "kag-mainnet.kinesisgroup.io": "KAG",
  })[new URL(url).hostname];
const day = (value) =>
  /^\d{4}-\d{2}-\d{2}T/.test(value ?? "") && Number.isFinite(Date.parse(value))
    ? value.slice(0, 10)
    : undefined;
const financialTransaction = (tx) => [
  tx.hash,
  tx.successful,
  tx.created_at,
  tx.source_account,
  tx.fee_account,
  String(tx.fee_charged),
  tx.operation_count,
];

function operationFor(transaction, pages, asset) {
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
  const operations = matches[0].body?._embedded?.records;
  if (!Array.isArray(operations) || operations.length !== 1)
    throw new Error("network_operation_unverified");
  const op = operations[0];
  if (
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
export function verifyKinesisNetworkReceipt(receipt, kind) {
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
  if (
    native?.length !== 1 ||
    !toDecimal(native[0].balance).isFinite() ||
    toDecimal(native[0].balance).lt(0) ||
    !toDecimal(native[0].balance).times(10000000).isInteger()
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
  const seenPages = new Set(),
    transactions = [];
  let page = starts[0];
  while (page) {
    if (seenPages.has(page.url)) throw new Error("network_history_incomplete");
    seenPages.add(page.url);
    const records = page.body?._embedded?.records;
    if (!Array.isArray(records)) throw new Error("network_history_incomplete");
    if (!records.length) break;
    transactions.push(...records);
    const next = page.body?._links?.next?.href;
    const url = new URL(next);
    if (
      hostAsset(next) !== asset ||
      url.pathname !== `/accounts/${account.account_id}/transactions` ||
      url.searchParams.get("cursor") !== String(records.at(-1).paging_token) ||
      url.searchParams.get("order") !== "desc"
    )
      throw new Error("network_history_incomplete");
    const nextPages = pages.filter((candidate) => candidate.url === next);
    if (nextPages.length !== 1) throw new Error("network_history_incomplete");
    page = nextPages[0];
  }
  if (
    !transactions.length ||
    new Set(transactions.map((item) => item.hash)).size !== transactions.length
  )
    throw new Error("network_history_incomplete");
  let balance = toDecimal(0);
  const operations = transactions.map((transaction) => ({
    transaction,
    ...operationFor(transaction, pages, asset),
  }));
  const ordered = [...operations].sort(
    (a, b) =>
      a.transaction.created_at.localeCompare(b.transaction.created_at) ||
      toDecimal(a.transaction.paging_token).comparedTo(
        b.transaction.paging_token,
      ),
  );
  if (
    ordered[0].op.type !== "create_account" ||
    ordered[0].destination !== account.account_id
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
  if (!balance.eq(native[0].balance))
    throw new Error("network_balance_unverified");
  const listed = operations.filter((item) => item.transaction.hash === tx.hash);
  if (
    listed.length !== 1 ||
    JSON.stringify(financialTransaction(listed[0].transaction)) !==
      JSON.stringify(financialTransaction(tx)) ||
    JSON.stringify(listed[0].op) !== JSON.stringify(receipt.operation)
  )
    throw new Error("network_operation_unverified");
  const item = listed[0];
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
export function verifiedKinesisNetworkRow(row) {
  try {
    const config = row.custom_config || {};
    const columns = config.source_columns;
    if (!Array.isArray(columns)) return undefined;
    const records = parseCsvText(portfolioPrimaryRawData(row.raw_data), {
      columns,
      skip_empty_lines: true,
    });
    if (records.length !== 1) return undefined;
    const record = records[0],
      mapping = config.column_mapping || {};
    const kind = record[mapping.type];
    if (!["asset_fee", "asset_transfer_witness"].includes(kind))
      return undefined;
    const receipt = JSON.parse(record.Receipt_JSON);
    const proof = verifyKinesisNetworkReceipt(receipt, kind);
    const number = (field) =>
      mapping[field] && record[mapping[field]] !== ""
        ? parseCustomAmount(record[mapping[field]], config.number_format, {
            rowNumber: 1,
            column: mapping[field],
          })
        : 0;
    if (
      record[mapping.currency] !== proof.asset ||
      record[mapping.symbol] !== proof.asset ||
      record[mapping.source_id] !== proof.hash ||
      record[mapping.source_account] !== proof.sourceAddress ||
      parsedDateToYmd(
        parseDateWithFormat(record[mapping.date], config.date_format),
      ) !== proof.date ||
      !equal(number("units"), proof.units) ||
      ["amount", "price", "fees", "taxes", "fx_rate"].some(
        (field) => !toDecimal(number(field)).eq(0),
      ) ||
      (row.fx_rate_to_eur != null && !toDecimal(row.fx_rate_to_eur).eq(0))
    )
      return undefined;
    const identity = assignImportIdentities([row], (source) =>
      portfolioIdentityBase(source, { accountIdentity: "UNASSIGNED" }),
    )[0];
    if (
      row.currency !== proof.asset ||
      row.dedup_fingerprint !== identity.fingerprint ||
      row.dedup_fingerprint_version !== identity.version ||
      Number(row.dedup_occurrence) !== identity.occurrence ||
      row.source_record_hash !==
        createHash("sha256")
          .update(portfolioPrimaryRawData(row.raw_data))
          .digest("hex") ||
      row.source_transaction_id !== proof.hash ||
      row.source_account_identity !== proof.sourceAddress ||
      row.symbol_raw !== proof.asset ||
      row.tx_date !== proof.date ||
      !equal(row.units, proof.units) ||
      ["amount", "price_per_unit", "fees", "taxes"].some(
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
  rows,
  batches,
  history,
  context = { sources: [], batches: [] },
) {
  const overrides = new Map(),
    bindings = [],
    blockers = [];
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
    (batch) => batch.custom_config?.format === "kinesis_transaction_history",
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
  const issue = (row, reason) =>
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
      if (
        matches.length &&
        (matches.length !== 1 ||
          matches[0].type !== "asset_adjustment" ||
          matches[0].adjustment_kind !== "asset_fee" ||
          Number(matches[0].account_id) !== Number(row.account_id) ||
          Number(matches[0].investment_id) !== Number(row.investment_id) ||
          matches[0].date !== row.tx_date ||
          !equal(matches[0].units, row.units) ||
          matches[0].source_record_hash !== row.source_record_hash)
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
    if (!matches.length) continue;
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
    if (unique.length !== 1) {
      issue(row, "network_witness_ambiguous");
      continue;
    }
    const witness = unique[0],
      verified = verifiedKinesisNetworkRow(witness);
    const retainedWitness = context.sources.some(
      (item) => Number(item.id) === Number(witness.id),
    );
    const witnessBatch = [...context.batches, ...batches].find(
      (item) => Number(item.id) === Number(witness.batch_id),
    );
    if (
      retainedWitness &&
      (witness.status !== "duplicate" ||
        ["aborted", "failed"].includes(witnessBatch?.status))
    ) {
      issue(row, "network_receipt_changed");
      continue;
    }
    if (
      !verified ||
      verified.kind !== "asset_transfer_witness" ||
      Number(witness.account_id) <= 0 ||
      Number(witness.account_id) === Number(row.account_id) ||
      (row.custom_config?.transfer_origin_account_id != null &&
        Number(row.custom_config.transfer_origin_account_id) !==
          Number(witness.account_id)) ||
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
    const binding = {
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
    const projected = {
      ...row,
      route: "asset_transfer",
      type: null,
      type_raw: "AssetTransfer",
      units: toDecimal(binding.principal).plus(binding.feeUnits).toFixed(8),
      custom_config: {
        ...row.custom_config,
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
      const owner = owners[0],
        current = canonical[0];
      if (
        owners.length !== 1 ||
        canonical.length !== 1 ||
        owner.status !== "committed" ||
        owner.source_record_hash !== row.source_record_hash ||
        hash(owner.asset_transfer_details.networkBinding) !== hash(binding) ||
        current.type !== "asset_transfer" ||
        Number(current.staging_row_id) !== Number(owner.id) ||
        Number(current.import_batch_id) !== Number(owner.batch_id) ||
        Number(current.source_account_id) !== binding.originAccountId ||
        Number(current.destination_account_id) !==
          binding.destinationAccountId ||
        Number(current.investment_id) !== Number(row.investment_id) ||
        current.date !== row.tx_date ||
        !equal(current.units, projected.units) ||
        !equal(current.fee_units, binding.feeUnits) ||
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

function verifiedNativeGiftRow(row) {
  try {
    if (row.route !== "portfolio" || row.type !== "gift") return undefined;
    const config = row.custom_config ?? {},
      mapping = config.column_mapping ?? {};
    const records = parseCsvText(portfolioPrimaryRawData(row.raw_data), {
      columns: config.source_columns,
      skip_empty_lines: true,
    });
    if (
      records.length !== 1 ||
      records[0][mapping.type] !== "gift" ||
      !records[0].Receipt_JSON
    )
      return undefined;
    const raw = records[0],
      receipt = JSON.parse(raw.Receipt_JSON),
      proof = verifyKinesisNetworkReceipt(receipt, "gift");
    const witness = receipt.recordedBasisWitness,
      literal = witness?.literal;
    if (
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
    const identity = assignImportIdentities([row], (source) =>
      portfolioIdentityBase(source, { accountIdentity: "UNASSIGNED" }),
    )[0];
    const number = (field) =>
      mapping[field] && raw[mapping[field]] !== ""
        ? parseCustomAmount(raw[mapping[field]], config.number_format, {
            rowNumber: 1,
            column: mapping[field],
          })
        : 0;
    if (
      !basis ||
      !toDecimal(basis.amount).gt("0.01") ||
      basis.currency !== row.currency ||
      !equal(row.amount, basis.amount) ||
      !equal(toDecimal(literal.sharesMinor).div(100000000), proof.principal) ||
      raw[mapping.currency] !== basis.currency ||
      raw[mapping.symbol] !== proof.asset ||
      raw[mapping.source_id] !== proof.hash ||
      raw[mapping.source_account] !== proof.sourceAddress ||
      parsedDateToYmd(
        parseDateWithFormat(raw[mapping.date], config.date_format),
      ) !== proof.date ||
      !equal(number("units"), proof.principal) ||
      !equal(number("amount"), basis.amount) ||
      ["fees", "taxes", "fx_rate"].some(
        (field) => !toDecimal(number(field)).eq(0),
      ) ||
      row.source_record_hash !==
        createHash("sha256")
          .update(portfolioPrimaryRawData(row.raw_data))
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
      row.note !== String(raw[mapping.note] ?? "").trim()
    )
      return undefined;
    return { row, receipt, proof, witness, basis };
  } catch {
    return undefined;
  }
}

/** Closed cardinality associates equivalent daily gifts; it does not infer an individual legacy identity. */
export function proveKinesisNativeGiftGroups(
  rows,
  batches,
  history,
  context = { receipts: [], sources: [], batches: [] },
) {
  const candidates = new Map(),
    groups = [],
    blockers = [];
  const selected = rows.filter(
    (row) =>
      row.type === "gift" &&
      row.custom_config?.column_mapping &&
      row.custom_config?.source_columns?.includes("Receipt_JSON"),
  );
  const issue = (row, reason) =>
    blockers.push({
      reason,
      rowId: Number(row.id),
      batchId: Number(row.batch_id),
      rowOrdinal: row.row_index + 1,
      candidateTransactionIds: [],
    });
  const grouped = new Map();
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
    grouped.get(key).push(member);
  }
  for (const members of grouped.values()) {
    try {
      members.sort(
        (a, b) =>
          a.receipt.transaction.created_at.localeCompare(
            b.receipt.transaction.created_at,
          ) || a.proof.hash.localeCompare(b.proof.hash),
      );
      const first = members[0],
        batch = batches.find(
          (item) => Number(item.id) === Number(first.row.batch_id),
        );
      const originalIncoming = first.receipt.sourceHistoryPages
        .flatMap((page) => page.body?._embedded?.records ?? [])
        .filter(
          (item) =>
            item.transaction_hash &&
            item.created_at?.slice(0, 10) === first.proof.date &&
            (item.to ?? item.account) ===
              first.receipt.destinationAccount.account_id &&
            equal(item.amount ?? item.starting_balance, first.proof.principal),
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
          (item) => !memberIds.includes(item.transaction_hash),
        ) ||
        !batch ||
        Number(batch.rows_total) !==
          rows.filter((row) => Number(row.batch_id) === Number(batch.id))
            .length ||
        batch.custom_config?.included_symbols?.length ||
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
      const matching = (current) =>
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
      let manifest;
      for (const { member, current } of owned) {
        const owners = context.sources.filter(
          (source) =>
            source.dedup_fingerprint === member.row.dedup_fingerprint &&
            source.dedup_fingerprint_version ===
              member.row.dedup_fingerprint_version &&
            source.source_record_hash === member.row.source_record_hash,
        );
        const owner = owners[0],
          receipt = owner?.asset_transfer_details?.nativeGiftGroupReceipt;
        const ownerBatch = context.batches.find(
          (item) => Number(item.id) === Number(owner?.batch_id),
        );
        if (
          owners.length !== 1 ||
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
          hash(owner.custom_config?.column_mapping) !==
            hash(member.row.custom_config?.column_mapping) ||
          hash(owner.custom_config?.source_columns) !==
            hash(member.row.custom_config?.source_columns) ||
          hash(owner.custom_config?.number_format) !==
            hash(member.row.custom_config?.number_format) ||
          hash(owner.custom_config?.date_format) !==
            hash(member.row.custom_config?.date_format) ||
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
          if (
            receipts.length !== 1 ||
            receipts[0].policy !== "prefer_source" ||
            owner.status !== "duplicate" ||
            hash(receipts[0].after_data) !== hash(current) ||
            hash(receipts[0].before_data) !== hash(preserved)
          )
            throw new Error("network_gift_receipt_changed");
        }
      }
      const proof = {
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
