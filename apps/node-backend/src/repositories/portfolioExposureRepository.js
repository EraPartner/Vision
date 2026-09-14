import { query, withTransaction } from "../database/connection.js";

const classificationColumns = `id,investment_id AS "investmentId",identifier_type AS "identifierType",
  identifier_value AS "identifierValue",identifier_exchange AS "identifierExchange",
  issuer_id AS "issuerId",issuer_name AS "issuerName",sector,
  issuer_country_code AS "issuerCountryCode",source_label AS "sourceLabel",
  created_at AS "createdAt",updated_at AS "updatedAt"`;

export async function listExposureSources() {
  const [classifications, documents] = await Promise.all([
    query(
      `SELECT ${classificationColumns} FROM portfolio_exposure_classifications ORDER BY issuer_name,id`,
    ),
    query(`SELECT id,investment_id AS "investmentId",share_class_identifier_json AS "shareClassIdentifier",
      document_json AS document,source_as_of_date AS "sourceAsOfDate",source_sha256 AS "sourceSha256",
      created_at AS "createdAt",updated_at AS "updatedAt"
      FROM portfolio_fund_holdings_documents ORDER BY investment_id`),
  ]);
  return { classifications: classifications.rows, documents: documents.rows };
}

export async function listExposureTargets(investmentIds) {
  if (!investmentIds.length) return [];
  const result = await query(
    `SELECT id,asset_class AS "assetClass"
       FROM investments
      WHERE id = ANY($1::int[])`,
    [investmentIds],
  );
  return result.rows;
}

export async function upsertExposureBundle({ classifications, fundDocuments }) {
  await withTransaction(async (client) => {
    for (const item of classifications) {
      const investmentTarget = item.investmentId !== undefined;
      await client.query(
        `INSERT INTO portfolio_exposure_classifications
          (investment_id,identifier_type,identifier_value,identifier_exchange,
           issuer_id,issuer_name,sector,issuer_country_code,source_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT ${
           investmentTarget
             ? "(investment_id) WHERE investment_id IS NOT NULL"
             : "(identifier_type,identifier_value,COALESCE(identifier_exchange,'')) WHERE investment_id IS NULL"
         }
         DO UPDATE SET issuer_id=EXCLUDED.issuer_id,issuer_name=EXCLUDED.issuer_name,
           sector=EXCLUDED.sector,issuer_country_code=EXCLUDED.issuer_country_code,
           source_label=EXCLUDED.source_label,updated_at=now()`,
        [
          item.investmentId ?? null,
          item.identifier?.type ?? null,
          item.identifier?.value ?? null,
          item.identifier?.exchange ?? null,
          item.issuerId,
          item.issuerName,
          item.sector ?? null,
          item.issuerCountryCode ?? null,
          item.sourceLabel,
        ],
      );
    }
    for (const item of fundDocuments) {
      await client.query(
        `INSERT INTO portfolio_fund_holdings_documents
          (investment_id,share_class_identifier_json,document_json,source_as_of_date,source_sha256)
         VALUES ($1,$2::jsonb,$3::jsonb,$4,$5)
         ON CONFLICT (investment_id) DO UPDATE SET
           share_class_identifier_json=EXCLUDED.share_class_identifier_json,
           document_json=EXCLUDED.document_json,
           source_as_of_date=EXCLUDED.source_as_of_date,
           source_sha256=EXCLUDED.source_sha256,
           updated_at=now()`,
        [
          item.investmentId,
          JSON.stringify(item.shareClassIdentifier),
          JSON.stringify(item.document),
          item.document.source.asOfDate,
          item.sourceSha256,
        ],
      );
    }
  });
  return listExposureSources();
}
