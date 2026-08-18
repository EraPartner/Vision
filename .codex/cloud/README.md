# Codex cloud environment

Choose Python 3.12 and Node.js 24 for the environment, ensure Bun is available, and set these
commands:

```bash
# Setup script
bash .codex/cloud/setup.sh

# Maintenance script
bash .codex/cloud/maintenance.sh
```

The setup exports `CODEX_SESSION_ENV=cloud` for its own lifecycle and adds the same export to
`.bashrc` for later shells. It installs the portable global working agreement, Python dependencies,
and Bun workspace dependencies. Dependency fingerprints include the relevant runtime version,
requirements, lockfiles, and workspace manifests. Successful fingerprints are stored under
`~/.codex/vision-cloud-state/`, so maintenance skips package managers entirely when those inputs and
their installed directories are unchanged.

The Bun install suppresses the root `prepare` hook. That hook installs the complete Electron
development and packaging toolchain, which cloud cannot use for macOS builds. The backend workspace
already declares `archiver` and `yauzl`, so its backup round-trip tests resolve those packages from
the root workspace without a separate `packaging/electron` install. Puppeteer's code is installed
without downloading Chrome or `chrome-headless-shell`.

After dependency setup, an eight-second `docker info` probe detects an already usable daemon. The
script does not install a Docker client or Compose merely to discover that no daemon exists. When a
daemon is available, `bun run test:db` keeps using its disposable `postgres:18-alpine` container.
Otherwise setup provisions native PostgreSQL 18, creates only a disposable `vision_test` role and
database, writes their fixed connection variables to `~/.codex/vision-cloud-test-db.env`, and
migrates the database through the same runner used by CI and application startup.

On a cached resume, maintenance installs only dependency layers whose fingerprints changed. If the
native database environment file already exists, maintenance refreshes that database directly and
does not repeat the Docker probe. Database migrations use a persistent head cache under
`~/.codex/vision-cloud-state/`. Installation and database lifecycle phases print timestamped
`START`, `DONE`, or `FAILED` messages. Docker probes, downloads, package operations, PostgreSQL
startup, SQL bootstrap, and migrations have explicit deadlines; package installation is
non-interactive and network calls have bounded retries.

Codex automatically invalidates its environment cache after setup or maintenance configuration
changes. Use **Reset cache** in the environment settings if an older cached image still has the
prior setup.

PDF tests that use Puppeteer need a separately installed compatible browser configured through
`PUPPETEER_EXECUTABLE_PATH`.

The setup does not create a repository `.env`. Never add production database credentials to the
cloud environment. If you override `DATABASE_URL` or `TEST_DATABASE_URL`, use only a disposable,
already-migrated test database; `bun run test:db` treats a pre-set URL as caller-managed.

Run `docker info` in a cloud task to see which path is active. A working response means Docker-based
database tests are available. A daemon connection or permission error is expected on runtimes that
use the native PostgreSQL fallback; `bun run test:db` still runs the database-backed suite because
`TEST_DATABASE_URL` is set for later Bash sessions.

The dependency cache behavior has a focused offline test:

```bash
bash .codex/cloud/tests/install-dependencies.test.sh
```

Do not copy the host hooks. They protect the local Mac and use host paths. Run macOS Electron,
Demo-app, Apple Container, firewall, and hardware-backed signing checks in a local session.
