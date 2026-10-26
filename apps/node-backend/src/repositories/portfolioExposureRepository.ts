import type { FundHoldingsDocument } from "@vision/types/fund-holdings";
import type { InvestmentId } from "@vision/types/brands";
import { sql } from "kysely";
import { asInvestmentId } from "@vision/types/brands";
import { withTransaction } from "../database/connection.ts";
import { checkedRows, db } from "../database/db.ts";
import {
  exposureClassificationRowSchema,
  exposureTargetRowSchema,
  fundHoldingsDocumentRowSchema,
} from "../database/rows/portfolio.ts";
import type {
  ExposureClassificationDbRow,
  FundHoldingsDocumentDbRow,
} from "../database/rows/portfolio.ts";

export type ExposureIdentifier = {
  type: string;
  value: string;
  exchange?: string | null | undefined;
};

export type ExposureClassificationInput = {
  investmentId?: number | undefined;
  identifier?: ExposureIdentifier | undefined;
  issuerId: string;
  issuerName: string;
  sector?: string | undefined;
  issuerCountryCode?: string | undefined;
  sourceLabel: string;
};

export type FundDocumentInput = {
  investmentId: number;
  shareClassIdentifier: ExposureIdentifier;
  document: FundHoldingsDocument;
  sourceSha256: string;
};

/** Derived from the checked row schema; `id` is a UUID string. */
export type ExposureClassificationRow = ExposureClassificationDbRow;

/** Derived from the checked row schema; `id` is a UUID string. */
export type FundHoldingsDocumentRow = FundHoldingsDocumentDbRow;

const classificationColumns = [
  "id",
  "investment_id as investmentId",
  "identifier_type as identifierType",
  "identifier_value as identifierValue",
  "identifier_exchange as identifierExchange",
  "issuer_id as issuerId",
  "issuer_name as issuerName",
  "sector",
  "issuer_country_code as issuerCountryCode",
  "source_label as sourceLabel",
  "created_at as createdAt",
  "updated_at as updatedAt",
] as const;

export async function listExposureSources(): Promise<{
  classifications: ExposureClassificationRow[];
  documents: FundHoldingsDocumentRow[];
}> {
  const [classifications, documents] = await Promise.all([
    checkedRows(
      exposureClassificationRowSchema,
      db
        .selectFrom("portfolio_exposure_classifications")
        .select(classificationColumns)
        .orderBy("issuer_name").orderBy("id"),
    ),
    checkedRows(
      fundHoldingsDocumentRowSchema,
      db
        .selectFrom("portfolio_fund_holdings_documents")
        .select([
          "id",
          "investment_id as investmentId",
          "share_class_identifier_json as shareClassIdentifier",
          "document_json as document",
          "source_as_of_date as sourceAsOfDate",
          "source_sha256 as sourceSha256",
          "created_at as createdAt",
          "updated_at as updatedAt",
        ])
        .orderBy("investment_id"),
    ),
  ]);
  return { classifications, documents };
}

export async function listExposureTargets(
  investmentIds: readonly number[],
): Promise<{ id: number; assetClass: string }[]> {
  if (investmentIds.length === 0) return [];
  return checkedRows(
    exposureTargetRowSchema,
    db
      .selectFrom("investments")
      .select(["id", "asset_class as assetClass"])
      .where("id", "=", sql<InvestmentId>`ANY(${investmentIds}::int[])`),
  );
}

export async function upsertExposureBundle({
  classifications,
  fundDocuments,
}: {
  classifications: readonly ExposureClassificationInput[];
  fundDocuments: readonly FundDocumentInput[];
}): ReturnType<typeof listExposureSources> {
  await withTransaction(async () => {
    for (const item of classifications) {
      await db
        .insertInto("portfolio_exposure_classifications")
        .values({
          investment_id:
            item.investmentId === undefined
              ? null
              : asInvestmentId(item.investmentId),
          identifier_type: item.identifier?.type ?? null,
          identifier_value: item.identifier?.value ?? null,
          identifier_exchange: item.identifier?.exchange ?? null,
          issuer_id: item.issuerId,
          issuer_name: item.issuerName,
          sector: item.sector ?? null,
          issuer_country_code: item.issuerCountryCode ?? null,
          source_label: item.sourceLabel,
        })
        .onConflict((oc) =>
          (item.investmentId !== undefined
            ? oc.column("investment_id").where("investment_id", "is not", null)
            : oc
                .expression(
                  sql`identifier_type,identifier_value,COALESCE(identifier_exchange,'')`,
                )
                .where("investment_id", "is", null)
          ).doUpdateSet((eb) => ({
            issuer_id: eb.ref("excluded.issuer_id"),
            issuer_name: eb.ref("excluded.issuer_name"),
            sector: eb.ref("excluded.sector"),
            issuer_country_code: eb.ref("excluded.issuer_country_code"),
            source_label: eb.ref("excluded.source_label"),
            updated_at: sql<Date>`now()`,
          })),
        )
        .execute();
    }
    for (const item of fundDocuments) {
      await db
        .insertInto("portfolio_fund_holdings_documents")
        .values({
          investment_id: asInvestmentId(item.investmentId),
          share_class_identifier_json: sql`${JSON.stringify(item.shareClassIdentifier)}::jsonb`,
          document_json: sql`${JSON.stringify(item.document)}::jsonb`,
          source_as_of_date: item.document.source.asOfDate,
          source_sha256: item.sourceSha256,
        })
        .onConflict((oc) =>
          oc.column("investment_id").doUpdateSet((eb) => ({
            share_class_identifier_json: eb.ref(
              "excluded.share_class_identifier_json",
            ),
            document_json: eb.ref("excluded.document_json"),
            source_as_of_date: eb.ref("excluded.source_as_of_date"),
            source_sha256: eb.ref("excluded.source_sha256"),
            updated_at: sql<Date>`now()`,
          })),
        )
        .execute();
    }
  });
  return listExposureSources();
}
