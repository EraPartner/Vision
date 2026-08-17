# Codex cloud environment

Choose Python 3.12 and Node.js 24 for the environment, ensure Bun is available, and set the setup
command to:

```bash
bash .codex/cloud/setup.sh
```

The setup exports `CODEX_SESSION_ENV=cloud` for its own lifecycle and adds the same export to
`.bashrc` for later shells. It installs the portable global working agreement, Python dependencies,
and Bun lockfile dependencies. Puppeteer's code is installed without downloading Chrome or
`chrome-headless-shell`. PDF tests that use Puppeteer need a separately installed compatible
browser configured through `PUPPETEER_EXECUTABLE_PATH`.

The setup does not create `.env` or provision PostgreSQL. Add disposable test values such as
`DATABASE_URL`, `DATABASE_URL_MIGRATIONS`, and `POSTGRES_PASSWORD` in the cloud environment only
when a task needs database tests. Never use production credentials.

Do not copy the host hooks. They protect the local Mac and use host paths. Run macOS Electron,
Demo-app, Apple Container, firewall, and hardware-backed signing checks in a local session.
