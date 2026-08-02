'use strict';

// ── Backup / restore orchestration ───────────────────────────────────────────
// Extracted verbatim from main.js (TODO.md Wave W6). Owns the pg_dump-based
// bundle backup (runBundleBackup), the .visionbak bundle restore
// (runBundleRestore), the legacy plain-SQL restore (runRestore), and their
// private helpers (DATABASE_URL parsing, PGPASSWORD env-file plumbing, and the
// alembic newer-schema guard). Mutable main.js state (workDir, overrideFiles,
// appPort) and the health-poll seam are threaded in via init() getters so the
// live value is observed at call time, exactly as when this code lived in
// main.js.

const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { createBundle, encryptBundle, openBundle, isBundleEncrypted } = require('./bundle');
const { dockerEnv, run, composeArgs } = require('../compose');
const {
  getBackupDeviceId, getBackupPassphrase, cleanupOldBackups,
  isEncryptedBackupFile, decryptBackupFileToTemp,
  ERR_PASSPHRASE_REQUIRED, ERR_INVALID_PASSPHRASE,
} = require('./crypto');

// Context threaded from main.js via init():
//   { workDir(), overrideFiles(), appPort(), repoRootFallback,
//     pollHealth, HEALTH_POLL_BUILD_ATTEMPTS }
// repoRootFallback is resolved in main.js (packaging/electron/__dirname two
// levels up) so the dev-mode fallback path is byte-identical to the original.
let ctx = {};
function init(context) {
  ctx = context;
}

/**
 * Write `PGPASSWORD=<password>` to a mode-0600 temp file, invoke callback(envFilePath),
 * then delete the file. Prevents PGPASSWORD from appearing in `ps` / `docker inspect`.
 */
async function withPgPassEnvFile(password, callback) {
  const envFilePath = path.join(app.getPath('temp'), `pgpass_${Date.now()}_${process.pid}.env`);
  await fs.promises.writeFile(envFilePath, `PGPASSWORD=${password}\n`, { mode: 0o600 });
  try {
    return await callback(envFilePath);
  } finally {
    try { fs.unlinkSync(envFilePath); } catch (_) {}
  }
}

// Validate a PostgreSQL identifier (username or database name).
// Restricts to safe characters so values can never break SQL strings or identifiers.
function validateIdentifier(name, label) {
  if (!/^[a-zA-Z0-9_]{1,63}$/.test(name)) {
    throw new Error(`Invalid ${label} in DATABASE_URL: "${name}". Only alphanumeric characters and underscores are allowed.`);
  }
}

// Parse the PRIVILEGED database connection string from .env file contents and
// validate the extracted identifiers.
// Returns { dbUser, dbPass, dbName } or throws on invalid/missing URL.
//
// Every consumer of this function runs a cluster-level admin operation —
// `pg_dump`, `DROP DATABASE`, `CREATE DATABASE ... OWNER`,
// `pg_terminate_backend` — none of which a non-superuser can perform. Under
// the least-privilege split DATABASE_URL deliberately keeps naming the
// privileged role (the low-privilege runtime role lives in DATABASE_URL_APP,
// which this function must NEVER read), so this stays correct for both
// single-role and two-role installs, and for an older app build reading the
// same file. DATABASE_URL_MIGRATIONS still wins when present — that is the
// hand-rolled layout where DATABASE_URL itself was repointed at `ftm_app`.
function parseDatabaseUrlFromEnv(envContents) {
  const privileged = envContents.match(/^DATABASE_URL_MIGRATIONS=(.+)$/m);
  const lineMatch = privileged || envContents.match(/^DATABASE_URL=(.+)$/m);
  const rawUrl = lineMatch ? lineMatch[1].trim() : null;

  let dbUser = 'ftm_user';
  let dbPass = '';
  let dbName = 'financial_transactions';

  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      dbUser = decodeURIComponent(parsed.username) || dbUser;
      dbPass = decodeURIComponent(parsed.password) || dbPass;
      dbName = parsed.pathname.replace(/^\//, '') || dbName;
    } catch {
      // Keep defaults if URL is malformed
    }
  }

  validateIdentifier(dbUser, 'username');
  validateIdentifier(dbName, 'database name');
  return { dbUser, dbPass, dbName };
}

// ── Bundle backup/restore helpers ────────────────────────────────────────────

/** Zero-padded numeric prefix of a Vision alembic revision id, or null. */
function revisionNumericPrefix(rev) {
  const m = /^(\d+)/.exec(String(rev || ''));
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Query the running DB for the current alembic revision.
 * Returns empty string if unavailable (e.g. DB not yet initialised).
 *
 * Fetches ALL alembic_version rows: under the known multi-head drift the old
 * `LIMIT 1` returned an arbitrary row, making the newer-schema guard
 * nondeterministic. Deterministically pick the highest numeric-prefixed
 * revision (the guard compares numeric prefixes).
 */
async function getSchemaHead(composeFileArgs, dbUser, dbName) {
  try {
    const result = await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', dbName, '-t', '-A', '-c',
      'SELECT version_num FROM alembic_version;',
    ], ctx.workDir(), { timeout: 10000 });
    const rows = result.split('\n').map(s => s.trim()).filter(Boolean);
    if (rows.length === 0) return '';
    let best = rows[0];
    for (const row of rows.slice(1)) {
      const a = revisionNumericPrefix(row);
      const b = revisionNumericPrefix(best);
      if (a != null && (b == null || a > b)) best = row;
    }
    return best;
  } catch {
    return '';
  }
}

/**
 * Newest revision in the LOCAL alembic/versions directory (by numeric
 * prefix; filenames match revision ids). Fail-safe fallback for the
 * newer-schema guard: when the DB's head is unreadable (fresh DB, container
 * down), an empty currentHead used to skip the guard entirely — but a bundle
 * from a newer install still crash-loops boot-time `alembic upgrade head`
 * regardless of DB state, because the CODE's migration chain doesn't know the
 * bundle's revision. Comparing against the local chain head catches that.
 */
function getLocalMigrationChainHead() {
  try {
    const versionsDir = path.join(ctx.workDir() || ctx.repoRootFallback, 'alembic', 'versions');
    let best = '';
    for (const f of fs.readdirSync(versionsDir)) {
      if (!f.endsWith('.py') || f.startsWith('_')) continue;
      const rev = f.slice(0, -3);
      const a = revisionNumericPrefix(rev);
      if (a == null) continue;
      const b = revisionNumericPrefix(best);
      if (b == null || a > b) best = rev;
    }
    return best;
  } catch {
    return '';
  }
}

/**
 * Extract the alembic revision recorded inside a plain-SQL pg_dump file.
 * pg_dump emits the alembic_version row either as a COPY block
 * (`COPY public.alembic_version (version_num) FROM stdin;` + data line)
 * or, with --inserts, as an INSERT statement. Streams the file and stops
 * at the first match, so arbitrarily large dumps stay cheap.
 * Returns '' when no revision is found (not a Vision dump, empty table, …).
 */
function readDumpSchemaHead(sqlPath) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(sqlPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let inCopyBlock = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      rl.close();
      stream.destroy();
    };
    rl.on('line', (line) => {
      if (inCopyBlock) {
        const value = line.trim();
        finish(value === '\\.' ? '' : value);
        return;
      }
      if (/^COPY\s+(?:"?[\w$]+"?\.)?"?alembic_version"?\s*\("?version_num"?\)\s+FROM\s+stdin;/i.test(line)) {
        inCopyBlock = true;
        return;
      }
      const insert = line.match(
        /^INSERT INTO\s+(?:"?[\w$]+"?\.)?"?alembic_version"?\s*(?:\("?version_num"?\)\s*)?VALUES\s*\('([^']+)'\)/i,
      );
      if (insert) finish(insert[1]);
    });
    rl.on('close', () => finish(''));
    stream.on('error', () => finish(''));
  });
}

/**
 * True only when `candidate` is provably a newer alembic revision than
 * `current`. Vision revisions carry a zero-padded numeric prefix
 * ("0071_planned_recurrence_bounds"); compare those numerically — the old
 * lexicographic `>` silently misorders any future hash-style id. When either
 * id has no numeric prefix (or `current` is unknown), skip the guard rather
 * than block a restore on an uncomparable pair.
 */
function isSchemaRevisionNewer(candidate, current) {
  const a = revisionNumericPrefix(candidate);
  const b = revisionNumericPrefix(current);
  if (a == null || b == null) return false;
  return a > b;
}

/**
 * Create a .visionbak bundle in destDir, optionally encrypted.
 * frontendStateJson may be null (e.g. when called at quit time).
 */
async function runBundleBackup(destDir, frontendStateJson = null) {
  if (!destDir) throw new Error('No backup directory configured');

  let dbUser = 'ftm_user';
  let dbName = 'financial_transactions';
  try {
    const envContents = await fs.promises.readFile(path.join(ctx.workDir(), '.env'), 'utf8');
    ({ dbUser, dbName } = parseDatabaseUrlFromEnv(envContents));
  } catch { /* use defaults */ }

  const composeFileArgs = composeArgs(ctx.workDir(), ctx.overrideFiles());
  const deviceId = await getBackupDeviceId();
  const appVersion = app.getVersion ? app.getVersion() : 'unknown';
  const schemaHead = await getSchemaHead(composeFileArgs, dbUser, dbName);

  // Temp dir for SQL dump and attachments staging
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vision_bak_'));
  const dbSqlPath = path.join(tmpDir, 'db.sql');
  let attachmentsDir = null;

  try {
    // 1. pg_dump to temp file
    await new Promise((resolve, reject) => {
      const args = [
        'compose', ...composeFileArgs,
        'exec', '-T', 'db',
        'pg_dump', '-U', dbUser, '-d', dbName, '--no-owner', '--no-acl',
      ];
      const child = spawn('docker', args, { env: dockerEnv, cwd: ctx.workDir() });
      const out = fs.createWriteStream(dbSqlPath);
      child.stdout.pipe(out);
      const stderr = [];
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.on('error', (err) => { out.destroy(); reject(err); });
      child.on('close', (code) => {
        if (code === 0) { out.end(() => resolve()); }
        else { out.destroy(); reject(new Error(Buffer.concat(stderr).toString().trim() || `pg_dump exited with code ${code}`)); }
      });
    });

    // 2. Copy attachments out of running container (optional — fails gracefully)
    const attachmentsTmp = path.join(tmpDir, 'attachments');
    try {
      await run('docker', [
        'compose', ...composeFileArgs,
        'cp', `app:/app/data/attachments`, attachmentsTmp,
      ], ctx.workDir(), { timeout: 120000 });
      // docker compose cp creates attachments/ as the target directory
      attachmentsDir = attachmentsTmp;
    } catch {
      // No attachments in container — bundle proceeds without them
    }

    // 3. Parse frontendState
    let frontendState = null;
    if (frontendStateJson) {
      try { frontendState = typeof frontendStateJson === 'string' ? JSON.parse(frontendStateJson) : frontendStateJson; }
      catch { /* non-fatal */ }
    }

    // 4. Assemble bundle zip
    const { bundlePath } = await createBundle({
      destDir,
      deviceId,
      schemaHead,
      appVersion,
      dbSqlPath,
      attachmentsDir,
      frontendState,
    });

    // 5. Encrypt if passphrase configured (v2: per-bundle salt + GCM)
    const passphrase = await getBackupPassphrase();
    let finalFile = bundlePath;
    let encrypted = false;
    let warning;
    if (passphrase) {
      const { encPath } = await encryptBundle(bundlePath, passphrase);
      finalFile = encPath;
      encrypted = true;
    } else {
      warning = 'Backup encryption skipped: no passphrase configured.';
    }

    // 6. Rotate old bundles
    const cleanup = await cleanupOldBackups(destDir, deviceId);
    return { success: true, file: finalFile, encrypted, warning, cleanupRemoved: cleanup.removed };

  } finally {
    // Always clean up temp SQL dump (bundle has its own copy)
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

/**
 * Restore a .visionbak (or .visionbak.enc) bundle.
 * Returns { success, file, frontendState } on success.
 * frontendState is the parsed { keys: { … } } object or null.
 */
async function runBundleRestore(bundlePath, { passphrase } = {}) {
  if (!bundlePath) throw new Error('No backup file specified');
  if (!fs.existsSync(bundlePath)) throw new Error(`File not found: ${bundlePath}`);

  const isEncrypted = await isBundleEncrypted(bundlePath);
  let effectivePassphrase = null;
  if (isEncrypted) {
    effectivePassphrase = passphrase || (await getBackupPassphrase());
    if (!effectivePassphrase) throw new Error(ERR_PASSPHRASE_REQUIRED);
  }

  // Open bundle — decrypt + extract to temp dir. openBundle throws on bad
  // decrypt; convert to a sentinel so the UI can re-prompt for the passphrase.
  let metadata, dbSqlPath, attachmentsDir, frontendState, cleanup;
  try {
    ({ metadata, dbSqlPath, attachmentsDir, frontendState, cleanup } = await openBundle(bundlePath, { passphrase: effectivePassphrase }));
  } catch (err) {
    if (isEncrypted) {
      const msg = err && err.message ? String(err.message) : '';
      if (
        /bad decrypt/i.test(msg) ||
        /wrong final block/i.test(msg) ||
        /unable to authenticate/i.test(msg) ||
        /missing metadata\.json/i.test(msg) ||
        /missing db\.sql/i.test(msg) ||
        /end of central directory/i.test(msg) ||
        /not a zip file/i.test(msg) ||
        (err && err.code === 'ERR_OSSL_BAD_DECRYPT') ||
        (err && err.code === 'ERR_CRYPTO_INVALID_AUTH_TAG')
      ) {
        throw new Error(ERR_INVALID_PASSPHRASE);
      }
    }
    throw err;
  }

  let dbUser = 'ftm_user';
  let dbPass = '';
  let dbName = 'financial_transactions';
  try {
    const envContents = await fs.promises.readFile(path.join(ctx.workDir(), '.env'), 'utf8');
    ({ dbUser, dbPass, dbName } = parseDatabaseUrlFromEnv(envContents));
  } catch { /* use defaults */ }

  const composeFileArgs = composeArgs(ctx.workDir(), ctx.overrideFiles());

  // Schema version check: block restore if bundle is from a newer schema.
  // When the DB head is unreadable (fresh DB, container down), fall back to
  // the local migration chain head instead of skipping the guard — a
  // newer-schema bundle crash-loops boot regardless of current DB state.
  if (metadata.schemaHead) {
    const currentHead = await getSchemaHead(composeFileArgs, dbUser, dbName)
      || getLocalMigrationChainHead();
    if (isSchemaRevisionNewer(metadata.schemaHead, currentHead)) {
      cleanup();
      throw new Error(
        `BUNDLE_SCHEMA_NEWER: This bundle was created on schema revision "${metadata.schemaHead}" ` +
        `but this Vision install is at "${currentHead}". ` +
        `Update Vision to a newer version and retry.`
      );
    }
  }

  // 1. Stop app container
  await run('docker', ['compose', ...composeFileArgs, 'stop', 'app'], ctx.workDir(), { timeout: 60000 });

  try {
    // 2a. Terminate remaining DB connections
    await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', 'postgres',
      '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
    ], ctx.workDir(), { timeout: 30000 });

    // 2b. Drop and recreate the database
    await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', 'postgres',
      '-c', `DROP DATABASE IF EXISTS "${dbName}";`,
    ], ctx.workDir(), { timeout: 30000 });

    await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', 'postgres',
      '-c', `CREATE DATABASE "${dbName}" OWNER "${dbUser}";`,
    ], ctx.workDir(), { timeout: 30000 });

    // 3. Restore SQL via throwaway container (same pattern as runRestore)
    const dbContainerName = await run('docker', [
      'compose', ...composeFileArgs, 'ps', '-q', 'db',
    ], ctx.workDir(), { timeout: 10000 }).then(s => s.trim()).catch(() => '');

    let pgImageTag = 'postgres:16';
    if (dbContainerName) {
      pgImageTag = await run('docker', [
        'inspect', '--format', '{{.Config.Image}}', dbContainerName,
      ], ctx.workDir(), { timeout: 10000 }).then(s => s.trim()).catch(() => 'postgres:16');
    }

    const networkName = await run('docker', [
      'inspect', '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}', dbContainerName,
    ], ctx.workDir(), { timeout: 10000 }).then(s => s.trim().split('\n')[0]).catch(() => '');

    const hostDir = path.dirname(dbSqlPath);
    const sqlFilename = path.basename(dbSqlPath);

    await withPgPassEnvFile(dbPass, (envFile) => new Promise((resolve, reject) => {
      const child = spawn('docker', [
        'run', '--rm',
        '-v', `${hostDir}:/restore:ro`,
        ...(networkName ? ['--network', networkName] : []),
        '--env-file', envFile,
        pgImageTag,
        // ON_ERROR_STOP: psql's default is continue-on-error + exit 0, so a
        // truncated/corrupt dump restored PARTIALLY and reported success —
        // after the original DB was already dropped. Exit 3 on first error
        // (the nonzero-exit rejection below fires) and --single-transaction
        // so a failed restore leaves an empty DB, not a half-restored one.
        'psql', '-h', 'db', '-U', dbUser, '-d', dbName,
        '-v', 'ON_ERROR_STOP=1',
        '--single-transaction',
        '-f', `/restore/${sqlFilename}`,
      ], { env: dockerEnv, cwd: ctx.workDir() });

      const stderr = [];
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.stdout.resume();
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(Buffer.concat(stderr).toString().trim() || `psql exited with code ${code}`));
      });
    }));

    // 4. Copy attachments into stopped app container (docker cp works on stopped containers).
    //    Uses staging + atomic swap inside the container's filesystem.
    if (attachmentsDir) {
      const appContainerId = await run('docker', [
        'compose', ...composeFileArgs, 'ps', '-q', 'app',
      ], ctx.workDir(), { timeout: 10000 }).then(s => s.trim()).catch(() => '');

      if (appContainerId) {
        // Copy bundle attachments into a staging directory
        await run('docker', [
          'cp', `${attachmentsDir}/.`, `${appContainerId}:/app/data/attachments.staging`,
        ], ctx.workDir(), { timeout: 120000 });
      }
    }

  } finally {
    cleanup();
    // 5. Always restart app container (runs alembic upgrade head on startup).
    // The DROP/CREATE DATABASE above also wiped every grant held by the
    // least-privilege `ftm_app` role (the ROLE itself is cluster-level and
    // survives). The backend's boot-time role bootstrap re-applies them on
    // this restart; if it cannot, it falls open to the privileged role and
    // the app still comes up. See apps/node-backend/src/database/appRoleBootstrap.js.
    const env = { ...dockerEnv, PORT: String(ctx.appPort()) };
    await run('docker', [
      'compose', ...composeFileArgs, 'start', 'app',
    ], ctx.workDir(), { timeout: 120000, env }).catch((err) => {
      console.error('Failed to restart app container after bundle restore:', err);
    });

    // 6. Atomically swap attachments.staging → attachments once container is up.
    //    Awaited so a swap failure surfaces to the caller instead of being silently dropped.
    if (attachmentsDir) {
      // A restore boot runs `alembic upgrade head`, which on a large DB can
      // exceed the normal liveness budget. A pollHealth() timeout here must NOT
      // skip the swap (that would strand the restored attachments in .staging
      // forever), so use the larger build budget and swallow a timeout — the
      // swap only needs the container process to be up, not fully migrated.
      try {
        await ctx.pollHealth(ctx.HEALTH_POLL_BUILD_ATTEMPTS);
      } catch (err) {
        console.warn('post-restore health poll did not confirm readiness in time; attempting attachments swap anyway:', err && err.message ? err.message : err);
      }
      const composeArgs_ = composeArgs(ctx.workDir(), ctx.overrideFiles());
      await run('docker', [
        'compose', ...composeArgs_, 'exec', '-T', 'app',
        'sh', '-c',
        // Guard the whole swap on the staging dir existing: only demote the live
        // attachments once the replacement is actually present. Without this, a
        // missing/failed staging copy would move live attachments to .old and
        // then fail to replace them — destroying the attachments dir.
        'if [ -d /app/data/attachments.staging ]; then ' +
        'rm -rf /app/data/attachments.old && ' +
        'mv /app/data/attachments /app/data/attachments.old 2>/dev/null; ' +
        'mv /app/data/attachments.staging /app/data/attachments && ' +
        'rm -rf /app/data/attachments.old; ' +
        'fi',
      ], ctx.workDir(), { timeout: 30000 });
    }
  }

  return { success: true, file: bundlePath, frontendState };
}

// ── Restore helpers ───────────────────────────────────────────────────────────
// Restores a plain-SQL pg_dump file into the running PostgreSQL container.
//
// The backup file is accessed via a bind-mount — it is never copied into the
// container, so there is no size limit and no extra disk usage.
//
// Sequence:
//   1. Stop the app container (disconnect all clients from the DB)
//   2. Terminate remaining DB connections, drop & recreate the database
//   3. Restore via `docker run --rm -v <dir>:/restore <pg-image> psql -f /restore/<file>`
//      — a temporary throwaway container that has direct access to the host file
//   4. Restart the app container (backend reconnects + alembic upgrade head runs)
async function runRestore(sqlFilePath, { passphrase } = {}) {
  if (!sqlFilePath) throw new Error('No backup file specified');
  if (!fs.existsSync(sqlFilePath)) throw new Error(`File not found: ${sqlFilePath}`);

  let restoreSource = sqlFilePath;
  let cleanupRestoreSource = () => {};
  if (await isEncryptedBackupFile(sqlFilePath)) {
    const effectivePassphrase = passphrase || (await getBackupPassphrase());
    if (!effectivePassphrase) throw new Error(ERR_PASSPHRASE_REQUIRED);
    restoreSource = await decryptBackupFileToTemp(sqlFilePath, effectivePassphrase);
    cleanupRestoreSource = () => fs.unlink(restoreSource, () => {});
  }

  let dbUser = 'ftm_user';
  let dbPass = '';
  let dbName = 'financial_transactions';
  try {
    const envContents = await fs.promises.readFile(path.join(ctx.workDir(), '.env'), 'utf8');
    ({ dbUser, dbPass, dbName } = parseDatabaseUrlFromEnv(envContents));
  } catch { /* use defaults */ }

  const composeFileArgs = composeArgs(ctx.workDir(), ctx.overrideFiles());

  // Newer-schema guard (parity with the bundle path): a plain dump taken on a
  // newer install restores cleanly at the psql level, then boot-time
  // `alembic upgrade head` hits the unknown revision and the backend
  // crash-loops with no user-facing message. Refuse before anything is
  // stopped or dropped.
  const dumpHead = await readDumpSchemaHead(restoreSource);
  if (dumpHead) {
    // Same fail-safe as the bundle path: unknown DB head → compare against
    // the local migration chain head rather than skipping the guard.
    const currentHead = await getSchemaHead(composeFileArgs, dbUser, dbName)
      || getLocalMigrationChainHead();
    if (isSchemaRevisionNewer(dumpHead, currentHead)) {
      cleanupRestoreSource();
      throw new Error(
        `BUNDLE_SCHEMA_NEWER: This backup was created on schema revision "${dumpHead}" ` +
        `but this Vision install is at "${currentHead}". ` +
        `Update Vision to a newer version and retry.`
      );
    }
  }

  // 1. Stop the app container (release DB connections)
  await run('docker', [
    'compose', ...composeFileArgs, 'stop', 'app',
  ], ctx.workDir(), { timeout: 60000 });

  try {
    // 2a. Terminate any remaining connections
    await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', 'postgres',
      '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
    ], ctx.workDir(), { timeout: 30000 });

    // 2b. Drop and recreate the database
    await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', 'postgres',
      '-c', `DROP DATABASE IF EXISTS "${dbName}";`,
    ], ctx.workDir(), { timeout: 30000 });

    await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', 'postgres',
      '-c', `CREATE DATABASE "${dbName}" OWNER "${dbUser}";`,
    ], ctx.workDir(), { timeout: 30000 });

    // 3. Restore using a throwaway container that bind-mounts the backup directory.
    //    This avoids any `docker cp` and works for arbitrarily large files.
    //    We need the postgres image name used by the db service.
    const pgImage = await run('docker', [
      'compose', ...composeFileArgs, 'images', '--quiet', 'db',
    ], ctx.workDir(), { timeout: 15000 }).then(s => s.trim()).catch(() => 'postgres:16');

    // Resolve the actual image name (images --quiet gives the ID, we need the tag).
    // Fall back to inspecting the running container.
    const dbContainerName = await run('docker', [
      'compose', ...composeFileArgs, 'ps', '-q', 'db',
    ], ctx.workDir(), { timeout: 10000 }).then(s => s.trim()).catch(() => '');

    let pgImageTag = 'postgres:16';
    if (dbContainerName) {
      pgImageTag = await run('docker', [
        'inspect', '--format', '{{.Config.Image}}', dbContainerName,
      ], ctx.workDir(), { timeout: 10000 }).then(s => s.trim()).catch(() => 'postgres:16');
    }

    // Get the internal Docker network so the throwaway container can reach the db service.
    const networkName = await run('docker', [
      'inspect', '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}', dbContainerName,
    ], ctx.workDir(), { timeout: 10000 }).then(s => s.trim().split('\n')[0]).catch(() => '');

    const hostDir = path.dirname(restoreSource);
    const sqlFilename = path.basename(restoreSource);

    // Stream psql output — no buffering, works for any file size
    await withPgPassEnvFile(dbPass, (envFile) => new Promise((resolve, reject) => {
      const child = spawn('docker', [
        'run', '--rm',
        '-v', `${hostDir}:/restore:ro`,
        ...(networkName ? ['--network', networkName] : []),
        '--env-file', envFile,
        pgImageTag,
        'psql',
        '-h', 'db',
        '-U', dbUser,
        '-d', dbName,
        // Fail fast + all-or-nothing: without ON_ERROR_STOP a partial/corrupt
        // dump restored partially and exited 0 (silent partial financial DB,
        // original already dropped). --single-transaction leaves an empty DB
        // on failure instead of a half-restored one.
        '-v', 'ON_ERROR_STOP=1',
        '--single-transaction',
        '-f', `/restore/${sqlFilename}`,
      ], { env: dockerEnv, cwd: ctx.workDir() });

      const stderr = [];
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      // psql outputs progress to stdout — discard it (we don't need it in memory)
      child.stdout.resume();

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(Buffer.concat(stderr).toString().trim() || `psql exited with code ${code}`));
      });
    }));

  } finally {
    cleanupRestoreSource();
    // 4. Always restart the app container
    const env = { ...dockerEnv, PORT: String(ctx.appPort()) };
    await run('docker', [
      'compose', ...composeFileArgs, 'start', 'app',
    ], ctx.workDir(), { timeout: 120000, env }).catch((err) => {
      console.error('Failed to restart app container after restore:', err);
    });
  }

  return { success: true, file: sqlFilePath };
}

module.exports = {
  init,
  runBundleBackup,
  runBundleRestore,
  runRestore,
};
