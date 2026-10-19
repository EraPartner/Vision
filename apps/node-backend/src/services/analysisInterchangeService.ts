import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import {
  analysisResultCsv,
  parseScenarioCsvText,
  workbookScenarioAttachment,
} from "@vision/shared-utils/analysis/interchange";
import {
  analysisResultWorkbook,
  importAnalysisWorkbook,
} from "@vision/shared-utils/analysis/workbook";
import { parseAnalysisWorkbookXml } from "./analysisWorkbookXml.ts";
import { ValidationError } from "../middleware/errorHandler.ts";
import { parseInput } from "../lib/zodInput.ts";

export type AnalysisInterchangeFormat = "csv" | "xlsx";
export const ANALYSIS_EXPORT_MAX_BYTES = 64 * 1024 * 1024;
const scalar = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const column = z.looseObject({
  id: z.string(),
  type: z.string(),
  label: z.string().optional(),
  nullable: z.boolean().optional(),
  unit: z.unknown().optional(),
});
const exportPayload = z.object({
  result: z.looseObject({
    requestId: z.string(),
    startedAt: z.string().optional(),
    completedAt: z.string(),
    executor: z.string().optional(),
    rows: z.array(z.record(z.string(), z.json())),
    columns: z.array(column),
    declaredColumns: z.array(column).optional(),
    complete: z.boolean().optional(),
    coverage: z.unknown().optional(),
    transformationCoverage: z.unknown().optional(),
    preparationLineage: z.unknown().optional(),
    transformationErrors: z.unknown().optional(),
    formulaErrors: z.unknown().optional(),
    formulaSummaries: z.record(z.string(), scalar).optional(),
    window: z.union([
      z.looseObject({
        kind: z.literal("page"),
        offset: z.number().int().nonnegative(),
        limit: z.number().int().nonnegative(),
        hasMore: z.boolean(),
        returnedRows: z.number().int().nonnegative(),
      }),
      z.looseObject({
        kind: z.literal("truncated"),
        reason: z.string(),
        returnedRows: z.number().int().nonnegative(),
        enforcedLimit: z.number().int().nonnegative(),
      }),
    ]),
  }),
  context: z.looseObject({
    name: z.string(),
    timezone: z.string(),
    workspace: z.string(),
    definitionId: z.string().optional(),
    definitionVersion: z.number().int().optional(),
    datasetIds: z.array(z.string()).optional(),
    sourceReferences: z.array(z.string()).optional(),
    assumptions: z.unknown().optional(),
    formulas: z.unknown().optional(),
  }),
});
function invalid(error: unknown): never {
  if (error instanceof ValidationError) throw error;
  throw new ValidationError(
    error instanceof Error
      ? error.message
      : "Invalid analysis interchange input",
  );
}
/** Size check and read through one handle, so the file read is the file measured. */
async function readBounded(
  filePath: string,
  limit: number,
  message: () => string,
): Promise<Buffer> {
  const file = await fs.open(filePath, "r");
  try {
    if ((await file.stat()).size > limit) throw new ValidationError(message());
    return await file.readFile();
  } finally {
    await file.close();
  }
}
/** Value-only file parsing. No Analysis execution, scenario save, settings or database writes. */
export async function importAnalysisInterchange(
  filePath: string,
  fileName: string,
  format: AnalysisInterchangeFormat,
) {
  const limit = format === "csv" ? 1_000_000 : 10_000_000;
  const bytes = await readBounded(filePath, limit, () =>
    format === "csv"
      ? "Scenario CSV exceeds the 1 MB limit"
      : "Workbook exceeds 10 MB",
  );
  try {
    const importedAt = new Date().toISOString();
    if (format === "csv") {
      const attachment = await parseScenarioCsvText({
        text: new TextDecoder().decode(bytes),
        fileName,
        size: bytes.length,
        importedAt,
        parse: (text, options) => parse(text, options),
        sha256: async (text) =>
          createHash("sha256")
            .update(new TextEncoder().encode(text))
            .digest("hex"),
      });
      return { format, attachment, formulaCells: 0 };
    }
    const workbook = importAnalysisWorkbook(bytes, parseAnalysisWorkbookXml);
    if (workbook.rows.length > 1000 || workbook.columns.length > 32)
      throw new ValidationError(
        "Workbook attachment exceeds 1,000 rows or 32 columns",
      );
    return {
      format,
      attachment: workbookScenarioAttachment(workbook, {
        id: `workbook_${randomUUID().replace(/-/g, "")}`,
        fileName,
        importedAt,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
      formulaCells: workbook.formulaCells,
    };
  } catch (error) {
    invalid(error);
  }
}

/** Export the submitted captured snapshot only. The native UI owns stale-input/export
 * availability checks; this operation never reruns a query or repairs missing values. */
export async function exportAnalysisInterchange(
  filePath: string,
  format: AnalysisInterchangeFormat,
) {
  const text = (
    await readBounded(
      filePath,
      ANALYSIS_EXPORT_MAX_BYTES,
      () => "Analysis export payload exceeds 64 MiB",
    )
  ).toString("utf8");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ValidationError("Analysis export payload must be valid JSON");
  }
  const _checked = parseInput(exportPayload, payload);
  // Validate without replacing the captured objects: Zod's clones reorder known
  // keys, which changes serialized provenance and stored-ZIP bytes.
  const { result, context } = payload as typeof _checked;
  try {
    return format === "csv"
      ? new TextEncoder().encode(
          analysisResultCsv(result, {
            ...context,
            datasetIds: context.datasetIds ?? [],
            sourceReferences: context.sourceReferences ?? [],
          }),
        )
      : analysisResultWorkbook(result, context);
  } catch (error) {
    invalid(error);
  }
}
