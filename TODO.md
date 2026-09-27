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

- [ ] **Verify destination Host policy in native and proxy runtimes** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-27. The early global Host guard passes 53 listener-free tests and independent bypass review. Run native health, SPA, and API requests with legitimate localhost/IP authorities and hostile or duplicate Host headers; verify rejection before OPTIONS/body/route effects. Test a proxy preserving its explicitly allowed public host and confirm its own hostname policy when rewriting upstream Host. This sandbox blocks HTTP listeners, so live HTTP/browser and deployed proxy behavior remain unverified.
  - ↪ _from: [[apps/node-backend/src/middleware/hostGuard.js]] current implementation_

- [ ] **Verify planned-execution concurrency on disposable PostgreSQL** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-26. Parent locking, replay, and bounded-series guards are implemented. Service tests pass. Run `bun run test:db tests/plannedExecutionConcurrency.db.test.js` and `bun vitest run tests/routes/plannedTransactions.test.js` from the backend for the HTTP checks. This sandbox rejects PostgreSQL `shmget` and HTTP `listen`; the four DB cases and route suite have not passed here.
  - ↪ _from: [[apps/node-backend/src/services/plannedExecutionService.js]] current implementation_

- [ ] **Verify historical FX fallback against disposable PostgreSQL** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-26. On-or-before index, prefetch, and SQL fallback changes pass focused unit tests. Run `bun run test:db tests/historicalFxFallback.db.test.js`. PostgreSQL startup is blocked by sandbox `shmget`; the two real-database fallback cases have not passed here.
  - ↪ _from: [[apps/node-backend/src/services/currency/rateFetcher.js]] current implementation_


- [ ] **Verify recipient merge races on disposable PostgreSQL** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-27. Ordered participant locks and post-lock target checks pass focused tests and independent review. Run `bun run test:db tests/recipientMergeConcurrency.db.test.js` from the backend. The two database cases cover a deterministic lock race and the opposite serial order; they remain unrun because this sandbox rejects PostgreSQL startup.
  - ↪ _from: [[apps/node-backend/src/services/recipientMergeService.js]] current implementation_

- [ ] **Verify uncategorized totals on disposable PostgreSQL** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-27. Shared count/page filters pass listener-free tests. Run `bun run test:db tests/transactionRepository.db.test.js`. The suite checks filtered and empty-page totals against a hand-counted corpus. Its 63 cases skipped here because PostgreSQL startup is blocked.
  - ↪ _from: [[apps/node-backend/src/repositories/transactionRepository.js]] current implementation_

- [ ] **Verify failed-row savepoint release on disposable PostgreSQL** 🔽
  - Tracking: 🔎 runtime-unverified 2026-09-27. Portfolio trade and cash failures now roll back to and release each savepoint before marking the error; failure/continuation unit tests and independent review pass. Add and run a real-database case forcing an insert failure, checking release and subsequent successful rows in the same chunk. Existing batch rollback tests cover a different contract. PostgreSQL startup is blocked here.
  - ↪ _from: [[apps/node-backend/src/services/portfolioImportPipeline/commit.js]] current implementation_

- [ ] **Define and implement settings save conflict handling** 🔼
  - Tracking: 🔎 verified-present 2026-09-27. `settingsRepository.set` replaces the whole value and browser hydration saves whole settings objects. Concurrent tabs or AI-tool writes can overwrite sibling fields. Define one contract covering field removal, nested values, stale saves, and every writer before adding version checks or field patches; do not silently merge arbitrary JSON.
  - ↪ _from: [[apps/node-backend/src/repositories/settingsRepository.js]] current implementation_

- [ ] **Define job scheduling across restarts and multiple instances** 🔽
  - Tracking: 🔎 decision-needed 2026-09-27. Guards remain process-local and interval schedules restart with the process. Establish whether concurrent server instances are supported and which daily jobs require catch-up after restart, then implement that scheduling contract. Single-process guards alone do not establish distributed exclusion.
  - ↪ _from: [[apps/node-backend/src/startup/warmup.js]] current implementation_

- [ ] **Reproduce forecast model quality against defined benchmarks** 🔽
  - Tracking: 🔎 partial 2026-09-27. July claims about unstandardized fitting, undamped trend, and near-zero percentage-error metrics have not been rerun against current models. Define baseline series and error criteria, reproduce current results, and fix validated failures without changing forecast policy from historical examples alone.
  - ↪ _from: [[apps/node-backend/src/services/calculations/forecast/methods/prophetLite.js]] current implementation_
