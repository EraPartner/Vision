# Codex cloud environment

Choose Python 3.12 and Node.js 24 for the environment, ensure Bun is available, and set the setup
command to:

```bash
bash .codex/cloud/setup.sh
```

The setup installs the portable global working agreement, Python dependencies, and Bun lockfile
dependencies. It does not create `.env` or provision PostgreSQL. Add disposable test values such as
`DATABASE_URL`, `DATABASE_URL_MIGRATIONS`, and `POSTGRES_PASSWORD` in the cloud environment only
when a task needs database tests. Never use production credentials.

Do not copy the host hooks. They protect the local Mac and use host paths. Run macOS Electron,
Demo-app, Apple Container, firewall, and hardware-backed signing checks in a local session.
