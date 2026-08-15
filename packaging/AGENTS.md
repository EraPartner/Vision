# Vision packaging rules

- `packaging/electron/resources/docker-compose.yml` is shipped in the app and must mirror the root
  `docker-compose.yml`. Compare both on every compose edit. A missing attachments volume caused
  data loss in v1.0.2.
- Keep versions in root `package.json` and `packaging/electron/package.json` identical.
- Preserve Electron isolation: `contextIsolation` on, `nodeIntegration` off, and `sandbox` on.
- Use the `release` skill for release builds and version changes.
