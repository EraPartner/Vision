import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  syntheticKinesisScope,
  syntheticKinesisManual,
} from "./kinesisAdoptionScope.ts";
import type {
  SyntheticAdoptionReceipt,
  SyntheticKinesisRow,
  SyntheticKinesisScope,
} from "./kinesisAdoptionScope.ts";
import { portfolioReferenceStagingBinding } from "../../src/services/portfolioPerformanceReferenceEvidence.ts";
import { kinesisYieldReferenceDigest } from "../../src/services/portfolioKinesisYieldGroups.ts";
import { toDecimal } from "../../src/lib/money.ts";
import {
  retainedEvent,
  retainedReference,
  retainedEvidenceRow,
} from "../fixtures/retainedPortfolioEvidence.ts";
import type { RetainedReference } from "../fixtures/retainedPortfolioEvidence.ts";
import type { ReconciliationSourceRow } from "../../src/repositories/portfolioImportReconciliationRepository.ts";

export interface KinesisYieldGroupOptions {
  /** Give the first two yields a sub-satoshi residual. */
  fractionalResidual?: boolean;
  /** Make the first yield's income an exact half cent. */
  halfwayIncome?: boolean;
  account?: number;
  investment?: number;
  priorBatchId?: number;
  priorRowStart?: number;
  batchId?: number;
  rowStart?: number;
  scope?: string;
  /** Attach the reference cache to the source batches (default true). */
  withReference?: boolean;
}

export interface KinesisYieldPlan {
  blockers: unknown[];
  yieldGroupEvidence: ReturnType<typeof retainedKinesisYieldEvidence>;
}

/** Synthetic rows carry only the columns the binding digest reads. */
const asSourceRows = (rows: SyntheticKinesisRow[]) =>
  rows as unknown as ReconciliationSourceRow[];

/** Complete synthetic source and already-retained JSON proof, with independent deposits. */
export async function syntheticKinesisYieldGroup(
  options: KinesisYieldGroupOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "vision-closed-yields-"));
  const path = join(directory, "source.csv");
  const columns = [
    "DateTime",
    "HIN",
    "Currency_Code",
    "Transaction_Type",
    "Transaction_ID",
    "Order_ID",
    "Currency_Pair",
    "Amount",
    "Trade_Price",
    "Total",
    "Fee",
    "Fee_Currency",
    "Trade_Value",
    "Trade_Value_Currency",
    "Starting_Balance",
    "Starting_Balance_Currency",
    "Closing_Balance",
    "Closing_Balance_Currency",
  ];
  const record = (
    day: string,
    type: string,
    id: string,
    units: string,
    value = "",
  ) =>
    [
      day + " 12:00:00 UTC",
      "SYNTHETIC-GROUP",
      "ETH",
      type,
      id,
      "",
      "",
      units,
      "",
      "",
      "",
      "",
      value,
      value ? "USD" : "",
      "",
      "",
      "",
      "",
    ].join(",");
  const reference = retainedReference([
    retainedEvent({
      id: "opening",
      date: "2024-01-02",
      shares: "100",
      amount: "50",
      currency: "USD",
    }),
    retainedEvent({
      id: "older-one",
      date: "2024-02-03",
      shares: "0.00010101",
      amount: "0.01",
      currency: "USD",
    }),
    retainedEvent({
      id: "older-two",
      date: "2024-03-06",
      shares: "0.00020202",
      amount: "0.01",
      currency: "USD",
    }),
    retainedEvent({
      id: "known-yield",
      date: "2024-04-15",
      shares: "0.00030303",
      amount: "0.01",
      currency: "USD",
    }),
    retainedEvent({
      id: "closing",
      date: "2024-04-30",
      shares: "200",
      amount: "100",
      currency: "USD",
    }),
  ]);
  try {
    await writeFile(
      path,
      columns.join(",") +
        "\n" +
        [
          record("2024-01-02", "Deposit", "OPEN-DEPOSIT", "100"),
          record(
            "2024-04-15",
            "Holder's_Distribution",
            "YIELD-ONE",
            options.fractionalResidual ? "0.000101014" : "0.00010101",
            options.halfwayIncome ? "0.00005" : "0.01",
          ),
          record(
            "2024-04-15",
            "Holder's_Distribution",
            "YIELD-TWO",
            options.fractionalResidual ? "0.000202024" : "0.00020202",
            "0.01",
          ),
          record(
            "2024-04-15",
            "Holder's_Distribution",
            "YIELD-ANCHOR",
            "0.00030303",
            "0.01",
          ),
          record("2024-04-30", "Deposit", "CLOSE-DEPOSIT", "200"),
          [
            "2024-06-01 12:00:00 UTC",
            "SYNTHETIC-GROUP",
            "USD",
            "Deposit",
            "OUTSIDE-CASH",
            "",
            "",
            "10",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
          ].join(","),
        ].join("\n") +
        "\n",
    );
    const base = {
      sourcePath: path,
      account: options.account ?? 7,
      investment: options.investment ?? 1,
    };
    const prior = await syntheticKinesisScope({
      ...base,
      batchId: options.priorBatchId ?? 1,
      rowStart: options.priorRowStart ?? 20,
    });
    const source = await syntheticKinesisScope({
      ...base,
      batchId: options.batchId ?? 2,
      rowStart: options.rowStart ?? 100,
    });
    const investments = [
      {
        id: base.investment,
        symbol: "ETH-EUR",
        name: "Synthetic Ether",
        price_provider_id: "ETH-EUR",
        currency: "EUR",
        asset_class: "crypto",
      },
    ];
    const giftRows = prior.rows.filter((row) => row.type === "gift");
    const history = giftRows.map((row, index) => {
      const current = syntheticKinesisManual(row, 400 + index);
      current.currency = "EUR";
      if (index === 0 || index === 4) {
        current.amount = index === 0 ? "50.0000" : "100.0000";
        current.price_per_unit = toDecimal(current.amount)
          .div(row.units!)
          .toFixed(6);
        current.fx_rate_to_eur = "1.0000000000";
      } else current.date = reference.events[index]!.date;
      return current;
    });
    for (const index of [0, 4]) {
      const row = giftRows[index]!;
      const event = reference.events[index]!;
      Object.assign(
        row,
        retainedEvidenceRow(row, reference, event, "recorded_native", {
          amount: event.amount,
          price_per_unit: toDecimal(event.amount).div(row.units!).toFixed(6),
          currency: event.currency,
          fx_rate_to_eur: null,
          asset_transfer_details: {
            direction: "in",
            basisStatus: "recorded_reference",
          },
        }),
      );
    }
    const priorRouting = [
      {
        batchId: prior.batches[0]!.id,
        accountId: base.account,
        originAccountId: null,
        destinationAccountId: null,
      },
    ];
    prior.batches[0]!.custom_config.portfolio_performance_reference = {
      sourceHash: reference.sourceHash,
      reconciliationScope: "correct_existing_only",
      originalBatchIds: [prior.batches[0]!.id],
      effectiveBatchIds: [prior.batches[0]!.id],
      routing: priorRouting,
      stagingBinding: portfolioReferenceStagingBinding(
        asSourceRows(prior.rows),
      ),
      originalStagingBinding: portfolioReferenceStagingBinding(
        asSourceRows(prior.rows),
      ),
    };
    const receipts: SyntheticAdoptionReceipt[] = [];
    for (const index of [0, 3, 4]) {
      const row = giftRows[index]!;
      const before = structuredClone(history[index]!);
      const after = {
        ...before,
        account_id: base.account,
        source_record_hash: row.source_record_hash,
        dedup_fingerprint: row.dedup_fingerprint,
        dedup_fingerprint_version: 1,
      };
      if (index !== 3)
        Object.assign(after, {
          currency: row.currency,
          fx_rate_to_eur: null,
          amount: row.amount,
          price_per_unit: row.price_per_unit,
        });
      receipts.push({
        id: index + 1,
        batch_id: prior.batches[0]!.id,
        staging_row_id: row.id,
        transaction_id: before.id,
        policy: index === 3 ? "preserve_existing" : "prefer_source",
        before_data: before,
        after_data: structuredClone(after),
      });
      history[index] = after;
      row.status = "duplicate";
    }
    source.history = history;
    source.kinesisAdoptionContext = {
      sources: prior.rows,
      batches: prior.batches,
      receipts,
    };
    const scope = options.scope ?? "adopt_existing_only";
    const groupPlan: KinesisYieldPlan = {
      blockers: [],
      yieldGroupEvidence: retainedKinesisYieldEvidence(source, reference),
    };
    if (options.withReference !== false)
      attachKinesisYieldReference(source, reference, groupPlan, scope);
    return { source, prior, reference, investments, groupPlan };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function attachKinesisYieldReference(
  source: SyntheticKinesisScope,
  reference: Pick<RetainedReference, "sourceHash">,
  plan: KinesisYieldPlan,
  scope = "adopt_existing_only",
): void {
  const ids = source.batches.map((batch) => Number(batch.id));
  const routing = source.batches.map((batch) => ({
    batchId: Number(batch.id),
    accountId: batch.account_id,
    originAccountId: null,
    destinationAccountId: null,
  }));
  const cache = {
    sourceHash: reference.sourceHash,
    reconciliationScope: scope,
    originalBatchIds: ids,
    effectiveBatchIds: ids,
    routing,
    originalRouting: routing,
    stagingBinding: portfolioReferenceStagingBinding(asSourceRows(source.rows)),
    originalStagingBinding: portfolioReferenceStagingBinding(
      asSourceRows(source.rows),
    ),
    yieldGroupEvidence: plan.yieldGroupEvidence,
  };
  for (const batch of source.batches) {
    batch.custom_config.portfolio_performance_reference = cache;
    batch.custom_config.reference_blockers = plan.blockers;
  }
  source.referenceOriginalRows = source.rows;
}

/** Fixed five-member fixture topology; this does not discover documentary matches. */
export function retainedKinesisYieldEvidence(
  source: SyntheticKinesisScope,
  reference: RetainedReference,
) {
  const gifts = source.rows.filter((row) => row.type === "gift");
  const history = source.history;
  if (
    gifts.length !== 5 ||
    history.length !== 5 ||
    reference.events.length !== 5
  )
    throw new Error(
      "Synthetic retained group must have exactly five fixture members",
    );
  const capture = source.batches[0]!.custom_config.kinesis_source_context;
  // Present by construction: the yield group is built on an adopted prior batch.
  const context = source.kinesisAdoptionContext!;
  const manifest = {
    sourceFileHash: capture.source_file_hash,
    referenceHash: reference.sourceHash,
    accountId: Number(source.batches[0]!.account_id),
    investmentId: Number(gifts[0]!.investment_id),
    portfolioId: "portfolio-one",
    securityId: "security-eth",
    lower: "2024-01-02",
    upper: "2024-04-30",
    boundaries: [0, 4].map((index) => ({
      canonicalId: Number(history[index]!.id),
      receiptId: Number(
        context.receipts.find(
          (receipt) =>
            Number(receipt.transaction_id) === Number(history[index]!.id),
        )!.id,
      ),
      sourceHash: gifts[index]!.source_record_hash,
      referenceId: reference.events[index]!.id,
    })),
    members: [1, 2, 3].map((index) => ({
      canonicalId: Number(history[index]!.id),
      eventKey: capture.events[gifts[index]!.row_index]!.eventKey,
      sourceHash: gifts[index]!.source_record_hash,
      sourceId: gifts[index]!.source_transaction_id,
      referenceId: reference.events[index]!.id,
      recordedDate: reference.events[index]!.date,
      paymentDate: gifts[index]!.tx_date,
      units: toDecimal(history[index]!.units).toFixed(8),
    })),
  };
  return {
    version: 1,
    reference,
    referenceDigest: kinesisYieldReferenceDigest(reference),
    accountMappings: [
      {
        portfolioId: "portfolio-one",
        accountId: Number(source.batches[0]!.account_id),
      },
    ],
    manifests: [manifest],
  };
}
