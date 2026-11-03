/**
 * Admin routes.
 *
 * Update strategy (packaged desktop app):
 *   - Electron shell updates: handled by the Electron wrapper (verified packaged-app ZIP install)
 *   - Database migrations (db/migrations): run automatically during native backend startup
 *
 * The git-pull based update approach has been removed. The Node backend running
 * in a packaged application has no git repository, so those endpoints were only
 * applicable to source checkouts (which can still use git manually). This
 * endpoint is focused on release metadata.
 */

import { Router } from "express";
import { stat } from "node:fs/promises";
import https from "https";
import { sql } from "kysely";
import { z } from "zod";
// eslint-disable-next-line vision-local/no-repo-direct-from-route -- admin table stats/VACUUM are legitimately DB-level (ADR-067 documented exemption)
import {
  checkConnection,
  getTableCount,
  withExclusiveWriter,
} from "../database/connection.ts";
// eslint-disable-next-line vision-local/no-repo-direct-from-route -- same ADR-067 exemption: checks the stats/VACUUM catalog rows above
import { checkedRow, checkedRows, compileQuery } from "../database/db.ts";
// eslint-disable-next-line vision-local/no-repo-direct-from-route -- same ADR-067 exemption as above
import {
  databaseSizeRowSchema,
  tableRowCountRowSchema,
  tableSizeRowSchema,
} from "../database/rows/admin.ts";
// eslint-disable-next-line vision-local/no-repo-direct-from-route -- same ADR-067 exemption as above
import type { TableStatsRow } from "../database/rows/admin.ts";
import settings from "../config/config.ts";
import { env } from "../config/env.ts";
import { logger } from "../config/logger.ts";
import { sanitizePersistedKinesisHistory } from "../services/priceProviderService.ts";
import {
  AppError,
  NotFoundError,
  ValidationError,
} from "../middleware/errorHandler.ts";
import {
  listProviderHealth,
  probeProvider,
} from "../services/providerHealthService.ts";
import { getMetrics } from "../middleware/requestMetrics.ts";
import { getRouteManifest } from "../services/routeManifest.ts";
import { adminMutateLimiter } from "../middleware/rateLimiter.ts";
import { isAccuracyTableHealthy } from "../services/calculations/forecast/accuracyStore.ts";
import {
  getTableMeta,
  listUserTables,
  readRows,
  applyMutations,
} from "../services/dbEditor.ts";
import { parseInput } from "../lib/zodInput.ts";
import { parseOr } from "../lib/looseJson.ts";

const GITHUB_OWNER = "EraPartner";
const GITHUB_REPO = "Vision";
const GITHUB_RELEASES_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

// Update mode reported to HTTP clients. See buildUpdateCheckPayload for why this
// is a constant rather than something detected per-request.
const UPDATE_MODE_SOURCE = "source";

const GITHUB_FETCH_TIMEOUT_MS = 5000;

/**
 * The few fields this module reads from the GitHub Releases API response, an
 * arbitrary upstream JSON shape read defensively
 * (hasValidReleaseTag/buildUpdateCheckPayload below).
 */
const gitHubReleaseSchema = z.looseObject({
  message: z.unknown().optional(),
  tag_name: z.string().optional().catch(undefined),
  published_at: z.string().optional().catch(undefined),
  body: z.string().optional().catch(undefined),
  html_url: z.string().optional().catch(undefined),
});
type GitHubRelease = z.output<typeof gitHubReleaseSchema>;

/**
 * Fetch the latest GitHub Release metadata.
 * Returns a plain object — callers handle errors.
 */
function fetchLatestRelease(): Promise<GitHubRelease | null> {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": `${GITHUB_REPO}-backend`,
        Accept: "application/vnd.github+json",
      },
      timeout: GITHUB_FETCH_TIMEOUT_MS,
    };
    const MAX_BODY = 512 * 1024;
    const req = https.get(GITHUB_RELEASES_URL, options, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) {
          req.destroy();
          reject(new Error("GitHub response exceeded size limit"));
        }
      });
      res.on("end", () => {
        try {
          resolve(parseOr(gitHubReleaseSchema, JSON.parse(body), null));
        } catch (e) {
          reject(
            new Error(
              `Failed to parse GitHub response: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => {
      req.destroy();
      reject(
        new Error(
          `GitHub API request timed out after ${GITHUB_FETCH_TIMEOUT_MS}ms`,
        ),
      );
    });
    req.on("error", reject);
  });
}

function hasValidReleaseTag(
  release: GitHubRelease | null,
): release is GitHubRelease {
  return !(
    release == null ||
    release.message === "Not Found" ||
    !release.tag_name
  );
}

function detectCurrentAppVersion() {
  return env.APP_VERSION || "unknown";
}

function buildUpdateCheckPayload(
  release: GitHubRelease,
  currentVersion: string,
) {
  const latestVersion = release.tag_name;
  const upToDate =
    latestVersion === currentVersion || latestVersion === `v${currentVersion}`;

  return {
    payload: {
      up_to_date: upToDate,
      current_version: currentVersion,
      latest_version: latestVersion,
      published_at: release.published_at,
      release_notes: release.body || "",
      html_url: release.html_url,
      // Anything reaching this HTTP route is a non-Electron client: inside the
      // desktop shell the frontend short-circuits to the electronUpdater IPC
      // (apps/frontend/src/lib/api/electron.ts → checkForUpdates), which
      // supplies its own native/source mode. HTTP clients are source deployments
      // and update from their host environment rather than an in-app installer.
      update_mode: UPDATE_MODE_SOURCE,
    },
    latestVersion,
    upToDate,
  };
}

function formatAdminStatusPayload(isConnected: boolean, tableCount: number) {
  const links: unknown[] = [];
  return {
    is_initialised: isConnected && tableCount > 0,
    table_count: tableCount,
    accuracy_table_healthy: isAccuracyTableHealthy(),
    timestamp: new Date().toISOString(),
    links,
  };
}

const resetBodySchema = z.object({ force: z.boolean().optional() });

const vacuumBodySchema = z.object({ table: z.string().min(1).nullish() });

const tableParamsSchema = z.object({ table: z.string().min(1) });

const providerParamsSchema = z.object({ provider: z.string().min(1) });

/** Structured browse filters; dbEditor resolves columns and operators. */
const dbFiltersSchema = z
  .string()
  .transform((raw, ctx): unknown => {
    try {
      return JSON.parse(raw);
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        message: err instanceof Error ? err.message : String(err),
      });
      return z.NEVER;
    }
  })
  .pipe(
    z.array(
      z.object({
        column: z.string(),
        op: z.string().optional(),
        value: z.unknown().optional(),
      }),
      { error: "filters must be an array" },
    ),
  );

// The raw `where` param was removed (SQLi timing oracle, see ADR-101
// addendum); it is still read so readRows can reject it with a 400 that
// points at filters[].
const rowsQuerySchema = z.object({
  filters: z.string().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
  orderBy: z.string().optional(),
  dir: z.string().optional(),
  where: z.string().optional(),
});

const rowValuesSchema = z.record(z.string(), z.unknown());

const mutateBodySchema = z.object({
  changes: z.array(
    z.object({
      op: z.enum(["insert", "update", "delete"]),
      values: rowValuesSchema.optional(),
      set: rowValuesSchema.optional(),
      pk: rowValuesSchema.optional(),
      xmin: z.union([z.string(), z.number()]).optional(),
    }),
  ),
  // Anything but a real boolean is rejected: a truthy string must never
  // commit a batch the caller meant to preview.
  dryRun: z.boolean().optional(),
});

const router = Router();

router.get("/", async (req, res) => {
  const isConnected = await checkConnection();
  const tableCount = isConnected ? await getTableCount() : 0;
  res.ok(formatAdminStatusPayload(isConnected, tableCount));
});

router.post("/database/init", async (req, res) => {
  const isConnected = await checkConnection();
  if (!isConnected)
    throw new AppError("Cannot connect to database", { status: 500 });

  res.status(201);
  res.ok({
    message: "Database connection verified successfully",
    details: {
      note: "Tables are managed by database migrations (db/migrations)",
    },
    links: [],
  });
});

router.post("/database/reset", adminMutateLimiter, (req, res) => {
  if (!settings.admin.enableResetDb) {
    throw new NotFoundError("Database reset endpoint disabled");
  }

  const { force } = parseInput(resetBodySchema, req.body ?? {});
  if (force !== true) {
    throw new ValidationError(
      "Database reset requires force=true in the request body",
      {
        details: {
          hint: "Set force=true in the JSON request body to confirm reset (DESTRUCTIVE)",
        },
      },
    );
  }

  res.ok({
    message: "Database reset is not performed through the API",
    details: {
      warning:
        "Restore a backup or rebuild the database with the migration runner instead",
    },
    links: [],
  });
});

router.get("/update/check", async (req, res) => {
  const release = await fetchLatestRelease();
  const currentVersion = detectCurrentAppVersion();

  if (!hasValidReleaseTag(release)) {
    res.ok({
      up_to_date: true,
      current_version: currentVersion,
      error: "No published releases found",
      latest_version: null,
      update_mode: UPDATE_MODE_SOURCE,
    });
    return;
  }

  const { payload, latestVersion, upToDate } = buildUpdateCheckPayload(
    release,
    currentVersion,
  );

  logger.info("Update check via GitHub Releases", {
    currentVersion,
    latestVersion,
    upToDate,
  });
  res.ok(payload);
});

router.post("/update/apply", (req, res) => {
  res.ok({
    success: true,
    note: "Updates are applied automatically by the desktop app. If an update is available, use the notification in the Vision app window to download and install it.",
  });
});

router.post("/update/apply-and-restart", (req, res) => {
  res.ok({
    success: true,
    note: "Updates are managed by the Vision desktop app for the active runtime provider. No manual action is required.",
  });
});

router.post(
  "/investments/kinesis/sanitize-history",
  adminMutateLimiter,
  async (req, res) => {
    const result = await sanitizePersistedKinesisHistory();
    res.ok({
      message: "Kinesis historical spikes sanitization completed",
      ...result,
    });
  },
);

// ── Database Maintenance ───────────────────────────────────────────────────────

/**
 * PostgreSQL's pg_size_pretty(): bytes below 10 kB, then kB, MB, GB, TB and
 * PB, each unit rounded half up once the value reaches 20 * 1024 - 1 of the
 * smaller one. The same text the page showed before ADR-263.
 */
export function prettySize(bytes: number): string {
  const units: Array<{ name: string; limit: number; round: boolean; bits: number }> = [
    { name: "bytes", limit: 10 * 1024, round: false, bits: 0 },
    { name: "kB", limit: 20 * 1024 - 1, round: true, bits: 10 },
    { name: "MB", limit: 20 * 1024 - 1, round: true, bits: 20 },
    { name: "GB", limit: 20 * 1024 - 1, round: true, bits: 30 },
    { name: "TB", limit: 20 * 1024 - 1, round: true, bits: 40 },
    { name: "PB", limit: 20 * 1024 - 1, round: true, bits: 50 },
  ];
  let size = Math.trunc(bytes);
  for (const [i, unit] of units.entries()) {
    const next = units[i + 1];
    if (next === undefined || Math.abs(size) < unit.limit) {
      if (unit.round) size = Math.trunc((size + (size < 0 ? -1 : 1)) / 2);
      return `${size} ${unit.name}`;
    }
    const shift =
      next.bits - unit.bits - (next.round ? 1 : 0) + (unit.round ? 1 : 0);
    size = Math.trunc(size / 2 ** shift);
  }
  return `${size} bytes`;
}

/**
 * When this backend process last ran VACUUM (the whole file) and ANALYZE (per
 * table). SQLite records neither, so /database/stats reports these and NULL
 * before the first run, as pg_stat_user_tables reported NULL for a table
 * never vacuumed.
 */
const maintenanceRuns: { vacuumedAt: string | null; analyzedAt: Map<string, string> } = {
  vacuumedAt: null,
  analyzedAt: new Map(),
};

/** Whether this SQLite build has the dbstat virtual table (null: not probed yet). */
let hasDbstat: boolean | null = null;

/** Bytes of each table's b-tree plus its indexes' b-trees, from dbstat. */
async function readTableSizes(): Promise<Map<string, string> | null> {
  if (hasDbstat === false) return null;
  try {
    const rows = await checkedRows(
      tableSizeRowSchema,
      sql`SELECT s.tbl_name AS table_name, sum(d.pgsize) AS "size_bytes::bigint"
            FROM dbstat AS d
            JOIN sqlite_schema AS s ON s.name = d.name
           WHERE d.aggregate = 1 AND s.type IN ('table', 'index')
           GROUP BY s.tbl_name`,
    );
    hasDbstat = true;
    return new Map(rows.map((r) => [r.table_name, r.size_bytes]));
  } catch (err) {
    // Builds without SQLITE_ENABLE_DBSTAT_VTAB (some system libraries) have
    // no per-table page accounting; the page then shows sizes as unknown.
    if (err instanceof Error && /no such table: dbstat/.test(err.message)) {
      hasDbstat = false;
      return null;
    }
    throw err;
  }
}

/** On-disk size of the database: the file and its write-ahead log. */
async function readDatabaseBytes(): Promise<number> {
  const file = settings.database.path;
  if (file && file !== ":memory:") {
    try {
      const main = await stat(file);
      const wal = await stat(`${file}-wal`).catch(() => null);
      return main.size + (wal?.size ?? 0);
    } catch {
      // Fall through to the page counters.
    }
  }
  const row = await checkedRow(
    databaseSizeRowSchema,
    sql`SELECT c.page_count * s.page_size AS "size_bytes::bigint"
          FROM pragma_page_count AS c, pragma_page_size AS s`,
  );
  return Number(row?.size_bytes ?? 0);
}

router.get("/database/stats", async (_req, res) => {
  const names = [...(await listUserTables({ fresh: true }))].sort();
  const counts = names.length > 0
    ? await checkedRows(
        tableRowCountRowSchema,
        sql.join(
          names.map(
            (name) =>
              sql`SELECT ${name} AS table_name, count(*) AS "live_rows::bigint" FROM ${sql.id(name)}`,
          ),
          sql` UNION ALL `,
        ),
      )
    : [];
  const liveRows = new Map(counts.map((r) => [r.table_name, r.live_rows]));
  const sizes = await readTableSizes();
  const tables: TableStatsRow[] = names.map((name) => {
    const sizeBytes = sizes?.get(name) ?? (sizes ? "0" : null);
    return {
      table_name: name,
      live_rows: liveRows.get(name) ?? "0",
      last_vacuum: maintenanceRuns.vacuumedAt,
      last_analyze: maintenanceRuns.analyzedAt.get(name) ?? null,
      size: sizeBytes === null ? "—" : prettySize(Number(sizeBytes)),
      size_bytes: sizeBytes ?? "0",
    };
  });
  // Largest first, as `ORDER BY size_bytes DESC`; without dbstat, by rows.
  tables.sort((a, b) => {
    const bySize = Number(b.size_bytes) - Number(a.size_bytes);
    if (bySize !== 0) return bySize;
    const byRows = Number(b.live_rows) - Number(a.live_rows);
    if (byRows !== 0) return byRows;
    return a.table_name.localeCompare(b.table_name);
  });
  res.ok({
    tables,
    db_size: prettySize(await readDatabaseBytes()),
  });
});

// codeql[js/missing-rate-limiting]: adminMutateLimiter is applied as middleware
// on this exact route (30 req/min). Scanner does not see middleware bound at
// the route level.
router.post("/database/vacuum", adminMutateLimiter, async (req, res) => {
  const { table } = parseInput(vacuumBodySchema, req.body ?? {});

  // Validate the table name against the catalog's user tables; the request
  // value is only a lookup key, the catalog's copy is what gets quoted.
  const tables = await listUserTables({ fresh: true });
  const target = table == null ? null : ([...tables].find((name) => name === table) ?? null);
  if (table != null && target === null) {
    throw new ValidationError(`Unknown table: ${table}`);
  }

  // SQLite's VACUUM rebuilds the whole file; it must run outside any
  // transaction, so it takes the writer exclusively (waiting for running
  // transactions). ANALYZE then refreshes the planner statistics of the
  // requested table (or of every table), and PRAGMA optimize lets SQLite
  // finish whatever else its planner asks for.
  const analyze = target === null
    ? "ANALYZE"
    : compileQuery(sql`ANALYZE ${sql.id(target)}`).sql;
  await withExclusiveWriter((writer) => {
    writer.exec("VACUUM");
    writer.exec(analyze);
    writer.exec("PRAGMA optimize");
  });
  const finishedAt = new Date().toISOString();
  maintenanceRuns.vacuumedAt = finishedAt;
  for (const name of target === null ? tables : [target]) {
    maintenanceRuns.analyzedAt.set(name, finishedAt);
  }

  res.ok({ vacuumed: table ?? "all" });
});

// ── Data Editor (JetBrains-style table browser/editor) ─────────────────────────

router.get("/database/tables/:table/schema", async (req, res) => {
  const { table } = parseInput(tableParamsSchema, req.params);
  res.ok(await getTableMeta(table));
});

router.get("/database/tables/:table/rows", async (req, res) => {
  const { table } = parseInput(tableParamsSchema, req.params);
  const { filters, limit, cursor, orderBy, dir, where } = parseInput(
    rowsQuerySchema,
    req.query,
  );
  const result = await readRows(table, {
    // parseInt matches the service's own clampInt parse (NaN -> default).
    limit: limit === undefined ? undefined : Number.parseInt(limit, 10),
    cursor,
    orderBy,
    dir,
    where,
    filters:
      filters === undefined
        ? []
        : parseInput(dbFiltersSchema, filters, {
            prefix: "Invalid filters parameter",
          }),
  });
  res.ok(result);
});

// codeql[js/missing-rate-limiting]: adminMutateLimiter is applied as middleware
// on this exact route. Identifiers are validated against the live catalog and
// double-quoted in dbEditor.js; values are parameterized.
router.post(
  "/database/tables/:table/mutate",
  adminMutateLimiter,
  async (req, res) => {
    const { table } = parseInput(tableParamsSchema, req.params);
    const { changes, dryRun } = parseInput(mutateBodySchema, req.body ?? {});
    const result = await applyMutations(table, changes, {
      dryRun: dryRun === true,
    });
    res.ok(result);
  },
);

// ── Provider Health ───────────────────────────────────────────────────────────

// Canonical collection shape `{items, total}` (unpaginated — `total` is the
// row count, present so pagination can land without breaking the shape).
router.get("/providers/health", async (_req, res) => {
  const items = await listProviderHealth();
  res.ok({ items, total: items.length });
});

router.post(
  "/providers/:provider/probe",
  adminMutateLimiter,
  async (req, res) => {
    const { provider } = parseInput(providerParamsSchema, req.params);
    const result = await probeProvider(provider);
    res.ok(result);
  },
);

// ── Request Metrics ───────────────────────────────────────────────────────────

// Canonical collection shape `{items, total}` (unpaginated — `total` is the
// row count, present so pagination can land without breaking the shape).
router.get("/metrics/requests", (_req, res) => {
  const items = getMetrics();
  res.ok({ items, total: items.length });
});

// ── Endpoint Manifest ─────────────────────────────────────────────────────────

// The manifest endpoint uses the canonical `{items, total}` collection shape.
router.get("/endpoints", (_req, res) => {
  const items = getRouteManifest();
  res.ok({ items, total: items.length });
});

export default router;
