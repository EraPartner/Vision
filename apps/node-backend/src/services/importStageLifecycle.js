/**
 * Shared lifecycle for the transaction and portfolio CSV staging phases.
 * Domain parsers and INSERT shapes stay in their pipelines; this helper owns
 * the state transitions, 500-row chunking, progress contract, and BIGSERIAL
 * wire normalization that must remain identical across both.
 */

export const IMPORT_STAGE_CHUNK_SIZE = 500;

/** @param {string|number} id */
export function normalizeCreatedBatchId(id) {
  return Number(id);
}

/**
 * @template T
 * @param {{
 *   batchId: string|number,
 *   parseRows: () => Promise<(T[] & { skipped?: number })>,
 *   markStaging: () => Promise<unknown>,
 *   persistTotal: (total: number) => Promise<unknown>,
 *   insertChunk: (rows: T[], startIndex: number) => Promise<void>,
 *   onParsed?: (summary: { total: number, skipped: number }) => void,
 *   onProgress?: (progress: { phase: 'staging', current: number, total: number }) => void,
 * }} options
 * @returns {Promise<{rowsTotal: number, rowsSkipped: number}>}
 */
export async function runImportStageLifecycle({
  parseRows,
  markStaging,
  persistTotal,
  insertChunk,
  onParsed,
  onProgress,
}) {
  await markStaging();
  const rows = await parseRows();
  const total = rows.length;
  const skipped = Number(rows.skipped) || 0;
  onParsed?.({ total, skipped });
  await persistTotal(total);
  onProgress?.({ phase: "staging", current: 0, total });

  for (let start = 0; start < total; start += IMPORT_STAGE_CHUNK_SIZE) {
    const end = Math.min(start + IMPORT_STAGE_CHUNK_SIZE, total);
    await insertChunk(rows.slice(start, end), start);
    onProgress?.({ phase: "staging", current: end, total });
  }

  return { rowsTotal: total, rowsSkipped: skipped };
}
