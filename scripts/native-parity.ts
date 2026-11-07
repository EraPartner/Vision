#!/usr/bin/env bun
/**
 * Records the parity corpus of the Swift backend (ADR-270 decision 5): for each
 * area, a fixed sequence of requests sent to the TypeScript backend's real
 * routers on a freshly migrated database with a small seed, and the status and
 * JSON body each one answered.
 *
 *   bun run native:parity            # rewrite apps/native/parity/*.json
 *   bun run native:parity -- tags    # one area
 *
 * The Swift tests (VisionBackendTests/ParityTests.swift) build the same
 * database from db/migrations and the seed, replay the steps in order through
 * RoutingAPITransport and compare the JSON semantically. `meta.requestId` is
 * left out, and timestamps the run created (any not written in the seed) are
 * compared by form only.
 *
 * Requests stay within what the generated client can send: a JSON object body
 * (or none), never a JSON scalar, whose body-parser message is the JavaScript
 * engine's own.
 *
 * The routers run behind the middleware main.ts mounts on the data plane
 * (request id, JSON body parser, CSRF guard, envelope, 404 and the error
 * handler in production mode); rate limiters and security headers are left
 * out, as tests/helpers/routeApp.ts explains.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./lib/isEntrypoint.ts";
import { REPO_ROOT, repoPath } from "./lib/nativeCodegen.ts";

export const PARITY_DIR = repoPath("apps/native/parity");

interface ParityStep {
  /** The generated client's operationId the request belongs to. */
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path and query, as the client sends them. */
  path: string;
  /** JSON body; absent for none. */
  body?: unknown;
}

interface ParityArea {
  /** The router module (relative to apps/node-backend/src/routes) and its mount path. */
  router: { module: string; mountPath: string };
  /** SQL run after the migrations, before the first step. */
  seed: string[];
  steps: ParityStep[];
}

const SEED_TIME = "2025-03-01T09:00:00.000000Z";

export const AREAS: Record<string, ParityArea> = {
  tags: {
    router: { module: "tags.ts", mountPath: "/api/tags" },
    seed: [
      `INSERT INTO tags (slug, color, is_active, created_at, updated_at) VALUES
        ('holiday', '#00aaff', 1, '${SEED_TIME}', '${SEED_TIME}'),
        ('rome-2020', NULL, 1, '${SEED_TIME}', '${SEED_TIME}'),
        ('archived', '#999999', 0, '${SEED_TIME}', '${SEED_TIME}'),
        ('business', NULL, 1, '${SEED_TIME}', '${SEED_TIME}')`,
    ],
    steps: [
      { operationId: "getTags", method: "GET", path: "/api/tags" },
      { operationId: "getTags", method: "GET", path: "/api/tags?active=all" },
      { operationId: "getTags", method: "GET", path: "/api/tags?active=false" },
      { operationId: "getTags", method: "GET", path: "/api/tags?active=0" },
      { operationId: "getTags", method: "GET", path: "/api/tags?active=bogus" },
      { operationId: "getTags", method: "GET", path: "/api/tags?active=all&limit=2&offset=1" },
      { operationId: "getTags", method: "GET", path: "/api/tags?limit=2" },
      { operationId: "getTags", method: "GET", path: "/api/tags?offset=1" },
      { operationId: "getTags", method: "GET", path: "/api/tags?limit=abc&offset=-3" },
      { operationId: "getTags", method: "GET", path: "/api/tags?limit=5000" },
      { operationId: "getTags", method: "GET", path: "/api/tags?limit=" },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: { slug: "  Groceries   Weekly!! ", color: "#ff0000" } },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: { slug: "groceries-weekly", color: "#00ff00" } },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: { slug: "Archived" } },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: { slug: "rome 2020", color: "#123456" } },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: { slug: "Café İstanbul", color: null } },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: {} },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: { slug: "" } },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: { slug: "!!!" } },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: { slug: 5 } },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: { slug: "x", color: 5 } },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: { slug: true, color: [] } },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: [] },
      { operationId: "createTag", method: "POST", path: "/api/tags" },
      { operationId: "createTag", method: "POST", path: "/api/tags", body: { slug: "extra", unknown: 1 } },
      { operationId: "getTags", method: "GET", path: "/api/tags?active=all" },
    ],
  },
};

interface RecordedStep extends ParityStep {
  status: number;
  response: unknown;
}

/** Drops `meta.requestId`, and `meta` itself when nothing else is in it. */
function withoutRequestId(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const { meta, ...rest } = body as { meta?: Record<string, unknown> };
  if (meta === undefined) return rest;
  const { requestId: _requestId, ...otherMeta } = meta;
  return Object.keys(otherMeta).length > 0 ? { ...rest, meta: otherMeta } : rest;
}

/** The parts of the backend's route-test helpers the recorder uses. */
interface AgentRequest extends PromiseLike<{ status: number; body: unknown }> {
  set(name: string, value: string): AgentRequest;
  send(body: string): AgentRequest;
}
type Agent = Record<"get" | "post" | "put" | "patch" | "delete", (url: string) => AgentRequest>;
interface RouteAppModule {
  createRouteApp: (router: unknown, options: { mountPath: string; isProduction: () => boolean }) => unknown;
}
interface HttpAgentModule {
  httpAgent: (app: unknown) => Agent;
}

async function recordArea(name: string, area: ParityArea): Promise<RecordedStep[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vision-parity-${name}-`));
  const file = path.join(dir, "vision.sqlite3");
  // Before any backend module loads its settings.
  process.env.VISION_DATABASE_PATH = file;
  process.env.NODE_ENV = "test";
  const { runMigrations } = await import("../apps/node-backend/src/database/migrate.ts");
  await runMigrations(file, { skipBackup: true });
  const { openDatabase } = await import("../apps/node-backend/src/database/connection.ts");
  const seedDb = openDatabase(file, "writer");
  for (const statement of area.seed) seedDb.exec(statement);
  seedDb.close();

  // The test helpers and routers load by path: routeApp.ts also holds vitest helpers,
  // which this script's program does not type.
  const backendModule = (...parts: string[]) => repoPath("apps/node-backend", ...parts);
  const { createRouteApp } = (await import(backendModule("tests/helpers/routeApp.ts"))) as RouteAppModule;
  const { httpAgent } = (await import(backendModule("tests/helpers/httpAgent.ts"))) as HttpAgentModule;
  const { default: router } = (await import(backendModule("src/routes", area.router.module))) as {
    default: unknown;
  };
  // The packaged backend runs in production, which masks 5xx messages.
  const agent = httpAgent(
    createRouteApp(router, { mountPath: area.router.mountPath, isProduction: () => true }),
  );
  const recorded: RecordedStep[] = [];
  for (const step of area.steps) {
    const method = step.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
    const request = agent[method](step.path);
    if ("body" in step) request.set("Content-Type", "application/json").send(JSON.stringify(step.body));
    const res = await request;
    recorded.push({ ...step, status: res.status, response: withoutRequestId(res.body) });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return recorded;
}

/** The corpus file of one area: the seed and the recorded steps. */
function corpusText(area: ParityArea, steps: RecordedStep[]): string {
  return `${JSON.stringify({ generatedBy: "bun run native:parity", seed: area.seed, steps }, null, 2)}\n`;
}

/**
 * Each area records in its own process: the backend reads its database path
 * once, when its settings module first loads.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--record") {
    const name = args[1] ?? "";
    const area = AREAS[name];
    if (area === undefined) throw new Error(`unknown parity area: ${name}`);
    const steps = await recordArea(name, area);
    fs.mkdirSync(PARITY_DIR, { recursive: true });
    fs.writeFileSync(path.join(PARITY_DIR, `${name}.json`), corpusText(area, steps));
    console.log(`${name}: ${steps.length} steps`);
    // The routers' modules keep timers and connections open.
    process.exit(0);
  }
  for (const name of Object.keys(AREAS)) {
    if (args.length > 0 && !args.includes(name)) continue;
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--record", name], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (child.status !== 0) throw new Error(`recording ${name} failed`);
  }
}

if (isEntrypoint(import.meta)) await main();
