#!/usr/bin/env bun
/**
 * Read-only PostgreSQL MCP server for coding agents (stdio, JSON-RPC 2.0).
 *
 * Gives Claude Code live schema, function and trigger introspection against a
 * LOCAL, migrated development or scratch database. Registered in .mcp.json.
 *
 * Safety, in layers:
 * - It connects only when VISION_MCP_DATABASE_URL is set, and only to a
 *   loopback host. It never reads DATABASE_URL, so it cannot pick up the app's
 *   database by accident.
 * - Every statement runs alone through the extended query protocol (which
 *   rejects multi-statement text) inside BEGIN READ ONLY, followed by ROLLBACK.
 *   The session also defaults to read-only transactions and a statement timeout.
 * - Use a read-only role in the URL for a hard guarantee.
 *
 * Usage: VISION_MCP_DATABASE_URL=postgresql://user@127.0.0.1:5432/db bun apps/node-backend/scripts/postgres-mcp.ts
 */
import { createInterface } from "node:readline";
import pg from "pg";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_ROWS = 200;
const STATEMENT_TIMEOUT_MS = 10_000;

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
      "Run one read-only SQL statement against the local Vision database and return up to " +
      `${MAX_ROWS} rows as JSON. Use information_schema and pg_catalog (pg_proc, pg_trigger, ` +
      "pg_views, pg_indexes) for schema, function and trigger introspection. Writes are refused.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SQL statement." },
      },
      required: ["sql"],
    },
  },
];

function clientConfig(raw: string | undefined): pg.ClientConfig {
  if (raw === undefined || raw === "") {
    throw new Error(
      "VISION_MCP_DATABASE_URL is not set; point it at a local migrated database.",
    );
  }
  const url = new URL(raw);
  if (!LOOPBACK.has(url.hostname)) {
    throw new Error(
      `Refusing non-loopback host '${url.hostname}'; only local databases are allowed.`,
    );
  }
  // Built from the URL parts only, so query parameters such as ?host= cannot
  // redirect the connection.
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    application_name: "vision-postgres-mcp",
    options: `-c default_transaction_read_only=on -c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
  };
}

let client: pg.Client | undefined;

async function connection(): Promise<pg.Client> {
  if (client === undefined) {
    const next = new pg.Client(
      clientConfig(process.env.VISION_MCP_DATABASE_URL),
    );
    await next.connect();
    client = next;
  }
  return client;
}

async function readOnlyQuery(sql: string): Promise<string> {
  const db = await connection();
  await db.query("BEGIN READ ONLY");
  try {
    // queryMode is supported by pg but missing from @types/pg.
    const statement: pg.QueryConfig & { queryMode: "extended" } = {
      text: sql,
      queryMode: "extended",
    };
    const result = await db.query(statement);
    const rows = result.rows.slice(0, MAX_ROWS);
    return JSON.stringify(
      {
        rowCount: result.rowCount,
        truncated: result.rows.length > MAX_ROWS,
        rows,
      },
      undefined,
      2,
    );
  } finally {
    await db.query("ROLLBACK");
  }
}

async function handle(request: Request): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "vision-postgres", version: "1.0.0" },
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
        return { content: [{ type: "text", text: await readOnlyQuery(sql) }] };
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

// One connection serves one statement at a time, so requests run in order.
let queue: Promise<void> = Promise.resolve();

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  queue = queue.then(async () => {
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
      send({ jsonrpc: "2.0", id: request.id, result: await handle(request) });
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
  void queue.then(() => client?.end()).then(() => process.exit(0));
});
