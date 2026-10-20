import { escapeCsvValue } from "@vision/shared-utils/csv";
import type {
  AnalysisInterchangeResult as AnalysisResult,
  AnalysisInterchangeValue as AnalysisValue,
} from "./types.ts";

export type ScenarioColumnType =
  "string" | "integer" | "decimal" | "boolean" | "date";
export interface ScenarioAttachment {
  id: string;
  fileName: string;
  importedAt: string;
  sha256: string;
  columns: Array<{ id: string; label: string; type: ScenarioColumnType }>;
  rows: Array<Record<string, AnalysisValue>>;
}
export interface AnalysisScenarioModel {
  attachments: ScenarioAttachment[];
  joins: Array<{
    inputId: string;
    resultColumn: string;
    inputColumn: string;
  }>;
}

export const SCENARIO_CSV_MAX_BYTES = 1_000_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER = /^-?(?:0|[1-9]\d*)$/;
const DECIMAL = /^-?(?:0|[1-9]\d*)\.\d+$/;
const isSafeIntegerText = (value: string) =>
  INTEGER.test(value) && Number.isSafeInteger(Number(value));
const isDate = (value: string) => {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

const columnId = (label: string, index: number) => {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(normalized)
    ? normalized.slice(0, 64)
    : `column_${index + 1}`;
};
const inferType = (values: string[]): ScenarioColumnType => {
  const present = values.filter((value) => value !== "");
  if (
    present.length &&
    present.every((value) => /^(?:true|false)$/i.test(value))
  )
    return "boolean";
  if (present.length && present.every((value) => isSafeIntegerText(value)))
    return "integer";
  if (
    present.length &&
    present.every((value) => isSafeIntegerText(value) || DECIMAL.test(value))
  )
    return "decimal";
  if (present.length && present.every(isDate)) return "date";
  return "string";
};
const normalize = (value: string, type: ScenarioColumnType): AnalysisValue => {
  if (value === "") return null;
  if (type === "boolean") return value.toLowerCase() === "true";
  if (type === "integer") return Number(value);
  return value;
};

export async function parseScenarioCsvText(input: {
  text: string;
  fileName: string;
  size: number;
  importedAt: string | (() => string);
  parse: (
    text: string,
    options: {
      bom: true;
      columns: false;
      relax_column_count: false;
      skip_empty_lines: true;
      trim: false;
    },
  ) => string[][];
  sha256: (text: string) => Promise<string>;
}): Promise<ScenarioAttachment> {
  if (input.size > SCENARIO_CSV_MAX_BYTES)
    throw new Error("Scenario CSV exceeds the 1 MB limit");
  const records = input.parse(input.text, {
    bom: true,
    columns: false,
    relax_column_count: false,
    skip_empty_lines: true,
    trim: false,
  });
  if (records.length < 2)
    throw new Error("Scenario CSV needs a header and at least one row");
  const headers = records[0];
  if (!headers?.length || headers.length > 32)
    throw new Error("Scenario CSV must contain 1 to 32 columns");
  if (records.length - 1 > 1_000)
    throw new Error("Scenario CSV exceeds the 1,000 row limit");
  const headerColumns = headers.map((label, index) => ({
    label,
    id: columnId(label, index),
  }));
  if (new Set(headerColumns.map(({ id }) => id)).size !== headers.length)
    throw new Error("Scenario CSV column names must be unique");
  const columns = headerColumns.map(({ label, id }, index) => ({
    id,
    label: label.trim() || id,
    type: inferType(records.slice(1).map((row) => row[index] ?? "")),
  }));
  const sha256 = await input.sha256(input.text);
  const id = `scenario_${sha256.slice(0, 12)}`;
  return {
    id,
    fileName: input.fileName,
    importedAt:
      typeof input.importedAt === "function"
        ? input.importedAt()
        : input.importedAt,
    sha256,
    columns,
    rows: records
      .slice(1)
      .map((record) =>
        Object.fromEntries(
          columns.map(({ id: key, type }, index) => [
            key,
            normalize(record[index] ?? "", type),
          ]),
        ),
      ),
  };
}

export function analysisResultCsv(
  result: AnalysisResult,
  metadata: {
    name: string;
    timezone: string;
    workspace: string;
    definitionId?: string | undefined;
    definitionVersion?: number | undefined;
    datasetIds: string[];
    sourceReferences: string[];
  },
): string {
  const declared = result.declaredColumns?.length
    ? result.declaredColumns
    : result.columns;
  const columns = [
    ...declared.map(({ id }) => id),
    ...result.rows.flatMap((row) => Object.keys(row)),
  ].filter((id, index, all) => all.indexOf(id) === index);
  const schema = columns.map((id) => {
    const declaredColumn = declared.find((column) => column.id === id);
    if (declaredColumn) return `${id}:${declaredColumn.type}:unit-unavailable`;
    const sample = result.rows
      .map((row) => row[id])
      .find((value) => value !== null && value !== undefined);
    const inferredType =
      typeof sample === "boolean"
        ? "boolean"
        : typeof sample === "number"
          ? Number.isSafeInteger(sample)
            ? "integer"
            : "decimal"
          : "string";
    return `${id}:${inferredType}:unit-unavailable:runtime-inferred`;
  });
  const windowLabel =
    result.window.kind === "truncated"
      ? `truncated:${result.window.reason}`
      : result.window.hasMore
        ? `page:${result.window.offset}:${result.window.returnedRows}`
        : "complete";
  const lines = [
    ["# Vision analysis export", metadata.name],
    ["# analysis_workspace", metadata.workspace],
    ["# definition_id", metadata.definitionId ?? "unavailable"],
    ["# definition_version", metadata.definitionVersion ?? "unavailable"],
    [
      "# datasets",
      metadata.datasetIds.length
        ? metadata.datasetIds.join("; ")
        : "unavailable",
    ],
    ["# request_id", result.requestId],
    ["# executor", result.executor],
    ["# source_versions", "unavailable"],
    ["# snapshot_id", "unavailable"],
    ["# started_at", result.startedAt],
    ["# completed_at", result.completedAt],
    ["# reporting_timezone", metadata.timezone],
    ["# value_semantics", "as-returned; no currency conversion"],
    [
      "# source_date_columns",
      declared
        .filter(({ type }) => type === "date" || type === "datetime")
        .map(({ id }) => id)
        .join("; ") || "unavailable",
    ],
    [
      "# source_references",
      metadata.sourceReferences.length
        ? metadata.sourceReferences.join("; ")
        : "unavailable",
    ],
    ["# column_schema", schema.join("; ")],
    ["# result_window", windowLabel],
    columns,
    ...result.rows.map((row) => columns.map((id) => row[id] ?? null)),
  ];
  return `${lines.map((row) => row.map((value) => escapeCsvValue(value, { treatNumericStringsAsSafe: true })).join(",")).join("\r\n")}\r\n`;
}
