---
name: update-vision-docs
description: Evaluate documentation impact from completed Vision implementation diffs and synchronize the Obsidian knowledge base, PlantUML diagrams, and flow visualizer. Use when a change may alter documented behavior, APIs, architecture, schema, environment or configuration, integrations, security, workflows, packaging, public interfaces, or code locations, and when the user asks to review or update docs. Do not invoke for clearly docs-neutral formatting, tests-only work, generated outputs, or internal refactors unless they expose stale documentation.
---

# Update Vision documentation

The portable workflow in `.agents/skills/update-vision-docs/SKILL.md` is canonical. Read it in full
before making documentation changes, then follow it using Claude Code's available file tools and
skills.

For a substantial documentation update, delegate the documentation-only work to the
`vision-kb-updater` subagent after the implementation diff is stable. Review its output before
final verification and commit. For a small documentation correction, apply the portable workflow
directly.
