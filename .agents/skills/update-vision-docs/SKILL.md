---
name: update-vision-docs
description: Evaluate documentation impact from completed Vision implementation diffs and synchronize the Obsidian knowledge base, PlantUML diagrams, and flow visualizer. Use when a change may alter documented behavior, APIs, architecture, schema, environment or configuration, integrations, security, workflows, packaging, public interfaces, or code locations, and when the user asks to review or update docs. Do not invoke for clearly docs-neutral formatting, tests-only work, generated outputs, or internal refactors unless they expose stale documentation.
---

# Update Vision documentation

## Run the decision gate

1. Wait until the implementation diff is stable. Evaluate docs before final verification and
   commit, not before the behavior is known.
2. Inspect the diff and compare changed behavior with existing docs. Treat docs as intent and code
   as current behavior; resolve conflicts explicitly.
3. Classify the change using the table below.
4. Update every affected surface in the same change. If no update is needed, do not edit docs;
   report the reason in the completion report.

| Documentation required                                                         | Usually no documentation update                                                           |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| User-visible behavior or workflow changed                                      | Tests or fixtures only                                                                    |
| API path, operation, input, output, status, error, or rate limit changed       | Formatting, comments, or lint-only edits                                                  |
| Schema, environment, configuration, security, packaging, or operations changed | Generated-output refresh with unchanged source behavior                                   |
| Architecture, ownership, dependency, integration, or end-to-end flow changed   | Internal refactor preserving behavior, contracts, architecture, and documented paths      |
| Documented interface, component role, or code location changed                 | Dependency or lockfile update with no documented compatibility, security, or build effect |
| Existing documentation is inaccurate or records a limitation that was removed  | Bug fix that restores behavior already described accurately                               |

When uncertain, search for references to the changed symbols, paths, endpoints, configuration keys,
and workflows before deciding.

## Route affected documentation

- API contract: update `openapi.yaml`, its `docs/api/` page, and
  `docs/reference/api-endpoint-matrix.md`; state whether it is breaking. Derived types must be
  regenerated before final product validation. A documentation-only worker reports the required
  command and outputs to the parent, which owns generation and final validation; the worker must
  not write generated product artifacts. When using this skill directly, the main agent runs
  `bun run generate:types` and validates the resulting changes itself.
- Behavior: update the relevant feature, integration, guide, security, performance, testing, or
  troubleshooting page.
- Schema, environment, configuration, or packaging: update the matching reference and operational
  guide. Use a new ADR for a significant decision.
- Component, hook, service, or repository: update its docs only when its documented interface, role,
  ownership, relationship, or location changed.
- Architectural decision: add a new ADR from `docs/adr/template.md`; never rewrite an accepted ADR.
- New document: update the relevant index or map-of-content note.

Use `obsidian:obsidian-markdown` when available. Otherwise use plain repository file tools and
follow `docs/AGENTS.md` and adjacent notes. Preserve required frontmatter, wikilinks, embeds,
callouts, and cross-references. Update dates. Prefer existing Dataview patterns over static listings.

Every new or heavily changed note must link to a relevant index and at least one related feature,
API, integration, or guide. Add a useful `## Related` section and reciprocal links where needed.
Avoid orphan notes and ensure frontmatter makes notes appear in expected Dataview views.

## Update diagrams only for structural changes

Do not update PlantUML merely because a file in a mapped layer changed. Update diagrams when a
component is added, removed, renamed, moved, changes ownership, gains or loses a load-bearing
dependency, or changes an end-to-end flow.

| Structural change                               | Diagrams                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| Repository boundary, ownership, or dependency   | `backend-repository-layer.puml`, `backend-domain-model.puml`      |
| Backend service boundary or call relationship   | `backend-service-layer.puml`, `system-architecture.puml`          |
| Express route group, mount, or middleware chain | `backend-api-layer.puml`, `system-architecture.puml`              |
| Table, view, aggregation, or relationship       | `backend-database-schema.puml`, `backend-domain-model.puml`       |
| React page, route, or feature boundary          | `frontend-pages-routes.puml`, `frontend-component-structure.puml` |
| State ownership or data-flow relationship       | `frontend-state-management.puml`, `frontend-data-flow.puml`       |
| External integration or provider relationship   | `system-architecture.puml` and its flow diagram                   |
| End-to-end workflow hop or payload              | Corresponding sequence or flow diagram                            |

Embed updated diagrams in the relevant architecture document. For a new diagram, update
`docs/diagrams/index.md` and `docs/architecture/index.md`; link a new flow diagram from its feature.

## Synchronize the interactive flow visualizer

Update `docs/flow-visualizer.html` only when the same change alters architecture or an end-to-end
flow:

- Maintain `components[]` for added, removed, renamed, or moved architectural surfaces.
- Maintain `baseEdges[]` for changed load-bearing dependencies.
- Maintain `flows[]` for changed workflow hops, payloads, and annotations.

Every flow needs `id`, `name`, `category`, `summary`, and ordered steps. Every step needs existing
`from` and `to` IDs plus non-empty `payload` and `annotation`. Cite real code paths in annotations.
Keep component boxes inside the SVG canvas and non-overlapping.

Before finishing, extract and parse the embedded JSON. Verify IDs, bounds, overlaps, payloads, and
annotations. When counts change, update visualizer callouts in `docs/index.md`,
`docs/diagrams/index.md`, `docs/architecture/index.md`, and `docs/features/views.md` where present.

## Create session notes selectively

Create a session note only when durable context is not captured better in an ADR, feature,
reference, or guide. Suitable cases include multi-stage investigations, cross-module deliveries,
and operational findings needed for later work. Skip session notes for review-only work, routine
fixes or refactors, formatting, generated-output refreshes, and documentation-only maintenance
unless the user asks for one.

## Report completion

Report:

- docs changed, or the reason no update was required;
- PlantUML and flow-visualizer changes, or why neither was needed;
- index, backlink, frontmatter, and Dataview checks;
- validation performed, pending parent generation or validation actions, and remaining gaps.

Confirm claims against code and tests. Never document intended behavior as implemented.
