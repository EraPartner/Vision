---
title: Codebase audit implementation delivery
type: testing
status: active
date: 2026-10-19
tags: [audit, implementation, verification, recovery, performance]
description: Implementation ledger for the October 2026 audit and the user-authorized waiver of further optional live acceptance checks.
---

# Codebase audit implementation delivery

On 2026-10-13 the user asked to finish the remaining implementation without further verification.
This changes the completion boundary for this delivery: implementation and essential code checks
are recorded separately from optional live acceptance. A removed TODO entry does not mean an
unexecuted database, browser, native-app or performance check passed. This waiver applies to this
audit delivery; it does not change the repository's general testing policy.

The original native audit warning has not been reproduced. Session recovery, reason-specific
notifications and clearing recovered warnings are implemented, but the original installation's
cause is still unconfirmed. No keys, receipts or trust anchors were reset and no existing database
was enrolled automatically. Belgian tax correctness and household/multiple-activity support remain
outside this delivery. The filing workflow changes do not establish tax-rule correctness.

## Implementation ledger

All 40 audit implementations, both walkthrough remediations and the selective test cleanup are
delivered. TODO retains only the separately excluded Belgian tax correctness/household item.
Completion here means the implementation boundary authorized by the user, not successful live
acceptance or confirmed reproduction of the original native warning.

| Audit | Outcome | Delivered implementation | Contract |
| --- | --- | --- | --- |
| 01 | Planned-payment currency | Currency is normalized and compared in manual clearing, suggestions, automatic matching and import inputs. | [[docs/features/plannedTransactions]] |
| 02 | Locked planned occurrence | Automatic execution rechecks occurrence and ledger validity under the plan lock; completed/inactive new execution rejects and existing-pair replay remains idempotent. | [[docs/features/plannedTransactions]] |
| 03 | Manual duplicate identity | Manual-v3 includes currency, database amount precision and consistent memo trimming; stale claims are checked against live fields. | [[docs/reference/provider-neutral-transaction-provenance]] |
| 04 | Linked-transaction deletion | Single/bulk deletion and import rollback reject planned execution references under coordinated locks. | [[docs/api/transactions]] |
| 05 | Statistics cache publication | Generation checks prevent stale in-flight work from publishing over newer invalidated cache state. | [[docs/performance/caching-strategies]] |
| 06 | Complete portfolio inventory/history | All inventory pages load; recent overview history is explicitly bounded, while detail/tax/rental consumers request complete history. | [[docs/features/portfolio]] |
| 07 | History state | Loading, failure and retry reach history consumers without fabricating an empty result. | [[docs/features/portfolio]] |
| 08 | Rental currency | Rent uses transaction currency with explicit original-investment fallback; missing-rate retry refreshes FX and portfolio. | [[docs/features/portfolio]] |
| 09 | Bounded history requests | No catch-all fallback fanout; four workers per query attempt, first-failure drainage, transport cancellation and abortable retry waits. | [[docs/performance/caching-strategies]] |
| 10 | Runtime manifest worker | Exact manifest verification runs in a worker using streamed hashes before executable use. | [[docs/architecture/electron]] |
| 11 | Live Reduce Motion | Preference changes stop animation for a static frame, resume permitted animation and clean up listeners. | [[docs/performance/caching-strategies]] |
| 12 | Dotenv roots | Deterministic source and packaged roots define environment-file lookup and precedence. | [[docs/guides/backend-configuration]] |
| 13 | Offline inflation | Offline startup uses supported local inflation data without remote fetching. | [[docs/performance/materialized-views]] |
| 14 | Documentation counts | Unchecked resource/index counts were removed; computed API and diagram catalogue counts remain authoritative. | [[docs/index]] |
| 15 | Coordinated restore recovery | Normal and Demo startup recover attachment/database journals together before writes or seed decisions; ambiguous recovery fails closed. | [[docs/features/backup-coverage-audit]] |
| 16 | Update activation cleanup | Cleanup failure after successful launch cannot roll back the running new application to a partially removed old copy. | [[docs/features/application-updates]] |
| 17 | Quiescent backup | A maintenance guard pauses backend/audit work while database and attachment bytes are captured; readiness resumes before compression. | [[docs/features/backup-coverage-audit]] |
| 18 | Bank chronology | Migration 0127 and parser/staging/insert propagation preserve bank sequence in balance-anchor ordering, with conservative backfill. | [[docs/adr/206-bank-chronology]] |
| 19 | Protected classifications | Manual transfer operations protect opening, adjustment and brokerage ownership; bulk UI respects eligibility. | [[docs/features/transfers]] |
| 20 | Account lifecycle | Shared lifecycle locks coordinate ledger mutation/import/rollback with account closing. | [[docs/features/accounts]] |
| 21 | Manual pair validity | Reciprocity, activity, different accounts and opposite signs are revalidated after sorted graph locking; unequal amounts/currencies remain supported. | [[docs/features/transfers]] |
| 22 | Import edit recovery | Serialized edits settle fully, refetch persisted preview after failure and display truthful mixed categories. | [[docs/features/import]] |
| 23 | Import commit ordering | Client pending/failure guards and server batch-lock/conditional claims order overrides before commit. | [[docs/api/imports]] |
| 24 | Widget persistence | Module-owned serialized saves survive navigation; ordered early edits merge with hydrated settings and failed reads cannot overwrite other pages. | [[docs/features/settings]] |
| 25 | Category merge freshness | Affected transaction, recipient, aggregate and research queries invalidate so mounted consumers update IDs, labels and totals. | [[docs/features/categories]] |
| 26 | Tax report provenance | Personal income tax uses matching selected-year/frozen inputs, omits incompatible annual calculations and remains explicitly denominated in EUR. | [[docs/features/pdf-report-export]] |
| 27 | Exact report dates | Inclusive calendar bounds reach source aggregation, including monthly all-time callers. | [[docs/features/pdf-report-export]] |
| 28 | Report exclusions | Both category and recipient exclusions reach filtered aggregates; explicitly labelled all-data comparisons remain separate. | [[docs/features/pdf-report-export]] |
| 29 | Unavailable report sources | Required financial, portfolio and tax source failures reject generation instead of fabricating zero/current replacements. | [[docs/features/pdf-report-export]] |
| 30 | Historical portfolio reports | Related historical KPIs use one dated snapshot; current holdings are separately labelled. | [[docs/features/pdf-report-export]] |
| 31 | Batched bank imports | Grouped duplicate lookup, bulk insert and staging writes preserve occurrence/provenance guards and per-row savepoint fallback. | [[docs/features/import]] |
| 32 | Bounded transfer graph | Directional uniqueness probes stop at two candidates; suggestions use bounded edge pagination and automatic pairs revalidate after locks. | [[docs/features/transfers]] |
| 33 | Planned candidate buckets | Recipient/direction/currency/calendar-day buckets narrow candidate comparisons without changing matching or ambiguity rules. | [[docs/features/plannedTransactions]] |
| 34 | Narrow execution reads | Locked recurrence/count/replay state is narrow; expanded history hydration is conditional. | [[docs/features/plannedTransactions]] |
| 35 | Startup backfills | Backfills are coalesced and expensive derived refresh happens after the batch rather than for every producer. | [[docs/performance/materialized-views]] |
| 36 | Visible Dashboard consumers | Hydrated visibility gates only the query families with active consumers, preserving shared/cached data. | [[docs/performance/caching-strategies]] |
| 37 | Lazy Settings | Lightweight section routing precedes lazy dialog/section loading; opening retains deep links and drafts. | [[docs/features/settings]] |
| 38 | Bounded exclusions picker | Virtual rows, memoized membership and keyboard focus bound work for large recipient lists. | [[docs/features/settings]] |
| 39 | Report admission | Admission bounds the complete preparation/render pipeline to two active/eight queued requests, with overflow rejection and cancellation cleanup. | [[docs/adr/208-bounded-report-pipeline]] |
| 40 | Selected report dependencies | Portfolio sections select only required datasets while retaining shared dependencies and source failure semantics. | [[docs/features/pdf-report-export]] |

## Walkthrough and cleanup work

- Tax-filing entry points, preparation guidance, confirmation, current/historical status and
  amendment handling are implemented on both tax pages. Profile, frozen snapshot and metadata
  persist together before filed status is published. Newer changes in other years remain intact.
  Recording a filing in Vision does not submit a declaration to a tax authority.
- Native audit session recovery and notifications distinguish unavailable protection, enrollment,
  partial verification and actual integrity failure. The original warning remains unconfirmed.
- The test cleanup inventory preserves financial precision, conservation, parser, recurrence,
  property, PostgreSQL and restore fault coverage. Duplicate tests and obsolete implementation
  assertions are replaced selectively. See [[docs/testing/test-inventory]] and
  `scripts/browser-tests/coverage-ledger.json` for the exact retained/replaced/removed decisions.
  The exact CSS source-count suite was retired. Its authored browser geometry replacements and the
  controlled Yahoo provider fixture were removed with Playwright on 2026-10-18, because only the
  Swift native app is a supported UI; React web layout has no browser coverage. The Swift app was
  retired on 2026-10-19 ([[docs/adr/214-retire-vision-native-swift-port|ADR-214]]); the React UI
  is the only UI again and still has no browser coverage.

## Checks already performed

Earlier work ran source/test TypeScript checks, workspace lint, frontend production builds,
focused integrity/import/report/portfolio tests, 244 compiled Electron tests and 59 script tests.
The broad frontend run passed 4074 tests and exposed one incomplete Crypto fixture; its corrected
observable journey passed with the full 92-test portfolio suite. The broad backend run passed 4803
cases, while 52 HTTP suites failed because socket binding was denied. Its one unrelated stale
transfer fixture was repaired and passed all five focused tests. Conditional database tests were
skipped, not passed. Exact commands, results and recovery checkpoints are in the untracked local
`.vision-todo-wip.tmp`; these figures are delivery evidence, not current whole-tree guarantees.

The last implementation gaps found after the waiver were Demo's separate database recovery and
widget preference hydration. They received essential compilation and focused synthetic checks;
no optional live run was added for either change. The test-only Yahoo fixture additionally passed
three provider-protocol/safety contract tests without binding a socket.

## Live acceptance not executed

These checks are waived for implementation closure, not recorded as successful:

- Reproduce the original audit warning and review current/historical filing, layout, deep links,
  Reduce Motion and visual appearance in a rebuilt synthetic Vision Demo.
- Execute PostgreSQL migration 0127, chronology, duplicate-identity, account-closing, transfer,
  planned-execution and import/rollback interleavings against a disposable database.
- Exercise real process interruption during coordinated database/attachment recovery and verify
  quiescent backup during concurrent attachment writes.
- Run isolated native smoke against its disposable synthetic stack.
- Compare native startup, manifest memory/event-loop behavior, dense transfer/import work,
  execution lock duration, exclusions interaction latency, GPU behavior and real PDF throughput.
- Check PDF content and cancellation with a launched Chromium process.

The available environment denied PostgreSQL shared-memory creation and local HTTP socket binding.
The standard Electron build also failed to remove generated output, despite approved cleanup, and
Chromium did not launch. Repeated attempts are not evidence of success. No user-data migration,
Demo reset, signed commit or publication was performed.

The measured planned-matching probe is limited to local CPU work with mocked database access:
840 candidate checks versus 2,089,800, identical 760 links, median 11.91 ms versus 23.01 ms for the prior
traversal using the same predicate. It does not establish end-to-end database, startup or GPU gains.

## Related

- [[docs/testing/index]]
- [[docs/testing/testing]]
- [[docs/features/backup-coverage-audit]]
- [[docs/features/belgian-tax]]
- [[docs/features/plannedTransactions]]
- [[docs/adr/207-coordinated-native-recovery]]
