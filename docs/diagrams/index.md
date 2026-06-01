---
title: Diagrams Index
type: reference
status: active
date: 2026-04-02
tags: [diagrams, index, plantuml, uml, reference]
description: Complete index of all PlantUML diagrams in Vision - organized by category with descriptions and use cases
aliases: [diagram index, UML diagrams, plantuml diagrams]
---

# Diagrams Index

> [!abstract] Overview
> This index provides quick access to all PlantUML diagrams in the Vision knowledge base. Diagrams are organized by system layer and purpose. Use this to find the right diagram for your task.

## Backend Diagrams

### Domain & Architecture

| Diagram | File | Description | Use Case |
|---------|------|-------------|----------|
| [[docs/diagrams/backend-domain-model.puml|Domain Model]] | `backend-domain-model.puml` | Core entities (Transaction, Recipient, Category, etc.) | Understanding domain |
| [[docs/diagrams/backend-repository-layer.puml|Repository Layer]] | `backend-repository-layer.puml` | Data access repositories | Understanding data layer |
| [[docs/diagrams/backend-service-layer.puml|Service Layer]] | `backend-service-layer.puml` | Business logic services | Understanding business logic |
| [[docs/diagrams/backend-api-layer.puml|API Layer]] | `backend-api-layer.puml` | Express routes and middleware | Understanding API structure |
| [[docs/diagrams/backend-database-schema.puml|Database Schema]] | `backend-database-schema.puml` | Full ERD with all tables | Database design |

### Backend Flow Diagrams

| Diagram | File | Description | Use Case |
|---------|------|-------------|----------|
| [[docs/diagrams/import-pipeline.puml|Import Pipeline]] | `import-pipeline.puml` | CSV import with bank adapters and deduplication | Understanding import flow |
| [[docs/diagrams/import-sequence.puml|Import Sequence]] | `import-sequence.puml` | Detailed import sequence | Debugging imports |
| [[docs/diagrams/currency-conversion-flow.puml|Currency Conversion]] | `currency-conversion-flow.puml` | Exchange rate fetching and caching | Understanding currency |
| [[docs/diagrams/price-provider-flow.puml|Price Provider]] | `price-provider-flow.puml` | Investment price updates | Understanding price feeds |
| [[docs/diagrams/recurring-detection-flow.puml|Recurring Detection]] | `recurring-detection-flow.puml` | Automatic recurring detection | Understanding detection |
| [[docs/diagrams/materialized-view-flow.puml|Materialized Views]] | `materialized-view-flow.puml` | View refresh strategy | Performance optimization |
| [[docs/diagrams/ai-chat-tool-loop.puml|AI Chat Tool Loop]] | `ai-chat-tool-loop.puml` | Ollama tool-call loop with repository dispatch | Understanding AI chat |
| [[docs/diagrams/backup-aead-encryption.puml|Backup AEAD Encryption]] | `backup-aead-encryption.puml` | AES-256-GCM v2 bundle create + restore | Understanding backup format |
| [[docs/diagrams/dev-observability-flow.puml|Dev Observability]] | `dev-observability-flow.puml` | API event bus → ring buffer → Inspector | Frontend internals |

## Frontend Diagrams

### Architecture

| Diagram | File | Description | Use Case |
|---------|------|-------------|----------|
| [[docs/diagrams/frontend-component-structure.puml|Component Structure]] | `frontend-component-structure.puml` | UI components and feature modules | Component overview |
| [[docs/diagrams/frontend-state-management.puml|State Management]] | `frontend-state-management.puml` | React Context + React Query | Understanding state |
| [[docs/diagrams/frontend-data-flow.puml|Data Flow]] | `frontend-data-flow.puml` | API client and type system | Understanding data flow |
| [[docs/diagrams/frontend-pages-routes.puml|pages & Routes]] | `frontend-pages-routes.puml` | React Router structure | Understanding routing |

### Sequence & State

| Diagram | File | Description | Use Case |
|---------|------|-------------|----------|
| [[docs/diagrams/transaction-creation-sequence.puml|Transaction Creation]] | `transaction-creation-sequence.puml` | Transaction creation flow | Understanding creation |
| [[docs/diagrams/transaction-state.puml|Transaction State]] | `transaction-state.puml` | Transaction lifecycle states | Understanding states |
| [[docs/diagrams/planned-transaction-state.puml|PlannedTransaction State]] | `planned-transaction-state.puml` | PlannedTransaction lifecycle | Understanding planning |

## System-Wide Diagrams

| Diagram | File | Description | Use Case |
|---------|------|-------------|----------|
| [[docs/diagrams/api-communication.puml|API Communication]] | `api-communication.puml` | Frontend ↔ Backend request flow | System overview |
| [[docs/diagrams/system-architecture.puml|System Architecture]] | `system-architecture.puml` | Complete system overview | Architecture docs |
| [[docs/diagrams/deployment-architecture.puml|Deployment]] | `deployment-architecture.puml` | Docker, production, desktop | Deployment planning |
| [[docs/diagrams/use-case-diagram.puml|Use Case]] | `use-case-diagram.puml` | User interactions overview | Feature overview |

## Special-Purpose Diagrams

| Diagram | File | Description | Use Case |
|---------|------|-------------|----------|
| [[docs/diagrams/recipient-merge-sequence.puml|Recipient Merge]] | `recipient-merge-sequence.puml` | Recipient merge workflow | Understanding merges |

## Interactive Flow Visualizer

A single-page HTML companion to these PlantUML diagrams — click a flow on the left, see the path light up, step through it, and read the payload + annotation at each hop.

- **File:** `docs/flow-visualizer.html` — open it directly in any browser (no build step, no network calls).
- **Coverage:** 51 components / 21 flows including transactions, imports, portfolio, AI chat, backup, admin, build/release, dev observability, sign-in, custom CSV parsers, cashflow forecast, app update.
- **Extending:** edit the JSON block at the bottom of the HTML (schema documented inline).
- **Shortcuts:** ←/→ step, Space play, R restart, A show all, Esc clear.

## Embedded in Documentation

These diagrams are embedded in the markdown files and rendered directly:

- [[docs/architecture/backend-architecture|Backend Architecture]] - Contains Domain, Repository, Service, API, Schema diagrams
- [[docs/architecture/frontend-architecture|Frontend Architecture]] - Contains Component, State, Data Flow, Routes diagrams
- [[docs/architecture/deep-dive|Architecture Deep Dive]] - Contains system topology diagram
- [[docs/architecture/trade-offs|System Trade-offs]] - Contains comparison diagrams

## Generating Diagrams

To regenerate diagrams after code changes:

1. Review the relevant source files
2. Update the PlantUML source in the `.puml` file
3. The diagrams in the markdown files will render automatically

See [[docs/architecture/index|Architecture Index]] for details.

## Related

- [[docs/architecture/index|Architecture Documentation]]
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/guides/kb-maintenance|KB Maintenance Guide]]