---
name: release
description: Vision release and packaging — building the Electron .dmg, version bumps, publishing the app image. Invoke directly when cutting a release, building a dist, or bumping a version. The edit-time compose/packaging sync rules load automatically from .claude/rules/packaging.md, so this skill is only needed for the release workflow itself.
disable-model-invocation: true
---

# Release / packaging

Vision ships as an Electron `.dmg` (Apple Silicon); the shell starts and supervises a Docker stack
(Postgres + backend). Release image: `ghcr.io/erapartner/vision`.

```bash
npm run dist                 # frontend build, then electron-builder in packaging/electron/
bun run electron:dev | electron:prod | electron:clean
bun run docker:dev | docker:clean | docker:logs
```

## Critical sync rules (caused real data loss before — v1.0.2)

- **`packaging/electron/resources/docker-compose.yml` is baked into the packaged `.app` and MUST
  mirror the root `docker-compose.yml`.** Any named volume added to root must be added there too —
  omitting the attachments volume caused the v1.0.2 data-loss bug. Check this on EVERY compose edit.
- **Version bump touches two files:** root `package.json` and `packaging/electron/package.json`
  must match.
- **Electron security posture:** on any electron/runtime change keep `contextIsolation` on,
  `nodeIntegration` off, `sandbox` on.

Compose files: `docker-compose.yml` (prod-mode local dev) · `docker-compose.dev.yml` (hot-reload) ·
`docker-compose.clean.yml` (clean-slate rebuild) · `packaging/electron/resources/docker-compose.yml`
(packaged copy — keep in sync per above).
