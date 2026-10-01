# TODO

Vision's live implementation queue. Completed findings and earlier planning remain in Git history
and the relevant project docs.

## Queue contract

- `- [ ]` means open. Revalidate the current code before implementing it.
- Remove completed findings after verification; this file is not an archive.
- Put evidence or a blocker on an indented `Tracking:` line. Do not put history in the title.
- Every finding has one owner-sized outcome.
- `🔎 verified-present YYYY-MM-DD` means the issue was reproduced on that date.
- `🔎 partial YYYY-MM-DD` means only the stated remainder is open.
- `🔎 decision-needed YYYY-MM-DD` means implementation waits for a product or data decision.
- `🔎 runtime-unverified YYYY-MM-DD` means source work is complete but a live environment check is
  still required.
- `🔎 needs-GitHub-check YYYY-MM-DD` means the current platform state must be read from GitHub.

Run `bun run todo:list` for the concise queue and `bun run todo:check` for ledger hygiene.

## Findings

### Analysis extension acceptance

The eight extension areas are implemented. Their contracts, limits and supported Excel interchange
are documented in [[docs/features/analysis-workspace|Analysis Workspace]]. The correctness and workspace improvements are implemented and covered by regression tests. The
remaining queue is runtime acceptance; these checks must not be inferred from source tests.

- [ ] **Verify the analysis workbench in native Demo, PostgreSQL and desktop Excel** 🔼
  - Tracking: 🔎 runtime-unverified 2026-10-01. Verify the redesigned Data, Prepare, Calculate and Present workflow, wide formula previews, stale/export guards, per-group row/column expansion, ordered pivot fields and localized values in the rebuilt native Demo. Reconcile closing financial totals, filtered benchmark returns, missing coverage, lookup units and calendar preparation against independent synthetic fixtures. Exercise saved refresh, scenarios, sensitivity and bounded Goal Seek. Check XLSX values/types and Summary results in desktop Excel. The prior installed Demo was exercised (template, formula preview, chart and pivot) and exposed the now-fixed issues; it does not validate the updated build. Rebuild attempted: installer dependency installation failed with EPERM; building from installed pinned dependencies reached the migration runner but macOS denied its semaphore (semctl: Operation not permitted). Disposable PostgreSQL previously failed shared-memory initialization, so full SQL acceptance remains open. Current focused checks pass 112 backend and 60 frontend tests, frontend typecheck, workspace lint (warnings only), locale validation and production frontend build. Source review has no unresolved blocking findings. Native Demo, PostgreSQL and desktop Excel acceptance must still be completed without changing real financial data.
  - ↪ _from: [[docs/features/analysis-workspace|Analysis Workspace]] extension acceptance_
