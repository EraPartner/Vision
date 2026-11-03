# Vision packaging rules

- Keep versions in root `package.json` and `packaging/electron/package.json` identical.
- Vision desktop ships no database server: the backend opens one SQLite file in-process through
  the bundled Bun and the system SQLite (3.39.0 or later, ADR-263). Keep the runtime manifest, the
  database-file tool (`tools/db-file.js`), the backup transport, and the isolated data directory
  synchronized with the Electron runtime implementation.
- Keep native database and attachment paths inside the application data directory.
- Treat the SQLite file format and minimum version, the storage types and canonical value forms
  in `docs/reference/sqlite-sql-dialect.md`, the migration ledger, and the database directory
  layout as persistence contracts. Require a verified backup and explicit migration plan before
  changing them.
- Preserve Electron isolation: `contextIsolation` on, `nodeIntegration` off, and `sandbox` on.
- Use the `release` skill for release builds and version changes. Run its checks before claiming
  that an artifact is ready.
