# Vision documentation rules

These files form an Obsidian knowledge base.

- Keep YAML frontmatter on every vault content page: `title`, `type`, `date`, `tags`, and
  `description`. Repository instruction files such as `docs/AGENTS.md` are not vault content pages.
- Update the date when changing a page.
- Preserve wikilinks, embeds, callouts, and cross-references. Use the
  `obsidian:obsidian-markdown` skill for Obsidian Flavored Markdown when available. Otherwise use
  plain repository file tools and follow the conventions in this file and adjacent notes.
- Use plain repository file tools in the dev container. The Obsidian CLI and Defuddle require host
  applications or network access.
- Keep docs aligned with code, but do not rewrite historical ADRs. Add a superseding ADR.
- Update docs only when the implementation changes a documented fact, contract, workflow,
  architecture relationship, or code location. Do not create documentation churn for tests-only
  changes, formatting, generated files, or behavior-preserving internal refactors.
