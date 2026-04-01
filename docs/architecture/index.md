---
title: Architecture Diagrams
type: architecture-index
status: active
date: 2026-03-31
tags: [architecture, index, uml, plantuml, diagrams]
description: Index of all UML diagrams for the Vision project - backend, frontend, system, and sequence diagrams
aliases: [architecture, diagrams, UML, system design]
---

# Architecture Diagrams

> [!abstract] Overview
> Complete collection of UML diagrams for the Vision project, generated from source code and maintained alongside it. All diagrams use PlantUML and render in Obsidian.

## Overview

The diagrams are organized into categories:

- [Backend Diagrams](#backend-diagrams)
- [Backend Flow Diagrams](#backend-flow-diagrams)
- [Frontend Diagrams](#frontend-diagrams)
- [System-Wide Diagrams](#system-wide-diagrams)
- [Sequence & State Diagrams](#sequence--state-diagrams)

## Backend Diagrams

Located in `docs/diagrams/`:

| Diagram | Description | File |
|---------|-------------|------|
| Domain Model | Core entities (Transaction, Recipient, Category, etc.) | `backend-domain-model.puml` |
| Repository Layer | Data access repositories | `backend-repository-layer.puml` |
| Service Layer | Business logic services | `backend-service-layer.puml` |
| API Layer | Express routes and middleware | `backend-api-layer.puml` |
| Database Schema | Full ERD with all tables | `backend-database-schema.puml` |

## Backend Flow Diagrams

| Diagram | Description | File |
|---------|-------------|------|
| Import Pipeline | CSV import with bank adapters and deduplication | `import-pipeline.puml` |
| Import Sequence | Detailed import sequence diagram | `import-sequence.puml` |
| Currency Conversion | Exchange rate fetching and caching | `currency-conversion-flow.puml` |
| Price Provider | Investment price updates from external APIs | `price-provider-flow.puml` |
| Recurring Detection | Automatic recurring transaction detection | `recurring-detection-flow.puml` |
| Materialized Views | View refresh on startup and schedules | `materialized-view-flow.puml` |

## Frontend Diagrams

| Diagram | Description | File |
|---------|-------------|------|
| Component Structure | UI components and feature modules | `frontend-component-structure.puml` |
| State Management | React Context + React Query | `frontend-state-management.puml` |
| Data Flow | API client and type system | `frontend-data-flow.puml` |
| Pages & Routes | React Router structure | `frontend-pages-routes.puml` |
| Transaction Creation | Sequence flow for creating transactions | `transaction-creation-sequence.puml` |
| Transaction State | Transaction lifecycle states | `transaction-state.puml` |

## System-Wide Diagrams

| Diagram | Description | File |
|---------|-------------|------|
| API Communication | Frontend ↔ Backend request flow | `api-communication.puml` |
| System Architecture | Complete system overview | `system-architecture.puml` |
| Deployment Architecture | Docker, production, desktop | `deployment-architecture.puml` |
| Use Case | User interactions overview | `use-case-diagram.puml` |

## Sequence & State Diagrams

| Diagram | Description | File |
|---------|-------------|------|
| Import Sequence | Detailed CSV import flow | `import-sequence.puml` |
| Recipient Merge | Recipient merge/unmerge workflow | `recipient-merge-sequence.puml` |
| Transaction Creation | Transaction creation sequence | `transaction-creation-sequence.puml` |
| PlannedTransaction State | PlannedTransaction lifecycle | `planned-transaction-state.puml` |
| Transaction State | Transaction lifecycle states | `transaction-state.puml` |

## Diagram Documentation

Detailed documentation with embedded diagrams:

- [[Backend Architecture]] - Backend-specific diagrams
- [[Frontend Architecture]] - Frontend-specific diagrams

## Regenerating Diagrams

To regenerate diagrams after code changes:

1. Review the relevant source files
2. Update the PlantUML source in the `.puml` file
3. The diagrams in the markdown files will render automatically

## Adding New Diagrams

To add a new diagram:

1. Create a `.puml` file in `docs/diagrams/`
2. Add the PlantUML code to the appropriate documentation file
3. Update this index

## Technology Stack

- **UML Tool**: PlantUML
- **Rendering**: Obsidian with PlantUML plugin
- **Hosting**: Git (version controlled diagrams)
