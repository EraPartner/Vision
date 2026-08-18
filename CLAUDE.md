@AGENTS.md

# Claude Code compatibility

`AGENTS.md` is the canonical project guidance. Keep shared project facts, conventions, commands,
and verification rules there instead of duplicating them in this file.

- Claude-specific project skills are exposed under `.claude/skills/`; their required outcomes must
  stay aligned with the portable skills under `.agents/skills/`.
- Path-scoped compatibility rules live in `.claude/rules/`. The canonical nested guidance remains
  in `docs/AGENTS.md` and `packaging/AGENTS.md`.
- Host-specific Claude setup belongs in the gitignored `CLAUDE.local.md`.
- The optional dev container supports both Claude Code and Codex through separate launchers and
  isolated provider state. See `.devcontainer/README.md` for login and lifecycle details.
