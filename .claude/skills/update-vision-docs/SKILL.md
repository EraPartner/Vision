---
name: update-vision-docs
description: Synchronize the Vision Obsidian knowledge base, PlantUML diagrams, and interactive flow visualizer with implementation changes. Use after behavior, API, architecture, schema, integration, security, workflow, package, route, service, repository, page, hook, store, provider, or other project knowledge changes that affect docs/.
---

# Update Vision documentation

The portable workflow in `.agents/skills/update-vision-docs/SKILL.md` is canonical. Read it in full
before making documentation changes, then follow it using Claude Code's available file tools and
skills.

For a substantial documentation update, delegate the documentation-only work to the
`vision-kb-updater` subagent after the implementation diff is ready. Review its output before
committing. For a small documentation correction, apply the portable workflow directly.
