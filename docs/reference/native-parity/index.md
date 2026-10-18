---
title: "Native parity inventory"
type: reference
status: active
date: 2026-10-12
updated: 2026-10-12
tags: [reference, swift-rewrite, native-parity, index, adr-203]
description: "Index of the code-derived inventory of every screen, dialog and user action in the web UI. It is the parity checklist for the Swift rewrite (ADR-204): each row is web today and flips to native when a screen PR ports it."
aliases: [native parity, parity inventory, swift parity checklist]
---

# Native parity inventory

> [!abstract] Purpose
> The Swift rewrite ([[docs/adr/204-vision-native-swift-app-target|ADR-204]]) follows the parity rule: never cut functionality. These pages list every screen, dialog and user action of the React frontend, derived from the code on 2026-10-12 (main `2ba25c9`), each with its source line and English label key. Every screen PR in phase 3 shows where each row lives in SwiftUI and flips its `Status` from `web` to `native`.

## How to read a page

- One page per area. Each screen has its regions, URL state and an action table; each dialog, sheet, popover or menu has its own sub-section with fields and actions.
- `Element` gives the i18n key and its English text from `i18n/source/en.json`. The Dutch text comes from `nl.json`; nothing is retyped.
- `Source` is `apps/frontend/src/<path>:<line>` at the commit above. Lines drift; the key and the component name are the stable anchors.
- `Status` is `web` or `native`. A screen is done when every row of its tables, including its dialogs, is `native` or has an entry under "Deliberate cuts" below.
- "Gaps and unsure" at the end of each page lists what the inventory could not confirm, and where a feature doc disagrees with the code. Those items are marked `unverified` and are not rows.

## Pages

| Page                                                                                                   | Routes                                                                                                     | Screens | Dialogs, sheets, popovers, menus | Action rows |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------: | -------------------------------: | ----------: |
| [[docs/reference/native-parity/shell-and-settings\|App shell, navigation, settings and onboarding]]    | app chrome, Settings dialog, onboarding, 404, Electron menus and bridge                                    |       3 |                               12 |         205 |
| [[docs/reference/native-parity/home-and-statistics\|Home, Statistics and reports]]                     | `/`, `/statistics`                                                                                         |       2 |                               13 |         148 |
| [[docs/reference/native-parity/transactions-and-splits\|Transactions, splits and Who owes you]]        | `/transactions`, `/owes`                                                                                   |       2 |                               29 |         218 |
| [[docs/reference/native-parity/accounts-categories-recipients\|Accounts, categories, payees and tags]] | `/accounts`, `/accounts/:id`, `/categories`, `/recipients`                                                 |       4 |                               25 |         170 |
| [[docs/reference/native-parity/planned-payments\|Planned payments]]                                    | `/planned`                                                                                                 |       1 |                                9 |          66 |
| [[docs/reference/native-parity/imports\|Budgeting CSV import and review]]                              | `/import`, `/import/:batchId/review`                                                                       |       2 |                                9 |          75 |
| [[docs/reference/native-parity/portfolio-holdings\|Portfolio overview and holdings]]                   | `/portfolio`, five asset-class pages, `/portfolio/rebalance`                                               |       8 |                               18 |         144 |
| [[docs/reference/native-parity/portfolio-wealth-tools\|Net worth, brokerage import and portfolio tax]] | `/portfolio/net-worth`, `/portfolio/import`, `/portfolio/import/:batchId/review`, `/portfolio/tax`         |       4 |                               11 |         129 |
| [[docs/reference/native-parity/analysis\|Analysis workspace and monitors]]                             | `/analysis`, `/analysis/monitors`                                                                          |       2 |                                7 |         224 |
| [[docs/reference/native-parity/tax\|Belgian tax]]                                                      | `/tax`                                                                                                     |       1 |                                8 |         117 |
| [[docs/reference/native-parity/research-and-ai-chat\|Research and AI chat]]                            | seven `/research*` routes, `/research/dossiers`, `/ai-chat`                                                |       9 |                               25 |         222 |
| [[docs/reference/native-parity/admin\|Admin and developer tools]]                                      | `/admin`, `/admin/db`, `/admin/db/:table`, `/admin/providers`, `/admin/endpoints`, `/admin/exchange-rates` |       6 |                               13 |          89 |
| **Total**                                                                                              | 40 routes in `appRouteManifest`, one legacy redirect, plus the shell                                       |  **44** |                          **179** |   **1,807** |

Counts are the pages' own. The 44 screens are the 40 manifest routes, the `/portfolio/performance` redirect, and the shell page's app chrome, 404 page and Electron startup error page. Shared components (`VirtualDataTable`, comboboxes, `DatePicker`, `RowMenu`, `ExportDialog`) are inventoried in full on the first page that uses them and referenced from the others.

## Phase 1 exit

[[docs/reference/native-parity/phase-1-exit|The phase 1 exit checklist]] maps each of the shell
page's 205 action rows, its keyboard shortcuts and its bridge methods to the Vision Native code at
the end of phase 1, and counts the gaps that remain for the hand-over
([[docs/adr/205-vision-native-hand-over|ADR-205]], accepted).

## Findings that change the plan

- **The Belgian tax engine runs in the frontend**, not the backend: `apps/frontend/src/lib/belgianTax/` (about 9,500 lines), lazy-loaded by `BelgianTaxProfileContext`. The backend stores the profile and renders the PDF. The rewrite plan assumed a backend service; Tor decided on 2026-10-12 that the engine moves behind a backend OpenAPI operation before the Tax screen goes native (ADR-204 §6).
- **Two routes were missing from [[docs/reference/frontend-routes|Frontend Routes]]**: `/analysis/monitors` and `/research/dossiers`. Both are in `appRouteManifest` and the sidebar; the routes page now lists them.
- **Electron-only surfaces** (application and dock menus, badge, CSV open-with, vibrancy, accent colour, the `electronBackup`, `electronAudit`, `electronUpdater`, `electronServices`, `electronAPI` and `electronRecovery` bridges) are inventoried on the shell page. The updater rows are the one deliberate cut (ADR-204 §5).

## Deliberate cuts

| Rows                                                                                    | Decision                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Shell: Updates section of Settings › About, `electronUpdater` bridge, update menu items | Not ported; the install script is the update path (ADR-204 §5, Tor 2026-10-11). |

## Doc and code conflicts

Each page's "Gaps and unsure" section lists where a feature doc in `docs/features/` disagrees with the code (about 40 items across the twelve pages). They are inventory findings, not fixes; the feature docs are corrected separately. Possible bugs found along the way are collected in the same sections and marked `unverified`.

## Related

- [[docs/adr/204-vision-native-swift-app-target|ADR-204: Vision Native]]
- [[docs/reference/native-parity/phase-1-exit|Native parity: phase 1 exit checklist]]
- [[docs/reference/frontend-routes|Frontend Routes]]
- [[docs/reference/index|Reference index]]
