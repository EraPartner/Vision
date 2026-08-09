---
title: Session 2026-08-09 — TODO.md backlog orchestration (contract, onboarding, money guards, motion, a11y, fx tiers)
type: session
date: 2026-08-09
tags: [session, backlog, contract-tests, openapi, onboarding, money-formatting, css-motion, accessibility, visual-effects, adr-075]
description: Implementation session on PR #154 — 19 TODO.md findings verified-fixed and stamped across the MSW contract layer, OpenAPI/import contracts, onboarding step order, money-formatter guards (independently verified), the press-feedback transition system, keyboard accessibility, and the ADR-075 static-atmosphere gate; one finding proven look-changing and gated on user sign-off.
---

# Session 2026-08-09 — TODO.md backlog orchestration

Implementation session (branch `claude/vision-backlog-orchestration-szg45z`, PR **#154**).
`TODO.md` is the source of truth — every item below is stamped there with its fix commit;
this note is only the pointer.

## Landed (19 findings, 9 fix commits)

1. **MSW contract fixtures** (`e3f4c54e`) — recipients-merge fixture pinned to the real
   `{primary, merged_ids, reassigned, aliases, patternSuggestion}` shape, settings PUT fixture
   returns the stored row, `ACCOUNT_STUB` split from list-only enrichments (schema now strict).
2. **OpenAPI/import contracts** (`69e5cdcd`) — ai/conversations spec shape, import status codes,
   `/csv/custom` request body, `/csv/stream` response corrected to `text/event-stream`; the
   streaming review path no longer fabricates `total_processed` (the frontend cast was the lie,
   verified against `lib/importProgress.js`).
3. **Onboarding** (`8be788be`) — `categories` step now precedes `bank`/`import` (step-dependency
   audit first: steps are independent, nothing persists an index); shared `isReviewRequired`
   narrowing for the 202 review body.
4. **Money-formatter guards** (`7f5415ff`) — `appSettings` blob validated with zod at hydration
   (dashboard-slice precedent); `formatCurrency` + the string hook degrade like Money/parts on bad
   input. **Independently verified** per the money-path rule: 0 mismatches across 16,632
   valid-input probes; verifier corrected the implementer's corrupt-input delta inventory (all
   benign, default-restoring).
5. **Motion system** (`63b2d24e`) — `.press-feedback` composes with consumer transition lists via
   a non-inheriting `--press-compose` custom property (the finding's preferred longhand split was
   disproven in-browser); buttons/sidebar/tiles got their declared fades back, press curve and
   reduced-motion byte-identical. Slider thumb + topbar title `translate`/`scale` snaps fixed.
6. **Keyboard accessibility** (`0e8d7c34`, `6905de79`, `1eebf923`) — pivot drill-down cells get
   in-cell buttons; skip link + `<nav>` landmark; 14 button-only dialogs converted to real forms
   (4 destructive/wizard cases deliberately skipped); all four line/area/bar/sparkline surfaces
   gained arrow-key point navigation via one shared `useChartKeyboardNav` hook —
   `docs/components/charts.md` had claimed this existed; now it does.
7. **Visual-effects tiers** (`e0811621`) — `fx-static-atmosphere` now freezes ShaderAurora to a
   held frame via a pure `resolveAuroraMode()`, executing [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075]]'s
   recorded mitigation; WebGL-failure fallback and display transitions preserved.
8. **CI** (`01403b96`) — two new HIGH advisories (nanoid, js-yaml) resolved past their fixes via
   overrides; `audit-js.sh` still carries zero accepted-risk ignores.

Also: one finding did not reproduce (BankBalancesWidget keyboard access — already fixed on main
by `d3f7398a`), and several sub-claims were corrected on their stamps rather than silently
absorbed (the rows-override spec entry exists; the four "unpinned" status rows were already
pinned by #149).

## Gated on user sign-off (left open, evidence on the TODO items)

- **CSS aurora blobs pause under live WebGL** — pixel-probed: blob drift changes **41% of
  viewport pixels** through the 60%-opacity shader canvas, so the "redundant work" premise is
  false and the fix is look-changing. Design sketched on the item (`fx-webgl-live` root class).
- **Chart tooltip `glass-thick`** — both listed fixes (opaque / thinner blur) change the look.
- Button hover-lift glide, sidebar pill scale, AdminOverviewPage hover shadow — the known
  lift-glide sign-off family.
- Statistics rolling-window default (the all-time pivot finding's LEFT half).

## Where the queue stands

Session ended on the API usage limit mid-dispatch of the CategoryPivotTable sticky-column blur
consolidation (finding untouched, still open). Tree clean, all 19 stamps pushed. Next session:
that pivot-blur item, the residue groups filed this session (openapi drift, money-formatter,
motion, a11y), and the gated list above once the user decides.
