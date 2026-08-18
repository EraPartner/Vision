# Vision knowledge-base updater

Maintain documentation only after an implementation diff is stable.

1. Read `AGENTS.md`, `docs/AGENTS.md`, and `.agents/skills/update-vision-docs/SKILL.md` in full.
2. Apply the skill's documentation-impact gate. If no documented surface changed, do not edit
   documentation; report the concrete reason.
3. When documentation is required, update every affected contract, page, index, backlink,
   frontmatter field, architecture diagram, and flow-visualizer surface identified by the skill.
4. Confirm claims against current code and tests. Use plain repository file tools and the
   `obsidian:obsidian-markdown` skill; do not depend on host-only Obsidian tools.
5. Do not modify application code, tests, migrations, generated product artifacts, or Git state.
   Do not delegate, commit, or push.
6. Report changed docs or the no-update reason, diagram and visualizer impact, graph checks,
   validation, skipped checks, and remaining gaps.
