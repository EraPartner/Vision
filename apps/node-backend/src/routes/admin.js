/**
 * Admin routes.
 *
 * Update strategy (packaged desktop app):
 *   - Electron shell updates: handled by the Electron wrapper (manual unsigned ZIP install)
 *   - Docker image updates: Electron calls `docker compose pull` + `docker compose up -d`
 *   - Alembic migrations: run automatically via docker-entrypoint.sh on every container start
 *
 * The git-pull based update approach has been removed. The Node backend running
 * inside the Docker container has no git repo, so those endpoints were only
 * applicable to bare self-hosted installs (which can still use git manually).
 * This endpoint is focused on backend/container update metadata.
 */

import { Router } from 'express';
import https from 'https';
// eslint-disable-next-line vision-local/no-repo-direct-from-route -- admin table stats/VACUUM are legitimately DB-level (ADR-067 documented exemption)
import { checkConnection, getClient, getTableCount, query } from '../database/connection.js';
import { getSettings } from '../config/config.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { sanitizePersistedKinesisHistory } from '../services/priceProviderService.js';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { listProviderHealth, probeProvider } from '../services/providerHealthService.js';
import { getMetrics } from '../middleware/requestMetrics.js';
import { getRouteManifest } from '../services/routeManifest.js';
import { adminMutateLimiter } from '../middleware/rateLimiter.js';
import { isAccuracyTableHealthy } from '../services/calculations/forecast/accuracyStore.js';
import { getTableMeta, readRows, applyMutations } from '../services/dbEditor.js';

const GITHUB_OWNER = 'EraPartner';
const GITHUB_REPO = 'Vision';
const GITHUB_RELEASES_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

/**
 * Fetch the latest GitHub Release metadata.
 * Returns a plain object — callers handle errors.
 */
const GITHUB_FETCH_TIMEOUT_MS = 5000;

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': `${GITHUB_REPO}-backend`,
        'Accept': 'application/vnd.github+json',
      },
      timeout: GITHUB_FETCH_TIMEOUT_MS,
    };
    const MAX_BODY = 512 * 1024;
    const req = https.get(GITHUB_RELEASES_URL, options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) {
          req.destroy();
          reject(new Error('GitHub response exceeded size limit'));
        }
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Failed to parse GitHub response: ${e.message}`)); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`GitHub API request timed out after ${GITHUB_FETCH_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
  });
}

function hasValidReleaseTag(release) {
  return !(release.message === 'Not Found' || !release.tag_name);
}

function detectCurrentAppVersion() {
  return env.APP_VERSION || env.APP_IMAGE_TAG || 'unknown';
}

function buildUpdateCheckPayload(release, currentVersion) {
  const latestVersion = release.tag_name;
  const upToDate = latestVersion === currentVersion || latestVersion === `v${currentVersion}`;

  return {
    payload: {
      up_to_date: upToDate,
      current_version: currentVersion,
      latest_version: latestVersion,
      published_at: release.published_at,
      release_notes: release.body || '',
      html_url: release.html_url,
    },
    latestVersion,
    upToDate,
  };
}

function formatAdminStatusPayload(isConnected, tableCount) {
  return {
    is_initialised: isConnected && tableCount > 0,
    table_count: tableCount,
    accuracy_table_healthy: isAccuracyTableHealthy(),
    timestamp: new Date().toISOString(),
    links: [],
  };
}

const router = Router();

router.get('/', async (req, res) => {
  const isConnected = await checkConnection();
  const tableCount = isConnected ? await getTableCount() : 0;
  res.ok(formatAdminStatusPayload(isConnected, tableCount));
});

router.post('/database/init', async (req, res) => {
  const isConnected = await checkConnection();
  if (!isConnected) throw new AppError('Cannot connect to database', { status: 500 });

  res.status(201);
  res.ok({
    message: 'Database connection verified successfully',
    details: { note: 'Tables are managed by Alembic migrations' },
    links: [],
  });
});

router.post('/database/reset', adminMutateLimiter, async (req, res) => {
  const settings = getSettings();
  if (!settings.admin.enableResetDb) {
    throw new NotFoundError('Database reset endpoint disabled');
  }

  const force = req.query.force === 'true';
  if (!force) {
    throw new ValidationError('Database reset requires force=true parameter', {
      details: { hint: 'Set force=true query parameter to confirm reset (DESTRUCTIVE)' },
    });
  }

  res.ok({
    message: 'Database reset should be performed via Alembic migrations (Python backend)',
    details: { warning: 'Use the Python backend for destructive database operations' },
    links: [],
  });
});

router.get('/update/check', async (req, res) => {
  const release = await fetchLatestRelease();

  if (!hasValidReleaseTag(release)) {
    res.ok({ up_to_date: true, error: 'No published releases found', latest_version: null });
    return;
  }

  const currentVersion = detectCurrentAppVersion();
  const { payload, latestVersion, upToDate } = buildUpdateCheckPayload(release, currentVersion);

  logger.info('Update check via GitHub Releases', { currentVersion, latestVersion, upToDate });
  res.ok(payload);
});

router.post('/update/apply', async (req, res) => {
  res.ok({
    success: true,
    note: 'Updates are applied automatically by the desktop app. If an update is available, use the notification in the Vision app window to download and install it.',
  });
});

router.post('/update/apply-and-restart', async (req, res) => {
  res.ok({
    success: true,
    note: 'Updates are managed by the Vision desktop app via Docker image pulls and the desktop shell updater. No manual action is required.',
  });
});

router.post('/investments/kinesis/sanitize-history', adminMutateLimiter, async (req, res) => {
  const result = await sanitizePersistedKinesisHistory();
  res.ok({
    message: 'Kinesis historical spikes sanitization completed',
    ...result,
  });
});

// ── Database Maintenance ───────────────────────────────────────────────────────

router.get('/database/stats', async (_req, res) => {
  const [tablesResult, sizeResult] = await Promise.all([
    query(`
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
    `, []),
    query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size`, []),
  ]);
  res.ok({
    tables: tablesResult.rows,
    db_size: sizeResult.rows[0]?.db_size ?? null,
  });
});

// codeql[js/missing-rate-limiting]: adminMutateLimiter is applied as middleware
// on this exact route (30 req/min). Scanner does not see middleware bound at
// the route level.
router.post('/database/vacuum', adminMutateLimiter, async (req, res) => {
  const { table } = req.body ?? {};

  // Validate table name against actual user tables to prevent injection
  const allowed = await query(
    `SELECT relname FROM pg_stat_user_tables WHERE schemaname = 'public'`,
    []
  );
  const allowedNames = new Set(allowed.rows.map((r) => r.relname));

  if (table !== undefined && table !== null && !allowedNames.has(table)) {
    throw new ValidationError(`Unknown table: ${table}`);
  }

  // VACUUM cannot run inside a transaction block — use raw client
  const client = await getClient();
  try {
    await client.query('SET statement_timeout = 120000');
    // codeql[js/sql-injection]: `table` is validated against the allowlist
    // populated from pg_stat_user_tables above; double-quoting the identifier
    // prevents identifier-injection. VACUUM also rejects parameterized
    // identifiers, so dynamic SQL is the only viable form here.
    const sql = table ? `VACUUM ANALYZE "${table}"` : 'VACUUM ANALYZE';
    await client.query(sql);
  } catch (err) {
    if (err.code === '42501') {
      // insufficient_privilege
      const target = table ?? 'all tables';
      throw new ForbiddenError(`Insufficient database privileges to VACUUM ${target}`);
    }
    throw err;
  } finally {
    client.release();
  }

  res.ok({ vacuumed: table ?? 'all' });
});

// ── Data Editor (JetBrains-style table browser/editor) ─────────────────────────

router.get('/database/tables/:table/schema', async (req, res) => {
  const meta = await getTableMeta(req.params.table);
  res.ok(meta);
});

router.get('/database/tables/:table/rows', async (req, res) => {
  let filters = [];
  if (req.query.filters !== undefined) {
    try {
      const parsed = JSON.parse(req.query.filters);
      if (!Array.isArray(parsed)) throw new Error('filters must be an array');
      filters = parsed;
    } catch (err) {
      throw new ValidationError(`Invalid filters parameter: ${err.message}`);
    }
  }
  // The raw `where` query param was removed (SQLi timing oracle, see ADR-101
  // addendum); readRows rejects it with a 400 pointing at filters[].
  const result = await readRows(req.params.table, {
    limit: req.query.limit,
    offset: req.query.offset,
    orderBy: req.query.orderBy,
    dir: req.query.dir,
    where: req.query.where,
    filters,
  });
  res.ok(result);
});

// codeql[js/missing-rate-limiting]: adminMutateLimiter is applied as middleware
// on this exact route. Identifiers are validated against the live catalog and
// double-quoted in dbEditor.js; values are parameterized.
router.post('/database/tables/:table/mutate', adminMutateLimiter, async (req, res) => {
  const { changes, dryRun } = req.body ?? {};
  const result = await applyMutations(req.params.table, changes, { dryRun: dryRun === true });
  res.ok(result);
});

// ── Provider Health ───────────────────────────────────────────────────────────

router.get('/providers/health', async (_req, res) => {
  const providers = await listProviderHealth();
  res.ok(providers);
});

router.post('/providers/:provider/probe', adminMutateLimiter, async (req, res) => {
  const { provider } = req.params;
  const result = await probeProvider(provider);
  res.ok(result);
});

// ── Request Metrics ───────────────────────────────────────────────────────────

router.get('/metrics/requests', (_req, res) => {
  res.ok(getMetrics());
});

// ── Endpoint Manifest ─────────────────────────────────────────────────────────

router.get('/endpoints', (_req, res) => {
  res.ok(getRouteManifest());
});

router.get('/endpoint-liveness', (_req, res) => {
  const manifest = getRouteManifest();
  res.ok(manifest.map((entry) => ({ ...entry, live: true })));
});

export default router;
