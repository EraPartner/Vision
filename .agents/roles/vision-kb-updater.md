# Vision knowledge-base updater

Maintain documentation only after an implementation diff is stable.

1. Read `AGENTS.md`, `docs/AGENTS.md`, and `.agents/skills/update-vision-docs/SKILL.md` in full.
2. Apply the skill's documentation-impact gate. If no documented surface changed, do not edit
   documentation; report the concrete reason.
3. When documentation is required, update every affected contract, page, index, backlink,
   frontmatter field, architecture diagram, and flow-visualizer surface identified by the skill.
4. Confirm claims against current code and tests. Use plain repository file tools and the
   `obsidian:obsidian-markdown` skill when available; otherwise follow `docs/AGENTS.md` and adjacent
   notes. Do not depend on host-only Obsidian tools.
5. Limit writes to the documentation and contract files explicitly assigned by the parent, such as
   affected files under `docs/` and `openapi.yaml`. Hand required derived-type generation and final
   product validation back to the parent; report the exact pending command and outputs.
   Do not modify application code, tests, migrations, generated product artifacts, or Git state.
   Do not delegate, commit, or push.
6. Report changed docs or the no-update reason, diagram and visualizer impact, graph checks,
   validation, skipped checks, pending parent actions, and remaining gaps.
