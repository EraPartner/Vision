# Zod migration plan (2026-07)

Follow-up to the 2026-07 code-simplification audit (PR #103). Migrates remaining
hand-rolled validation to zod v4 using the established idiom from
`apps/node-backend/src/routes/settings.js` / `reports.js`:
schema → `safeParse` → join `issues` into a message → `throw new ValidationError(...)`.

## Hard invariants (every unit)

1. **No validation loss.** Every input the old code rejected must still be
   rejected. Before swapping a unit, pin the old behavior with regression tests
   (valid + invalid + boundary inputs) that pass against the OLD code, then
   swap; the pins must stay green.
2. **Wire format preserved.** Status 400, `code: VALIDATION_ERROR`, human
   message via the `{ ok:false, error:{...}, meta }` envelope
   (`src/middleware/errorHandler.js`). Message wording may change EXCEPT where
   tests assert substrings: `tests/routes/transactionsBulkUpdate.test.js`
   (`/at least one/i`) and the dynamic unknown-tag list in
   `tests/routes/transactionsBulkTag.test.js` (stays handler logic).
3. **Coercion side-effects preserved.** Callers must receive `result.data`
   (uppercased currency, parsed int arrays, trimmed strings) exactly as the old
   in-place mutation produced.
4. **Loose where loose.** Settings-like blobs use `z.looseObject` (unknown keys
   stored, not stripped). Never tighten a boundary that was deliberately
   forgiving.
5. **Out of scope (do NOT migrate):** `sanitizeUpdateFields`/`ALLOWED_COLUMNS`
   and `sanitizeString` (SQL-identifier allowlist), `dataImportService` +
   `importPipeline/validate.js` (count-and-continue semantics),
   `marketLookup.js` Yahoo mapping (`NO_VALIDATE`), anything in
   `packaging/electron` (packaged-shell dep precedent, see SIMP-74).
6. Full gate suite green before each commit: `bun run typecheck && bun run lint
   && bun run test && bun run test:frontend && node scripts/validate-locales.js`.

## Status ledger

Flip a row to `DONE (#103)` in the same commit that lands the unit.
Resume by grepping this table for `OPEN`.

| ID | Unit | Scope | Status |
|----|------|-------|--------|
| ZOD-01 | routes/savedCharts.js | enums, booleans, int arrays, illegal (type,variant) combos via superRefine | DONE (#103) |
| ZOD-02 | routes/watchlist.js | validateWatchlistFields → schema + .partial() for update | DONE (#103) |
| ZOD-03 | routes/ai.js | UUID/length/boolean checks (validateChatBody, requireConversationId, title/model) | DONE (#103) |
| ZOD-04 | controllers/investmentController.js | numeric-bounds + string-length tables + currency; SSRF URL check stays imperative | DONE (#103) |
| ZOD-05 | services/accountService.js | sanitize() enum/boolean/currency maps + .partial(); async FK check stays | DONE (#103) |
| ZOD-06 | routes/transactions.js | POST/PATCH bodies + bulk-tag/bulk-update bodies (list-query coercion excluded) | DONE (#103) |
| ZOD-07 | routes/importRoutes.js + portfolioImportRoutes.js | shared coerced batch-id schema (5 copy-paste sites), multipart config coercion, Set→z.enum | DONE (#103) |
| ZOD-08 | routes/plannedTransactions.js + routes/splits.js | leaf field validation only; loan-schedule logic stays imperative | DONE (#103) |
| ZOD-09 | routes/crossWorkspace.js + routes/research.js + services/openingBalanceService.js | rebalance-weights schema kept SEPARATE from settings.js rebalancePlanSchema (request path coerces weights, settings stores as sent — sharing would change one side's wire), query params, normalizeOpeningBalance | DONE (#103) |
| ZOD-10 | frontend SSE payloads | per-event schemas in lib/api/sse.ts, imports.ts, portfolioImports.ts, ai.ts; ai.ts adopts shared SSE frame reader (readSseFrames) | DONE (#103) |
| ZOD-11 | frontend persisted state | SettingsContext localStorage blob schema with .catch(defaults) before API write-back (migrateDashboardSettings in settingsStore); ChartBuilderPage state merge (chartBuilderState.ts) | DONE (#103) |
| ZOD-12 | backend research adapters | dedicated pass over services/research/adapters/*.js third-party JSON parsing; tolerant semantics preserved (schema failures degrade the same way current guards do, never new throws on hot paths) | OPEN |

## Batching (sequential subagents)

- Batch B1: ZOD-01, 02, 03 (backend route trio)
- Batch B2: ZOD-04, 05 (controller/service pair)
- Batch B3: ZOD-06, 07 (transactions + import routes)
- Batch B4: ZOD-08, 09 (remaining backend routes/services)
- Batch B5: ZOD-10, 11 (frontend)
- Batch B6: ZOD-12 (research adapters, dedicated)
