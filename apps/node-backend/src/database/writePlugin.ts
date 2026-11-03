/**
 * Kysely plugin that does for builder writes what PostgreSQL did on
 * assignment (ADR-263):
 *
 * - a value written to a DECIMAL_TEXT(p,s) column is rounded to the column's
 *   scale (half away from zero) and refused above its precision with
 *   SQLSTATE 22003, as a `numeric(p,s)` assignment cast did;
 * - a value written to a JSONB_TEXT column is stored as canonical jsonb text;
 * - a value written to a BOOLEAN, DATE_TEXT or TIMESTAMPTZ_TEXT column is
 *   read the way PostgreSQL's input function read the text node-postgres
 *   sent: `'yes'` is true, `'2026-01-05T23:30:00Z'` is the date 2026-01-05,
 *   a Date is its local date, and timestamp text becomes canonical UTC text;
 * - an UPDATE (or an upsert's DO UPDATE) of a table with `updated_at` sets it
 *   to `now()` unless the statement sets it, as the
 *   `update_updated_at_column` triggers did. SQLite's trigger runs after the
 *   row is written, so without this RETURNING would show the old value.
 *
 * Hand-written SQL does the same with `vision_numeric(?, p, s)`,
 * `vision_jsonb(?)` and `updated_at = now()`; CHECK constraints refuse any
 * write that skipped it.
 */
import {
  ColumnNode,
  ColumnUpdateNode,
  InsertQueryNode,
  OnConflictNode,
  PrimitiveValueListNode,
  TableNode,
  UpdateQueryNode,
  ValueListNode,
  ValueNode,
  ValuesNode,
  sql,
} from "kysely";
import type {
  KyselyPlugin,
  OperationNode,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from "kysely";
import * as N from "./sqlite/numeric.ts";
import { TABLE_WRITE_INFO } from "./schemaMap.generated.ts";
import type { TableWriteInfo } from "./schemaMap.generated.ts";
import { canonicalJsonbValue } from "./sqlite/jsonbValue.ts";
import { canonicalTimestamp, dateInputText, formatInstant, instantFromDate } from "./sqlite/pgTime.ts";
import { booleanInput } from "./sqlite/values.ts";

/** Canonical decimal text for a value bound to NUMERIC(p, s). */
export function canonicalDecimal(value: unknown, precision: number | null, scale: number | null): unknown {
  if (value === null || value === undefined) return value;
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "bigint") text = String(value);
  else if (typeof value === "object" && typeof (value as { toFixed?: unknown }).toFixed === "function") {
    // A Decimal.js value prints its exact digits.
    text = (value as { toString(): string }).toString();
  } else {
    return value;
  }
  const parsed = N.parseDecimalText(text);
  return N.formatDec(precision === null ? parsed : N.coerceTypmod(parsed, precision, scale ?? 0));
}

function tableName(node: OperationNode | undefined): string | undefined {
  if (!node) return undefined;
  if (TableNode.is(node)) return node.table.identifier.name;
  const aliased = node as { kind?: string; node?: OperationNode };
  if (aliased.kind === "AliasNode" && aliased.node) return tableName(aliased.node);
  return undefined;
}

function columnName(node: OperationNode): string | undefined {
  return ColumnNode.is(node) ? node.column.name : undefined;
}

/** A value assigned to a DATE column, as PostgreSQL's date input read it. */
function dateValue(value: unknown): unknown {
  if (typeof value === "string") return dateInputText(value);
  if (value instanceof Date) return dateInputText(formatInstant(instantFromDate(value)));
  return value;
}

function convertValue(info: TableWriteInfo, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const decimal = info.decimals?.[column];
  if (decimal) return canonicalDecimal(value, decimal[0], decimal[1]);
  if (info.jsonb?.includes(column)) return canonicalJsonbValue(value);
  if (info.booleans?.includes(column)) return booleanInput(value);
  if (info.dates?.includes(column)) return dateValue(value);
  if (info.timestamps?.includes(column) && typeof value === "string") return canonicalTimestamp(value);
  return value;
}

function convertNode(info: TableWriteInfo, column: string, node: OperationNode): OperationNode {
  if (!ValueNode.is(node)) return node;
  const converted = convertValue(info, column, node.value);
  if (converted === node.value) return node;
  return node.immediate ? ValueNode.createImmediate(converted) : ValueNode.create(converted);
}

function convertUpdates(
  info: TableWriteInfo,
  updates: readonly ColumnUpdateNode[],
): ColumnUpdateNode[] {
  const out = updates.map((u) => {
    const column = columnName(u.column);
    return column ? ColumnUpdateNode.create(u.column, convertNode(info, column, u.value)) : u;
  });
  if (info.updatedAt && !updates.some((u) => columnName(u.column) === "updated_at")) {
    out.push(ColumnUpdateNode.create(ColumnNode.create("updated_at"), sql`now()`.toOperationNode()));
  }
  return out;
}

function transformInsert(node: InsertQueryNode): InsertQueryNode {
  const info = TABLE_WRITE_INFO[tableName(node.into) ?? ""];
  if (!info) return node;
  const columns = (node.columns ?? []).map((c) => c.column.name);
  let values = node.values;
  if (values && ValuesNode.is(values) && (info.decimals || info.jsonb || info.booleans || info.dates || info.timestamps)) {
    values = ValuesNode.create(
      values.values.map((item) => {
        if (PrimitiveValueListNode.is(item)) {
          return PrimitiveValueListNode.create(
            item.values.map((v, i) => convertValue(info, columns[i] ?? "", v)),
          );
        }
        if (ValueListNode.is(item)) {
          return ValueListNode.create(item.values.map((v, i) => convertNode(info, columns[i] ?? "", v)));
        }
        return item;
      }),
    );
  }
  let onConflict = node.onConflict;
  if (onConflict?.updates) {
    onConflict = OnConflictNode.cloneWith(onConflict, { updates: convertUpdates(info, onConflict.updates) });
  }
  if (values === node.values && onConflict === node.onConflict) return node;
  return { ...node, ...(values ? { values } : {}), ...(onConflict ? { onConflict } : {}) };
}

function transformUpdate(node: UpdateQueryNode): UpdateQueryNode {
  const info = TABLE_WRITE_INFO[tableName(node.table) ?? ""];
  if (!info || !node.updates) return node;
  return { ...node, updates: convertUpdates(info, node.updates) };
}

export class VisionWritePlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    const { node } = args;
    if (InsertQueryNode.is(node)) return transformInsert(node);
    if (UpdateQueryNode.is(node)) return transformUpdate(node);
    return node;
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}
