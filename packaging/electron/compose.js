'use strict';

// ── Docker / Compose orchestration ───────────────────────────────────────────
// Extracted verbatim from main.js (TODO.md Wave W6). Owns the docker CLI env,
// the shared run() exec helper, the Docker daemon/socket probes, and every
// `docker compose` action. Mutable main.js state (appPort, useRepoMode) is
// threaded in via init() getters so the live value is observed at call time,
// exactly as when this code lived in main.js.

const { app } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Context threaded from main.js via init(): { appPort(), useRepoMode(), isDemo() }.
let ctx = {};
function init(context) {
  ctx = context;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// Extend PATH so the docker CLI is found when launched as a macOS .app.
// Whitelist only the env vars that docker/psql/bun actually need — inheriting
// all of process.env leaks secrets (API keys, tokens, etc.) into every
// spawned subprocess.
const DOCKER_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP',
  'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
  'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK',
];
const dockerEnv = (() => {
  const env = {};
  for (const key of DOCKER_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PATH = [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin'].filter(Boolean).join(':');
  return env;
})();

function run(bin, args, cwd, opts = {}) {
  const { env: envOverride, ...rest } = opts;
  const env = envOverride || dockerEnv;
  return new Promise((resolve, reject) => {
    // pg_dump bypasses run() and uses spawn() with stream-to-file — no in-memory
    // buffering. 10 MB is ample for all docker compose command outputs here.
    const maxBuffer = rest.maxBuffer ?? 10 * 1024 * 1024;
    execFile(bin, args, { env, cwd, ...rest, maxBuffer }, (err, stdout, stderr) => {
      if (err) return reject(stderr?.trim() || err.message || String(err));
      resolve(stdout);
    });
  });
}

// ── Docker checks ─────────────────────────────────────────────────────────────
// A single `docker info` call tells us both: if docker isn't on PATH it throws
// ENOENT (not installed); if Docker Desktop isn't running it exits non-zero.
// Returns 'ok' | 'not-installed' | 'not-running'
// Ping the Docker daemon via its Unix socket /_ping endpoint — much faster
// than `docker info` (no CLI spawn overhead, no daemon serialization of full
// engine state). Returns a promise that resolves on HTTP 200 or rejects.
function pingDockerSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { socketPath, path: '/_ping', timeout: 2000 },
      (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else reject(new Error(`/_ping status ${res.statusCode}`));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('socket timeout')); });
  });
}

// Candidate Docker Unix-socket paths, most-specific first. Shared by the daemon
// ping and the container-state probe below.
function dockerSocketCandidates() {
  const homeDir = process.env.HOME || '';
  return [
    process.env.DOCKER_HOST?.replace(/^unix:\/\//, ''),
    path.join(homeDir, '.docker', 'run', 'docker.sock'),
    path.join(homeDir, '.docker', 'desktop', 'docker.sock'),
    '/var/run/docker.sock',
  ].filter(Boolean);
}

// GET a JSON body from the Docker Engine socket. Resolves the parsed body on 200,
// rejects otherwise (or on timeout). Same lightweight pattern as pingDockerSocket.
function dockerSocketGetJson(socketPath, urlPath, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: urlPath, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`status ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('socket timeout')); });
  });
}

// True when the compose `app` service container is already running, checked via
// the Docker socket (~15–20ms) instead of a `docker compose images` CLI spawn
// (~150–250ms). Used to skip the pre-pull image-presence check on warm boots,
// where the image is necessarily present. `projectName` (the compose `name:`)
// scopes the match to THIS install so a sibling demo/app can't answer for us.
// Any failure resolves false → the caller falls back to the CLI check, so a
// wrong answer can only cost the spawn we hoped to save, never correctness
// (a running container guarantees its image is present).
async function isComposeAppRunning(projectName) {
  // The request itself is scoped only by the fixed compose service label — the
  // project name (read from the compose file on disk) is deliberately NOT put
  // into the outbound request; it only filters the returned list in memory, so
  // no file-derived data reaches the network sink.
  const filters = encodeURIComponent(JSON.stringify({
    label: ['com.docker.compose.service=app'],
    status: ['running'],
  }));
  const urlPath = `/containers/json?filters=${filters}`;
  for (const socketPath of dockerSocketCandidates()) {
    try {
      await fs.promises.access(socketPath);
      const list = await dockerSocketGetJson(socketPath, urlPath);
      if (Array.isArray(list) && list.some((c) => !projectName
        || (c && c.Labels && c.Labels['com.docker.compose.project'] === projectName))) {
        return true;
      }
    } catch { /* try next candidate */ }
  }
  return false;
}

// The compose project name is declared via the `name:` top-level key in the
// shipped compose file; Docker labels running containers with it. Read it once,
// synchronously, so isComposeAppRunning() can scope its match. Undefined on any
// read/parse miss (probe then matches by service label alone).
function readComposeProjectName(cwd) {
  try {
    const txt = fs.readFileSync(path.join(cwd, 'docker-compose.yml'), 'utf8');
    const m = txt.match(/^name:\s*(\S+)\s*$/m);
    if (m) return m[1];
  } catch { /* fall through */ }
  return undefined;
}

async function checkDocker(cwd) {
  // Fast path: hit the Docker socket directly — avoids spawning docker CLI
  // and serialising `docker info` output (~6s → <50ms on warm macOS).
  const socketCandidates = dockerSocketCandidates();

  // Race all socket candidates in parallel instead of probing them serially: a
  // dead candidate (missing socket, or the daemon still waking from resource-
  // saver idle) no longer stacks its full 2s timeout ahead of the live one, so
  // the wake path is bounded by the single slowest probe rather than their sum.
  try {
    await Promise.any(socketCandidates.map(async (socketPath) => {
      await fs.promises.access(socketPath);
      await pingDockerSocket(socketPath);
    }));
    return 'ok';
  } catch {
    // No candidate answered (all sockets missing / daemon not responding) —
    // fall through to the docker CLI probe below.
  }

  // Fallback: docker info (distinguishes "not installed" from "not running")
  try {
    await run('docker', ['info'], cwd, { timeout: 5000 });
    return 'ok';
  } catch (err) {
    if (/ENOENT|not found|no such file/i.test(String(err))) return 'not-installed';
    return 'not-running';
  }
}

// Extract the host port an existing compose `app` service is published on, from
// a `docker compose ps --format json` service object. The container's internal
// target port is always 3002. Returns undefined when not published/parseable.
function publishedHostPort(service) {
  const pubs = service?.Publishers || service?.publishers || [];
  for (const p of Array.isArray(pubs) ? pubs : []) {
    const target = Number(p.TargetPort ?? p.targetPort);
    const published = Number(p.PublishedPort ?? p.publishedPort);
    if (target === 3002 && Number.isInteger(published) && published > 0) return published;
  }
  return undefined;
}

// ── Docker Compose actions ────────────────────────────────────────────────────
function composeArgs(cwd, extraFiles = []) {
  // Build -f flags: always start with the base docker-compose.yml, then any overrides.
  const files = [
    path.join(cwd, 'docker-compose.yml'),
    ...extraFiles,
  ];
  return files.flatMap(f => ['-f', f]);
}

function startContainers(cwd, extraFiles = [], skipBuild = false) {
  const args = [
    'compose', ...composeArgs(cwd, extraFiles),
    'up', '-d',
    ...((app.isPackaged && !ctx.useRepoMode()) || skipBuild ? [] : ['--build']),
  ];
  // Inject the resolved port so docker-compose.yml's ${PORT:-3002} interpolation
  // maps the correct host port → container 3002.
  const env = { ...dockerEnv, PORT: String(ctx.appPort()) };
  return run('docker', args, cwd, { timeout: 300000, env });
}

const POSTGRES_IMAGE = 'postgres:18-alpine';
const POSTGRES_PLATFORM = 'linux/amd64';

// A broken postgres:18-alpine ARM64 image was published with empty entrypoint
// scripts (docker-library/postgres#1378). Docker keeps that bad image in its
// local cache indefinitely, and `compose up` does not pull a replacement while
// the tag is already present. Smoke-test the cached image without mounting the
// real database. If it cannot even print its version, refresh the tag and test
// once more. Returning true tells the caller to use `compose up` so an existing
// db container is recreated from the refreshed image instead of being resumed.
async function ensurePostgresImage(cwd, runner = run) {
  const smokeArgs = [
    'run',
    '--rm',
    '--platform',
    POSTGRES_PLATFORM,
    '--pull=never',
    POSTGRES_IMAGE,
    'postgres',
    '--version',
  ];
  try {
    await runner('docker', smokeArgs, cwd, { timeout: 30000 });
    return false;
  } catch (err) {
    console.warn(
      `[postgres-image] cached ${POSTGRES_IMAGE} failed its startup check; pulling a replacement:`,
      err
    );
  }

  await runner(
    'docker',
    ['pull', '--platform', POSTGRES_PLATFORM, POSTGRES_IMAGE],
    cwd,
    { timeout: 300000 }
  );
  await runner('docker', smokeArgs, cwd, { timeout: 30000 });
  return true;
}

// `docker compose ps --format json` emits NDJSON in newer compose versions
// and a JSON array in older ones — handle both.
function parseComposePsOutput(out) {
  if (!out) return [];
  const trimmed = out.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { return []; }
  }
  return trimmed.split('\n')
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// Warm-boot fast path: skip or minimise compose invocation when containers
// already exist. Priority order:
//   1. All running → return immediately (works in all modes)
//   2. All stopped (exited/created) + not a dev rebuild → `compose start`
//   3. Fallback → `compose up [-d [--build]]`
//
// Returns { built: true } when `up --build` actually ran, { built: false } otherwise.
async function composeStartOrUp(cwd, extraFiles = [], skipBuild = false) {
  // The demo uses a locally built, pre-seeded database image. It must never be
  // replaced by the production Postgres tag.
  const databaseImageRefreshed = ctx.isDemo && ctx.isDemo()
    ? false
    : await ensurePostgresImage(cwd);

  // `compose start` keeps the old image ID. After a repair pull, force the `up`
  // path so Compose recreates the db container while preserving its named data
  // volume. No database files are deleted or rewritten by this step.
  if (databaseImageRefreshed) {
    await startContainers(cwd, extraFiles, skipBuild);
    return { built: !skipBuild && (!app.isPackaged || ctx.useRepoMode()) };
  }

  try {
    const psOut = await run(
      'docker',
      ['compose', ...composeArgs(cwd, extraFiles), 'ps', '--all', '--format', 'json'],
      cwd,
      { timeout: 15000 }
    );
    const services = parseComposePsOutput(psOut);
    if (services.length > 0) {
      const getState = s => String(s?.State || s?.state || '').toLowerCase();
      // The `start` fast paths reuse the existing container AS-IS, and
      // `docker compose start` cannot remap a published port. If the existing app
      // container is published on a different host port than the one we resolved
      // (and will poll), reusing it would leave Electron polling a dead port and
      // hanging on "Almost ready…". Only take a fast path when the ports agree;
      // otherwise fall through to `up`, which recreates the container on appPort.
      const appSvc = services.find(s => (s.Service || s.service) === 'app');
      const portMatches = !appSvc || publishedHostPort(appSvc) === ctx.appPort();
      // All already running — skip if packaged (no build possible) or if the
      // skip-build cache confirmed the running image matches the current source.
      // In dev mode without a cache hit, fall through so `compose up --build`
      // can detect whether the running containers have stale code.
      if (portMatches && services.every(s => getState(s) === 'running') && ((app.isPackaged && !ctx.useRepoMode()) || skipBuild)) return { built: false };
      // All in a known stopped state + not a forced dev rebuild → compose start.
      const knownStates = new Set(['running', 'exited', 'created', 'paused']);
      const canUseStart = (app.isPackaged && !ctx.useRepoMode()) || skipBuild;
      if (portMatches && canUseStart && services.every(s => knownStates.has(getState(s)))) {
        const env = { ...dockerEnv, PORT: String(ctx.appPort()) };
        await run(
          'docker',
          ['compose', ...composeArgs(cwd, extraFiles), 'start'],
          cwd,
          { timeout: 60000, env }
        );
        return { built: false };
      }
    }
  } catch (err) {
    console.warn('composeStartOrUp probe failed; falling back to up:', err);
  }
  await startContainers(cwd, extraFiles, skipBuild);
  return { built: !skipBuild && (!app.isPackaged || ctx.useRepoMode()) };
}

// `stop`, not `down`: keeping the stopped containers + network around is what
// lets composeStartOrUp()'s `compose start` fast path fire on the next launch
// (a `down` here forced full container/network recreation on every boot).
// The clean-run flow does its own `down --volumes` at launch, and
// `restart: unless-stopped` treats user-stopped containers as stopped, so
// nothing auto-revives them when the Docker daemon restarts.
function stopContainers(cwd, extraFiles = []) {
  const args = ['compose', ...composeArgs(cwd, extraFiles), 'stop'];
  return run('docker', args, cwd, { timeout: 60000 });
}

// Pull the latest Docker image for both the app and db services (without
// stopping the running containers). Includes `db` so packaged installs also
// receive Postgres minor/security updates — the `postgres:18-alpine` tag pins
// the major, so only in-place-compatible minor bumps are fetched.
// Returns true if a new image layer was pulled, false if already up to date.
async function pullLatestImage(cwd, extraFiles = []) {
  try {
    const output = await run('docker', ['compose', ...composeArgs(cwd, extraFiles), 'pull', 'app', 'db'], cwd, { timeout: 120000 });
    // docker compose pull outputs "Pulled" when a new layer was downloaded
    return /pulled/i.test(output);
  } catch (err) {
    console.warn('docker compose pull failed (non-fatal):', err);
    return false;
  }
}

// Restart only the app container (not the db) to pick up the new image.
async function restartAppContainer(cwd, extraFiles = []) {
  const args = ['compose', ...composeArgs(cwd, extraFiles), 'up', '-d', '--no-deps', 'app'];
  // Same PORT injection as every other compose start path: `up` recreates the
  // container, and without it compose falls back to ${PORT:-3002} — republishing
  // on 3002 (wrong CORS too) while Electron keeps polling the persisted appPort.
  const env = { ...dockerEnv, PORT: String(ctx.appPort()) };
  await run('docker', args, cwd, { timeout: 120000, env });
}

module.exports = {
  init,
  dockerEnv,
  run,
  checkDocker,
  readComposeProjectName,
  isComposeAppRunning,
  composeArgs,
  ensurePostgresImage,
  composeStartOrUp,
  stopContainers,
  pullLatestImage,
  restartAppContainer,
};
