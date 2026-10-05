# Vision packaging rules

- Keep versions in root `package.json` and `packaging/electron/package.json` identical.
- Vision desktop packages only the native PostgreSQL 18 runtime. Keep its payload manifest,
  least-privilege grants, backup transport, and isolated data directory synchronized with the
  Electron runtime implementation.
- Keep native database and attachment paths inside the application data directory.
- Treat PostgreSQL major version, libc family, collation provider, and data-directory format as
  persistence contracts. Require a verified backup and explicit migration plan before changing
  them.
- Preserve Electron isolation: `contextIsolation` on, `nodeIntegration` off, and `sandbox` on.
- Use the `release` skill for release builds and version changes. Run its checks before claiming
  that an artifact is ready.
