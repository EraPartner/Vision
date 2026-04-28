---
title: Guides Index
type: guides-index
status: active
date: 2026-03-31
tags: [guides, index, how-to]
description: Setup, development, deployment, and contribution guides for the Vision project
aliases: [guides, how-to, getting started]
---

# Guides

> [!abstract] Overview
> Step-by-step guides for setting up, developing, deploying, and contributing to Vision.

## Available Guides

```dataview
TABLE WITHOUT FILE title AS "Guide", description AS "Description", date AS "Updated"
FROM "docs/guides"
WHERE type = "guide"
SORT title ASC
```

## By Category

### Getting Started
- [[docs/guides/setup\|Setup Guide]] - Local development environment setup
- [[docs/guides/backend-configuration\|Backend Configuration]] - Config, logging, and database utilities

### Development

- [[docs/guides/contributing|Contributing Guide]] - How to contribute to Vision
- [[docs/guides/migrations|Database Migration Guide]] - Creating, running, and managing Alembic migrations
- [[docs/guides/how-to-add-api-endpoint|How to Add an API Endpoint]] - Step-by-step backend API guide
- [[docs/guides/how-to-add-new-page|How to Add a New Page]] - Step-by-step frontend page guide
- [[docs/guides/how-to-add-react-component|How to Add a React Component]] - Step-by-step frontend component guide
- [[docs/guides/debugging|Debugging Guide]] - Error handling, debugging techniques, common failure modes

### Deployment & Release
- [[docs/guides/deployment\|Deployment Guide]] - Production deployment (Docker, Electron)
- [[docs/guides/cicd-pipelines\|CI/CD Pipelines]] - GitHub Actions workflows for testing, building, and releasing (April 2026)

## Troubleshooting

- [[docs/troubleshooting\|Troubleshooting & FAQ]] - Common issues and solutions

## Reference

- [[docs/glossary\|Glossary]] - Key terms and disambiguation
- [[docs/tag-taxonomy\|Tag Taxonomy]] - Controlled vocabulary for KB tags

### KB Maintenance
- [[docs/guides/kb-maintenance\|KB Maintenance Guide]] - How to keep docs in sync with code
- [[docs/guides/ai-agent-kb-usage\|AI Agent KB Usage]] - How AI agents should use MCP tools

## Task-Oriented Navigation

- [[docs/common-tasks\|Common Tasks Quick Reference]] - "I want to X, where do I look?"

## Related Documentation

- [[docs/index\|Knowledge Base Home]] - Main entry point
- [[docs/api/index\|API Documentation]] - REST API reference
- [[docs/architecture/index\|Architecture]] - System diagrams and architecture
