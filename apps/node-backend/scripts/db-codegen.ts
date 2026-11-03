#!/usr/bin/env bun
/**
 * Generate the Kysely database types and the write plugin's column map from
 * the SQLite schema the migrations build (ADR-226, ADR-263; replaces
 * kysely-codegen).
 *
 * Usage: bun run apps/node-backend/scripts/db-codegen.ts [--verify]
 *   (no flag)  rewrite src/database/schema.generated.ts and schemaMap.generated.ts
 *   --verify   exit 1 when either file differs from what the migrations produce
 *
 * Types come from the declared column types (docs/reference/sqlite-sql-dialect.md);
 * db-codegen.config.json adds branded ids, money columns, enum types and array
 * element types.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "../src/database/connection.ts";
import { migrateConnection } from "../src/database/migrate.ts";

const BACKEND_ROOT = path.resolve(import.meta.dirname, "..");

interface CodegenConfig {
  outFile: string;
  mapFile: string;
  customImports: Record<string, string>;
  enums: Record<string, string[]>;
  enumColumns: Record<string, string>;
  arrayColumns: Record<string, string>;
  overrides: Record<string, string>;
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

const EXCLUDED = new Set(["vision_migrations", "vision_sequences"]);

function pascal(name: string): string {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function baseType(declared: string, key: string, config: CodegenConfig): string {
  const enumName = config.enumColumns[key];
  if (enumName) return enumName;
  const t = declared.trim().toUpperCase();
  if (t === "INTEGER" || t === "INT") return "number";
  if (t === "BIGINT") return "Int8";
  if (t.startsWith("DECIMAL_TEXT")) return "Numeric";
  if (t === "REAL") return "number";
  if (t === "BOOLEAN") return "boolean";
  if (t === "TIMESTAMPTZ_TEXT" || t === "DATE_TEXT") return "Timestamp";
  if (t === "JSONB_TEXT" || t === "JSON_TEXT") return "Json";
  if (t === "TEXT_ARRAY") return config.arrayColumns[key] ?? "string[]";
  if (t === "TEXT" || t === "UUID_TEXT") return "string";
  if (t === "") return "unknown";
  throw new Error(`No TypeScript type for declared type "${declared}" (${key})`);
}

function isAutoincrementPk(tableSql: string, column: ColumnInfo): boolean {
  return column.pk > 0 && column.type.toUpperCase() === "INTEGER" && /AUTOINCREMENT/i.test(tableSql);
}

export interface GeneratedFiles {
  schema: string;
  map: string;
  config: CodegenConfig;
}

export function generateSchemaFiles(): GeneratedFiles {
  const config = JSON.parse(readFileSync(path.join(BACKEND_ROOT, "db-codegen.config.json"), "utf8")) as CodegenConfig;
  const db = openDatabase(":memory:", "writer");
  try {
    migrateConnection(db, ":memory:", { skipBackup: true });
    const relations = db
      .prepare(
        `SELECT name, type, sql FROM sqlite_schema
          WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as Array<{ name: string; type: string; sql: string }>;

    const interfaces: string[] = [];
    const dbEntries: string[] = [];
    const mapEntries: string[] = [];
    const usedOverrides = new Set<string>();
    for (const relation of relations) {
      if (EXCLUDED.has(relation.name)) continue;
      const columns = db
        .prepare(`SELECT * FROM pragma_table_xinfo(?) ORDER BY name`)
        .all(relation.name) as unknown as ColumnInfo[];
      const iface = pascal(relation.name);
      const lines: string[] = [];
      const decimals: string[] = [];
      const jsonb: string[] = [];
      let updatedAt = false;
      for (const column of columns) {
        // hidden: 1 = a virtual table's hidden column, 2/3 = a generated column.
        if (column.hidden === 1) continue;
        const computed = column.hidden === 2 || column.hidden === 3;
        const key = `${relation.name}.${column.name}`;
        const override = config.overrides[key];
        let type: string;
        if (override) {
          usedOverrides.add(key);
          type = override;
        } else {
          type = baseType(column.type, key, config);
          const isView = relation.type === "view";
          const nullable = isView || (column.notnull === 0 && column.pk === 0);
          if (nullable) type = `${type} | null`;
          const generated =
            !isView && (column.dflt_value !== null || isAutoincrementPk(relation.sql, column));
          if (computed) type = `ColumnType<${type}, never, never>`;
          else if (generated) type = `Generated<${type}>`;
        }
        lines.push(`  ${column.name}: ${type};`);
        if (relation.type === "table" && !computed) {
          const decimal = /^DECIMAL_TEXT(?:\((\d+),(\d+)\))?$/i.exec(column.type.replace(/\s+/g, ""));
          if (decimal) {
            decimals.push(`    ${column.name}: [${decimal[1] ?? "null"}, ${decimal[2] ?? "null"}],`);
          }
          if (column.type.toUpperCase() === "JSONB_TEXT") jsonb.push(JSON.stringify(column.name));
          if (column.name === "updated_at") updatedAt = true;
        }
      }
      interfaces.push(`export interface ${iface} {\n${lines.join("\n")}\n}`);
      dbEntries.push(`  ${relation.name}: ${iface};`);
      if (decimals.length > 0 || jsonb.length > 0 || updatedAt) {
        const parts: string[] = [];
        if (decimals.length > 0) parts.push(`  decimals: {\n${decimals.join("\n")}\n  },`);
        if (jsonb.length > 0) parts.push(`  jsonb: [${jsonb.join(", ")}],`);
        if (updatedAt) parts.push("  updatedAt: true,");
        mapEntries.push(`  ${relation.name}: {\n${parts.map((p) => `  ${p.replaceAll("\n", "\n  ")}`).join("\n")}\n  },`);
      }
    }
    const unused = Object.keys(config.overrides).filter((k) => !usedOverrides.has(k));
    if (unused.length > 0) throw new Error(`Overrides name columns that do not exist: ${unused.join(", ")}`);

    const importsBySource = new Map<string, string[]>();
    for (const [name, source] of Object.entries(config.customImports)) {
      importsBySource.set(source, [...(importsBySource.get(source) ?? []), name]);
    }
    const importLines = [...importsBySource.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([source, names]) => `import type { ${names.sort().join(", ")} } from "${source}";`);

    const enumLines = Object.entries(config.enums)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, labels]) => `export type ${name} = ${[...labels].sort().map((l) => JSON.stringify(l)).join(" | ")};`);

    const schema = [
      "/**",
      " * Generated by scripts/db-codegen.ts from the SQLite schema the migrations build.",
      " * Do not edit; run `bun run db:codegen`.",
      " */",
      "",
      ...importLines,
      'import type { ColumnType } from "kysely";',
      "",
      ...enumLines.flatMap((l) => [l, ""]),
      "export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>",
      "  ? ColumnType<S, I | undefined, U>",
      "  : ColumnType<T, T | undefined, T>;",
      "",
      "export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;",
      "",
      "export type Json = JsonValue;",
      "",
      "export type JsonArray = JsonValue[];",
      "",
      "export type JsonObject = {",
      "  [x: string]: JsonValue | undefined;",
      "};",
      "",
      "export type JsonPrimitive = boolean | number | string | null;",
      "",
      "export type JsonValue = JsonArray | JsonObject | JsonPrimitive;",
      "",
      "export type Numeric = ColumnType<string, number | string, number | string>;",
      "",
      "export type Timestamp = ColumnType<Date, Date | string, Date | string>;",
      "",
      ...interfaces.flatMap((i) => [i, ""]),
      "export interface DB {",
      ...dbEntries,
      "}",
      "",
    ].join("\n");

    const map = [
      "/**",
      " * Generated by scripts/db-codegen.ts: per table, the DECIMAL_TEXT columns",
      " * with their (precision, scale), the JSONB_TEXT columns and whether the",
      " * table has `updated_at`. Read by src/database/writePlugin.ts.",
      " * Do not edit; run `bun run db:codegen`.",
      " */",
      "",
      "export interface TableWriteInfo {",
      "  decimals?: Readonly<Record<string, readonly [number | null, number | null]>>;",
      "  jsonb?: readonly string[];",
      "  updatedAt?: true;",
      "}",
      "",
      "export const TABLE_WRITE_INFO: Readonly<Record<string, TableWriteInfo>> = {",
      ...mapEntries,
      "};",
      "",
    ].join("\n");
    return { schema, map, config };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const verify = process.argv.includes("--verify");
  const { schema, map, config } = generateSchemaFiles();
  let drift = false;
  for (const [file, text] of [
    [config.outFile, schema],
    [config.mapFile, map],
  ] as const) {
    const full = path.join(BACKEND_ROOT, file);
    if (verify) {
      let current = "";
      try {
        current = readFileSync(full, "utf8");
      } catch {
        // missing counts as drift
      }
      if (current !== text) {
        console.error(`[db-codegen] ${file} is out of date; run bun run db:codegen`);
        drift = true;
      }
    } else {
      writeFileSync(full, text);
      console.log(`[db-codegen] wrote ${file}`);
    }
  }
  process.exit(drift ? 1 : 0);
}
