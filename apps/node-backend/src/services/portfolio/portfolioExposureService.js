import { createHash } from "node:crypto";
import { z } from "zod";
import Decimal from "decimal.js";
import { fundHoldingsDocumentSchema } from "@vision/types/fund-holdings";
import { getPortfolioSummary } from "./portfolioSummaryService.js";
import * as repository from "../../repositories/portfolioExposureRepository.js";

const identifier = z
  .strictObject({
    type: z.enum(["isin", "ticker", "sedol", "cusip", "lei", "proprietary"]),
    value: z.string().trim().min(1).max(128),
    exchange: z.string().trim().min(1).max(64).optional(),
  })
  .superRefine((value, context) => {
    if (value.type !== "ticker" && value.exchange !== undefined)
      context.addIssue({
        code: "custom",
        path: ["exchange"],
        message: "Only ticker identifiers may declare an exchange",
      });
    if (
      value.type === "isin" &&
      !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(value.value)
    )
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "ISIN must use its 12-character canonical form",
      });
  });
const classification = z
  .strictObject({
    investmentId: z.number().int().positive().optional(),
    identifier: identifier.optional(),
    issuerId: z.string().trim().min(1).max(128),
    issuerName: z.string().trim().min(1).max(256),
    sector: z.string().trim().min(1).max(128).optional(),
    issuerCountryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    sourceLabel: z.string().trim().min(1).max(300),
  })
  .refine(
    (value) =>
      Number(value.investmentId !== undefined) +
        Number(value.identifier !== undefined) ===
      1,
    {
      message:
        "Classification must target exactly one investment or typed identifier",
    },
  );
const documentInput = z.strictObject({
  investmentId: z.number().int().positive(),
  shareClassIdentifier: identifier,
  document: fundHoldingsDocumentSchema,
});
export const portfolioExposureBundleSchema = z.strictObject({
  classifications: z.array(classification).max(5_000),
  fundDocuments: z.array(documentInput).max(500),
});

const identifierKey = (value) =>
  `${value.type}:${value.exchange ?? ""}:${value.value}`;
const money = (value) => new Decimal(value || 0);
const emit = (value) =>
  Number(value.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toString());
const weight = (amount, total) =>
  total.isZero() ? 0 : emit(amount.times(100).dividedBy(total));
const invalidSource = (message, issues) =>
  Object.assign(new Error(message), {
    code: "INVALID_PORTFOLIO_EXPOSURE_SOURCE",
    issues,
  });

export async function upsertPortfolioExposureBundle(input) {
  const parsed = portfolioExposureBundleSchema.safeParse(input);
  if (!parsed.success)
    throw invalidSource(
      "The exposure source bundle is invalid",
      parsed.error.issues,
    );
  const bundle = parsed.data;
  const investments = new Set();
  const identifiers = new Set();
  for (const item of bundle.classifications) {
    const key = item.investmentId
      ? `investment:${item.investmentId}`
      : `identifier:${identifierKey(item.identifier)}`;
    if ((item.investmentId ? investments : identifiers).has(key))
      throw invalidSource("Exposure classification targets must be unique");
    (item.investmentId ? investments : identifiers).add(key);
  }
  const docs = new Set();
  const fundDocuments = bundle.fundDocuments.map((item) => {
    if (docs.has(item.investmentId))
      throw invalidSource(
        "Only one fund document may be attached to an investment",
      );
    docs.add(item.investmentId);
    if (
      !item.document.shareClass.identifiers.some(
        (candidate) =>
          identifierKey(candidate) === identifierKey(item.shareClassIdentifier),
      )
    )
      throw invalidSource(
        "Fund attachment must match an exact typed share-class identifier",
      );
    return {
      ...item,
      sourceSha256: createHash("sha256")
        .update(JSON.stringify(item.document))
        .digest("hex"),
    };
  });
  const targetIds = [
    ...new Set([
      ...bundle.classifications.flatMap((item) =>
        item.investmentId === undefined ? [] : [item.investmentId],
      ),
      ...fundDocuments.map(({ investmentId }) => investmentId),
    ]),
  ];
  const targets = await repository.listExposureTargets(targetIds);
  const byId = new Map(targets.map((item) => [Number(item.id), item]));
  const missingId = targetIds.find((id) => !byId.has(id));
  if (missingId !== undefined)
    throw invalidSource("Exposure sources must target existing investments");
  const invalidFund = fundDocuments.find(
    ({ investmentId }) => byId.get(investmentId)?.assetClass !== "etf",
  );
  if (invalidFund)
    throw invalidSource(
      "Fund holdings documents may target only ETF investments",
    );
  return repository.upsertExposureBundle({
    classifications: bundle.classifications,
    fundDocuments,
  });
}

function aggregateDimension(contributions, property, totalValue) {
  const rows = new Map();
  let unclassified = new Decimal(0);
  for (const contribution of contributions) {
    const key = contribution.classification?.[property];
    if (!key) {
      unclassified = unclassified.plus(contribution.amount);
      continue;
    }
    const id = property === "issuerId" ? key : String(key);
    const current = rows.get(id) ?? {
      id,
      label:
        property === "issuerId"
          ? contribution.classification.issuerName
          : String(key),
      amount: new Decimal(0),
      contributions: [],
    };
    current.amount = current.amount.plus(contribution.amount);
    current.contributions.push({
      sourceType: contribution.sourceType,
      investmentId: contribution.investmentId,
      investmentName: contribution.investmentName,
      sourceFundName: contribution.sourceFundName ?? null,
      amount: emit(contribution.amount),
      sourceAsOfDate: contribution.sourceAsOfDate ?? null,
      stale: contribution.stale ?? false,
    });
    rows.set(id, current);
  }
  return {
    rows: [...rows.values()]
      .map((row) => ({
        ...row,
        amount: emit(row.amount),
        weightPercent: weight(row.amount, totalValue),
      }))
      .sort((a, b) => b.amount - a.amount),
    classifiedValue: emit(
      [...rows.values()].reduce(
        (total, row) => total.plus(row.amount),
        new Decimal(0),
      ),
    ),
    classifiedWeightPercent: weight(
      [...rows.values()].reduce(
        (total, row) => total.plus(row.amount),
        new Decimal(0),
      ),
      totalValue,
    ),
    unclassifiedValue: emit(unclassified),
    unclassifiedWeightPercent: weight(unclassified, totalValue),
  };
}

function aggregatePortfolioExposure(summary, sources) {
  const evaluationDate = String(summary.computed_at).slice(0, 10);
  const evaluationTime = Date.parse(`${evaluationDate}T00:00:00Z`);
  const direct = new Map(
    sources.classifications
      .filter((item) => item.investmentId)
      .map((item) => [Number(item.investmentId), item]),
  );
  const byIdentifier = new Map(
    sources.classifications
      .filter((item) => item.identifierType)
      .map((item) => [
        identifierKey({
          type: item.identifierType,
          value: item.identifierValue,
          exchange: item.identifierExchange ?? undefined,
        }),
        item,
      ]),
  );
  const documents = new Map(
    sources.documents.map((item) => [Number(item.investmentId), item]),
  );
  const contributions = [];
  let uncovered = new Decimal(0);
  let coveredCash = new Decimal(0);
  const warnings = [];
  const fundSources = [];
  for (const holding of summary.summaries) {
    const value = money(holding.currentValue);
    const source = documents.get(Number(holding.id));
    if (!source) {
      if (["etf", "fund"].includes(String(holding.asset_class).toLowerCase()))
        uncovered = uncovered.plus(value);
      else
        contributions.push({
          amount: value,
          sourceType: "direct",
          investmentId: Number(holding.id),
          investmentName: holding.name,
          classification: direct.get(Number(holding.id)),
        });
      continue;
    }
    const sourceAsOfTime = Date.parse(
      `${source.document.source.asOfDate}T00:00:00Z`,
    );
    const sourceAgeDays = Math.max(
      0,
      Math.floor((evaluationTime - sourceAsOfTime) / 86_400_000),
    );
    const sourceIsStale =
      sourceAgeDays > source.document.staleness.maximumAgeDays;
    fundSources.push({
      investmentId: Number(holding.id),
      investmentName: holding.name,
      asOfDate: source.document.source.asOfDate,
      evaluatedAt: evaluationDate,
      ageDays: sourceAgeDays,
      maximumAgeDays: source.document.staleness.maximumAgeDays,
      stale: sourceIsStale,
      coverageStatus: source.document.coverage.status,
    });
    if (sourceIsStale)
      warnings.push({
        code: "STALE_FUND_SOURCE",
        investmentId: Number(holding.id),
        asOfDate: source.document.source.asOfDate,
        evaluatedAt: evaluationDate,
        ageDays: sourceAgeDays,
        maximumAgeDays: source.document.staleness.maximumAgeDays,
      });
    for (const row of source.document.holdings) {
      const amount = value.times(row.weightPercent).dividedBy(100);
      if (row.exposureStatus === "unsupported") {
        uncovered = uncovered.plus(amount);
        continue;
      }
      if (row.exposureKind === "cash") {
        coveredCash = coveredCash.plus(amount);
        continue;
      }
      const matches = row.identifiers
        .map((item) => byIdentifier.get(identifierKey(item)))
        .filter(Boolean);
      const issuerIds = new Set(matches.map((item) => item.issuerId));
      if (issuerIds.size > 1) {
        uncovered = uncovered.plus(amount);
        warnings.push({
          code: "AMBIGUOUS_CONSTITUENT_MAPPING",
          investmentId: Number(holding.id),
          rowNumber: row.provenance.rowNumber,
        });
        continue;
      }
      contributions.push({
        amount,
        sourceType: "fund",
        investmentId: Number(holding.id),
        investmentName: row.name,
        sourceFundName: holding.name,
        sourceAsOfDate: source.document.source.asOfDate,
        stale: sourceIsStale,
        classification: matches[0],
      });
    }
    uncovered = uncovered.plus(
      value.times(source.document.coverage.missingWeightPercent).dividedBy(100),
    );
  }
  const totalValue = money(summary.totals.totalPortfolioValue);
  return {
    currency: summary.currency,
    computedAt: summary.computed_at,
    totalValue: emit(totalValue),
    uncoveredValue: emit(uncovered),
    uncoveredWeightPercent: weight(uncovered, totalValue),
    coveredCashValue: emit(coveredCash),
    coveredCashWeightPercent: weight(coveredCash, totalValue),
    fundSources,
    issuer: aggregateDimension(contributions, "issuerId", totalValue),
    sector: aggregateDimension(contributions, "sector", totalValue),
    issuerCountry: aggregateDimension(
      contributions,
      "issuerCountryCode",
      totalValue,
    ),
    warnings,
    scopeNotes: [
      "Issuer country is explicit source metadata, not listing or revenue geography.",
      "No economic foreign-exchange exposure is inferred.",
    ],
  };
}

export async function getPortfolioExposure(currency = "EUR") {
  const [summary, sources] = await Promise.all([
    getPortfolioSummary(currency),
    repository.listExposureSources(),
  ]);
  return aggregatePortfolioExposure(summary, sources);
}

export { aggregatePortfolioExposure as __aggregatePortfolioExposure };
