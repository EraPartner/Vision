/**
 * Admin routes.
 *
 * Update strategy (packaged desktop app):
 *   - Electron shell updates: handled by the Electron wrapper (manual unsigned ZIP install)
 *   - Alembic migrations: run automatically during native backend startup
 *
 * The git-pull based update approach has been removed. The Node backend running
 * in a packaged application has no git repository, so those endpoints were only
 * applicable to source checkouts (which can still use git manually). This
 * endpoint is focused on release metadata.
 */

import { Router } from "express";
import https from "https";
import { z } from "zod";
// eslint-disable-next-line vision-local/no-repo-direct-from-route -- admin table stats/VACUUM are legitimately DB-level (ADR-067 documented exemption)
import {
  checkConnection,
  getClient,
  getTableCount,
  query,
} from "../database/connection.ts";
import settings from "../config/config.ts";
import { env } from "../config/env.ts";
import { logger } from "../config/logger.ts";
import { sanitizePersistedKinesisHistory } from "../services/priceProviderService.ts";
import {
  AppError,
  ForbiddenError,
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
  readRows,
  applyMutations,
} from "../services/dbEditor.ts";
import { parseInput } from "../lib/zodInput.ts";

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
interface GitHubRelease {
  message?: unknown;
  tag_name?: string;
  published_at?: string;
  body?: string;
  html_url?: string;
}

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
          resolve(JSON.parse(body) as GitHubRelease | null);
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
      // supplies its own native/dev mode. HTTP clients are source deployments
      // and update from their host environment rather than an in-app installer.
      update_mode: UPDATE_MODE_SOURCE,
    },
    latestVersion,
    upToDate,
  };
}

function formatAdminStatusPayload(isConnected: boolean, tableCount: number) {
  return {
    is_initialised: isConnected && tableCount > 0,
    table_count: tableCount,
    accuracy_table_healthy: isAccuracyTableHealthy(),
    timestamp: new Date().toISOString(),
    links: [] as unknown[],
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
    details: { note: "Tables are managed by Alembic migrations" },
    links: [],
  });
});

router.post("/database/reset", adminMutateLimiter, async (req, res) => {
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
    message:
      "Database reset should be performed via Alembic migrations (Python backend)",
    details: {
      warning: "Use the Python backend for destructive database operations",
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

router.post("/update/apply", async (req, res) => {
  res.ok({
    success: true,
    note: "Updates are applied automatically by the desktop app. If an update is available, use the notification in the Vision app window to download and install it.",
  });
});

router.post("/update/apply-and-restart", async (req, res) => {
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

router.get("/database/stats", async (_req, res) => {
  const [tablesResult, sizeResult] = await Promise.all([
    query(
      `
      SELECT
        schemaname,
        relname AS table_name,
        n_live_tup AS live_rows,
        n_dead_tup AS dead_rows,
        last_autovacuum::text,
        last_autoanalyze::text,
        pg_size_pretty(pg_total_relation_size(relid)) AS size,
        pg_total_relation_size(relid) AS size_bytes
      FROM pg_stat_user_tables
      ORDER BY size_bytes DESC
    `,
      [],
    ),
    query(
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size`,
      [],
    ),
  ]);
  res.ok({
    tables: tablesResult.rows,
    db_size: sizeResult.rows[0]?.db_size ?? null,
  });
});

// codeql[js/missing-rate-limiting]: adminMutateLimiter is applied as middleware
// on this exact route (30 req/min). Scanner does not see middleware bound at
// the route level.
router.post("/database/vacuum", adminMutateLimiter, async (req, res) => {
  const { table } = parseInput(vacuumBodySchema, req.body ?? {});

  // Validate table name against actual user tables to prevent injection
  const allowed = await query(
    `SELECT relname FROM pg_stat_user_tables WHERE schemaname = 'public'`,
    [],
  );
  const allowedNames = new Set(
    allowed.rows.map((r: { relname: string }) => r.relname),
  );

  if (table != null && !allowedNames.has(table)) {
    throw new ValidationError(`Unknown table: ${table}`);
  }

  // VACUUM cannot run inside a transaction block — use raw client
  const client = await getClient();
  try {
    await client.query("SET statement_timeout = 120000");
    // codeql[js/sql-injection]: `table` is validated against the allowlist
    // populated from pg_stat_user_tables above; double-quoting the identifier
    // prevents identifier-injection. VACUUM also rejects parameterized
    // identifiers, so dynamic SQL is the only viable form here.
    const sql = table ? `VACUUM ANALYZE "${table}"` : "VACUUM ANALYZE";
    await client.query(sql);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "42501") {
      // insufficient_privilege
      const target = table ?? "all tables";
      throw new ForbiddenError(
        `Insufficient database privileges to VACUUM ${target}`,
      );
    }
    throw err;
  } finally {
    client.release();
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

// Both manifest endpoints use the canonical `{items, total}` collection shape.
router.get("/endpoints", (_req, res) => {
  const items = getRouteManifest();
  res.ok({ items, total: items.length });
});

router.get("/endpoint-liveness", (_req, res) => {
  const items = getRouteManifest().map((entry) => ({ ...entry, live: true }));
  res.ok({ items, total: items.length });
});

export default router;
