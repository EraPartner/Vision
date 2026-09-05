# Codex cloud environment

Choose Python 3.12 and Node.js 24 for the environment and set these commands:

```bash
# Setup script
bash .codex/cloud/setup.sh

# Maintenance script
bash .codex/cloud/maintenance.sh
```

Create or select this environment for the GitHub-connected Vision repository in Codex cloud
settings when the automatic pull-request lifecycle is required. The repository setup script cannot
create that platform connection or expose the post-task **Open pull request** control. A task that
does not receive those capabilities still finishes portable implementation and review, then reports
the exact platform handoff it is waiting for.

The setup exports `CODEX_SESSION_ENV=cloud` for its own lifecycle and adds the same export to
`.bashrc` for later shells. It installs the portable global working agreement, the pinned Bun
runtime, Python dependencies, and Bun workspace dependencies. Python uses the exact, hash-verified
`config/requirements.txt` compiled from `config/requirements.in`. Dependency fingerprints include
the relevant runtime version, requirement input, lockfiles, and workspace manifests. Successful
fingerprints are stored under `~/.codex/vision-cloud-state/`, so maintenance skips package managers
entirely when those inputs and their installed directories are unchanged.

The PostgreSQL adapter uses the prebuilt `psycopg2-binary` distribution. Cloud pip accepts only a
published wheel for that package, so setup never spends its startup budget compiling `psycopg2`
from source. An unsupported Python or platform combination fails promptly instead.

Cloud uses the same Bun 1.3.14 version as CI and the devcontainer. A discovered Bun command is
accepted only when `bun --version` returns 1.3.14 within ten seconds. Otherwise setup downloads the
release with the same SHA-256 checksums used by the devcontainer into
`~/.codex/vision-cloud-bin/` and persists that directory on `PATH` through
`~/.codex/vision-cloud-toolchain.env`. This avoids spending an unbounded part of the cloud startup
deadline on a lazy or incompatible preinstalled Bun command. If the GitHub release asset is
unavailable, setup installs the same exact version from Bun's official platform package on npm,
with lifecycle scripts disabled. The fallback is bound to the public npm registry and a reviewed
SHA-512 Subresource Integrity value in a temporary package lock. Setup also verifies the installed
runtime version before using it.

pip, Bun, and their dependency lifecycle processes run with a sanitized environment. They receive
only `HOME`, `PATH`, `CODEX_SESSION_ENV`, and standard proxy or certificate variables; other cloud
setup secrets are not exposed to package code.

The Bun install suppresses the root `prepare` hook. That hook installs the complete Electron
development and packaging toolchain, which cloud cannot use for macOS builds. The backend workspace
already declares `archiver` and `yauzl`, so its backup round-trip tests resolve those packages from
the root workspace without a separate `packaging/electron` install. Puppeteer's code is installed
without downloading Chrome or `chrome-headless-shell`.

Before dependency setup, an eight-second `docker info` probe detects an already usable daemon. The
script does not install a Docker client or Compose merely to discover that no daemon exists. When a
daemon is available, `bun run test:db` keeps using its disposable `postgres:18-alpine` container.
Otherwise setup installs the native PostgreSQL 18 packages before the Python and Bun dependencies,
so the bounded system-package phase receives the cloud startup budget first. Package installation
disables `dpkg` pseudo-terminal progress, emits a heartbeat every 30 seconds, and does not create a
cluster from the package maintainer script. After project dependencies are ready, setup explicitly
creates and starts the cluster, then creates only a disposable `vision_test` role and database. The
role is not a superuser and cannot bypass row security. It owns the disposable database and has
`CREATEDB` because three migration suites create isolated scratch databases. It has `CREATEROLE`
because the role-bootstrap suite verifies role creation, grants, default privileges, idempotency,
and degraded behavior with a separate restricted role. The active `pg_trgm` and `pgcrypto`
migrations use PostgreSQL trusted extensions, so database ownership is sufficient for those two.
Migration 0095 also needs `pg_stat_statements`, which is not trusted. Provisioning preserves
existing preloaded libraries, adds query statistics when absent, and restarts the managed cluster
only when needed. After each schema reset, a fixed local administrator connection recreates this
extension before migrations run as `vision_test`; the test role stays `NOSUPERUSER`. Reset now
requires root or non-interactive sudo before making any schema changes. Setup writes
fixed connection variables to `~/.codex/vision-cloud-test-db.env`, drops and rebuilds the
disposable schema, and migrates it through the same runner used by CI and application startup.

On a cached resume, maintenance installs only dependency layers whose fingerprints changed. If the
native database environment file already exists, maintenance resets that database directly and
does not repeat the Docker probe. `bun run test:db` also resets this one fixed managed database
before every suite, so rows from an interrupted or prior task cannot survive into the next run.
Caller-supplied database URLs remain caller-managed and are never reset. Database migrations use a
persistent head cache under
`~/.codex/vision-cloud-state/`. Installation and database lifecycle phases print timestamped
`START`, `WAIT`, `DONE`, or `FAILED` messages. Setup merges standard error into standard output
before the first marker so package-manager output and lifecycle markers retain execution order.
System-package commands use `timeout --foreground` so `apt-get` and `dpkg` retain normal access to
the setup terminal instead of being suspended in a separate process group. Long-running commands
still execute synchronously; only their heartbeat timer runs in the background.
PostgreSQL cluster creation and server startup are separate lifecycle steps. Before
`pg_ctlcluster` daemonizes the server, its launch wrapper closes every inherited file descriptor
above standard input, output, and error. The running server therefore cannot retain a private
Codex setup descriptor and keep the completed setup session open.
Dependency-fingerprint writes are explicit lifecycle steps. Docker probes, downloads, package
operations, PostgreSQL startup, SQL bootstrap, and migrations have explicit deadlines; package
installation is non-interactive and network calls have bounded retries. The package-index step
stops after two minutes. PostgreSQL package-support and PostgreSQL 18 installation each stop after
five minutes. These deadlines reserve startup time for project dependency installation instead of
allowing one silent system-package command to consume the entire cloud deadline. The pinned Bun
download stops after two minutes, Bun runtime resolution stops after fifteen seconds, and the
workspace install emits a heartbeat every 30 seconds and stops after seven minutes.

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
bash .codex/cloud/tests/install-bun.test.sh
bash .codex/cloud/tests/install-dependencies.test.sh
bash .codex/cloud/tests/provision-test-db.test.sh
bash .codex/cloud/tests/reset-test-db.test.sh
```

After changing Python dependency floors, regenerate the reviewed lock on Python 3.12:

```bash
uv pip compile config/requirements.in --output-file config/requirements.txt \
  --generate-hashes --python-version 3.12 --universal
```

Do not copy the host hooks. They protect the local Mac and use host paths. Run macOS Electron,
Demo-app, Apple Container, firewall, and hardware-backed signing checks in a local session.

## Pull request lifecycle

Use the post-task platform-managed **Open pull request** action to create a pull request. It does not
need to be exposed to the running agent as a terminal command, MCP resource, or `make_pr` tool. A
pull-request-linked cloud task may inspect comments and checks, make in-scope follow-up changes, and
let the connected GitHub integration update the same branch. When the user explicitly asks to
merge, the integration may do so only after required checks and approvals pass and no blocking
review remains. Never use an admin bypass or directly update a protected branch.
