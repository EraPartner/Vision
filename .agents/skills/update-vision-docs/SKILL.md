---
name: update-vision-docs
description: Synchronize the Vision Obsidian knowledge base, PlantUML diagrams, and interactive flow visualizer with implementation changes. Use after behavior, API, architecture, schema, integration, security, workflow, package, route, service, repository, page, hook, store, provider, or other project knowledge changes that affect docs/.
---

# Update Vision documentation

Inspect the implementation diff first. Update only documentation made stale by the change, but
follow every connected surface through indexes, diagrams, backlinks, and the flow visualizer.

## Documentation routing and graph integrity

- Endpoint: update its `docs/api/` page and `docs/reference/api-endpoint-matrix.md`.
- Behavior: update the relevant feature, integration, guide, security, performance, testing, or
  troubleshooting page.
- Schema or environment: update the corresponding reference page.
- Component or hook: update `docs/components/`.
- Architectural decision: add a new ADR from `docs/adr/template.md`; never rewrite an accepted ADR.
- New document: update the relevant index or map-of-content note.

Use `obsidian:obsidian-markdown`. Preserve required frontmatter, wikilinks, embeds, callouts, and
cross-references. Update dates. Prefer existing Dataview patterns over static listings.

Every new or heavily changed note must link to a relevant index and at least one related feature,
API, integration, or guide. Add a useful `## Related` section and reciprocal links where needed.
Avoid orphan notes and ensure frontmatter makes notes appear in expected Dataview views.

## PlantUML diagrams

Treat `docs/diagrams/*.puml` as load-bearing documentation.

| Change | Diagrams |
|---|---|
| Repository | `backend-repository-layer.puml`, `backend-domain-model.puml` |
| Backend service | `backend-service-layer.puml`, `system-architecture.puml` |
| Express route or middleware | `backend-api-layer.puml`, `system-architecture.puml` |
| Table, view, or aggregation | `backend-database-schema.puml`, `backend-domain-model.puml` |
| React page or feature directory | `frontend-pages-routes.puml`, `frontend-component-structure.puml` |
| Hook, context, or store | `frontend-state-management.puml`, `frontend-data-flow.puml` |
| External integration or provider | `system-architecture.puml` and its flow diagram |
| End-to-end workflow | Corresponding sequence or flow diagram |

Embed updated diagrams in the relevant architecture document. For a new diagram, update
`docs/diagrams/index.md` and `docs/architecture/index.md`; link a new flow diagram from its feature.

## Interactive flow visualizer

`docs/flow-visualizer.html` contains JSON in `<script type="application/json" id="flow-data">`.
Update it whenever the same change alters architecture:

- Maintain `components[]` for packages, services, repositories, routes, integrations, and build
  surfaces.
- Maintain `baseEdges[]` for load-bearing dependencies.
- Maintain `flows[]` for workflows, hop order, payloads, and annotations.
- Update moved paths and remove deleted workflows.

Every flow needs `id`, `name`, `category`, `summary`, and ordered steps. Every step needs existing
`from` and `to` IDs plus non-empty `payload` and `annotation`. Cite real code paths in annotations.
Keep component boxes inside the SVG canvas and non-overlapping.

Before finishing, extract and parse the embedded JSON. Verify IDs, bounds, overlaps, payloads, and
annotations. When counts change, update visualizer callouts in `docs/index.md`,
`docs/diagrams/index.md`, `docs/architecture/index.md`, and `docs/features/views.md` where present.

## Completion report

Report documents changed, PlantUML changes or why none were needed, flow-visualizer changes or why
none were needed, index/backlink/Dataview checks, validation, and remaining gaps. Confirm claims
against code and tests; never document intended behavior as implemented.
