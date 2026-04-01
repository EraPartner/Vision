---
title: AI Agent KB Usage Guide
type: guide
status: active
date: 2026-03-31
tags: [guide, ai-agent, mcp, obsidian, usage]
description: How AI agents should use the Obsidian MCP tools to effectively navigate and update the Vision knowledge base
aliases: [ai agent guide, mcp usage, obsidian mcp, agent instructions, how to use kb]
---

# AI Agent KB Usage Guide

> [!abstract] Purpose
> This guide tells AI agents how to use the Obsidian MCP tools to navigate, search, and update the Vision knowledge base effectively.

## MCP Tools Available

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `obsidian_simple_search` | Full-text search across all docs | Finding docs by keyword or concept |
| `obsidian_complex_search` | Query by tags, paths, frontmatter | Finding docs by type, tag, or date |
| `obsidian_list_files_in_dir` | List files in a directory | Discovering what docs exist in a section |
| `obsidian_get_file_contents` | Read a specific doc | Getting detailed information from a known doc |
| `obsidian_patch_content` | Insert content into a doc | Updating existing docs |
| `obsidian_append_content` | Add content to end of doc | Adding to lists or creating new sections |
| `obsidian_delete_file` | Remove a doc | Cleaning up obsolete docs |

## Workflow: Before Making Code Changes

1. **Search for existing docs** — Don't assume something doesn't exist
   ```
   obsidian_simple_search: "planned transactions"
   obsidian_complex_search: {"glob": ["docs/api/*.md", {"var": "path"}]}
   ```

2. **Read relevant ADRs** — Understand architectural decisions
   ```
   obsidian_list_files_in_dir: "docs/adr"
   obsidian_get_file_contents: "docs/adr/002-database-schema.md"
   ```

3. **Check API docs** — Verify endpoints don't already exist
   ```
   obsidian_simple_search: "POST /api/transactions"
   ```

4. **Read code patterns** — Follow project conventions
   ```
   obsidian_get_file_contents: "docs/reference/code-patterns.md"
   ```

## Workflow: After Making Code Changes

1. **Identify what changed** — List modified files
2. **Update relevant docs** — Use `obsidian_patch_content` to update sections
3. **Update frontmatter dates** — Set `date: YYYY-MM-DD` to today
4. **Update diagrams** — If architecture changed, update PUML files
5. **Add code links** — Use `[[path/to/file.js]]` format
6. **Update index files** — If new docs added, update the relevant index

## Search Strategies

### Find docs by type
```
obsidian_complex_search: {"and": [{"glob": ["docs/*.md", {"var": "path"}]}, {"=": [{"var": "type"}, "endpoint"]}]}
```

### Find recently updated docs
```
obsidian_complex_search: {"and": [{"glob": ["docs/*.md", {"var": "path"}]}, {">=": [{"var": "date"}, "2026-03-01"]}]}
```

### Find docs by tag
```
obsidian_complex_search: {"and": [{"glob": ["docs/*.md", {"var": "path"}]}, {"=": [{"var": "tags"}, "feature"]}]}
```

### Find all API docs
```
obsidian_list_files_in_dir: "docs/api"
```

### Find docs mentioning a specific file
```
obsidian_simple_search: "transactionRepository.js"
```

## Updating Docs

### Update a section
```
obsidian_patch_content:
  filepath: "docs/api/transactions.md"
  operation: "replace"
  target_type: "heading"
  target: "Endpoints"
  content: "New content here"
```

### Add to a list
```
obsidian_append_content:
  filepath: "docs/api/index.md"
  content: "- [[docs/api/new-endpoint|New Endpoint]]"
```

### Update frontmatter date
```
obsidian_patch_content:
  filepath: "docs/api/transactions.md"
  operation: "replace"
  target_type: "frontmatter"
  target: "date"
  content: "2026-03-31"
```

## Common Mistakes to Avoid

| Mistake | Correct Approach |
|---------|-----------------|
| Creating a doc that already exists | Always search first with `obsidian_simple_search` |
| Using absolute paths in wiki-links | Use `[[docs/api/file]]` format, not full paths |
| Forgetting to update frontmatter date | Always update `date:` when modifying a doc |
| Breaking wiki-links | Verify the target file exists before linking |
| Not checking ADRs before decisions | Read `docs/adr/` before making architectural changes |
| Updating only one related doc | Check for cross-references in index files |

## Key Docs to Always Check

| When... | Check... |
|---------|----------|
| Adding a new API endpoint | [[docs/api/index\|API Index]], [[docs/reference/error-codes\|Error Codes]] |
| Adding a new page | [[docs/reference/frontend-routes\|Frontend Routes]], [[docs/features/views\|Views]] |
| Changing database schema | [[docs/adr/002-database-schema\|Database Schema]], [[docs/reference/migration-dependencies\|Migration Dependencies]] |
| Adding a new service | [[docs/reference/code-patterns\|Code Patterns]], [[docs/architecture/backend-architecture\|Backend Architecture]] |
| Adding a new component | [[docs/components/index\|Components Index]], [[docs/reference/code-patterns\|Code Patterns]] |
| Changing env vars | [[docs/reference/environment-variables\|Environment Variables]] |

## Related

- [[docs/tag-taxonomy\|Tag Taxonomy]] - Controlled vocabulary for tagging
- [[docs/glossary\|Glossary]] - Key terms and disambiguation
- [[docs/guides/how-to-add-api-endpoint\|How to Add an API Endpoint]]
- [[docs/guides/how-to-add-react-component\|How to Add a React Component]]
- [[docs/guides/how-to-add-new-page\|How to Add a New Page]]
