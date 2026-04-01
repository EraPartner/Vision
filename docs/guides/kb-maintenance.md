---
title: KB Maintenance Guide
type: guide
status: active
date: 2026-03-31
tags: [guide, maintenance, kb-sync, documentation, workflow]
description: How to keep the Vision knowledge base in sync with code changes after every commit
aliases: [kb maintenance, update docs, sync docs, documentation workflow, post-commit]
---

# KB Maintenance Guide

> [!abstract] Purpose
> This guide ensures the knowledge base stays synchronized with the codebase. Every code change should trigger a documentation update.

## When to Update the KB

| Code Change | Update These Docs |
|-------------|-------------------|
| New API endpoint | Create/update `docs/api/<resource>.md`, update `docs/api/index.md` |
| New database table/column | Update `docs/adr/002-database-schema.md`, update `docs/diagrams/backend-database-schema.puml` |
| New migration | Add to `docs/reference/migration-dependencies.md`, add migration reference to relevant feature docs |
| New frontend page | Update `docs/features/views.md`, `docs/reference/frontend-routes.md`, `docs/architecture/frontend-architecture.md` |
| New React component | Update relevant `docs/components/*.md` file |
| New hook | Update `docs/components/hooks.md` |
| New service | Update `docs/architecture/backend-architecture.md`, create/update integration doc |
| New env var | Update `docs/reference/environment-variables.md` |
| New React Query key | Update `docs/reference/react-query-keys.md` |
| Changed error response | Update `docs/reference/error-codes.md` |
| Changed rate limit | Update `docs/reference/error-codes.md`, relevant API doc |
| New bank adapter | Update `docs/integrations/bank-adapters.md` |
| New price provider | Update `docs/integrations/price-providers.md` |

## Maintenance Checklist

After every code change, run through this checklist:

### 1. Identify What Changed
```bash
# See modified files
git diff --name-only HEAD~1..HEAD

# See recent commits
git log --oneline -5
```

### 2. Update Relevant Docs
For each modified file, ask:
- **Is this an API change?** → Update API doc
- **Is this a schema change?** → Update ADR-002 and PUML diagram
- **Is this a new feature?** → Update/create feature doc
- **Is this a new component?** → Update component doc
- **Is this a new service?** → Update architecture doc

### 3. Update Frontmatter
```yaml
# Always update the date when modifying a doc
date: 2026-03-31
```

### 4. Update Code Links
Add `[[path/to/file.js]]` links to any new or modified files:
```markdown
Code links: [[apps/node-backend/src/services/newService.js]]
```

### 5. Update Diagrams (if architecture changed)
- Backend changes → `docs/diagrams/backend-*.puml`
- Frontend changes → `docs/diagrams/frontend-*.puml`
- System changes → `docs/diagrams/system-architecture.puml`

### 6. Update Index Files
If you created a new doc, add it to the relevant index:
- New API doc → `docs/api/index.md`
- New feature doc → `docs/features/index.md`
- New component doc → `docs/components/index.md`
- New guide → `docs/guides/index.md`

## Automated Checks

Run these checks periodically to catch drift:

### Check for Missing Frontmatter
```bash
# Find docs missing tags
rg -l "^---" docs/ | while read f; do head -10 "$f" | grep -q "tags:" || echo "MISSING TAGS: $f"; done
```

### Check for Broken Wiki-Links
```bash
# Find wiki-links to non-existent component docs
rg '\[\[docs/components/[a-z-]+\|' docs/ | while read line; do
  link=$(echo "$line" | grep -o '\[\[docs/components/[^|]*')
  file="${link#[[}.md"
  [ ! -f "$file" ] && echo "BROKEN: $line"
done
```

### Check for Stale Terminology
```bash
# Find deprecated provider names
rg "CoinGecko|Kraken" docs/ --exclude="glossary.md" --exclude="tag-taxonomy.md"
```

### Check for Orphan Docs
```bash
# Find docs not referenced by any other doc
rg -l "^---" docs/ | while read f; do
  name=$(basename "$f" .md)
  count=$(rg -l "$name" docs/ | wc -l)
  [ "$count" -le 1 ] && echo "ORPHAN: $f (referenced $count times)"
done
```

## Common Patterns

### Adding a New API Endpoint
1. Create `docs/api/<resource>.md` using template from `docs/api/transactions.md`
2. Add to `docs/api/index.md` quick reference table
3. Add curl/apiClient examples
4. Add to `docs/reference/error-codes.md` if new error type
5. Update `docs/reference/code-patterns.md` if new pattern

### Adding a New Database Table
1. Add table definition to `docs/adr/002-database-schema.md`
2. Add to `docs/diagrams/backend-database-schema.puml`
3. Add migration reference to relevant feature docs
4. Update `docs/reference/migration-dependencies.md`
5. Update `docs/reference/database-triggers.md` if new triggers

### Adding a New Frontend Page
1. Add to `docs/features/views.md`
2. Add to `docs/reference/frontend-routes.md`
3. Update `docs/architecture/frontend-architecture.md` routes diagram
4. Add to `docs/components/index.md` if new components

## Related

- [[docs/guides/ai-agent-kb-usage|AI Agent KB Usage Guide]]
- [[docs/tag-taxonomy|Tag Taxonomy]]
- [[docs/guides/contributing|Contributing Guide]]
