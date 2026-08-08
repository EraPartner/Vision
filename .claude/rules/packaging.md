---
paths:
  - "packaging/**"
  - "docker-compose*.yml"
  - "package.json"
---

# Packaging / Electron / compose rules (caused real data loss before)

- **`packaging/electron/resources/docker-compose.yml` MUST mirror the root `docker-compose.yml`.**
  Any named volume added to root must be added there too — omitting the attachments volume caused
  the v1.0.2 data-loss bug. Check on EVERY compose edit.
- **Version bump touches two files:** root `package.json` and `packaging/electron/package.json`
  must match.
- **Electron security posture:** keep `contextIsolation` on, `nodeIntegration` off, `sandbox` on.
