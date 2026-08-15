# Vision documentation rules

These files form an Obsidian knowledge base.

- Keep YAML frontmatter on every page: `title`, `type`, `date`, `tags`, and `description`.
- Update the date when changing a page.
- Preserve wikilinks, embeds, callouts, and cross-references. Use the
  `obsidian:obsidian-markdown` skill for Obsidian Flavored Markdown.
- Use plain repository file tools in the dev container. The Obsidian CLI and Defuddle require host
  applications or network access.
- Keep docs aligned with code, but do not rewrite historical ADRs. Add a superseding ADR.
