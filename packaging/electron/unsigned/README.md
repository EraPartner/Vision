# Vision source launcher bundle

This folder now represents a source-based distribution path for Vision on macOS.
It is meant for trusted/internal distribution where users can run the app from
source using Bun and Vision's private native services, without signed/notarized
Apple binaries.

Contents

- `launch.command` — double-clickable launcher that:
  - installs Bun automatically when missing
  - prepares bundled PostgreSQL 18, the standalone migration runner, and the
    pinned PDF browser when they are missing
  - runs `bun run electron:prod` from the Vision source folder

How to use

1. Ensure you have the Vision source folder on disk (`Vision/` with `package.json`).
2. Place `launch.command` either:
   - inside the `Vision/` repo root, or
   - next to a sibling `Vision/` folder.
3. Double-click `launch.command` in Finder.

Requirements

- macOS (Apple Silicon)
- PostgreSQL 18.6 build files from Postgres.app or Homebrew; the service does
  not need to be started
- Python with the pinned packages in `config/requirements.txt` and
  PyInstaller 6.22.2 for the one-time migration-runner build

Docker Desktop is optional and is used only when `VISION_RUNTIME_MODE=docker`
is selected deliberately.

Security note

- This setup intentionally avoids Apple signing/notarization. Distribute only
  to users and machines you trust.
