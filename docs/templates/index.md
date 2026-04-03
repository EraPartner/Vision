---
title: Documentation Templates
type: index
status: active
date: 2026-04-02
tags: [templates, index, documentation, guide]
description: Templates for creating new documentation in the Vision knowledge base
aliases: [template, templates, new doc, create doc]
---

# Documentation Templates

> [!abstract] Overview
> Use these templates when creating new documentation for Vision. Each template includes the required frontmatter, structure, and sections for consistency.

## Available Templates

| Template | Use For | Location |
|----------|---------|----------|
| [[docs/adr/template|ADR Template]] | Architecture Decision Records | `docs/adr/template.md` |
| [[docs/templates/api-endpoint|API Endpoint]] | New REST API endpoints | `docs/templates/api-endpoint.md` |
| [[docs/templates/feature|Feature]] | New feature documentation | `docs/templates/feature.md` |
| [[docs/templates/component|Component]] | React component docs | `docs/templates/component.md` |
| [[docs/templates/guide|Guide]] | How-to guides | `docs/templates/guide.md` |
| [[docs/templates/hook|Hook Template]] | React custom hooks | `docs/templates/hook.md` |

## Template Usage

### Frontmatter Required Fields

Every new document MUST include:

```yaml
---
title: {Document Title}
type: {endpoint|feature|component|guide|adr|reference}
status: {active|draft|deprecated}
date: {YYYY-MM-DD}
tags: [tag1, tag2, tag3]
description: {Brief description (max 200 chars)}
aliases: [alias1, alias2]
related_code: ["path/to/code/file.js"]
---
```

### Content Structure

1. **Title** — H1 heading matching frontmatter title
2. **Overview** — `> [!abstract]` callout with one-sentence summary
3. **Body** — Detailed content with sections
4. **Related** — Links to related documentation

### Wiki-Links Format

- Code links: `[[apps/node-backend/src/routes/file.js]]`
- Doc links: `[[docs/api/index|API Index]]`
- Diagrams: `[[docs/diagrams/diagram.puml]]`

## Tag Taxonomy Reference

See [[docs/tag-taxonomy|Tag Taxonomy]] for the controlled vocabulary.

## Related

- [[docs/guides/kb-maintenance|KB Maintenance Guide]]
- [[docs/tag-taxonomy|Tag Taxonomy]]
- [[docs/guides/ai-agent-kb-usage|AI Agent KB Usage]]