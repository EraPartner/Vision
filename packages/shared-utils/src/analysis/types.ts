/** The captured value snapshot used by browser/native interchange. This is not an
 * executable analysis definition; unknown metadata on the original objects stays intact. */
export type AnalysisInterchangeValue = string | number | boolean | null;
export interface AnalysisInterchangeColumn {
  id: string;
  type: string;
  label?: string | undefined;
  nullable?: boolean | undefined;
  unit?: unknown;
}
export interface AnalysisInterchangeResult {
  requestId: string;
  startedAt?: string | undefined;
  completedAt: string;
  executor?: string | undefined;
  generatedSql?: string | undefined;
  byteLength?: number | undefined;
  // Analysis wire rows include JSON/array columns as well as scalars. Imported
  // scenario attachments keep the separate scalar AnalysisInterchangeValue contract.
  rows: Array<Record<string, unknown>>;
  columns: AnalysisInterchangeColumn[];
  declaredColumns?: AnalysisInterchangeColumn[] | undefined;
  complete?: boolean | undefined;
  coverage?: unknown;
  transformationCoverage?: unknown;
  preparationLineage?: unknown;
  transformationErrors?: unknown;
  formulaErrors?: unknown;
  formulaSummaries?: Record<string, AnalysisInterchangeValue> | undefined;
  window:
    | {
        kind: "page";
        offset: number;
        limit: number;
        hasMore: boolean;
        returnedRows: number;
      }
    | {
        kind: "truncated";
        reason: string;
        returnedRows: number;
        enforcedLimit: number;
      };
}
