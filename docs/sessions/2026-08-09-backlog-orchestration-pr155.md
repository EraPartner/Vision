---
title: Session 2026-08-09 (second) — TODO.md backlog orchestration (forecast weighting, tax PDF, pagination, clocks, import, errors, recurrence)
type: session
date: 2026-08-09
tags: [session, backlog, forecast, tax-reports, pagination, adr-009, import-pipeline, error-taxonomy, ai-chat, recurrence]
description: Implementation session on PR #155 — 19 TODO.md findings resolved (17 ticked, 2 marked partial) across forecast ensemble weighting, tax PDF sections, tags/categories pagination, migration tooling, the APP_TIMEZONE clock rule, the import pipeline, splits/ai contracts, the error taxonomy, AI tool-call coercion, and the recurrence grammar; money-path fixes were independently adversarially verified; five new findings filed from discoveries.
---

# Session 2026-08-09 (second) — TODO.md backlog orchestration, PR #155

Implementation session (branch `claude/vision-backlog-orchestration-v5lpu8`, PR **#155**).
`TODO.md` is the source of truth — every item is stamped there with its fix commit; this
note is only the pointer.

## Landed (19 findings, 13 fix commits)

1. **Forecast ensemble accuracy weighting** (`718af55a`) — the accuracy store's DB branch
   returned snake_case rows the ensemble's camelCase filter always dropped, so persisted
   accuracy never influenced weights; store now normalizes to one `AccuracyRecord` shape.
2. **Tax PDF sections** (`4843a9f6`, adversarially verified) — six sections read fields
   `fetchTaxData` never produced (always-zero figures, fees-only totals, array-index
   asset-class labels); also fixed the latent 100× `fmtPct` double-scale the zeros hid.
3. **Tags/categories silent truncation at limit=50** (`b28d7d01`) — both list endpoints
   moved to opt-in pagination; spec, generated types, docs updated.
4. **Bare-alembic npm scripts** (`ac3e688e`) — `db-migrate.js` is now a preflighted CLI
   (upgrade/downgrade/stamp/reset); the `db:migrate` name collision resolved; proven live
   on scratch databases.
5. **Two-clock date split** (`91f29ffa`) — `infoRepositoryMonthly` and
   `plannedTransactionRepository` now bind one `todayAppDateString()` reading per call
   (ADR-009); string-concat interval → `make_interval`; 11 tests fail on pre-fix source.
6. **Import unresolved-recipient rows** (`787497d6`) — decided into `status='error'` at
   commit instead of failing the NOT NULL and demoting the chunk to per-row replay.
7. **Form fixes** (`f1b8f1f4`) — PlannedPaymentForm's inert in-flight guard wired;
   MarkAsFiledDialog cancel routed through the reset path.
8. **statementPartition sub-cent residues** (`9bb0bee7`, partial, adversarially verified) —
   residues that round to 0.00 now drop as zero-sum; the mislabelled-account rationale
   stays an open product decision.
9. **Splits/ai spec residuals** (`1d3e3b1c`) — settle/getById re-select via the sibling
   CTE so `amount_paid`/`recipient_name` are truthful; POST bodies, nullability, new AI
   schemas + contract-guard entries.
10. **Portfolio txn dialogs + loading label** (`0467b53c`) — inline field-error pattern
    ported from the money forms; `Loading` aria-label localized across 31 consumers.
11. **Test-infra trio** (`95149fa1`) — shared DB `wipeAll()` helper; validate-locales
    exact-match key matcher (closed the substring hole, unmasked 63 confirmed-dead keys);
    e2e combobox driven through its real popover flow.
12. **Error taxonomy** (`e24c47dd`) — `UpstreamError` 502 / `UpstreamTimeoutError` 504
    added with deliberate prod masking; AI error shim deleted; price-provider throws typed.
13. **AI tool-call coercion** (`4576259c`) — single coercion point in `dispatchTool`;
    persistence stores what the tool saw; pre-dispatch SSE `tool_call` emission preserved
    and pinned.
14. **Recurrence grammar unification** (`85d022fc`) — one shared grammar + string-space
    stepper; 29,232-combo A/B harness proved bit-for-bit preservation.

## Filed, not fixed (new findings in TODO.md)

- Tax-PDF residues group (incl. a **live 100× percent bug** in `belgianRulesSummary.js`
  and the gross-vs-net dividend convention gap).
- Splits spec drift (`pay` body param, bare settle envelopes).
- Fall-back **DST divergence** in Date-space recurrence stepping (discovered by the A/B
  harness; both behaviors pinned, calendar-exactness is a schedule-changing decision).
- Dead-keys finding marked partial with a concrete 63-key confirmed starting list.

## Gated on the user

- The two ⏫ page-recomposition findings (Statistics/Planned/Performance/Forecast scaffold,
  TaxOverviewPage document metaphor) and the enhanced-tier aurora blob pause — all proven
  or presumed look-changing.
- Product decisions: recipient-pivot alias semantics, statementPartition step-1 rationale,
  Ollama TIMEOUT→504 remap, `expandOccurrences` calendar-exactness.
