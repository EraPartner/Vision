/** Apply a literal secondary statement to review staging, never to canonical history. */
import { withTransaction } from "../database/connection.ts";
import { createHash } from "node:crypto";
import { ConflictError, ValidationError } from "../middleware/errorHandler.ts";
import { toDecimal } from "../lib/money.ts";
import {
  normalizeIdentityText,
  assignImportIdentities,
  portfolioIdentityBase,
} from "./importIdentity.js";
import { readPortfolioPerformanceXml } from "./portfolioPerformanceXmlParser.js";
import { findNexoReferenceYieldGroups } from "./portfolioReferenceYieldCoverage.js";
import {
  recordedPortfolioPerformanceBasis,
  portfolioPerformanceTradeFacts,
  portfolioReferenceStagingBinding,
  verifiedKinesisWithdrawal,
} from "./portfolioPerformanceReferenceEvidence.js";
import {
  getNexoProSpotReconciliationEvidence,
  nexoProSourceMoneyMatches,
} from "./portfolioImportPipeline/nexoProTransactionHistoryAdapter.js";
import { parseKinesisSourceRecordForBasisPolicy } from "./portfolioImportPipeline/kinesisTransactionHistoryAdapter.js";
import { createBatch } from "./portfolioImportPipeline/stage.js";
import { validateBatch } from "./portfolioImportPipeline/validate.js";
import {
  matchBatch,
  providerAssetAlias,
} from "./portfolioImportPipeline/matchInvestments.js";
import { assertPortfolioImportAccount } from "./portfolioImportAccountService.js";
import {
  lockReconciliationAccountsAndHistory,
  readReconciliationSources,
  readReconciliationHistory,
} from "../repositories/portfolioImportReconciliationRepository.js";
import {
  lockPortfolioReferenceScope,
  lockPortfolioReferenceRows,
  readPortfolioReferenceInvestments,
  updatePortfolioReferenceRow,
  savePortfolioReferenceConfiguration,
  stagePortfolioReferenceRows,
  markPortfolioReferenceAwaitingReview,
  restagePortfolioReferencePolicyRow,
} from "../repositories/portfolioImportReferenceRepository.js";

const FORMAT = "portfolio_performance_reference";
const same = (a, b, places = 8) =>
  a != null &&
  b != null &&
  toDecimal(a).toDecimalPlaces(places).eq(toDecimal(b).toDecimalPlaces(places));
const dayDistance = (a, b) =>
  Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
const format = (row) => row.custom_config?.format || row.adapter_name;
const basisEnvelope = (
  row,
  reference,
  event,
  basisPolicy,
  evidence = undefined,
) =>
  JSON.stringify({
    primaryRawData: row.raw_data,
    __portfolioPerformanceReference: {
      sourceHash: reference.sourceHash,
      transactionId: event.id,
      securityId: event.securityId,
      portfolioId: event.portfolioId,
      investmentId: row.investment_id,
      accountId: Number(row.account_id),
      literal: event.literal,
      basisPolicy,
      ...(evidence ? { evidence } : {}),
    },
  });

function literalPro(row) {
  if (format(row) !== "nexo_pro_spot_history") return undefined;
  const proof = getNexoProSpotReconciliationEvidence(row.raw_data);
  if (
    !proof ||
    proof.side !== row.type ||
    proof.symbol !== row.symbol_raw ||
    proof.currency !== row.currency ||
    proof.sourceTimestamp.slice(0, 10) !== row.tx_date ||
    row.source_transaction_id !==
      `nexo-pro:spot:order:${proof.sourceOrderId}` ||
    !same(proof.netUnits, row.units) ||
    !nexoProSourceMoneyMatches(proof.amount, row.amount) ||
    !same(proof.unitPrice, row.price_per_unit, 6) ||
    !nexoProSourceMoneyMatches(proof.quoteFee, row.fees)
  )
    return undefined;
  return proof;
}
function tradeMatches(row, event) {
  const facts =
    portfolioPerformanceTradeFacts(event, row.currency) ||
    portfolioPerformanceTradeFacts(event);
  const proof = literalPro(row);
  if (
    !facts ||
    dayDistance(row.tx_date, event.date) > (proof ? 31 : 7) ||
    !(
      same(row.units, event.shares) ||
      (proof && same(proof.grossUnits, event.shares))
    )
  )
    return false;
  // A proven primary execution and exact same-day PP asset/quantity/type can
  // anchor an old currency transcription. This makes no currency conversion claim.
  if (
    proof &&
    row.currency !== facts.currency &&
    dayDistance(row.tx_date, event.date) <= 7
  )
    return true;
  if (row.currency !== facts.currency) return false;
  const principal =
    row.amount ?? toDecimal(row.units).times(row.price_per_unit).toFixed();
  const cash =
    row.type === "buy"
      ? toDecimal(principal)
          .plus(row.fees || 0)
          .plus(row.taxes || 0)
      : toDecimal(principal)
          .minus(row.fees || 0)
          .minus(row.taxes || 0);
  const amounts = [
    principal,
    cash.toFixed(),
    ...(proof ? [proof.grossQuoteAmount] : []),
  ];
  // PP stores money as minor units. Its displayed unit price can be based on
  // net proceeds, so exact primary execution price is retained independently.
  return (
    amounts.some((amount) => same(amount, facts.amount, 2)) ||
    (row.currency === event.currency && same(cash.toFixed(), event.amount, 2))
  );
}
function kinesisYield(row) {
  return (
    format(row) === "kinesis_transaction_history" &&
    row.type === "gift" &&
    (row.asset_adjustment_details?.kind === "yield_acquisition" ||
      /^(?:Holder's Distribution units|Velocity's Distribution units|Kinesis holder distribution adjustment; original cost basis unavailable)$/.test(
        row.note || "",
      ))
  );
}

/** Pure, inspectable source coverage plan; ambiguous reference data never becomes a row. */
export function planPortfolioImportReference({
  reference,
  rows,
  investments,
  history = [],
}) {
  /** @type {any[]} */
  const blockers = [];
  const corrections = [];
  const supplemental = [];
  const covered = new Set();
  const matches = new Map();
  const coverageEvidence = new Map();
  const groupedYieldRows = new Map();
  const accounts = new Map();
  const securityInvestment = new Map();
  const primaryAccounts = new Set(
    rows.map((row) => Number(row.account_id)).filter(Boolean),
  );
  const unrestrictedAccounts = new Set(
    rows
      .filter((row) => !row.custom_config?.included_symbols?.length)
      .map((row) => Number(row.account_id)),
  );
  const accountInvestments = new Map();
  for (const row of rows) {
    const account = Number(row.account_id);
    if (!accountInvestments.has(account))
      accountInvestments.set(account, new Set());
    if (row.investment_id != null)
      accountInvestments.get(account).add(Number(row.investment_id));
  }
  const selectedInvestments = new Set(
    rows
      .filter((row) => row.status === "matched" && row.investment_id != null)
      .map((row) => Number(row.investment_id)),
  );
  // Spot order exports contain executions, not custody. A Pro-only review must
  // still detect missing trades without claiming to cover the wallet statement.
  const proOnly =
    rows.length > 0 &&
    rows.every((row) => format(row) === "nexo_pro_spot_history");
  const inScope = (event) =>
    accounts.has(event.portfolioId) &&
    (!proOnly || ["BUY", "SELL"].includes(event.type)) &&
    (primaryAccounts.has(accounts.get(event.portfolioId))
      ? unrestrictedAccounts.has(accounts.get(event.portfolioId)) ||
        accountInvestments
          .get(accounts.get(event.portfolioId))
          ?.has(Number(securityInvestment.get(event.securityId)?.id))
      : selectedInvestments.has(
          Number(securityInvestment.get(event.securityId)?.id),
        ));
  const add = (reason, event, row) =>
    blockers.push({
      reason,
      referenceTransactionId: event?.id,
      ...(row
        ? { rowOrdinal: row.row_index + 1, batchId: Number(row.batch_id) }
        : {}),
    });
  for (const security of reference.securities) {
    const keys = new Set(
      [security.ticker, security.isin, security.name]
        .filter(Boolean)
        .map(normalizeIdentityText),
    );
    const candidates = investments.filter((investment) =>
      [
        investment.symbol,
        investment.price_provider_id,
        investment.name,
        providerAssetAlias(investment),
      ].some((value) => value && keys.has(normalizeIdentityText(value))),
    );
    if (candidates.length === 1)
      securityInvestment.set(security.id, candidates[0]);
  }
  const assetMatches = (row, event) => {
    const asset = securityInvestment.get(event.securityId);
    if (asset && row.investment_id != null)
      return Number(asset.id) === Number(row.investment_id);
    const security = reference.securities.find(
      (item) => item.id === event.securityId,
    );
    return (
      row.investment_id == null &&
      [security?.ticker, security?.isin].some(
        (value) =>
          value &&
          normalizeIdentityText(value) ===
            normalizeIdentityText(row.symbol_raw),
      )
    );
  };
  const bind = (portfolioId, accountId, event, row) => {
    if (!portfolioId || accountId == null) return;
    if (
      accounts.has(portfolioId) &&
      accounts.get(portfolioId) !== Number(accountId)
    )
      add("reference_account_mapping_conflict", event, row);
    else {
      const custody = reference.portfolios.find(
        (portfolio) => portfolio.id === portfolioId,
      )?.referenceAccountId;
      const related = custody
        ? reference.portfolios.filter(
            (portfolio) => portfolio.referenceAccountId === custody,
          )
        : [{ id: portfolioId }];
      for (const portfolio of related) {
        if (
          accounts.has(portfolio.id) &&
          accounts.get(portfolio.id) !== Number(accountId)
        )
          add("reference_account_mapping_conflict", event, row);
        else accounts.set(portfolio.id, Number(accountId));
      }
    }
  };
  for (const row of rows) {
    if (row.status !== "matched" || row.route === "cash") continue;
    const options = reference.events.filter((event) => {
      if (!assetMatches(row, event)) return false;
      if (["buy", "sell"].includes(row.type))
        return (
          event.type === row.type.toUpperCase() && tradeMatches(row, event)
        );
      if (row.route === "account_internal")
        return (
          ["TRANSFER_IN", "TRANSFER_OUT"].includes(event.type) &&
          row.tx_date === event.date &&
          same(row.units, event.shares)
        );
      if (row.route === "asset_transfer")
        return (
          event.type ===
            (row.asset_transfer_details?.direction === "in"
              ? "TRANSFER_IN"
              : "TRANSFER_OUT") &&
          row.tx_date === event.date &&
          same(row.units, event.shares)
        );
      if (row.route === "asset_adjustment")
        return (
          event.type === "DELIVERY_OUTBOUND" &&
          row.tx_date === event.date &&
          same(row.units, event.shares)
        );
      if (row.type === "gift")
        return (
          [
            "DELIVERY_INBOUND",
            ...(row.asset_transfer_details?.direction === "in"
              ? ["TRANSFER_IN"]
              : []),
          ].includes(event.type) &&
          row.tx_date === event.date &&
          same(row.units, event.shares)
        );
      return false;
    });
    if (options.length > 1) {
      add("reference_ambiguous_match", undefined, row);
      continue;
    }
    if (!options.length) continue;
    const event = options[0];
    matches.set(Number(row.id), event);
    covered.add(event.id);
    bind(event.portfolioId, row.account_id, event, row);
    if (["TRANSFER_IN", "TRANSFER_OUT"].includes(event.type)) {
      const pairedId =
        event.type === "TRANSFER_OUT"
          ? event.literal.toTransactionId
          : event.literal.fromTransactionId;
      const paired = reference.events.find((item) => item.id === pairedId);
      if (row.route === "account_internal")
        bind(paired.portfolioId, row.account_id, event, row);
      else if (event.type === "TRANSFER_OUT")
        bind(
          paired.portfolioId,
          row.custom_config?.transfer_destination_account_id,
          event,
          row,
        );
      else
        bind(
          paired.portfolioId,
          row.custom_config?.transfer_origin_account_id,
          event,
          row,
        );
      if (accounts.has(paired.portfolioId)) covered.add(paired.id);
    }
  }
  // PP commonly records a net custody movement and a separate unit fee. The
  // maintained statement already proves the gross, received and fee quantities.
  // Cover that alternate representation only when one unique literal pair fits.
  for (const row of rows) {
    if (
      matches.has(Number(row.id)) ||
      row.status !== "matched" ||
      row.route !== "asset_transfer" ||
      row.asset_transfer_details?.direction !== "out" ||
      !["kinesis_transaction_history", "nexo_transaction_history"].includes(
        format(row),
      )
    )
      continue;
    const fee = toDecimal(row.asset_transfer_details.feeUnits || 0);
    const received = toDecimal(
      row.asset_transfer_details.receivedUnits ??
        toDecimal(row.units).minus(fee),
    );
    if (!fee.gt(0) || !received.gt(0) || !received.plus(fee).eq(row.units))
      continue;
    const options = reference.events.filter(
      (event) =>
        event.type === "TRANSFER_OUT" &&
        !covered.has(event.id) &&
        assetMatches(row, event) &&
        event.date === row.tx_date &&
        same(event.shares, received.toFixed()) &&
        accounts.get(event.portfolioId) === Number(row.account_id),
    );
    const possible = options.flatMap((event) =>
      reference.events
        .filter(
          (other) =>
            other.type === "DELIVERY_OUTBOUND" &&
            !covered.has(other.id) &&
            other.portfolioId === event.portfolioId &&
            other.securityId === event.securityId &&
            other.date === event.date &&
            same(other.shares, fee.toFixed()),
        )
        .map((feeEvent) => ({ event, feeEvent })),
    );
    if (possible.length !== 1) continue;
    const { event, feeEvent } = possible[0];
    const paired = reference.events.find(
      (item) => item.id === event.literal.toTransactionId,
    );
    const destination = row.custom_config?.transfer_destination_account_id;
    if (!paired || destination == null) continue;
    bind(event.portfolioId, row.account_id, event, row);
    bind(paired.portfolioId, destination, event, row);
    matches.set(Number(row.id), event);
    covered.add(event.id);
    covered.add(paired.id);
    covered.add(feeEvent.id);
    coverageEvidence.set(Number(row.id), {
      fee: feeEvent.literal,
      paired: paired.literal,
    });
  }
  // A broker day's withdrawals can appear as net PP transfers plus rounded unit
  // fee deliveries. Cover the complete literal group; retain broker quantities.
  const withdrawalGroups = new Map();
  for (const row of rows) {
    if (matches.has(Number(row.id)) || row.status !== "matched") continue;
    const proof = verifiedKinesisWithdrawal(row);
    if (!proof || !toDecimal(proof.feeUnits).gt(0)) continue;
    const key = `${row.account_id}:${row.investment_id}:${row.tx_date}`;
    withdrawalGroups.set(key, [
      ...(withdrawalGroups.get(key) || []),
      { row, proof },
    ]);
  }
  const withdrawalRounding = toDecimal("0.0000001");
  for (const group of withdrawalGroups.values()) {
    const chosen = [];
    for (const { row, proof } of group) {
      const candidates = reference.events.filter(
        (event) =>
          event.type === "TRANSFER_OUT" &&
          !covered.has(event.id) &&
          assetMatches(row, event) &&
          event.date === row.tx_date &&
          accounts.get(event.portfolioId) === Number(row.account_id) &&
          toDecimal(event.shares)
            .minus(proof.receivedUnits)
            .abs()
            .lte(withdrawalRounding),
      );
      if (candidates.length !== 1) break;
      const event = candidates[0];
      const paired = reference.events.find(
        (other) => other.id === event.literal.toTransactionId,
      );
      const destination = row.custom_config?.transfer_destination_account_id;
      if (
        !paired ||
        destination == null ||
        paired.date !== event.date ||
        paired.securityId !== event.securityId ||
        !same(paired.shares, event.shares) ||
        covered.has(paired.id)
      )
        break;
      chosen.push({ row, proof, event, paired, destination });
    }
    if (
      chosen.length !== group.length ||
      new Set(chosen.map((item) => item.event.id)).size !== chosen.length
    )
      continue;
    const first = chosen[0].event;
    if (
      chosen.some(
        (item) =>
          item.event.portfolioId !== first.portfolioId ||
          item.event.securityId !== first.securityId,
      )
    )
      continue;
    const fees = reference.events.filter(
      (event) =>
        event.type === "DELIVERY_OUTBOUND" &&
        !covered.has(event.id) &&
        event.portfolioId === first.portfolioId &&
        event.securityId === first.securityId &&
        event.date === first.date,
    );
    if (fees.length !== chosen.length) continue;
    const expectedFees = chosen
      .map((item) => toDecimal(item.proof.feeUnits))
      .sort((a, b) => a.comparedTo(b));
    const recordedFees = fees
      .map((event) => toDecimal(event.shares))
      .sort((a, b) => a.comparedTo(b));
    if (
      recordedFees.some((fee, index) =>
        fee.minus(expectedFees[index]).abs().gt(withdrawalRounding),
      )
    )
      continue;
    for (const { row, proof, event, paired, destination } of chosen) {
      bind(event.portfolioId, row.account_id, event, row);
      bind(paired.portfolioId, destination, event, row);
      matches.set(Number(row.id), event);
      covered.add(event.id);
      covered.add(paired.id);
      coverageEvidence.set(Number(row.id), {
        withdrawalGroup: {
          fees: fees.map((fee) => fee.literal),
          paired: paired.literal,
          sourceGrossUnits: proof.grossUnits,
          sourceReceivedUnits: proof.receivedUnits,
          sourceFeeUnits: proof.feeUnits,
          roundingLimitUnits: withdrawalRounding.toFixed(),
        },
      });
    }
    for (const fee of fees) covered.add(fee.id);
  }
  // PP can record base-denominated trading fees later as unit removals. The
  // proven executions already retain net units, so that representation is
  // coverage only. Do not debit those fees again.
  const baseFeeGroups = new Map();
  for (const row of rows) {
    if (proOnly) continue;
    const event = matches.get(Number(row.id));
    const proof = literalPro(row);
    if (
      event?.type !== "BUY" ||
      !proof ||
      proof.feeCurrency !== proof.symbol ||
      !toDecimal(proof.feeUnits).gt(0) ||
      !same(proof.grossUnits, event.shares)
    )
      continue;
    const key = `${event.portfolioId}:${event.securityId}`;
    baseFeeGroups.set(key, [
      ...(baseFeeGroups.get(key) || []),
      { row, event, proof },
    ]);
  }
  for (const group of baseFeeGroups.values()) {
    const first = group[0].event;
    const latestBuy = group
      .map((item) => item.event.date)
      .sort()
      .at(-1);
    const nextSale = reference.events
      .filter(
        (event) =>
          event.portfolioId === first.portfolioId &&
          event.securityId === first.securityId &&
          event.type === "SELL" &&
          event.date >= latestBuy,
      )
      .map((event) => event.date)
      .sort()[0];
    const feeEvents = reference.events.filter(
      (event) =>
        event.portfolioId === first.portfolioId &&
        event.securityId === first.securityId &&
        event.type === "DELIVERY_OUTBOUND" &&
        !covered.has(event.id) &&
        event.date >= latestBuy &&
        (!nextSale || event.date <= nextSale),
    );
    if (!feeEvents.length) continue;
    const sourceUnits = group.reduce(
      (total, item) => total.plus(item.proof.feeUnits),
      toDecimal(0),
    );
    const recordedUnits = feeEvents.reduce(
      (total, event) => total.plus(event.shares),
      toDecimal(0),
    );
    const difference = sourceUnits.minus(recordedUnits);
    // Each recorded unit removal has eight decimal places. Bound accumulated
    // transcription rounding; primary quantities and dates stay unchanged.
    if (difference.abs().gt(toDecimal("0.00000001").times(feeEvents.length)))
      continue;
    for (const event of feeEvents) covered.add(event.id);
    for (const item of group)
      coverageEvidence.set(Number(item.row.id), {
        ...coverageEvidence.get(Number(item.row.id)),
        baseFeeCoverage: {
          recordedFees: feeEvents.map((event) => event.literal),
          sourceFeeUnits: sourceUnits.toFixed(),
          recordedFeeUnits: recordedUnits.toFixed(),
          roundingDifferenceUnits: difference.toFixed(),
        },
      });
  }
  const groupedYields = findNexoReferenceYieldGroups({
    reference,
    rows,
    alreadyCovered: covered,
    history,
    accountMappings: accounts,
    securityInvestments: securityInvestment,
  });
  blockers.push(...groupedYields.blockers);
  for (const group of groupedYields.groups) {
    const sourceRows = [...group.acquisitionRows, ...group.incomeRows];
    groupedYieldRows.set(
      group.event.id,
      new Set(sourceRows.map((row) => Number(row.id))),
    );
    covered.add(group.event.id);
    for (const row of sourceRows) {
      matches.set(Number(row.id), group.event);
      coverageEvidence.set(Number(row.id), {
        groupedYieldCoverage: {
          sourceIds: group.acquisitionRows.map(
            (item) => item.source_transaction_id,
          ),
          sourceHashes: group.acquisitionRows.map(
            (item) => item.source_record_hash,
          ),
          units: group.event.shares,
        },
      });
    }
  }
  // Every source match is global: one PP transaction cannot back two distinct
  // primary records, except paired audit rows for the same internal movement.
  const uses = new Map();
  for (const [rowId, event] of matches)
    uses.set(event.id, [...(uses.get(event.id) || []), rowId]);
  for (const event of reference.events)
    if ((uses.get(event.id)?.length || 0) > 1) {
      const sourceRows = rows.filter((row) =>
        uses.get(event.id).includes(Number(row.id)),
      );
      const identities = new Set(
        sourceRows.map(
          (row) => row.source_transaction_id || row.dedup_fingerprint,
        ),
      );
      const groupedIds = groupedYieldRows.get(event.id);
      const verifiedGroup =
        groupedIds &&
        groupedIds.size === sourceRows.length &&
        sourceRows.every((row) => groupedIds.has(Number(row.id)));
      if (identities.size > 1 && !verifiedGroup)
        add("reference_ambiguous_match", event);
    }
  for (const row of rows) {
    const event = matches.get(Number(row.id));
    if (!event) continue;
    if (
      event.type === "DELIVERY_INBOUND" &&
      row.type === "gift" &&
      !groupedYieldRows.has(event.id)
    ) {
      const basis = recordedPortfolioPerformanceBasis(event);
      if (!basis) {
        add("reference_unproven_basis", event, row);
        continue;
      }
      const zero =
        kinesisYield(row) &&
        ["EUR", "USD"].includes(basis.currency) &&
        toDecimal(basis.amount).lte("0.01");
      const missingBasis =
        row.asset_transfer_details?.basisStatus === "unresolved";
      if (zero)
        corrections.push({
          row,
          after: {
            ...row,
            amount: "0",
            price_per_unit: null,
            raw_data: basisEnvelope(row, reference, event, "zero"),
            asset_transfer_details: null,
            asset_adjustment_details: {
              kind: "yield_acquisition",
              basisPolicy: "zero",
            },
          },
        });
      else if (missingBasis && toDecimal(basis.amount).gt("0.01"))
        corrections.push({
          row,
          after: {
            ...row,
            amount: basis.amount,
            price_per_unit: toDecimal(basis.amount)
              .div(row.units)
              .toDecimalPlaces(6)
              .toFixed(),
            currency: basis.currency,
            fx_rate_to_eur: basis.fxRateToEur,
            raw_data: basisEnvelope(row, reference, event, "recorded_native"),
            asset_transfer_details: {
              ...row.asset_transfer_details,
              basisStatus: "recorded_reference",
            },
          },
        });
      else if (missingBasis) add("reference_unproven_basis", event, row);
    } else if (
      event.type === "TRANSFER_IN" &&
      row.asset_transfer_details?.direction === "in"
    ) {
      const from = reference.events.find(
        (item) => item.id === event.literal.fromTransactionId,
      );
      const origin = accounts.get(from.portfolioId);
      if (
        origin == null ||
        Number(row.custom_config?.transfer_origin_account_id) !== origin
      ) {
        add("reference_unmapped_portfolio", event, row);
        continue;
      }
      const outgoing = rows.find(
        (other) =>
          matches.get(Number(other.id))?.id === from.id &&
          other.route === "asset_transfer",
      );
      corrections.push({
        row,
        after: {
          ...row,
          type: null,
          type_raw: outgoing ? "InternalMovement" : "AssetTransfer",
          route: outgoing ? "account_internal" : "asset_transfer",
          amount: "0",
          price_per_unit: null,
          raw_data: basisEnvelope(row, reference, event, "paired_custody"),
          asset_transfer_details: {
            direction: outgoing ? "internal" : "in",
            basisStatus: outgoing ? "not_applicable" : "carried",
            feeUnits: "0",
            receivedUnits: String(row.units),
          },
        },
      });
    } else if (["BUY", "SELL"].includes(event.type) && literalPro(row))
      corrections.push({
        row,
        after: {
          ...row,
          raw_data: basisEnvelope(
            row,
            reference,
            event,
            "primary_execution",
            coverageEvidence.get(Number(row.id)),
          ),
        },
      });
  }
  for (const row of rows) {
    const event = matches.get(Number(row.id));
    if (
      !event ||
      corrections.some(
        (correction) => Number(correction.row.id) === Number(row.id),
      )
    )
      continue;
    corrections.push({
      row,
      after: {
        ...row,
        raw_data: basisEnvelope(
          row,
          reference,
          event,
          "source_coverage",
          coverageEvidence.get(Number(row.id)),
        ),
      },
    });
  }
  let unmatchedLegacyRows = 0;
  for (const current of history) {
    if (
      current.account_id != null ||
      current.import_batch_id != null ||
      !["gift", "buy", "sell"].includes(current.type)
    )
      continue;
    const witnesses = reference.events.filter((event) => {
      if (
        !inScope(event) ||
        Number(securityInvestment.get(event.securityId)?.id) !==
          Number(current.investment_id) ||
        event.date !== current.date ||
        !same(event.shares, current.units)
      )
        return false;
      if (["BUY", "SELL"].includes(event.type)) {
        const facts = portfolioPerformanceTradeFacts(event);
        return (
          current.type === event.type.toLowerCase() &&
          facts &&
          current.currency === facts.currency &&
          (same(current.amount, facts.amount, 4) ||
            same(current.amount, event.amount, 4))
        );
      }
      if (event.type === "DELIVERY_INBOUND" && current.type === "gift") {
        const basis = recordedPortfolioPerformanceBasis(event);
        return (
          basis &&
          (same(current.amount, basis.amount, 4) ||
            (["EUR", "USD"].includes(basis.currency) &&
              toDecimal(basis.amount).lte("0.01") &&
              toDecimal(current.amount || 0).lte("0.01")))
        );
      }
      return (
        ["TRANSFER_IN", "TRANSFER_OUT"].includes(event.type) &&
        current.type === "gift"
      );
    });
    if (!witnesses.length) continue;
    const corresponding = witnesses.filter(
      (event) =>
        covered.has(event.id) &&
        rows.some(
          (row) =>
            matches.get(Number(row.id))?.id === event.id &&
            row.route === "portfolio",
        ),
    );
    if (witnesses.length !== 1 || corresponding.length !== 1) {
      unmatchedLegacyRows++;
      blockers.push({
        reason: "reference_uncovered_legacy_history",
        referenceTransactionId: witnesses[0].id,
        candidateTransactionIds: [Number(current.id)],
        accountId: accounts.get(witnesses[0].portfolioId),
      });
    }
  }
  for (const event of reference.events) {
    if (covered.has(event.id)) continue;
    if (!inScope(event)) continue;
    const accountId = accounts.get(event.portfolioId);
    const asset = securityInvestment.get(event.securityId);
    if (accountId == null) continue;
    if (!asset) {
      add("reference_ambiguous_asset", event);
      continue;
    }
    if (
      ["BUY", "SELL"].includes(event.type) &&
      !primaryAccounts.has(accountId)
    ) {
      const facts = portfolioPerformanceTradeFacts(event);
      if (!facts) {
        add("reference_unproven_basis", event);
        continue;
      }
      const possible = history.filter(
        (current) =>
          Number(current.investment_id) === Number(asset.id) &&
          current.type === event.type.toLowerCase() &&
          dayDistance(current.date, event.date) <= 7 &&
          same(current.units, event.shares),
      );
      if (possible.length) {
        add("reference_existing_trade_conflict", event);
        continue;
      }
      supplemental.push({
        accountId,
        row: {
          investment_id: asset.id,
          type: event.type.toLowerCase(),
          type_raw: event.type === "BUY" ? "Buy" : "Sell",
          route: "portfolio",
          symbol_raw: asset.symbol,
          name_raw: asset.name,
          tx_date: event.date,
          units: event.shares,
          amount: facts.amount,
          price_per_unit: null,
          fees: facts.fees,
          taxes: facts.taxes,
          currency: facts.currency,
          fx_rate_to_eur: facts.fxRateToEur,
          source_transaction_id: `portfolio-performance:${event.id}:trade`,
          raw_data: JSON.stringify({
            __portfolioPerformanceReference: {
              sourceHash: reference.sourceHash,
              literal: event.literal,
              basisPolicy: "recorded_trade",
            },
          }),
        },
      });
      covered.add(event.id);
      continue;
    }
    if (event.type === "DELIVERY_OUTBOUND" && !primaryAccounts.has(accountId)) {
      const inbound = reference.events.filter(
        (item) =>
          item.portfolioId === event.portfolioId &&
          item.securityId === event.securityId &&
          item.date <= event.date &&
          item.type === "TRANSFER_IN" &&
          covered.has(item.id),
      );
      const returns = reference.events.filter(
        (item) =>
          item.portfolioId === event.portfolioId &&
          item.securityId === event.securityId &&
          item.date === event.date &&
          item.type === "TRANSFER_OUT" &&
          covered.has(item.id),
      );
      const pairs = inbound.flatMap((incoming) =>
        returns
          .filter(
            (returned) =>
              incoming.date <= returned.date &&
              toDecimal(incoming.shares).minus(returned.shares).gt(0) &&
              same(
                toDecimal(incoming.shares).minus(returned.shares).toFixed(),
                event.shares,
              ) &&
              // Only an isolated custody round trip proves the loss. Earlier
              // same-asset movements and disposals must not be ignored.
              !reference.events.some(
                (other) =>
                  other.portfolioId === event.portfolioId &&
                  other.securityId === event.securityId &&
                  other.id !== incoming.id &&
                  other.id !== returned.id &&
                  other.id !== event.id &&
                  other.date >= incoming.date &&
                  other.date <= returned.date,
              ),
          )
          .map((returned) => ({ incoming, returned })),
      );
      if (pairs.length !== 1) {
        add("reference_unproven_transfer_fee", event);
        continue;
      }
      supplemental.push({
        accountId,
        row: {
          investment_id: asset.id,
          type: null,
          type_raw: "AssetAdjustment",
          route: "asset_adjustment",
          symbol_raw: asset.symbol,
          name_raw: asset.name,
          tx_date: event.date,
          units: event.shares,
          amount: "0",
          fees: "0",
          taxes: "0",
          currency: asset.currency,
          source_transaction_id: `portfolio-performance:${event.id}:asset-fee`,
          asset_adjustment_details: {
            kind: "asset_fee",
            basisPolicy: "carried",
          },
          raw_data: JSON.stringify({
            __portfolioPerformanceReference: {
              sourceHash: reference.sourceHash,
              literal: event.literal,
              basisPolicy: "carried_fee",
              inbound: pairs[0].incoming.literal,
              returned: pairs[0].returned.literal,
            },
          }),
        },
      });
      covered.add(event.id);
      continue;
    }
    add("reference_unmatched_event", event);
  }
  return {
    corrections,
    supplemental,
    blockers,
    matchedReferenceRows: covered.size,
    coverage: {
      referenceEvents: reference.events.length,
      matchedReferenceEvents: covered.size,
      unmatchedMappedReferenceEvents: reference.events.filter(
        (event) => inScope(event) && !covered.has(event.id),
      ).length,
      outsideSelectedReferenceEvents: reference.events.filter(
        (event) => !inScope(event),
      ).length,
      unmatchedPrimaryRows: rows.filter(
        (row) =>
          row.route !== "cash" &&
          row.route !== "account_internal" &&
          !matches.has(Number(row.id)),
      ).length,
      unmatchedLegacyRows,
    },
    accountMappings: [...accounts].map(([portfolioId, accountId]) => ({
      portfolioId,
      accountId,
    })),
  };
}

function routing(batches) {
  return batches
    .map((batch) => ({
      batchId: Number(batch.id),
      accountId: batch.account_id,
      originAccountId: batch.custom_config?.transfer_origin_account_id ?? null,
      destinationAccountId:
        batch.custom_config?.transfer_destination_account_id ?? null,
    }))
    .sort((a, b) => a.batchId - b.batchId);
}
function stagingBinding(rows) {
  return portfolioReferenceStagingBinding(rows);
}
function validateIds(batchIds) {
  if (
    !Array.isArray(batchIds) ||
    !batchIds.length ||
    batchIds.length > 100 ||
    batchIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(batchIds).size !== batchIds.length
  )
    throw new ValidationError(
      "batch_ids must contain unique positive batch IDs",
    );
  return [...batchIds].sort((a, b) => a - b);
}

export async function applyPortfolioImportReference({
  batchIds,
  referencePath,
  placeholderBasisPolicy,
}) {
  const selected = validateIds(batchIds);
  if (placeholderBasisPolicy !== "zero")
    throw new ValidationError("placeholder_basis_policy must be zero");
  const reference = await readPortfolioPerformanceXml(referencePath);
  return withTransaction(async () => {
    let batches = await lockPortfolioReferenceScope(selected);
    if (batches.length !== selected.length)
      throw new ValidationError("A selected source batch is missing");
    const cached = batches
      .map((batch) => batch.custom_config?.portfolio_performance_reference)
      .filter(Boolean);
    const previousEntry = cached[0];
    const sameOriginalScope =
      previousEntry &&
      JSON.stringify(selected) ===
        JSON.stringify(previousEntry.originalBatchIds);
    const sameEffectiveScope =
      previousEntry &&
      JSON.stringify(selected) ===
        JSON.stringify(previousEntry.effectiveBatchIds);
    if (
      cached.length === batches.length &&
      cached.length &&
      (sameOriginalScope || sameEffectiveScope) &&
      previousEntry.sourceHash === reference.sourceHash
    ) {
      const entry = cached[0];
      if (
        cached.some((item) => item.sourceHash !== reference.sourceHash) ||
        entry.sourceHash !== reference.sourceHash
      )
        throw new ConflictError(
          "A different XML reference requires automatic restaging of the statements",
          { details: { reason: "reference_requires_restaging" } },
        );
      if (
        cached.length !== batches.length ||
        cached.some(
          (item) =>
            JSON.stringify(item.result) !== JSON.stringify(entry.result),
        )
      )
        throw new ConflictError("The reference source scope changed", {
          details: { reason: "reference_scope_changed" },
        });
      const expected = entry.routing.filter((item) =>
        selected.includes(item.batchId),
      );
      if (
        JSON.stringify(
          routing(batches).filter((item) =>
            expected.some((value) => value.batchId === item.batchId),
          ),
        ) !== JSON.stringify(expected)
      )
        throw new ConflictError("Reference account routing changed", {
          details: { reason: "reference_scope_changed" },
        });
      const boundRows = await readReconciliationSources(
        entry.effectiveBatchIds,
      );
      if (
        !entry.stagingBinding ||
        stagingBinding(boundRows) !== entry.stagingBinding
      )
        throw new ConflictError(
          "Reference source or investment binding changed",
          { details: { reason: "reference_scope_changed" } },
        );
      if (
        stagingBinding(
          await readReconciliationSources(entry.originalBatchIds),
        ) !== entry.originalStagingBinding
      )
        throw new ConflictError("Retained source binding changed", {
          details: { reason: "reference_scope_changed" },
        });
      return entry.result;
    }
    if (
      batches.some(
        (batch) =>
          batch.custom_config?.portfolio_performance_reference &&
          !["complete", "complete_with_errors"].includes(batch.status),
      )
    )
      throw new ConflictError(
        "A changed XML or source selection requires automatic restaging",
        { details: { reason: "reference_requires_restaging" } },
      );
    if (
      batches.some(
        (batch) =>
          ![
            "awaiting_review",
            "matching",
            "complete",
            "complete_with_errors",
          ].includes(batch.status),
      )
    )
      throw new ValidationError(
        "XML enrichment requires reviewable or retained terminal statement batches",
      );
    const originalRouting = routing(batches);
    const accountIds = [
      ...new Set(
        batches
          .flatMap((batch) => [
            batch.account_id,
            batch.custom_config?.transfer_origin_account_id,
            batch.custom_config?.transfer_destination_account_id,
          ])
          .filter((value) => value != null),
      ),
    ].sort((a, b) => a - b);
    await lockReconciliationAccountsAndHistory(accountIds);
    for (const id of accountIds) await assertPortfolioImportAccount(id);
    await lockPortfolioReferenceRows(selected);
    const initialRows = await readReconciliationSources(selected);
    const supplementalMetadata = [];
    const replacements = [];
    for (const original of batches.filter((batch) =>
      ["complete", "complete_with_errors"].includes(batch.status),
    )) {
      if (
        original.adapter_name !== "ibkr_transaction_history" &&
        original.custom_config?.format !== "ibkr_transaction_history"
      )
        throw new ValidationError(
          "Only retained IBKR statements can be restaged from persisted history",
        );
      const sourceRows = initialRows.filter(
        (row) => Number(row.batch_id) === Number(original.id),
      );
      if (
        sourceRows.length !== original.rows_total ||
        sourceRows.some(
          (row) =>
            !row.raw_data ||
            !row.source_record_hash ||
            !row.dedup_fingerprint ||
            createHash("sha256").update(row.raw_data, "utf8").digest("hex") !==
              row.source_record_hash,
        )
      )
        throw new ConflictError("Retained source provenance is incomplete", {
          details: { reason: "reference_retained_source_incomplete" },
        });
      const reviewId = await createBatch({
        adapterName: "ibkr_transaction_history",
        filename: "Retained IBKR history review",
        customConfig: {
          ...original.custom_config,
          format: "ibkr_transaction_history",
          reference_parent_batch_id: Number(original.id),
        },
        isBrokerage: original.is_brokerage,
        defaultAssetClass: original.default_asset_class,
        defaultType: original.default_type,
        accountId: original.account_id,
      });
      await stagePortfolioReferenceRows(reviewId, sourceRows, {
        status: "pending",
      });
      await validateBatch({ batchId: reviewId });
      await matchBatch({ batchId: reviewId });
      await markPortfolioReferenceAwaitingReview(reviewId);
      await savePortfolioReferenceConfiguration(reviewId, {
        ...original.custom_config,
        format: "ibkr_transaction_history",
        reference_parent_batch_id: Number(original.id),
      });
      replacements.push({
        original_batch_id: Number(original.id),
        review_batch_id: reviewId,
      });
      supplementalMetadata.push({
        batch_id: reviewId,
        original_batch_id: Number(original.id),
        account_id: original.account_id,
        adapter_name: "ibkr_transaction_history",
        source_filename: "Retained IBKR history review",
        status: "awaiting_review",
        rows_total: sourceRows.length,
      });
    }
    const effective = selected.map(
      (id) =>
        replacements.find((item) => item.original_batch_id === id)
          ?.review_batch_id ?? id,
    );
    batches = await lockPortfolioReferenceScope(effective);
    const policyBlockers = [];
    for (const batch of batches.filter(
      (value) =>
        (value.custom_config?.format || value.adapter_name) ===
        "kinesis_transaction_history",
    )) {
      if (batch.custom_config?.yield_basis_policy === "zero") continue;
      const sourceRows = await readReconciliationSources([Number(batch.id)]);
      let reparsed = false;
      for (const row of sourceRows) {
        const affected =
          kinesisYield(row) ||
          /holder distribution (?:adjustment|reversal)|Unsupported Kinesis event: Holder's_Distribution_Adjustment/i.test(
            `${row.note || ""} ${row.type_raw || ""}`,
          );
        if (!affected) continue;
        const parsed = parseKinesisSourceRecordForBasisPolicy(row.raw_data, {
          sourceColumns: batch.custom_config?.source_columns,
          yield_basis_policy: "zero",
        });
        const candidate = parsed?.find(
          (item) => item.sourceId === row.source_transaction_id,
        );
        if (!candidate) {
          policyBlockers.push({
            reason: "reference_restage_for_yield_policy",
            batchId: Number(batch.id),
            rowOrdinal: row.row_index + 1,
          });
          continue;
        }
        await restagePortfolioReferencePolicyRow(row, candidate);
        reparsed = true;
      }
      if (reparsed) {
        await savePortfolioReferenceConfiguration(Number(batch.id), {
          ...batch.custom_config,
          yield_basis_policy: "zero",
        });
        await validateBatch({ batchId: Number(batch.id) });
        await matchBatch({ batchId: Number(batch.id) });
        await markPortfolioReferenceAwaitingReview(Number(batch.id));
      }
    }
    const rows = await readReconciliationSources(effective);
    const investments = await readPortfolioReferenceInvestments();
    const history = await readReconciliationHistory(
      investments.map((investment) => investment.id),
    );
    const plan = planPortfolioImportReference({
      reference,
      rows,
      investments,
      history,
    });
    plan.blockers.unshift(...policyBlockers);
    for (const correction of plan.corrections)
      if (
        !(await updatePortfolioReferenceRow(correction.row, correction.after))
      )
        throw new ConflictError(
          "A staged source row changed during reference review",
          { details: { reason: "reference_scope_changed" } },
        );
    const groups = new Map();
    for (const item of plan.supplemental)
      groups.set(item.accountId, [
        ...(groups.get(item.accountId) || []),
        item.row,
      ]);
    for (const [accountId, newRows] of groups) {
      if (!accountIds.includes(accountId))
        throw new ConflictError(
          "Reference account was not explicitly selected",
          { details: { reason: "reference_scope_changed" } },
        );
      const id = await createBatch({
        adapterName: FORMAT,
        filename: "Portfolio Performance reference.xml",
        sizeBytes: undefined,
        customConfig: { format: FORMAT },
        isBrokerage: true,
        accountId,
      });
      const identified = assignImportIdentities(newRows, (row) =>
        portfolioIdentityBase(row, { accountIdentity: `PP:${accountId}` }),
      );
      const staged = newRows.map((row, index) => ({
        ...row,
        source_record_hash: identified[index].sourceRecordHash,
        dedup_fingerprint: identified[index].fingerprint,
        dedup_fingerprint_version: identified[index].version,
        dedup_occurrence: identified[index].occurrence,
      }));
      await stagePortfolioReferenceRows(id, staged);
      effective.push(id);
      supplementalMetadata.push({
        batch_id: id,
        account_id: accountId,
        adapter_name: FORMAT,
        source_filename: "Portfolio Performance reference.xml",
        status: "awaiting_review",
        rows_total: newRows.length,
      });
    }
    const result = {
      batch_ids: effective.sort((a, b) => a - b),
      matched_reference_rows: plan.matchedReferenceRows,
      source_corrections: plan.corrections.length,
      supplemental_batches: supplementalMetadata,
      replacement_batches: replacements,
      blockers: plan.blockers,
      coverage: plan.coverage,
    };
    const allBatches = await lockPortfolioReferenceScope(
      [...new Set([...selected, ...effective])].sort((a, b) => a - b),
    );
    const cache = {
      sourceHash: reference.sourceHash,
      originalBatchIds: selected,
      effectiveBatchIds: result.batch_ids,
      routing: routing(allBatches),
      originalRouting,
      result,
      stagingBinding: stagingBinding(
        await readReconciliationSources(result.batch_ids),
      ),
      originalStagingBinding: stagingBinding(
        await readReconciliationSources(selected),
      ),
    };
    for (const batch of allBatches)
      await savePortfolioReferenceConfiguration(Number(batch.id), {
        ...batch.custom_config,
        ...(batch.custom_config?.format === "kinesis_transaction_history"
          ? { yield_basis_policy: "zero" }
          : {}),
        portfolio_performance_reference: cache,
        reference_blockers: plan.blockers,
      });
    return result;
  });
}
