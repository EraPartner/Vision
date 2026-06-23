---
title: ADR 001 - Technology Stack
type: adr
status: Accepted
date: 2026-03-17
tags: [architecture, stack, frontend, backend]
description: Technology stack selection - React, TypeScript, Node.js, PostgreSQL, and Electron
aliases: [tech stack, technology choices, stack selection]
related_code: ["package.json", "apps/frontend/src/", "apps/node-backend/src/", "config/"]
---

# ADR-001: Technology Stack Selection

## Status
Accepted

## Date
2026-03-17

## Context
Vision requires a desktop only financial transaction management application with:
- Desktop app capability (Electron)
- Robust backend for data processing
- PostgreSQL for structured financial data

## Decision

### Frontend
- **React 19** with TypeScript for UI
- **Vite** for build tooling (fast dev, optimized production builds)
- **Tailwind CSS** for styling
- **Radix UI** for accessible primitive components

### Backend
- **Node.js** runtime with **Bun** as package manager and runtime
- **Express** for REST API

### Database
- **PostgreSQL** with Alembic migrations (see ADR-002)

### Desktop
- **Electron** for cross-platform desktop application

### Testing
- **Vitest** for backend unit tests
- **React Testing Library** for frontend component tests

## Consequences

### Positive
- TypeScript provides type safety across full stack
- Bun offers fast installation and execution
- Tailwind + Radix enables rapid UI development
- Electron enables desktop app from web codebase

### Negative
- Multiple technologies to maintain
- Electron adds significant bundle size

## Related
- [[docs/guides/setup|Setup Guide]]
- [[docs/adr/index|All ADRs]]
- [[docs/architecture/backend-architecture|Backend Architecture]]
- [[docs/architecture/frontend-architecture|Frontend Architecture]]
- [[docs/reference/scripts|Scripts Reference]]
