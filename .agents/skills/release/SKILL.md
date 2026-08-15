---
name: release
description: Prepare, build, or verify Vision Electron releases and version changes. Use for release cutting, desktop distribution builds, .dmg creation, packaging changes, image publication, or version bumps.
---

# Vision release workflow

Vision ships an Apple Silicon Electron `.dmg` and uses `ghcr.io/erapartner/vision` for its app
image.

```bash
npm run dist
bun run electron:dev
bun run electron:prod
bun run electron:clean
bun run docker:dev
bun run docker:clean
bun run docker:logs
```

- Keep `packaging/electron/resources/docker-compose.yml` aligned with root
  `docker-compose.yml`, including every named volume.
- Keep versions in root and packaging `package.json` files identical.
- Preserve `contextIsolation`, disabled `nodeIntegration`, and Electron sandboxing.
- Run the full release build before claiming the release artifact works. If signing, publication,
  or platform checks are unavailable, state that clearly.
