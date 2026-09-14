import { query, withTransaction } from "../database/connection.js";

const DOCUMENT_COLUMNS = `id, title, source_name AS "sourceName", media_type AS "mediaType",
  content_sha256 AS "contentSha256", version, extraction_status AS "extractionStatus",
  extraction_error AS "extractionError", created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function listDocuments() {
  const result = await query(
    `SELECT ${DOCUMENT_COLUMNS} FROM ai_research_documents ORDER BY updated_at DESC`,
  );
  return result.rows;
}

export async function getDocument(id) {
  const result = await query(
    `SELECT ${DOCUMENT_COLUMNS} FROM ai_research_documents WHERE id=$1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function createDocument(input, passages) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `ai-research-document:${input.sourceName}`,
    ]);
    const existing = await client.query(
      `SELECT ${DOCUMENT_COLUMNS} FROM ai_research_documents
       WHERE source_name=$1 AND content_sha256=$2`,
      [input.sourceName, input.contentSha256],
    );
    if (existing.rows[0]) return existing.rows[0];
    const next = await client.query(
      "SELECT COALESCE(MAX(version),0)+1 AS version FROM ai_research_documents WHERE source_name=$1",
      [input.sourceName],
    );
    const inserted = await client.query(
      `INSERT INTO ai_research_documents
        (title,source_name,media_type,content_sha256,version,extraction_status,extraction_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${DOCUMENT_COLUMNS}`,
      [
        input.title,
        input.sourceName,
        input.mediaType,
        input.contentSha256,
        Number(next.rows[0].version),
        input.extractionStatus,
        input.extractionError ?? null,
      ],
    );
    const document = inserted.rows[0];
    for (const passage of passages) {
      await client.query(
        `INSERT INTO ai_research_passages
          (document_id,ordinal,page_number,section,content,embedding_json)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          document.id,
          passage.ordinal,
          passage.pageNumber ?? null,
          passage.section ?? null,
          passage.content,
          passage.embedding ? JSON.stringify(passage.embedding) : null,
        ],
      );
    }
    return document;
  });
}

export async function deleteDocument(id) {
  const result = await query(
    "DELETE FROM ai_research_documents WHERE id=$1 RETURNING id",
    [id],
  );
  return result.rowCount > 0;
}

export async function keywordSearch(search, limit) {
  const result = await query(
    `SELECT p.id, p.document_id AS "documentId", p.ordinal,
            p.page_number AS "pageNumber", p.section, p.content,
            p.embedding_json AS embedding, d.title, d.source_name AS "sourceName",
            d.version, d.content_sha256 AS "documentHash",
            ts_rank_cd(p.search_vector, websearch_to_tsquery('simple',$1)) AS score
       FROM ai_research_passages p
       JOIN ai_research_documents d ON d.id=p.document_id
      WHERE d.extraction_status='ready'
        AND p.search_vector @@ websearch_to_tsquery('simple',$1)
      ORDER BY score DESC, d.updated_at DESC, p.ordinal
      LIMIT $2`,
    [search, limit],
  );
  return result.rows;
}

export async function semanticCandidates(limit = 200) {
  const result = await query(
    `SELECT p.id, p.document_id AS "documentId", p.ordinal,
            p.page_number AS "pageNumber", p.section, p.content,
            p.embedding_json AS embedding, d.title, d.source_name AS "sourceName",
            d.version, d.content_sha256 AS "documentHash"
       FROM ai_research_passages p
       JOIN ai_research_documents d ON d.id=p.document_id
      WHERE d.extraction_status='ready' AND p.embedding_json IS NOT NULL
      ORDER BY d.updated_at DESC, p.ordinal LIMIT $1`,
    [limit],
  );
  return result.rows;
}
