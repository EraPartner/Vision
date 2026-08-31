# Vision packaging rules

- `packaging/electron/resources/docker-compose.yml` is shipped in the app and must mirror the root
  `docker-compose.yml`. Run `bun run check-compose-sync` on every compose edit; the same check gates
  CI and release verification. A missing attachments volume caused data loss in v1.0.2.
- Keep versions in root `package.json` and `packaging/electron/package.json` identical.
- Treat the PostgreSQL image's libc family as part of the persisted-volume format. Never switch an
  existing database volume between Alpine/musl and Debian/glibc images. If a variant migration is
  unavoidable, require a verified backup, validate the target collation/provider, and rebuild the
  database's text indexes with `REINDEX` before serving application traffic.
- Preserve Electron isolation: `contextIsolation` on, `nodeIntegration` off, and `sandbox` on.
- Use the `release` skill for release builds and version changes.
