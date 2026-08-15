@AGENTS.md

# Claude Code compatibility

`AGENTS.md` is the canonical project guidance. Keep shared project facts, conventions, commands,
and verification rules there instead of duplicating them in this file.

- Claude-specific project skills are exposed under `.claude/skills/`; their required outcomes must
  stay aligned with the portable skills under `.agents/skills/`.
- Path-scoped compatibility rules live in `.claude/rules/`. The canonical nested guidance remains
  in `docs/AGENTS.md` and `packaging/AGENTS.md`.
- Host-specific Claude setup belongs in the gitignored `CLAUDE.local.md`.
- The optional dev container currently supports Claude Code only. Codex synchronization is deferred
  and documented in the gitignored `AGENTS.local.md`.
