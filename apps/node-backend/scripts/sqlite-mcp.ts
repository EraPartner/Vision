#!/usr/bin/env bun
/**
 * Read-only SQLite MCP server for coding agents (stdio, JSON-RPC 2.0).
 *
 * Gives Claude Code live schema, trigger and data introspection against a
 * LOCAL, migrated development or scratch database file (ADR-227, ADR-263).
 * Registered in .mcp.json.
 *
 * Safety, in layers:
 * - It opens a database only when VISION_MCP_DATABASE_PATH is set. It never
 *   reads VISION_DATABASE_PATH, so it cannot pick up the app's database by
 *   accident.
 * - The file is opened read-only with `PRAGMA query_only = ON`; every request
 *   is prepared as exactly one statement (trailing statements are refused)
 *   and runs inside a read transaction that is rolled back.
 * - Vision's SQL functions are registered, so views and dec_* calls work.
 *
 * Usage: VISION_MCP_DATABASE_PATH=/path/to/vision.sqlite3 bun apps/node-backend/scripts/sqlite-mcp.ts
 */
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { registerFunctions } from "../src/database/sqlite/functions.ts";
import { scanSql } from "../src/database/sqlite/sqlText.ts";

const MAX_ROWS = 200;

interface Request {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "query",
    description:
      "Run one read-only SQL statement against the local Vision SQLite database and return up to " +
      `${MAX_ROWS} rows as JSON. Use sqlite_schema, pragma_table_xinfo('<table>'), ` +
      "pragma_index_list('<table>') and pragma_foreign_key_list('<table>') for schema introspection. Writes are refused.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SQL statement." },
      },
      required: ["sql"],
    },
  },
];

let db: DatabaseSync | undefined;

function connection(): DatabaseSync {
  if (db === undefined) {
    const file = process.env.VISION_MCP_DATABASE_PATH;
    if (file === undefined || file === "") {
      throw new Error(
        "VISION_MCP_DATABASE_PATH is not set; point it at a local migrated database file.",
      );
    }
    const next = new DatabaseSync(file, { readOnly: true });
    next.exec("PRAGMA query_only = ON");
    registerFunctions(next, { transactionStart: null, statementStart: null });
    db = next;
  }
  return db;
}

function readOnlyQuery(sql: string): string {
  const conn = connection();
  if (scanSql(sql).multipleStatements) throw new Error("Send exactly one statement.");
  conn.exec("BEGIN");
  try {
    const rows = conn.prepare(sql).all();
    return JSON.stringify(
      {
        rowCount: rows.length,
        truncated: rows.length > MAX_ROWS,
        rows: rows.slice(0, MAX_ROWS),
      },
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      2,
    );
  } finally {
    conn.exec("ROLLBACK");
  }
}

function handle(request: Request): unknown {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "vision-sqlite", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = request.params?.name;
      const sql = (request.params?.arguments as { sql?: unknown } | undefined)
        ?.sql;
      if (name !== "query" || typeof sql !== "string") {
        return {
          isError: true,
          content: [
            { type: "text", text: "Call 'query' with a string 'sql'." },
          ],
        };
      }
      try {
        return { content: [{ type: "text", text: readOnlyQuery(sql) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: String(error) }],
        };
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${request.method}`), {
        code: -32601,
      });
  }
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// Requests run in order.
let queue: Promise<void> = Promise.resolve();

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  queue = queue.then(() => {
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    if (request.id === undefined) return; // notification
    try {
      send({ jsonrpc: "2.0", id: request.id, result: handle(request) });
    } catch (error) {
      const code = (error as { code?: number }).code ?? -32603;
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code, message: String(error) },
      });
    }
  });
});

process.stdin.on("end", () => {
  void queue.then(() => db?.close()).then(() => process.exit(0));
});
