---
title: ADR-152 - Depth-Agnostic Category Hierarchy
type: adr
status: Accepted
date: 2026-09-19
tags: [adr, categories, migration, compatibility, reporting]
description: Preserve category IDs while replacing the two-part category shape with parent-linked ordered paths.
aliases: [category hierarchy migration, ordered category paths]
---

# ADR-152: Depth-Agnostic Category Hierarchy

## Context

The `GENERAL:DETAIL` pair represented one assignable leaf below a broad group. Category IDs already
appear in transactions, recipient defaults, planned payments, import overrides, saved charts, and
other financial records. Replacing those IDs or interpreting colons in a name as structural
separators would change results or make existing names ambiguous.

## Decision

Migration 0114 adds `categories.parent_id`, `name`, `path_name`, `legacy_compatible`, and
`hierarchy_only`. Each distinct existing `general` becomes a new structural root. Every existing
category retains its ID and becomes that root's child with `name = detail`. The canonical path is
the ordered `category_paths.ids` and `category_paths.names` arrays. `path_name` joins the names for
display only; no hierarchy operation parses it. `category_ancestors` gives each node exactly one
row per ancestor, including itself, for rollups.

The old `general` and `detail` columns remain compatibility aliases. Legacy category create and
update operations keep the old pair and resolve a matching root. The legacy list shows
legacy-compatible rows; the additive `/api/categories/tree` API exposes every node, including
assignable depth-one nodes. A hierarchy rename or move does not rewrite the old alias. Legacy
clients can still find their existing category IDs by the old pair, while modern clients use IDs
and path arrays. New hierarchy nodes have private synthetic legacy aliases to satisfy the old
non-null and unique constraints; clients must not treat those aliases as display labels.
`category_merge_aliases` preserves merged legacy pairs and `category_root_aliases` preserves
renamed, moved, or merged structural-root prefixes, including former root names. Both redirect through later merges and restrict deletion of
their target. Import resolution and merges share a transaction-scoped advisory lock; direct SQL
insertion of a merged pair is rejected rather than silently recreating it. The old PATCH and
DELETE endpoints cannot mutate tree-only nodes or structural roots.

The database rejects self-parentage, sibling-name collisions, and cycles. Mutations reject
inactive or missing parents. Delete is limited to childless nodes; existing foreign-key deletion
semantics determine whether direct assignments become uncategorized. Merge moves children and
direct category references in one transaction. It rejects a target inside the source subtree and
fails atomically on duplicate sibling names or unique reference memberships. An uncategorized
record still has a null effective category; it is not a hidden tree node.

Financial leaf calculations continue to use the existing effective category ID resolution.
Category-ID filters include descendants of a selected ancestor; this changes only selections
of nodes that have children.
Ancestor reporting joins each effective ID to `category_ancestors` once per ancestor. The
version-1 analysis datasets and legacy API remain unchanged. Version-2 transaction and cash-flow
datasets add category path text, ordered name segments, and ordered IDs. The materialized category
views are rebuilt after migration to show the new full path without changing their numeric grain.

## Reversal

The downgrade preserves existing IDs and assignments. It refuses to run after a non-legacy node,
an unrepresentable move or rename, a changed structural root, a merge alias, or a direct root
reference exists.
The operator must resolve those states explicitly before downgrade; the migration does not discard
or silently flatten them. Derived materialized views are recreated by the old application on boot.

## Consequences

- New clients should use path arrays and IDs; displayed colons may occur inside a segment.
- A depth-one node can be assigned directly and can later gain children. Exact-node results and
  ancestor rollups must be labelled separately so a parent amount is not counted twice.
- Legacy aliases can differ from the current path after a hierarchy edit. They are compatibility
  identifiers, not the canonical name.

## Related

- [[docs/features/categories|Categories]]
- [[docs/api/categories|Categories API]]
- [[docs/adr/140-versioned-analysis-datasets|ADR-140]]
- [[docs/adr/index|All ADRs]]
