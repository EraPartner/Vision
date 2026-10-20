#!/usr/bin/env bun
/**
 * TypeScript code-navigation MCP server for coding agents (stdio, JSON-RPC 2.0).
 *
 * Wraps the repository's own tsserver (node_modules/typescript) so Claude Code
 * gets symbol search, go-to-definition, find-references, hover types and
 * diagnostics in every session, local or cloud, with nothing to install.
 * Registered in .mcp.json (ADR-228).
 *
 * The repository has no root tsconfig, and tsserver only searches projects it
 * has loaded, so startup opens one anchor file per workspace project. Without
 * that, references to a shared-utils symbol would miss its backend and
 * frontend callers. Files are reloaded from disk before every request, so
 * results follow edits made outside this server.
 *
 * Usage: bun apps/node-backend/scripts/typescript-mcp.ts
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TSSERVER = path.join(ROOT, "node_modules/typescript/lib/tsserver.js");
const ANCHORS = [
  "apps/frontend/src/main.tsx",
  "apps/node-backend/src/main.ts",
  "packages/shared-utils/src/index.ts",
  "packages/types/src/index.ts",
];
// tsserver under Node uses about half the memory it uses under Bun.
const RUNTIME =
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => path.join(dir, "node"))
    .find((candidate) => existsSync(candidate)) ?? process.execPath;
const MAX_RESULTS = 200;
const REQUEST_TIMEOUT_MS = 120_000;

interface Request {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface Position {
  line: number;
  offset: number;
}

interface FileSpan {
  file: string;
  start: Position;
  end: Position;
}

interface ServerResponse {
  request_seq: number;
  success: boolean;
  message?: string;
  body?: unknown;
}

interface Diagnostic {
  start: Position;
  text: string;
  code?: number;
  category: string;
}

const LOCATION = {
  file: {
    type: "string",
    description:
      "Repository-relative path, e.g. packages/shared-utils/src/money.ts.",
  },
  line: { type: "integer", description: "1-based line number." },
  symbol: {
    type: "string",
    description: "The identifier as written on that line; locates the column.",
  },
};

const TOOLS = [
  {
    name: "find_symbol",
    description:
      "Find where a symbol (function, type, constant, class, component) is declared across " +
      "the frontend, backend and shared packages. Matches whole names first, then prefixes " +
      "and camel-case fragments. Returns file:line and the declaration kind.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name or fragment." },
      },
      required: ["name"],
    },
  },
  {
    name: "definition",
    description:
      "Go to the definition of the symbol at file:line, following imports and re-exports " +
      "across workspace packages.",
    inputSchema: {
      type: "object",
      properties: LOCATION,
      required: ["file", "line", "symbol"],
    },
  },
  {
    name: "references",
    description:
      "Find every reference to the symbol at file:line across the frontend, backend source " +
      "and shared packages (backend tests are not indexed). Returns file:line and the line text.",
    inputSchema: {
      type: "object",
      properties: LOCATION,
      required: ["file", "line", "symbol"],
    },
  },
  {
    name: "hover",
    description:
      "Show the inferred type and documentation of the symbol at file:line.",
    inputSchema: {
      type: "object",
      properties: LOCATION,
      required: ["file", "line", "symbol"],
    },
  },
  {
    name: "diagnostics",
    description:
      "Type-check one file as it is on disk with its own tsconfig and return its syntax and " +
      "type errors. `bun run typecheck` stays authoritative for the whole repository.",
    inputSchema: {
      type: "object",
      properties: { file: LOCATION.file },
      required: ["file"],
    },
  },
];

const server = spawn(
  RUNTIME,
  [
    TSSERVER,
    "--disableAutomaticTypingAcquisition",
    "--suppressDiagnosticEvents",
  ],
  { cwd: ROOT, stdio: ["pipe", "pipe", "ignore"] },
);
const pending = new Map<number, (response: ServerResponse) => void>();
let seq = 0;
let buffer = Buffer.alloc(0);

// tsserver frames each message as `Content-Length: N\r\n\r\n<json>`.
server.stdout.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const header = buffer.indexOf("\r\n\r\n");
    if (header < 0) return;
    const length = Number(
      /Content-Length: (\d+)/.exec(buffer.subarray(0, header).toString())?.[1],
    );
    if (buffer.length < header + 4 + length) return;
    const message = JSON.parse(
      buffer.subarray(header + 4, header + 4 + length).toString(),
    ) as { type: string } & ServerResponse;
    buffer = buffer.subarray(header + 4 + length);
    if (message.type === "response") {
      pending.get(message.request_seq)?.(message);
      pending.delete(message.request_seq);
    }
  }
});

function notify(command: string, args: Record<string, unknown>): void {
  seq += 1;
  server.stdin.write(
    `${JSON.stringify({ seq, type: "request", command, arguments: args })}\n`,
  );
}

function request<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  notify(command, args);
  const id = seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`tsserver '${command}' timed out`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, (response) => {
      clearTimeout(timer);
      if (response.success) resolve(response.body as T);
      else
        reject(new Error(response.message ?? `tsserver '${command}' failed`));
    });
  });
}

const opened = new Set<string>();

function absolute(file: string): string {
  const resolved = path.resolve(ROOT, file);
  if (!resolved.startsWith(`${ROOT}${path.sep}`) || !existsSync(resolved)) {
    throw new Error(`No such file in the repository: ${file}`);
  }
  return resolved;
}

function relative(file: string): string {
  return path.relative(ROOT, file);
}

// Opening a file loads its project; reopened files are re-read from disk.
function sync(file: string): void {
  if (opened.has(file)) {
    notify("reload", { file, tmpfile: file });
  } else {
    notify("open", { file });
    opened.add(file);
  }
}

const ready = (async () => {
  for (const anchor of ANCHORS) {
    const file = path.join(ROOT, anchor);
    if (existsSync(file)) {
      sync(file);
      await request("projectInfo", { file, needFileNameList: false });
    }
  }
})();

async function prepare(file: string): Promise<string> {
  await ready;
  const resolved = absolute(file);
  for (const anchor of opened) {
    if (anchor !== resolved) sync(anchor);
  }
  sync(resolved);
  return resolved;
}

function locate(file: string, line: number, symbol: string): Position {
  const text = readFileSync(file, "utf8").split("\n")[line - 1];
  if (text === undefined)
    throw new Error(`Line ${line} is past the end of the file.`);
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).exec(text);
  if (match === null)
    throw new Error(`'${symbol}' does not appear on line ${line}.`);
  return { line, offset: match.index + 1 };
}

function lines(entries: string[]): string {
  if (entries.length === 0) return "No results.";
  const shown = entries.slice(0, MAX_RESULTS);
  const more = entries.length - shown.length;
  return shown.join("\n") + (more > 0 ? `\n… ${more} more` : "");
}

function spanLine(span: FileSpan): string {
  return `${relative(span.file)}:${span.start.line}:${span.start.offset}`;
}

async function findSymbol(name: string): Promise<string> {
  await ready;
  const seen = new Set<string>();
  const entries: string[] = [];
  const items = await request<
    Array<
      FileSpan & {
        name: string;
        kind: string;
        matchKind: string;
        containerName?: string;
      }
    >
  >("navto", { searchValue: name, maxResultCount: MAX_RESULTS });
  for (const item of items) {
    const where = spanLine(item);
    if (item.file.includes("/node_modules/") || seen.has(where)) continue;
    seen.add(where);
    const container = item.containerName ? ` in ${item.containerName}` : "";
    entries.push(
      `${where} ${item.kind} ${item.name}${container} (${item.matchKind})`,
    );
  }
  return lines(entries);
}

async function atSymbol(
  tool: "definition" | "references" | "hover",
  args: { file: string; line: number; symbol: string },
): Promise<string> {
  const file = await prepare(args.file);
  const position = { file, ...locate(file, args.line, args.symbol) };
  if (tool === "definition") {
    const spans = await request<FileSpan[]>("definition", position);
    return lines(spans.map(spanLine));
  }
  if (tool === "hover") {
    const info = await request<{
      displayString: string;
      documentation: string;
    }>("quickinfo", position);
    return [info.displayString, info.documentation]
      .filter(Boolean)
      .join("\n\n");
  }
  const body = await request<{
    refs: Array<FileSpan & { lineText: string; isDefinition?: boolean }>;
  }>("references", position);
  const refs = body.refs.filter((ref) => !ref.file.includes("/node_modules/"));
  const files = new Set(refs.map((ref) => ref.file)).size;
  return (
    `${refs.length} references in ${files} files\n` +
    lines(
      refs.map(
        (ref) =>
          `${spanLine(ref)}${ref.isDefinition ? " (definition)" : ""}  ${ref.lineText.trim()}`,
      ),
    )
  );
}

async function diagnostics(file: string): Promise<string> {
  const resolved = await prepare(file);
  const [syntactic, semantic] = await Promise.all([
    request<Diagnostic[]>("syntacticDiagnosticsSync", { file: resolved }),
    request<Diagnostic[]>("semanticDiagnosticsSync", { file: resolved }),
  ]);
  const found = [...syntactic, ...semantic].map(
    (d) =>
      `${relative(resolved)}:${d.start.line}:${d.start.offset} ${d.category} TS${d.code ?? "?"}: ${d.text}`,
  );
  return found.length === 0 ? "No problems." : found.join("\n");
}

async function callTool(
  name: unknown,
  args: Record<string, unknown>,
): Promise<string> {
  const text = (key: string): string => {
    const value = args[key];
    if (typeof value !== "string" || value === "")
      throw new Error(`'${key}' must be a string.`);
    return value;
  };
  const line = (): number => {
    const value = Number(args.line);
    if (!Number.isInteger(value) || value < 1)
      throw new Error("'line' must be a positive integer.");
    return value;
  };
  switch (name) {
    case "find_symbol":
      return findSymbol(text("name"));
    case "definition":
    case "references":
    case "hover":
      return atSymbol(name, {
        file: text("file"),
        line: line(),
        symbol: text("symbol"),
      });
    case "diagnostics":
      return diagnostics(text("file"));
    default:
      throw new Error(`Unknown tool: ${String(name)}`);
  }
}

async function handle(request: Request): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "vision-typescript", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      try {
        const args = (request.params?.arguments ?? {}) as Record<
          string,
          unknown
        >;
        return {
          content: [
            { type: "text", text: await callTool(request.params?.name, args) },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
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

// tsserver answers one request at a time, so tool calls run in order.
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
  server.kill();
  process.exit(0);
});
server.on("exit", () => process.exit(1));
