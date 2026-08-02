import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../config/logger.js'
import { query } from './connection.js'
import { withDdlRunner } from './appRoleBootstrap.js'

const execFileAsync = promisify(execFile)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// repo root: apps/node-backend/src/database/ -> ../../../..
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

// A cold or big-jump upgrade can legitimately run for minutes (full-table
// rewrites on transactions / asset_price_history). The old 120s kill turned a
// slow-but-progressing upgrade into a hard failure. Default to 10 minutes and
// let operators override via VISION_MIGRATE_TIMEOUT_MS (0 = no timeout).
// Progress is now durable per-migration (env.py transaction_per_migration), so
// even if this fires mid-chain the completed migrations persist and the next
// boot resumes rather than restarting the whole chain.
function resolveDefaultTimeoutMs() {
  const raw = process.env.VISION_MIGRATE_TIMEOUT_MS
  if (raw === undefined || raw === '') return 600_000
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 600_000
  return n // 0 disables the execFile timeout entirely
}

const DEFAULT_TIMEOUT_MS = resolveDefaultTimeoutMs()

// Binary path for alembic. Defaults to PATH lookup; override in containers
// where alembic lives inside a venv (e.g. /venv/bin/alembic).
const ALEMBIC_BIN = process.env.ALEMBIC_BIN || 'alembic'

// alembic.ini lives at config/alembic.ini relative to repo root.
const ALEMBIC_CONFIG = process.env.ALEMBIC_CONFIG || 'config/alembic.ini'

// Skip-at-head cache. After a successful `alembic upgrade head`, we record the
// applied revision + a fingerprint of alembic/versions/. On subsequent boots,
// if the DB is still at that revision and the versions directory hasn't
// changed, we skip the alembic invocation entirely (~1-3s warm-boot win).
const HEAD_CACHE_DIR = process.env.VISION_CACHE_DIR || path.join(REPO_ROOT, '.vision-cache')
const HEAD_CACHE_FILE = path.join(HEAD_CACHE_DIR, 'alembic-head.json')
const VERSIONS_DIR = path.join(REPO_ROOT, 'alembic', 'versions')

function fingerprintVersionsDir() {
  try {
    const files = readdirSync(VERSIONS_DIR)
      .filter(f => f.endsWith('.py') && !f.startsWith('_'))
      .sort()
    return files.join(',')
  } catch {
    return ''
  }
}

async function isAtHeadCached() {
  if (!existsSync(HEAD_CACHE_FILE)) return false
  try {
    const cached = JSON.parse(readFileSync(HEAD_CACHE_FILE, 'utf8'))
    if (!cached?.head || !cached?.fingerprint) return false
    const fp = fingerprintVersionsDir()
    if (!fp || fp !== cached.fingerprint) return false
    const res = await query('SELECT version_num FROM alembic_version LIMIT 1')
    const dbRev = res.rows[0]?.version_num
    return dbRev === cached.head
  } catch (err) {
    logger.warn({ err: err.message }, 'isAtHeadCached check failed; will run alembic')
    return false
  }
}

async function writeHeadCache() {
  try {
    mkdirSync(HEAD_CACHE_DIR, { recursive: true })
    const res = await query('SELECT version_num FROM alembic_version LIMIT 1')
    const head = res.rows[0]?.version_num
    if (!head) return
    const payload = {
      head,
      fingerprint: fingerprintVersionsDir(),
      appliedAt: new Date().toISOString(),
    }
    writeFileSync(HEAD_CACHE_FILE, JSON.stringify(payload) + '\n')
  } catch (err) {
    logger.warn({ err }, 'writeHeadCache failed; non-fatal')
  }
}

// Consolidated baseline revision — replaces the 0002..0032 chain that was
// previously overlaid on top of a schemaInit.js-seeded DB. Kept in sync with
// the `revision` identifier in alembic/versions/0001_initial_database_schema.py.
const BASELINE_REVISION = '0001_initial'

// Revisions that existed in the previous chain and were moved to
// alembic/legacy_versions/ as part of ADR-027 squash. If a deployed DB is
// stamped at any of these, we normalize it to BASELINE_REVISION so that
// `alembic upgrade head` does not fail with "Can't locate revision".
const LEGACY_REVISIONS = new Set([
  '0002_add_url',
  '0003_make_recipient_nullable',
  '0004_portfolio_tables',
  '0005_manual_raw_transactions',
  '0006_price_providers',
  '0007_recipient_merge',
  '0008_drop_custom_raw_txns',
  '0009_transaction_splits',
  '0010_inv_muni_tax',
  '0011_planned_loans',
  '0012_add_indexes',
  '0013_investment_inheritance',
  '0014_investments_view_update_trigger',
  '0015_add_gift_portfolio_txn_type',
  '0016_add_fx_rate_to_portfolio_transactions',
  '0017_investment_custom_provider_history',
  '0018_metals_transactions_inheritance_split',
  '0019_asset_price_history_cache',
  '0020_drop_asset_price_history_fk',
  '0021_price_provider_binance',
  '0022_price_provider_kinesis',
  '0023_portfolio_performance_snapshots',
  '0024_per_class_invested_columns',
  '0025_exchange_rate_cache',
  '0026_finance_aggregations',
  '0027_planned_execution_idempotency',
  '0028_split_audit_overpayment_guard',
  '0029_recipient_category_uniqueness',
  '0030_import_pipeline_staging',
  '0031_ai_chat_tables',
  '0032_add_hot_path_indexes',
])

/**
 * If the DB has an `alembic_version` row pointing at a revision that was
 * moved to legacy_versions/, rewrite it to the current baseline so
 * `alembic upgrade head` does not fail with "Can't locate revision".
 *
 * On a truly fresh DB the table does not exist yet. Alembic would otherwise
 * create it itself with a default `version_num VARCHAR(32)`, which is too
 * narrow for current revision names (e.g. `0003_import_batch_id_on_transactions`
 * is 38 chars). We preflight-create it at VARCHAR(64) so the first revision
 * insert does not blow up with a string-truncation error.
 */
export async function stampBaselineIfLegacy() {
  // Runs on the PRIVILEGED role when one is configured (two-role installs).
  // Everything below is migration-scoped DDL on `alembic_version` — CREATE
  // TABLE, and an ALTER TABLE that requires OWNERSHIP of a table Alembic
  // created. On a least-privilege runtime pool that ALTER is a hard 42501 and
  // this function rethrows, i.e. it would BRICK boot on exactly the installs
  // this hardening targets. withDdlRunner falls back to the runtime pool when
  // no privileged URL is configured, so single-role installs are byte-for-byte
  // unchanged.
  return withDdlRunner((run) => stampBaselineWith(run), query)
}

/**
 * @param {(text: string, params?: any[]) => Promise<any>} run
 */
async function stampBaselineWith(run) {
  try {
    const tableExists = await run(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'alembic_version'
       ) AS present`
    )
    if (!tableExists.rows[0]?.present) {
      await run(
        `CREATE TABLE alembic_version (
           version_num VARCHAR(64) NOT NULL,
           CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
         )`
      )
      logger.info('alembic_version preflight-created with VARCHAR(64)')
      return { skipped: true, reason: 'preflight-created empty alembic_version' }
    }

    // Expand version_num to VARCHAR(64) if narrower — older DBs created by
    // alembic at a time when revision IDs were short still have VARCHAR(32),
    // which truncates the longer named revisions we use today.
    const colRes = await run(
      `SELECT character_maximum_length AS len
       FROM information_schema.columns
       WHERE table_name = 'alembic_version' AND column_name = 'version_num'`
    )
    const colLen = colRes.rows[0]?.len
    if (typeof colLen === 'number' && colLen < 64) {
      logger.warn({ from: colLen, to: 64 }, 'expanding alembic_version.version_num')
      await run('ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(64)')
    }

    const versionRes = await run('SELECT version_num FROM alembic_version LIMIT 1')
    const current = versionRes.rows[0]?.version_num
    if (!current) {
      return { skipped: true, reason: 'alembic_version table empty' }
    }
    if (current === BASELINE_REVISION) {
      return { skipped: true, reason: 'already at baseline' }
    }
    if (!LEGACY_REVISIONS.has(current)) {
      return { skipped: true, reason: `unknown revision ${current}; leaving untouched` }
    }

    await run('UPDATE alembic_version SET version_num = $1', [BASELINE_REVISION])
    logger.warn(
      { from: current, to: BASELINE_REVISION },
      'alembic_version stamped to new baseline (ADR-027 squash)'
    )
    return { stamped: true, from: current, to: BASELINE_REVISION }
  } catch (error) {
    logger.error({ err: error }, 'stampBaselineIfLegacy failed')
    throw error
  }
}

/**
 * Best-effort ANALYZE of the tables a migration most likely rewrote or
 * backfilled in full, so the planner has fresh row/histogram stats for the
 * first queries after an upgrade instead of stale (or empty) ones. Runs only
 * on a real (non-cached) upgrade. Failures are logged and swallowed — stale
 * statistics degrade plans but must never fail application boot.
 */
async function analyzeAfterMigrations() {
  // On the privileged role when one is configured. ANALYZE requires table
  // OWNERSHIP (or, from PostgreSQL 17, the MAINTAIN privilege) and these
  // tables are owned by the migration role — but note the failure mode is
  // SILENT: a non-owner ANALYZE emits a WARNING ("permission denied to analyze
  // …, skipping it", SQLSTATE 01000) and returns success without sampling
  // anything, so the try/catch below would never have noticed. Running it on
  // the privileged connection is what actually keeps the stats fresh. Still
  // best-effort either way — stale stats degrade plans, never boot.
  await withDdlRunner(async (run) => {
    for (const table of ['transactions', 'asset_price_history']) {
      try {
        await run(`ANALYZE ${table}`)
      } catch (err) {
        logger.warn({ err: err.message, table }, 'post-migration ANALYZE failed; non-fatal')
      }
    }
  }, query)
}

/**
 * Run alembic upgrade head. Fail-fast on non-zero exit.
 * Logs stdout/stderr streamed from alembic.
 *
 * @param {object} [options]
 * @param {string} [options.target='head']
 * @param {number} [options.timeoutMs=120000]
 */
export async function runMigrations(options = {}) {
  const target = options.target || 'head'
  // Nullish (not ||) so an explicit timeoutMs: 0 ("no timeout") is honoured.
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  logger.info({ target, cwd: REPO_ROOT }, 'alembic migrate start')

  await stampBaselineIfLegacy()

  if (target === 'head' && (await isAtHeadCached())) {
    logger.info('alembic skip: cached head matches DB and versions/ unchanged')
    return
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      ALEMBIC_BIN,
      ['-c', ALEMBIC_CONFIG, 'upgrade', target],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024
      }
    )

    if (stdout) {
      logger.info({ output: stdout.trim() }, 'alembic stdout')
    }
    if (stderr) {
      // alembic writes INFO-level progress to stderr by default
      logger.info({ output: stderr.trim() }, 'alembic stderr')
    }

    logger.info('alembic migrate ok')

    if (target === 'head') {
      await writeHeadCache()
    }

    // Freshen planner statistics on the two tables that migrations most often
    // rewrite/backfill wholesale (transactions, asset_price_history). This only
    // runs when alembic actually executed — the warm-boot path short-circuits
    // via isAtHeadCached() above and never reaches here — so it is not paid on
    // every boot. Best-effort: bad stats are a perf issue, never a boot blocker.
    await analyzeAfterMigrations()
  } catch (error) {
    logger.error(
      {
        err: error,
        stdout: error.stdout?.toString?.().trim?.(),
        stderr: error.stderr?.toString?.().trim?.(),
        code: error.code,
        signal: error.signal
      },
      'alembic migrate failed'
    )
    throw new Error(
      `Alembic migration failed (exit ${error.code ?? 'unknown'}): ${error.message}`,
      { cause: error }
    )
  }
}
