---
paths:
  - "packaging/**"
  - "package.json"
  - "install.sh"
  - "install-demo.sh"
---

# Packaging / Electron rules

- Vision desktop packages only the native PostgreSQL 18 runtime.
- Keep native database and attachment paths inside the application data directory.
- Treat PostgreSQL major version, libc family, collation provider, and data-directory format as
  persistence contracts. Require a verified backup and explicit migration plan before changing
  them.
- Keep root and Electron package versions identical.
- Preserve Electron isolation: `contextIsolation` on, `nodeIntegration` off, and `sandbox` on.
- Run the release skill checks before claiming that an artifact is ready.
