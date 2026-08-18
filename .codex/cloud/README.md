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
`.bashrc` for later shells. It installs the portable global working agreement, the Docker CLI and
Compose plugin, Python dependencies, and Bun lockfile dependencies. It then checks the real Docker
daemon with `docker info`. If a daemon is available, `bun run test:db` keeps using its disposable
`postgres:18-alpine` container. Codex cloud does not document a nested Docker daemon as part of the
environment contract, so the setup falls back to native PostgreSQL 18 when only the Docker CLI is
available. The fallback creates only a disposable `vision_test` role and database, writes their
fixed test connection variables to `~/.codex/vision-cloud-test-db.env`, and migrates the database
through the same runner used by CI and application startup.

The maintenance script refreshes Bun and Python dependencies after a cached environment resumes.
It also restarts, verifies, and migrates the native test database when Docker is unavailable. Codex
automatically invalidates its environment cache after setup or maintenance configuration changes;
use **Reset cache** in the environment settings if an older cached image still has the prior setup.

Puppeteer's code is installed without downloading Chrome or `chrome-headless-shell`. PDF tests that
use Puppeteer need a separately installed compatible browser configured through
`PUPPETEER_EXECUTABLE_PATH`.

The setup does not create a repository `.env`. Never add production database credentials to the
cloud environment. If you override `DATABASE_URL` or `TEST_DATABASE_URL`, use only a disposable,
already-migrated test database; `bun run test:db` treats a pre-set URL as caller-managed.

Run `docker info` in a cloud task to see which path is active. A working response means Docker-based
database tests are available. A daemon connection or permission error is expected on runtimes that
use the native PostgreSQL fallback; `bun run test:db` still runs the database-backed suite because
`TEST_DATABASE_URL` is set for later Bash sessions.

Do not copy the host hooks. They protect the local Mac and use host paths. Run macOS Electron,
Demo-app, Apple Container, firewall, and hardware-backed signing checks in a local session.
