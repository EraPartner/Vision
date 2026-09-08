---
name: release
description: Prepare, build, or verify Vision Electron releases and version changes. Use for release cutting, desktop distribution builds, .dmg creation, packaging changes, image publication, or version bumps.
---

# Vision release workflow

Vision ships an Apple Silicon Electron `.dmg` with a bundled native runtime.

```bash
npm run dist
bun run electron:dev
bun run electron:prod
bun run test:electron
bun run native:smoke
```

- Verify the bundled PostgreSQL runtime, migration runner, frontend, backend, and PDF browser.
- Keep native database and attachment paths inside the application data directory.
- Keep versions in root and packaging `package.json` files identical.
- Preserve `contextIsolation`, disabled `nodeIntegration`, and Electron sandboxing.
- Run the full release build before claiming the release artifact works. If signing, publication,
  or platform checks are unavailable, state that clearly.
