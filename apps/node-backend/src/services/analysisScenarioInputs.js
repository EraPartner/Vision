/** Typed, analysis-only CSV attachments and deterministic left joins. */

import { z } from "zod";
import Decimal from "decimal.js";

const scalar = z.union([
  z.string().max(10_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const column = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: z.string().min(1).max(200),
  type: z.enum(["string", "integer", "decimal", "boolean", "date"]),
});
const attachment = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  fileName: z.string().min(1).max(255),
  importedAt: z.iso.datetime({ offset: true }),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  columns: z.array(column).min(1).max(32),
  rows: z.array(z.record(z.string(), scalar)).max(1_000),
});
const join = z.strictObject({
  inputId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  resultColumn: z.string().min(1).max(128),
  inputColumn: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
});

const valueMatchesType = (value, type) => {
  if (value === null) return true;
  if (type === "string") return typeof value === "string";
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "decimal")
    return (
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    );
  if (type === "boolean") return typeof value === "boolean";
  return typeof value === "string" && z.iso.date().safeParse(value).success;
};

const canonicalJoinKey = (value, type) => {
  if (value === null || value === undefined) return null;
  if (type === "string" && typeof value === "string") return `string:${value}`;
  if (type === "boolean" && typeof value === "boolean")
    return `boolean:${value}`;
  if (type === "date" && typeof value === "string") {
    if (!z.iso.date().safeParse(value).success)
      throw new Error("Analysis result join value does not match date");
    return `date:${value}`;
  }
  if (type === "integer") {
    if (
      (typeof value === "number" && Number.isSafeInteger(value)) ||
      (typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value))
    )
      return `integer:${BigInt(value).toString()}`;
    throw new Error("Analysis result join value does not match integer");
  }
  if (type === "decimal") {
    if (
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    )
      return `decimal:${new Decimal(value).toString()}`;
    throw new Error("Analysis result join value does not match decimal");
  }
  throw new Error(`Analysis result join value does not match ${type}`);
};

export const analysisScenarioModelSchema = z
  .strictObject({
    attachments: z.array(attachment).max(5).default([]),
    joins: z.array(join).max(5).default([]),
  })
  .superRefine((model, context) => {
    const ids = new Set();
    const joinedInputs = new Set();
    for (const [index, item] of model.attachments.entries()) {
      if (ids.has(item.id))
        context.addIssue({
          code: "custom",
          path: ["attachments", index, "id"],
          message: "Scenario input ids must be unique",
        });
      ids.add(item.id);
      const columns = new Set(item.columns.map(({ id }) => id));
      if (columns.size !== item.columns.length)
        context.addIssue({
          code: "custom",
          path: ["attachments", index, "columns"],
          message: "Scenario column ids must be unique",
        });
      for (const [rowIndex, row] of item.rows.entries()) {
        if (
          Object.keys(row).some((key) => !columns.has(key)) ||
          [...columns].some((key) => !(key in row))
        )
          context.addIssue({
            code: "custom",
            path: ["attachments", index, "rows", rowIndex],
            message: "Scenario rows must exactly match declared columns",
          });
        for (const declared of item.columns) {
          if (!valueMatchesType(row[declared.id], declared.type))
            context.addIssue({
              code: "custom",
              path: ["attachments", index, "rows", rowIndex, declared.id],
              message: `Scenario value must match ${declared.type}`,
            });
        }
      }
    }
    for (const [index, binding] of model.joins.entries()) {
      if (joinedInputs.has(binding.inputId))
        context.addIssue({
          code: "custom",
          path: ["joins", index, "inputId"],
          message: "Each scenario input may have only one join",
        });
      joinedInputs.add(binding.inputId);
      const item = model.attachments.find(({ id }) => id === binding.inputId);
      if (!item || !item.columns.some(({ id }) => id === binding.inputColumn))
        context.addIssue({
          code: "custom",
          path: ["joins", index],
          message: "Scenario join must name an attached input column",
        });
      if (item) {
        const declaredType = item.columns.find(
          ({ id }) => id === binding.inputColumn,
        )?.type;
        const values = item.rows.map((row) =>
          canonicalJoinKey(row[binding.inputColumn], declaredType),
        );
        if (new Set(values).size !== values.length)
          context.addIssue({
            code: "custom",
            path: ["joins", index, "inputColumn"],
            message: "Scenario join keys must be unique",
          });
      }
    }
  });

const compatibleTypes = (resultType, inputType) =>
  resultType === inputType ||
  (resultType === "decimal" && inputType === "integer");

export function validateScenarioBindings(modelInput, resultColumns) {
  const model = analysisScenarioModelSchema.parse(
    modelInput ?? { attachments: [], joins: [] },
  );
  const columns = new Map(
    (resultColumns ?? []).map((column) => [column.id, column]),
  );
  const produced = new Set(columns.keys());
  for (const binding of model.joins) {
    const input = model.attachments.find(({ id }) => id === binding.inputId);
    const inputColumn = input?.columns.find(
      ({ id }) => id === binding.inputColumn,
    );
    const resultColumn = columns.get(binding.resultColumn);
    if (!resultColumn)
      throw new Error(
        `Scenario join result column does not exist: ${binding.resultColumn}`,
      );
    if (!inputColumn || !compatibleTypes(resultColumn.type, inputColumn.type))
      throw new Error(
        `Scenario join column types are incompatible: ${resultColumn.type} and ${inputColumn?.type ?? "unknown"}`,
      );
    for (const column of input.columns) {
      if (column.id === binding.inputColumn) continue;
      const outputId = `${input.id}.${column.id}`;
      if (produced.has(outputId))
        throw new Error(
          "Scenario columns must not replace analysis result columns",
        );
      produced.add(outputId);
    }
  }
  return model;
}

export function applyScenarioInputs(rows, modelInput, resultColumns) {
  const inferredColumns = resultColumns?.length
    ? resultColumns
    : Object.entries(rows[0] ?? {}).map(([id, value]) => ({
        id,
        type:
          typeof value === "number"
            ? Number.isSafeInteger(value)
              ? "integer"
              : "decimal"
            : typeof value === "boolean"
              ? "boolean"
              : "string",
      }));
  const model = validateScenarioBindings(modelInput, inferredColumns);
  let output = rows.map((row) => ({ ...row }));
  for (const binding of model.joins) {
    const input = model.attachments.find(({ id }) => id === binding.inputId);
    if (!input) continue;
    const resultType = inferredColumns.find(
      ({ id }) => id === binding.resultColumn,
    ).type;
    const index = new Map(
      input.rows.flatMap((row) => {
        const key = canonicalJoinKey(row[binding.inputColumn], resultType);
        return key === null ? [] : [[key, row]];
      }),
    );
    const addedColumns = input.columns
      .filter(({ id }) => id !== binding.inputColumn)
      .map(({ id }) => ({ sourceId: id, resultId: `${input.id}.${id}` }));
    output = output.map((row) => {
      const resultKey = canonicalJoinKey(row[binding.resultColumn], resultType);
      const matched = resultKey === null ? undefined : index.get(resultKey);
      return Object.fromEntries([
        ...Object.entries(row),
        ...addedColumns.map(({ sourceId, resultId }) => [
          resultId,
          matched?.[sourceId] ?? null,
        ]),
      ]);
    });
  }
  return output;
}
