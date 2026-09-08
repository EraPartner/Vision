# Vision packaging rules

- Keep versions in root `package.json` and `packaging/electron/package.json` identical.
- Vision desktop packages only the native PostgreSQL 18 runtime. Keep its payload manifest,
  least-privilege grants, backup transport, and isolated data directory synchronized with the
  Electron runtime implementation.
- Preserve Electron isolation: `contextIsolation` on, `nodeIntegration` off, and `sandbox` on.
- Use the `release` skill for release builds and version changes.
