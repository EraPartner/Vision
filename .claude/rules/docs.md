---
paths:
  - "docs/**"
---

# docs/ conventions (Obsidian vault)

- YAML frontmatter on every page: `title`, `type`, `date`, `tags`, `description`. Bump dates when editing.
- Internal links are `[[docs/path]]` wikilinks; preserve frontmatter/wikilinks/cross-refs when editing.
- Use the `obsidian:obsidian-markdown` skill for OFM-correct syntax (wikilinks, frontmatter,
  callouts); locate notes with `Grep`/`Glob`. `obsidian:obsidian-cli`/`obsidian:defuddle` are
  host-only (need the `obs` binary, a running Obsidian app, or network) — in the sandbox use
  plain file tools.
