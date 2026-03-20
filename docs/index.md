---
title: Vision Project Knowledge Base
type: index
---

# Vision Knowledge Base

Welcome to the Vision project documentation. This knowledge base contains architectural decisions, API documentation, guides, and all project knowledge designed for both humans and AI agents.

## Quick Links

- [[docs/adr/index|Architecture Decisions]] - Major project decisions and their rationale
- [[docs/guides/index|Guides]] - Setup, deployment, and contributing guides
- [[docs/api/index|API Overview]] - REST API endpoints and schemas

## Recent Updates

```dataview
TABLE title, date, type
FROM "docs"
WHERE date >= date(today) - dur(14 days)
SORT date DESC
LIMIT 10
```

## Knowledge Areas

| Area | Description |
|------|-------------|
| [[docs/adr/index|Architecture]] | ADRs - Major design decisions |
| [[docs/api/index|API]] | REST API endpoints and schemas |
| [[docs/guides/index|Guides]] | Setup, development, deployment guides |
| [[docs/features/index|Features]] | Feature documentation (Portfolio, Tax, etc.) |
| [[docs/integrations/index|Integrations]] | External services, bank adapters |
| [[docs/i18n/index|Localization]] | Internationalization and translations |
| [[docs/security/index|Security]] | Security policies and practices |
| [[docs/performance/index|Performance]] | Performance optimizations |

## Project Overview

Vision is a comprehensive **financial transaction management application** supporting:

- **Transactions**: Income/expense tracking with categories and recipients
- **Planned Transactions**: Future scheduled and recurring payments
- **Portfolio**: Stocks, crypto, real estate, savings tracking
- **Tax**: Belgian tax profile and deduction tracking
- **Imports**: CSV bank statement imports with deduplication
- **Multi-workspace**: Support for multiple workspaces/users

### Tech Stack

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS + Radix UI
- **Backend**: Node.js (Bun) + Express
- **Database**: PostgreSQL with Alembic migrations
- **Desktop**: Electron
- **Testing**: Vitest + React Testing Library

## Contributing

AI agents should:
1. **Read before writing** - Check existing docs before adding new content
2. **Use ADRs for decisions** - Document significant design choices in `docs/adr/`
3. **Update relevant docs** - Keep API, features, and guides docs in sync with code
4. **Use templates** - Start new documents from templates in each section
