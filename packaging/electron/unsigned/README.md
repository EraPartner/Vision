# Vision source launcher bundle

This folder now represents a source-based distribution path for Vision on macOS.
It is meant for trusted/internal distribution where users can run the app from
source using Bun + Docker, without signed/notarized Apple binaries.

Contents
- `launch.command` — double-clickable launcher that:
  - verifies Docker is present and opens Docker Desktop
  - installs Bun automatically when missing
  - runs `bun run electron:prod` from the Vision source folder

How to use
1. Ensure you have the Vision source folder on disk (`Vision/` with `package.json`).
2. Place `launch.command` either:
   - inside the `Vision/` repo root, or
   - next to a sibling `Vision/` folder.
3. Double-click `launch.command` in Finder.

Requirements
- macOS (Apple Silicon)
- Docker Desktop installed

Security note
- This setup intentionally avoids Apple signing/notarization. Distribute only
  to users and machines you trust.
