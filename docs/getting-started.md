---
title: Getting Started
type: map-of-content
status: active
date: 2026-03-31
tags: [getting-started, onboarding, moc, new-developer]
description: Map of Content for new developers and AI agents to quickly navigate the Vision knowledge base
aliases: [start here, onboarding, new dev, beginner]
---

# Getting Started with Vision

> [!abstract] Welcome
> This Map of Content (MOC) helps you quickly find what you need in the Vision knowledge base. Follow the path that matches your goal.

## 🆕 I'm a New Developer

### 1. Set Up Your Environment
Start with the [[docs/guides/setup\|Setup Guide]] to get the project running locally.

```
Setup Guide
├── Prerequisites (Node.js, Bun, PostgreSQL)
├── Clone & Install
├── Environment Variables
├── Database Setup
└── Run Development Server
```

### 2. Understand the Architecture
Get a high-level view before diving into code:
- [[docs/architecture/index\|Architecture Overview]] - System diagrams
- [[docs/architecture/backend-architecture\|Backend Architecture]] - Services, repos, API layer
- [[docs/architecture/frontend-architecture\|Frontend Architecture]] - Pages, components, hooks

### 3. Learn the Code Style
- [[docs/guides/contributing\|Contributing Guide]] - Workflow and conventions
- [[AGENTS.md]] - Coding standards and build commands

### 4. Understand Key Features
- [[docs/features/views\|Views & Pages]] - All application pages
- [[docs/features/transactions\|Transactions]] - Core feature
- [[docs/features/portfolio\|Portfolio]] - Investment tracking

## 🔍 I Need to Find Something

### API Endpoints
→ [[docs/api/index\|API Documentation]] - All REST endpoints

### Database Schema
→ [[docs/adr/002-database-schema\|Database Schema ADR]] - Complete table definitions

### Frontend Components
→ [[docs/components/index\|Components Index]] - All React components and hooks

### External Integrations
→ [[docs/integrations/index\|Integrations]] - Bank adapters, price providers, currency conversion

## 🏗️ I'm Making an Architectural Decision

1. Check existing [[docs/adr/index\|Architecture Decisions]]
2. Use the [[docs/adr/template\|ADR Template]]
3. Update relevant docs after implementation

## 🤖 I'm an AI Agent

### Before Making Changes
1. Read relevant [[docs/adr/index\|ADRs]] for context
2. Check [[docs/api/index\|API docs]] for existing endpoints
3. Search the KB using Obsidian MCP tools before reading code

### After Making Changes
1. Update relevant feature/API docs
2. Update UML diagrams if architecture changed
3. Add `[[code links]]` to new files
4. Update frontmatter dates

### Key Patterns
- **Wiki-links**: Use `[[path/to/file]]` format for code references
- **Frontmatter**: Always include `title`, `type`, `date`, `tags`, `description`
- **Callouts**: Use `> [!info]`, `> [!warning]`, `> [!tip]` for emphasis

## 📚 Knowledge Base Navigation

| Area | Link | Description |
|------|------|-------------|
| 🏗️ Decisions | [[docs/adr/index\|ADR Index]] | Architecture decisions |
| 📡 APIs | [[docs/api/index\|API Index]] | REST endpoints |
| 📖 Guides | [[docs/guides/index\|Guides Index]] | How-to guides |
| ⚡ Features | [[docs/features/index\|Features Index]] | Feature docs |
| 🔌 Integrations | [[docs/integrations/index\|Integrations Index]] | External services |
| 🧩 Components | [[docs/components/index\|Components Index]] | React components |
| 📐 Architecture | [[docs/architecture/index\|Architecture Index]] | System diagrams |
| 🚀 Performance | [[docs/performance/index\|Performance Index]] | Optimizations |
| 🧪 Testing | [[docs/testing/index\|Testing Index]] | Test strategies |
| 🌍 i18n | [[docs/i18n/index\|Localization Index]] | Translations |
| 🔒 Security | [[docs/security/index\|Security Index]] | Security docs |

## 📋 Quick Reference

### Build Commands
```bash
bun install           # Install dependencies
bun run dev           # Start dev server
bun run build         # Production build
bun run test          # Run all tests
bun run db:upgrade    # Run database migrations
```

### Key Directories
| Path | Description |
|------|-------------|
| `apps/frontend/src/` | React frontend |
| `apps/node-backend/src/` | Node.js backend |
| `alembic/versions/` | Database migrations |
| `docs/` | This knowledge base |
| `config/` | Shared configuration |
| `i18n/` | Localization files |
