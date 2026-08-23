---
title: Input Validation
type: security
status: active
date: 2026-04-26
updated: 2026-08-23
tags: [security, validation, sanitization, csv, formula-injection, cwe-1236, path-injection, redos, ssrf, outbound-request, url-safety]
description: Input validation and sanitization mechanisms to prevent SQL injection, XSS, formula injection in CSV exports, path injection, ReDoS, malformed data, and SSRF via user-controlled outbound URLs
aliases: [input validation, sanitization, sql injection, xss, validation middleware, csv formula injection, cwe-1236, ssrf, url safety]
related_code: ["apps/node-backend/src/middleware/validation.js", "apps/node-backend/src/lib/importBatchIds.js", "apps/node-backend/src/lib/parserConfigRoutes.js", "apps/node-backend/src/routes/importRoutes.js", "apps/node-backend/src/routes/portfolioImportRoutes.js", "apps/node-backend/src/routes/investments.js", "apps/node-backend/src/services/accountService.js", "apps/node-backend/src/lib/filterBuilder.js", "apps/node-backend/src/routes/aggregations.js", "apps/node-backend/src/routes/transactions.js", "apps/node-backend/src/services/aiChat/tools/_validate.js", "apps/node-backend/src/lib/csv.js", "apps/node-backend/src/lib/urlSafety.js", "apps/node-backend/src/controllers/investmentController.js", "apps/node-backend/src/repositories/portfolioTxRepo.reads.js", "apps/node-backend/src/services/prices/priceProviderRegistry.js"]
---

# Input Validation

Vision implements comprehensive input validation to prevent SQL injection, XSS attacks, and malformed data. All user inputs are validated before being processed or stored.

## Overview

The validation middleware (`validation.js`) provides centralized input validation for all API endpoints. It uses a whitelist approach to ensure only valid data enters the system.

## Validation Functions

### ID Validation

Validates that an ID parameter is a positive integer. **The single definition of a valid id** — `validateIntArray`, `assertOptionalId`, `validateIdParam`/`validateIntParam`, `splits.js`'s `validatedIdField`, `importBatchIds.js`'s `coercedIdSchema`, `aggregations.js`'s `parseIdArrayQueryParam` and the AI-chat tools' `parsePositiveInt` all delegate to it rather than re-deriving a shape rule. If you need an id check, add a call — not another parser.

```javascript
validateId(value, fieldName = 'id', max = MAX_INT32_ID)
```

**Rules — the accept set is exhaustive and deliberately strict:**
- A plain base-10 digit string (`"42"`; leading zeros allowed, `"00005"` → `5`), **or** an actual integer `number` (route middleware re-stamps `req.params` with the parsed integer, and JSON bodies send real numbers)
- Range 1 to `max`, which defaults to `MAX_INT32_ID` = 2,147,483,647 (`int4` — the width of every `SERIAL` PK these routes address). `max` is not a general knob: it exists only so the `BIGSERIAL`-backed import batch/row ids can share this one definition of *shape* without inheriting an `int4` ceiling their column does not have (see [[docs/security/input-validation#coercedIdSchema (import batch/row ids)|coercedIdSchema]])
- **Everything else is rejected**: trailing garbage (`"12abc"`, `"5px"`), decimals (`"12.5"`), exponent/hex/octal/binary literals (`"1e3"`, `"0x10"`, `"0o17"`, `"0b11"`), signs (`"+5"`, `"-5"`), separators (`"12,5"`, `"1_0"`), whitespace-padded values (`" 5 "`), the empty string, `"Infinity"`/`"NaN"`, non-ASCII digits, booleans, arrays and objects

> [!warning] Breaking change (2026-08-11) — `"12abc"` no longer resolves to id 12
> `validateId` was `parseInt`-based, so it took the *leading digits of anything*: `DELETE /api/research/mappings/12abc` deleted mapping **12**, `"12.5"` resolved to 12 and `"1e3"` to 1. A malformed id silently addressed a record the client never named, instead of failing. It is now a strict digit-string parse, and all such inputs return **400 `VALIDATION_ERROR`**.
>
> Note that a bare `Number()` would *not* have been a correct fix: it accepts `"0x10"` as 16, turns `"1e3"` into 1000 (a *different* wrong record) and leaves `"12.5"` a non-integer that reaches Postgres.
>
> This tightens **every** route behind `validateIdParam` / `validateIntParam` / `assertOptionalId` and the `validatedIdField` zod adapter in `splits.js`. It only narrows what is accepted: every id that a well-behaved client sends (a plain integer) behaves exactly as before, and `openapi.yaml` already typed these params `integer` — the implementation now conforms to the published contract rather than deviating from it.

**Returns:**
```javascript
{ valid: true, value: 123 }  // Success
{ valid: false, error: "id must be a positive integer" }  // Failure
```

---

### String Sanitization

Sanitizes string inputs by trimming whitespace and enforcing maximum length.

```javascript
sanitizeString(value, maxLength = 500)
```

**Rules:**
- Converts non-strings to strings
- Trims whitespace
- Enforces maximum length
- Returns `null` for null/undefined inputs

---

### Numeric Validation

Validates numeric values against min/max bounds.

```javascript
validateNumber(value, { min = -Infinity, max = Infinity, fieldName = 'value' })
```

**Rules:**
- Must be a valid number
- Must be within specified range (inclusive)

---

### Integer ID Validation in Query Parameters

Optional query parameters that reference IDs (e.g. `?account_id=`) go through `assertOptionalId`, the throwing wrapper around `validateId` — so they share the strict accept set documented above rather than a hand-rolled `parseInt` check.

```javascript
const accountId = assertOptionalId(req.query.account_id, 'account_id');
```

**Rules:**
- Absent or empty (`undefined` / `null` / `''`) returns `null`, so the caller can treat the filter as unset
- Anything else must satisfy `validateId`; otherwise a `ValidationError` (400) is raised **before** the value reaches the database layer
- This is what keeps `?account_id=abc` a 400 rather than a `NaN` parameter that Postgres rejects with `22P02` as a 500

**Call sites:** `routes/transactions.js` (export filters), `routes/info/statistics.js`.

---

### Date Validation

Validates date strings in ISO format (YYYY-MM-DD).

```javascript
validateDateString(value, fieldName = 'date')
```

**Rules:**
- Must match `^\d{4}-\d{2}-\d{2}$` pattern
- Must be a valid date

---

### Array Validation

Validates arrays of integer IDs (chart filter lists, dashboard exclusion lists).

```javascript
validateIntArray(values, fieldName = 'ids')
```

**Rules:**
- A scalar is wrapped into a one-element array; an empty array is valid
- **Every element goes through `validateId`**, so the per-element accept set is exactly the one documented above (plain base-10 digit string or integer `number`, 1..2,147,483,647)
- One bad element rejects the **whole** array — `ValidationError` with `"<field> contains invalid value: <value>"`. No partial or filtered set ever reaches the query

**Call sites — bodies:** `routes/savedCharts.js` (`categoryIds`, `recipientIds`, `tagIds`), `routes/settings.js` (`dashboard_settings.excludedCategoryIds` / `.excludedRecipientIds`).
**Call sites — query strings:** `routes/aggregations.js` via `parseIdArrayQueryParam` (see below).

> [!warning] Breaking change (2026-08-11) — `["12abc"]` no longer becomes `[12]`
> The element parse was `parseInt`, the same truncation the `:id` params lost the same day, and here it was worse. These arrays feed **exclusion and filter sets**, not a single-record lookup, so a truncated element did not 404 — it quietly changed which rows an aggregation or saved chart covered, and no error surfaced to anyone. `["12abc"]` silently became category `[12]`; `["12.5"]` and `["1e3"]` likewise became `[12]` and `[1]`.
>
> Malformed elements now return **400 `VALIDATION_ERROR`**. Clients sending plain integers are unaffected — the frontend types all four fields `number[]` (`lib/api/types.ts`, `stores/settingsStore.ts`), so no shipped caller is affected.

---

### Repeatable ID Query Params (aggregations)

The aggregation endpoints take their id lists in the query string, one occurrence per id (`?excluded_category_ids=5&excluded_category_ids=9`). They go through `parseIdArrayQueryParam` in `routes/aggregations.js`, a thin throwing wrapper around `validateIntArray` — so the per-element accept set is the same one documented under [[docs/security/input-validation#ID Validation|ID Validation]], not a second rule.

```javascript
parseIdArrayQueryParam(req.query.excluded_category_ids, 'excluded_category_ids')
```

**Rules:**
- Absent, or present-but-empty (`?excluded_category_ids=`), returns `[]` — "no filter", answered `200`. This is the same unset convention `assertOptionalId` uses, and it is what every shipped caller sends when its list is empty (the frontend query builders skip the param entirely rather than emitting an empty one)
- Any other value must satisfy `validateIntArray`; one bad element raises `ValidationError` → **400 `VALIDATION_ERROR`** (`"<field> contains invalid value: <value>"`) before any aggregation is computed
- An empty list and a list containing a bad element are deliberately **different** cases with different answers

**Params:** `excluded_category_ids`, `excluded_recipient_ids` (8 endpoints: `monthly-summary`, `recipient-insights`, `cashflow-comparison`, `cashflow-forecast-methods`, `cashflow-forecast-rolling`, `sankey`, `category-pivot`, `recipient-by-year`), plus `excluded_recipient_ids` + `recipient_ids` on `recipient-pivot` and `tag_ids` on `tag-pivot`.

`mc_percentiles` deliberately keeps the older lenient numeric parser: percentiles are distribution parameters in 0..100, not record ids, so fractional values are legitimate and a bad one costs a chart band rather than a wrong row set.

> [!warning] Breaking change (2026-08-11) — a malformed id is now a 400 instead of a silently different answer
> This parser was `.map(Number).filter(Number.isFinite)`, which **dropped** bad elements instead of rejecting them. `?excluded_category_ids=12abc` yielded `[]`, so the exclusion was switched off entirely and the endpoint answered with a *different dataset than the user asked for* — no error, no log line, a plausible-looking number on the dashboard. Meanwhile `"0x10"` decoded to 16 and `"1e3"` to 1000, excluding a category nobody named, and `"1.5"`/`"-1"` reached the SQL builder to be dropped a second time by `validateInt4Ids`.
>
> Worse than the body-array case above, which at least refused the request. Both paths now behave identically. Non-breaking for every shipped caller: the frontend builds these params from `number[]` state with `String(id)` and omits the param when the list is empty, so no legitimate request shape changes.

---

### Comma-separated ID Query Params (transactions list + export)

The transactions list and the two streamed export endpoints take their id lists comma-separated
(`?category_ids=5,7,12`, `?account_ids=3,9`) rather than one occurrence per id, because that is the
shape their `ids.join(',')` frontend builders emit. They go through `parseIdListQueryParam` in
`routes/transactions.js` — a thin throwing wrapper around `validateIntArray`, so the per-element
accept set is the same one under [[docs/security/input-validation#ID Validation|ID Validation]],
not a third rule. Repeated occurrences work too: Express hands back an array and `String([...])`
re-joins it with commas.

```javascript
parseIdListQueryParam(req.query.account_ids, 'account_ids')   // → number[] | null
```

**Rules:**
- Absent, or present-but-empty (`?category_ids=`), returns `null` — "no filter", answered `200`
- Any other value is split on `,` and every element must satisfy `validateId`; one bad element
  raises `ValidationError` → **400 `VALIDATION_ERROR`** (`"<field> contains invalid value: <value>"`)
  before any row is read. A trailing comma is therefore a 400, not a shrug
- No trimming — ` 5` is a malformed id here, exactly as in the path params
- `account_ids` is validated in full **before** `EXPORT_MAX_LIST_SIZE` (50) caps it, so a malformed
  id past the cap still rejects rather than being sliced away unseen

The four scalar id filters on the same endpoints — `transaction_id`, `category_id`, `recipient_id`,
`recipient_group_id` — go through `assertOptionalId`, joining `account_id`, which already did.

**Params:** `category_ids` (`GET /api/transactions`, `GET /api/transactions/export/csv|json`),
`account_ids` (both export endpoints), `investment_ids` (`GET /api/investments/transactions`).

`investment_ids` uses the same wrapper shape in `investmentController.js`, with one deliberate
difference: it is **required**, not optional, so absent/empty is the endpoint's pre-existing
`400 investment_ids is required` rather than "no filter". Its repository-side twin in
`portfolioTxRepo.reads.js` (`normalizeInvestmentIds`, feeding both `= ANY($1::int[])` predicates)
also delegates to `validateId` now, but keeps dropping rather than throwing — that layer has
always been a silent filter, and the throwing guard belongs where a 400 can reach the caller.

> [!warning] Breaking change (2026-08-11) — the last id parsers, and the only one whose output is a file
> These sat **upstream** of `validateInt4Ids`, so the SQL-build convergence did not close them: by
> the time the builder saw the value it was already a clean integer.
>
> The list parse was `.split(',').map(parseInt).filter(isFinite && > 0)` and had *both* failure
> modes. **Retarget:** `?category_ids=5,12abc` filtered by categories 5 **and 12**, and
> `?account_ids=12abc` exported account 12 — a record nobody named. **Widen:** an all-bad list
> parsed to `[]`, which the caller mapped back to "no filter", so `?account_ids=abc` emitted no
> account predicate at all and `GET /export/csv` streamed **every account's transactions** into the
> downloaded file, 200 and all. A silently widened export is the worst outcome in this family: the
> file looks right, the user keeps it, and nothing is logged.
>
> The four scalars were bare `parseInt`: `?category_id=12abc` filtered by category 12,
> `?recipient_group_id=1e3` by group 1, and `?transaction_id=0` / `?recipient_id=-4` reached the SQL
> builder as ids no row can have. A `NaN` — which is what the Transactions page sends for a
> hand-edited URL, since it parses these params with a bare `Number()` — passed the builder's
> `!= null` guard and reached Postgres as a **22P02 500**; it is now a 400.
>
> `POST /api/transactions/transfers` is converged in the same pass. Its `aId`/`bId` were bare
> `parseInt` guarded only by `Number.isInteger`, so `"12abc"` stamped transaction **12** as one leg
> of a transfer pair — a wrong-record *write*, not a wrong-record read — and an id past int4 passed
> the guard and 500'd at the column.
>
> Non-breaking for shipped callers: the Transactions page and the Imports Export card build these
> params with `ids.join(',')` from `number[]` state (dropping malformed URL elements client-side
> before the request), `buildQuery` omits empty values, and nothing in the frontend sends
> `account_ids` at all. `openapi.yaml` already typed the four scalars `integer`, so the
> implementation moves **onto** the published contract rather than away from it.

> [!warning] Breaking change (2026-08-11) — `investment_ids` joins them
> Missed by the pass above because it lives in `investmentController.js`, not `routes/`. Same
> `parseInt` + `filter(Number.isInteger)` shape and the same retarget: `?investment_ids=12abc`
> returned investment **12**'s transactions, `5,12abc` returned 5 **and** 12, and `1e3` returned
> investment 1 — all `200`. Read-only, hence the lowest severity in the set. The identical parse ran
> a second time in the repository, so closing only one layer would have left the other reachable
> from any future caller; both are on `validateId` now.
>
> Also corrected here: `openapi.yaml` documented this operation's filter as `investment_id`
> (singular, optional). The route has only ever read `investment_ids` and 400s without it. The spec
> now matches, so the operation's generated query type went from optional to required — a
> documentation fix, not a behaviour change. `useInvestments.ts` already sent
> `investment_ids: ids.join(',')`.

---

### SQL-build-time id lists (`validateInt4Ids`)

`apps/node-backend/src/lib/filterBuilder.js` — the last layer before an id becomes a `$n`
placeholder. Used by `buildTransactionWhere` (`accountIds`, `categoryIds`),
`buildExclusionClauses` (`excludedCategoryIds`, `excludedRecipientIds`),
`resolveBulkSelection`, `bulkTagTransactions`, and the price-history batch loader.

```javascript
validateInt4Ids(ids, fieldName)   // → number[], throws ValidationError
```

**Rules:**
- Delegates to `validateIntArray` → `validateId`, so the accepted element shapes are identical to
  the `:id` params', the body arrays' and the aggregation query params': a plain base-10 digit
  string or an integer number, `1..2147483647` **inclusive**
- One bad element rejects the whole list — `"<field> contains invalid value: <value>"`
- Nullish input means "no ids" and yields `[]`; callers skip the clause (the unset convention)

> [!warning] Breaking change (2026-08-11) — this layer dropped ids instead of rejecting them
> `validateInt4Ids` was `ids.filter(id => Number.isInteger(id) && id > 0 && id < MAX_INT4)`.
> A dropped id does not 404 here — it changes **which rows the query covers**. An exclusion list
> that lost one element quietly stopped excluding that category; one that lost every element
> emitted no predicate at all and answered with the full dataset while the caller believed its
> exclusions applied. This is also what dropped `1.5`/`-1` a *second* time on the aggregation
> path, masking the query-param bug above.
>
> Two callers additionally ran `.map(Number)` **before** the filter, which did not drop bad
> entries but **retargeted** them: `"1e3"` became id 1000, `"0x10"` became 16, `[7]` became 7 and
> `true` became 1. `resolveBulkSelection` feeds `POST /api/transactions/bulk-delete`, whose `ids`
> is read straight off `req.body` with no route-layer id validation — so a malformed id could
> **hard-delete a record the client never named**, returning 200 with a plausible count. The
> `.map(Number)` is gone; elements are validated as sent.
>
> Forgiveness was considered for the bulk paths and rejected: staleness is not what this filter
> catches. An id whose row was deleted in another tab is a valid integer — it passes validation
> and matches nothing in the `id = ANY(...)`, so a stale selection still succeeds. Only malformed
> input is rejected, and the frontend holds `number[]` straight from the API.
>
> The bound was also off by one: `id < 2147483647` rejected a legal int4 id at the ceiling that
> every route-layer validator accepts, so `?excluded_category_ids=2147483647` returned 200 and
> silently applied no exclusion. Now `<= 2147483647`, matching `validateId`.

---

### Bulk-action filter selector (`normalizeBulkFilter`)

`apps/node-backend/src/services/bulkSelection.js` — the `filter` half of the `{ ids } | { filter }`
selector shared by `POST /api/transactions/bulk-delete`, `/bulk-update` and `/bulk-export`. The
`ids` half was made strict earlier the same day (see `validateInt4Ids` above); this is its sibling.

```javascript
normalizeBulkFilter(filter)   // → builder opts, throws ValidationError
```

**Rules:**
- The accepted key set is closed. An unrecognised key rejects the request —
  `` `filter` contains unknown field(s): <keys>`` — rather than being ignored
- Each field is accepted in snake_case or camelCase, but **not both at once**: one field spelled
  twice rejects instead of silently preferring one spelling
- Scalar ids (`transaction_id`, `account_id`, `category_id`, `recipient_id`,
  `recipient_group_id`) go through `assertOptionalId`; `category_ids` through `validateIntArray`;
  dates through `assertYmd`
- `category_ids` and `bank_accounts` must be **arrays** — a comma-separated string is rejected
  (`tags` accepts either form, as it always has)
- Booleans (`active`, `amount_signed`) accept a real boolean or the query-string `'true'`/`'false'`;
  anything else rejects instead of collapsing to the default
- `transaction_type` must be exactly `'income'` or `'expense'`; amounts must parse as finite numbers
- Absent, `null` and empty (`''`, `[]`) mean "no filter on this field" and answer 200 — the same
  unset convention `assertOptionalId` and the query-param parsers use. `null` matters concretely:
  the Transactions page computes its id filters with `Number(param)`, and a `NaN` serialises to
  `null` over JSON
- `search` is **rejected** past 200 characters rather than truncated (see below)

> [!warning] Breaking change (2026-08-11) — a skipped filter field widens a bulk DELETE
> Every field here was applied best-effort: one that failed its type guard was **skipped**. On a
> read that only over-returns. On `POST /bulk-delete` it means the hard delete ran against a
> **wider** set than the caller named, answered 200 with a plausible count, and logged nothing —
> the mirror image of the `ids` retarget closed the same day, and invisible by construction.
>
> Reproduced end-to-end against a real Postgres before the fix: a 4-row corpus, a filter naming 2
> of them (`{category_ids: "<catId>"}` — a string where the array is expected), response
> `{"deleted": 4}`. Six shapes were live. `category_ids` and `bank_accounts` failed an
> `Array.isArray` guard; `tags` dropped an empty slug (`'rome-2020,'`); `transaction_type` failed a
> value guard, so a capitalised `'Expense'` swept income rows in too; `amount_min`/`amount_max` were
> parsed by `parseAmountFilter`, which returns `null` for anything unparseable, so `'25abc'` dropped
> the bound entirely; and `active: 0` collapsed to the `active: true` default.
>
> Worst of all was the **unknown key**, which was not a type guard at all: nothing in the body was
> understood, so the filter reached the SQL builder empty — "every active transaction" — and the
> delete swept the table up to the 5000-row cap. `{account_ids: [7]}` is a real list-endpoint param
> this normaliser never supported; `{catgeory_id: 7}` is a typo. Both deleted everything.
>
> Separately, the five scalar filter ids and the two dates were passed into `$n` **unvalidated**, so
> `{recipient_id: "12abc"}` reached Postgres as a **22P02 500** and `{start_date: "banana"}` as a
> **22007 500**. Both are 400s now.
>
> All three endpoints share the normaliser and were equally affected. On `bulk-export` the widen is
> not destructive but it is a disclosure: the user keeps a file containing rows their filter excluded.
>
> No caller breaks. The frontend's `BulkTransactionFilter` (`types/api.ts`) already types every
> field correctly, `JSON.stringify` drops the undefined ones, and the page sends only keys in the
> accept-list. The whole-table selection the "select all N matching" flow sends with no filters set
> (`{active: true}` and nothing else) is deliberately still accepted — it is a legitimate request,
> bounded by the 5000-row cap rather than by validation.
>
> Two silent behaviours were deliberately **kept**, both narrowing rather than widening and both
> shared verbatim with the list endpoint: a `search` shorter than `MIN_SEARCH_LENGTH` is ignored by
> the SQL builder, and `bank_accounts`/`tagSlugs` are sliced to the builder's 50-element cap (the
> same pre-existing narrowing `EXPORT_MAX_LIST_SIZE` carries on the export path). The one place this
> section diverges from the list endpoint is `search` length: the list truncates to 200 characters,
> which for a substring match matches *more* rows, so here it rejects instead.

---

### Optional id query params on the remaining list endpoints

The last `parseInt`-based id parsers outside the transactions routes, converged onto
`assertOptionalId` / `validateId` in the same pass:

| Site | Param | Was |
|---|---|---|
| `routes/plannedTransactions.js` (`GET /`) | `category_id`, `recipient_id` | `x ? parseInt(x) : null` |
| `routes/recipients.js` (`GET /`) | `default_category_id` | `x ? parseInt(x) : null` |
| `routes/research.js` (`POST /mappings/resolve`) | `investment_id` | `Number.parseInt`, `undefined` on failure |
| `routes/accounts.js` (`POST /:id/merge`) | `source_ids[]` | `parseInt` + `Number.isInteger` |
| `routes/accounts.js` (`GET /:id/merge-preview`) | `?into=` | `Number(...)` |

> [!warning] Breaking change (2026-08-11) — malformed ids on these five sites
> Same two failure modes as everywhere else in this family. **Retarget:**
> `?category_id=12abc` listed the planned transactions of category **12**,
> `?default_category_id=12abc` the recipients defaulting to category 12, and
> `investment_id: "12abc"` pre-seeded mapping proposals from holding 12. `?into=1e3` arrived at
> `previewMerge` as a well-formed **1000**. Worst of the set is `source_ids`: a merge deletes the
> source accounts and repoints their rows, and `parseInt('12abc')` produced the integer 12, which
> passed the `Number.isInteger` guard the route's all-or-nothing rejection list was built on — so
> `'12abc'` **merged and deleted account 12**, a wrong-record irreversible write.
> **Silent drop:** `investment_id: 'abc'` became "no holding", answering 200 with an un-seeded
> result indistinguishable from a correct one. **500:** a `NaN` from the two list filters passed the
> repositories' `!= null` guards and reached Postgres as a 22P02.
>
> Absent and empty still mean "no filter" at 200 on every one of them. No shipped caller breaks: the
> frontend types all of these `number | undefined` and its query builders omit undefined params.

### Pagination Validation

Validates and normalizes pagination parameters. `validatePagination(limit, offset)` was removed
in PR #103; list routes now use the helpers in `apps/node-backend/src/lib/pagination.js`.

```javascript
parseIntClamped(raw, { min = 1, max, fallback })
parsePagination(query, { defaultLimit = 50, maxLimit })
parseOptionalPagination(query, { defaultLimit, maxLimit })
```

**Rules:**
- `parseIntClamped`: parses `raw`, falls back to `fallback` if not finite or below `min`, clamps to `max` if given
- `parsePagination`: builds `{ limit, offset }` from `query.limit`/`query.offset` via `parseIntClamped` — `limit` falls back to `defaultLimit` and clamps to `maxLimit`; `offset` falls back to `0` with `min: 0`
- `parseOptionalPagination`: returns `null` when neither `limit` nor `offset` is supplied (serve the full collection); otherwise delegates to `parsePagination`, with the limit fallback defaulting to `maxLimit` instead of a small page size

---

### Parameterized Queries with Schema Checking (2026-04-26)

For operations on columns that may not exist in all schema versions (e.g., `planned_transactions.recipient_id`), Vision uses a two-step approach:

1. **Schema Validation:** Query `information_schema.columns` to check column existence before attempting to update it
2. **Parameterized Update:** If column exists, run a fully parameterized UPDATE using `ANY($2::int[])` for ID arrays

**Example:** Recipient merge service

```javascript
// Step 1: Check if column exists (safe, no data modification)
const colCheck = await client.query(
  `SELECT 1 FROM information_schema.columns
   WHERE table_name = 'planned_transactions' AND column_name = 'recipient_id'
   LIMIT 1`,
);

// Step 2: Only run UPDATE if column exists (fully parameterized)
if (colCheck.rows.length > 0) {
  const plannedRes = await client.query(
    `UPDATE planned_transactions
        SET recipient_id = $1
      WHERE recipient_id = ANY($2::int[])`,
    [primaryId, ids],  // Fully parameterized — no string interpolation
  );
}
```

**Rationale:**
- Avoids string interpolation or dynamic SQL construction
- Safely handles missing columns in older schema versions without error
- All ID values passed as parameters, not interpolated into SQL string

---

## Column Whitelisting

To prevent SQL injection through dynamic column names, Vision uses a whitelist approach:

```javascript
const ALLOWED_COLUMNS = {
  transactions: new Set([
    'date', 'transaction_date', 'bank_account', 'recipient_id', 'amount',
    'memo', 'currency', 'balance', 'category_id', 'comment', 'is_active',
  ]),
  categories: new Set([
    'general', 'detail', 'description', 'is_active',
  ]),
  recipients: new Set([
    'name', 'default_category_id', 'notes', 'is_active',
  ]),
  // ... other resources
};
```

### sanitizeUpdateFields()

This function filters update requests to only include allowed columns:

```javascript
sanitizeUpdateFields('transactions', { amount: 100, unknown_field: 'bad' })
// Returns: { amount: 100 }
// unknown_field is silently dropped
```

---

## Express Middleware

### validateIdParam

Express middleware for validating `:id` route parameters:

```javascript
router.get('/:id', validateIdParam, async (req, res) => {
  // req.params.id is now a validated integer
});
```

Applied in 14 routers: `accounts`, `attachments`, `categories`, `investments`, `plannedTransactions`, `recipientBankAccounts`, `recipients`, `research`, `savedCharts`, `splits`, `tags`, `transactions`, `watchlist`, plus the two import routers via the shared `registerParserRoutes` (`lib/parserConfigRoutes.js`, which registers the four saved-parser-config PATCH/DELETE operations on both).

### validateIntParam

Factory for sub-resource id params that the fixed-`:id` middleware cannot reach. Same accept set, same parsed-value re-stamp:

```javascript
router.delete('/:id/patterns/:patternId', validateIdParam, validateIntParam('patternId'), handler);
```

Used for `:patternId` (`recipients.js`), `:accountId` (`recipientBankAccounts.js`) and `:txnId` (`investments.js`). Unlike `validateIdParam` — which no-ops when there is no `:id` on the route — `validateIntParam` rejects a missing param, since a route that declares it always has it.

> [!warning] Breaking change (2026-08-11) — the last six operations with no `:id` middleware
> Six operations reached a repository with a hand-parsed id and no router-edge guard. All six now carry `validateIdParam`/`validateIntParam` **and** parse through `validateId`, so the guard runs twice and cannot disagree with itself.
>
> | Operations | Old parser | What a malformed id did |
> |---|---|---|
> | `PATCH`/`DELETE /api/import/parsers/:id` and `/api/portfolio/import/parsers/:id` | `parseParserId` — `parseInt` + `Number.isNaN` | `DELETE /parsers/12abc` → **204, parser 12 deleted**; `12.5` → 12; `1e3` → 1; `-1` and `0` cleared the NaN check and reached the repository |
> | `PATCH`/`DELETE /api/investments/transactions/:txnId` | `requireTxnId` — `parseInt` + `isNaN`/`<= 0` | `DELETE /transactions/12abc` → **204, transaction 12 hard-deleted**; `1e3` → transaction 1; PATCH retargeted identically |
>
> Both delete paths are irreversible writes against a record the caller never named, reported as success — the reason this pair was rated highest in the family. Everything listed now returns **400 `VALIDATION_ERROR`** before any repository call.
>
> No shipped caller is affected: `lib/api/imports.ts`, `lib/api/portfolioImports.ts` and `lib/api/portfolio.ts` all type these ids as `number`, and every caller takes them from server-supplied rows.

### coercedIdSchema (import batch/row ids)

The import pipelines' batch and row ids (`/api/import/batches/*`, `/api/portfolio/import/batches/*`) are parsed by the zod adapter `coercedIdSchema` in `lib/importBatchIds.js`, via `parseBatchIdParam(req)` and `parseBatchRowIdParams(req)`. It **delegates to `validateId`**, so there is one definition of a valid id rather than two kept in step by hand.

```javascript
const id = parseBatchIdParam(req);                  // req.params.id
const { batchId, rowId } = parseBatchRowIdParams(req); // req.params.id + req.params.rowId
```

The one intended difference from a plain `validateId` call is the **upper bound**:

| Validator | Bound | Why |
|---|---|---|
| `validateId` (default) | `MAX_INT32_ID` = 2,147,483,647 | every id it guards is an `int4` `SERIAL` PK (`categories`, `recipients`, `tags`, `transactions`, …) |
| `coercedIdSchema` | `MAX_SAFE_ID` = `Number.MAX_SAFE_INTEGER` | `import_batches.id`, `import_staging_rows.id` and the portfolio pair are **`BIGSERIAL`** — an `int4` ceiling would be narrower than the column. `2^53` is the real limit because the id crosses the wire as a JSON number, and above it the digit string and the parsed number stop being the same value (`"9007199254740993"` would address record …992) |

> [!warning] Breaking change (2026-08-11) — the two validators converged
> `coercedIdSchema` was a bare `Number()` coercion. It already agreed with `validateId` on the obvious cases (`"12abc"`, `"12.5"`, `0`, negatives, `""` all rejected), but it silently addressed a **different batch** on `"1e3"` → 1000, `"0x10"` → 16, `"0o17"` → 15, `"0b11"` → 3 and `"9007199254740993"` → …992, and additionally accepted `"+5"`, `" 12 "`, `"\n7\n"` and `"12.0"`. All of these now return **400 `VALIDATION_ERROR`**.
>
> Not affected: an integral id above `int32` (e.g. `2147483648`) is a legal `BIGSERIAL` row and still reaches the repository, 404ing if absent. `"1e300"`, previously let through to that same downstream 404, is now a 400 — it names no batch in any notation the API accepts.
>
> No shipped caller is affected: `lib/api/imports.ts` and `lib/api/portfolioImports.ts` type `batchId`/`rowId` as `number`, and `ImportReviewPage.tsx` normalizes the `:batchId` route param with `Number()` before building the URL, so a hand-typed `/import/12.0/review` was already requesting batch `12` on the wire.

---

### Portfolio transaction write bodies

`POST /api/investments/:id/transactions` and
`PATCH /api/investments/transactions/:txnId` use one loose Zod body schema in
`controllers/investmentController.js`. POST adds its `type` and `date` requiredness after the shared
parse; every PATCH field remains optional. The repository normalizer still owns type-specific unit
math, oversell checks, and recurrence-window validation.

The shared boundary validates these common shapes before any repository write:

| Fields | Rule |
|---|---|
| `type` | Canonical `PORTFOLIO_TXN_TYPES` value |
| `date`, `recurrence_end_date` | `YYYY-MM-DD`; transaction `date` cannot be cleared, while recurrence end date can |
| `amount`, `units`, `price_per_unit`, `fees`, `taxes`, `fx_rate_to_eur` | Finite JSON number or decimal numeric string (including exponent notation) within the field's PostgreSQL-safe range; strings normalize to numbers, while booleans, arrays, hex and padded forms reject |
| `currency` | Three-letter ISO shape, normalized to uppercase; create may fall back when empty, PATCH cannot clear it |
| `note` | String or `null` |
| `is_recurring` | Boolean, without string or number coercion |
| `recurrence_interval` | Canonical `PORTFOLIO_RECURRENCE_INTERVALS` value or a clear value |
| `account_id` | Existing `validateId` path described below; `null` retains its unassign meaning on PATCH |

Malformed values now return **400 `VALIDATION_ERROR`** instead of reaching PostgreSQL as a cast,
enum, NOT NULL, or numeric-range failure. The schema is loose so unknown fields retain the existing
repository-allowlist behavior; this change closes validation drift without changing the write
field vocabulary.

---

### FK ids in write bodies (`parseOverrideId` and the zod FK fields)

The id **route params** above are only half of what a write addresses. The other half is the FK id carried in the request **body** — the recipient/category an import row is re-attributed to, the investment a portfolio row is linked to, the brokerage account a batch lands on, the recipient/category a transaction is booked against, and an account's `funding_account_id`. All of these are now parsed with **`validateId`**, so the body and the URL agree on what an id is.

| Site | Field | Parser |
|---|---|---|
| `POST /api/import/batches/:id/rows/:rowId/override` | `recipient_id` | `parseOverrideId` (`lib/importBatchIds.js`) |
| `POST /api/import/batches/:id/rows/:rowId/category-override` | `category_id` | `parseOverrideId` |
| `POST /api/portfolio/import/batches/:id/rows/:rowId/investment-override` | `investment_id` | `parseOverrideId` |
| `POST /api/portfolio/import/batches/:id/commit` | `account_id` | `validateId`, inline |
| `POST /api/portfolio/import/csv/custom` (+ `/csv/custom/stream`) | `account_id` | `validateId`, in `brokerageParamsSchema` |
| `POST /api/transactions`, `PATCH /api/transactions/:id` | `recipient_id`, `category_id` | `validateId`, in the zod body schemas |
| `POST /api/accounts`, `PATCH /api/accounts/:id` | `funding_account_id` | `validateId`, in `accountService`'s zod schema |
| `POST /api/investments/:id/transactions`, `PATCH /api/investments/transactions/:txnId` | `account_id` | `validateId`, via `parseAccountId` (`investmentController.js`) |

**Absent and `null` keep their meaning.** On the three override endpoints and the two nullable transaction FKs, `null` — and, on the override endpoints, an absent field — means *clear the override / clear the FK* and answers **200**, unchanged. Only a **present but malformed** value rejects. On the commit and upload `account_id`, absent/`null` still means *no account for this batch*.

> [!warning] Breaking change (2026-08-11) — the seventh id-parser set converged
> These sites validated with `Number.isInteger(Number(value))`. That is a different sub-shape from the `parseInt` sites above and it looked sound, because it correctly rejects `"12abc"`. What it **accepts** is the problem: `Number("1e3")` is 1000, `Number("0x10")` is 16, `Number("0o17")` is 15, `Number(true)` is 1 and `Number([7])` is 7. A malformed value therefore did not fail validation — it named a **different, perfectly real record**, and every one of these sites is a **write**.
>
> The consequence is worse than on a read. An import staging row committed a transaction attributed to a recipient or category the user never picked; a portfolio row committed a lot against another instrument; the commit-time `account_id` is stamped on the batch, so *every* lot it commits inherited an account nobody named; and `PATCH /api/transactions/:id` re-attributed an existing ledger entry. The existence checks these sites run (`categoryExists`, `accountService.get`, `assertFundingAccountValid`) offered no protection, because they only ever saw the value **after** coercion — a retargeted id is a real id and passes them.
>
> Also newly rejected: `0` and negatives, which used to satisfy `Number.isInteger` and reached Postgres as an FK violation (a 500), and `""`, which coerced to `0` the same way.
>
> No shipped caller is affected: `lib/api/imports.ts`, `lib/api/portfolioImports.ts` and the transactions/accounts clients all type these fields as `number | null`, and the review pages take the ids from server-supplied rows rather than free text. The values above are reachable only from a direct API call.

> [!warning] Breaking change (2026-08-11) — the last two body FKs
> Two sites were missed by the sweep above and are now on `validateId` too.
>
> **`account_id` on the portfolio-transaction writes** was a bare `Number()` with **no integer check at all** — the weakest validator in the family. `'1e3'` booked the lot against account **1000**, `'0x10'` against 16, `true` against 1, `[7]` against 7 and `' 7 '` against 7, every one a **201**; `'12abc'` reached Postgres as `NaN` and 500'd. The PATCH forwarded the field raw through the repository's update allow-list, where Postgres' own hex-literal parsing turned `'0x10'` into account 16 and the rest into cast errors.
>
> **`category_id` on `POST /api/transactions`** had no guard whatsoever: the create schema validated `recipient_id` and `amount` and forwarded the rest raw, so `'12abc'`, `'1e3'`, `true`, `[7]` and `''` all reached Postgres as 22P02 and `0`/negatives as an FK violation — 500s on the create path for the app's core entity, and `'0x10'` a silent write to category 16 wherever that row exists. It now uses the same `nullableFkField` as the PATCH body.
>
> Absent/`null` semantics are unchanged and pinned: on transaction create both mean *uncategorized*; on portfolio-transaction create both mean *no brokerage account*; on the portfolio PATCH absent means *leave alone* and `null` means *unassign*.

---

### parsePositiveInt (AI-chat tool arguments)

The AI-chat tools' arguments arrive as JSON emitted by the model, not from a browser, and are validated by hand-rolled helpers in `services/aiChat/tools/_validate.js` (no zod — see `parseDate`, `parseEnum`, `parsePositiveInt`). Each throws `ToolValidationError`, which `dispatchTool` turns into `{ ok: false, error: { code: 'VALIDATION_ERROR', field, message } }` and feeds back to the model so it can correct its arguments and retry.

```javascript
parsePositiveInt(value, field, { min = 1, max = 1000, defaultValue = null })
```

**Rules:**
- `null`/`undefined` returns `defaultValue` (the tools' optional knobs)
- Shape is **`validateId`'s** — a plain base-10 digit string or an integer `number`, nothing else — so an id the model emits is parsed exactly like one arriving on a route
- `min`/`max` are the caller's own bounds and are checked separately from the shape: `limit` 1..500, `topN` 1..20, `year` 2000..2100, `minOccurrences` 2..20, and the id arguments (`categoryId`, `recipientId`, `plannedId`) 1..`Number.MAX_SAFE_INTEGER`
- The error message names the field, the bounds **and the received value** — the reader is a model deciding what to send next, so `"categoryId must be an integer between 1 and 9007199254740991 — received \"12.9\""` is actionable where the bounds alone are not

> [!warning] Breaking change (2026-08-11) — the fourth id parser converged
> This was `parseInt`, so `parsePositiveInt("12abc")` returned **12** and `"12.9"` returned **12**. On `categoryId`/`recipientId`/`plannedId` that meant a malformed id operated on the **wrong record** and returned a plausible answer. That is a worse failure here than anywhere else in the codebase: the caller is a model, so a rejection is something it can read and correct, while a silently wrong record is something nothing in the loop notices. `"12abc"`, `"12.9"`, `" 12 "` and `"1e3"` now all raise `ToolValidationError`.

---

## Best Practices

1. **Always validate user input** - Never trust client data
2. **Use type-specific validators** - Different data types need different validation
3. **Set appropriate limits** - Prevent buffer overflow and DoS
4. **Return clear error messages** - Help clients fix their requests
5. **Log validation failures** - Monitor for potential attacks

---

## CSV Formula Injection Prevention (CWE-1236)

CSV exports are vulnerable to formula injection when user-controllable data (recipient name, memo, comments) is written without sanitization. Attackers can craft malicious data that auto-executes in Excel or Google Sheets:

```
Malicious cell value: =cmd|'/c powershell ...'
Result when opened: Arbitrary code execution
```

### Prevention

All CSV exports use a centralized utility that prefixes dangerous leading characters (`=`, `+`, `-`, `@`, `\t` (tab), `\r` (carriage return)) with a single quote, rendering them as literal text. The check strips surrounding whitespace first to catch cases like `  = formula`:

```
Example: "  =formula" → trimmed to "=formula" → prefixed to "'=formula" (rendered as literal text)
```

**Implementation:** [[apps/node-backend/src/lib/csv.js|lib/csv.js]]

```js
export function escapeCsvValue(value) {
  if (value == null) return '';
  const stringValue = neutralizeCsvFormula(String(value));
  // Escape quotes and wrap if needed
  return stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
}
```

### Usage Rule

Every CSV export route **must** pass all user-controllable fields through `escapeCsvValue()`:

```js
import { escapeCsvValue } from '../lib/csv.js';

// Transaction export
const cols = [row.date, row.recipient_name, row.memo, row.comment];
const csv = cols.map(escapeCsvValue).join(',');

// Splits/owed transactions export
const cols = [row.recipient_name, row.memo, row.amount];
const csv = cols.map(escapeCsvValue).join(',');
```

### Compliance

- [[apps/node-backend/src/routes/transactions.js]] — `GET /api/transactions/export/csv` ✓
- [[apps/node-backend/src/routes/splits.js]] — `GET /api/splits/owed/:id/export/csv` ✓

---

## Outbound Request Guard — SSRF (2026-05-29)

Custom price-provider investments may carry user-supplied URLs (`price_provider_url`, `price_provider_latest_url`, `price_provider_history_url`) that the backend fetches server-side at price-refresh time. Without a guard, an attacker can point the server at internal services (cloud metadata endpoint `169.254.169.254`, Docker bridge siblings, loopback ports).

### Module

**[[apps/node-backend/src/lib/urlSafety.js]]** exports:

| Export | Description |
|--------|-------------|
| `assertPublicHttpUrl(url, opts)` | Validates a URL is safe to fetch. Throws `BlockedUrlError` on violation; returns parsed `URL` on success. Accepts `resolveDns` (default `true`) and injectable `lookup` for tests. |
| `isBlockedIpv4(ip)` | Returns `true` for private/loopback/link-local/CGNAT/unspecified IPv4 ranges |
| `isBlockedIpv6(ip)` | Returns `true` for loopback (`::1`, `::`), IPv4-mapped (`::ffff:`), ULA (`fc00::/7`), and link-local (`fe80::/10`) |
| `isBlockedAddress(ip)` | Dispatch to the above by address family; fails closed on unrecognized format |
| `BlockedUrlError` | Error subclass thrown on any violation |

**Blocked ranges (IPv4):** `0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` (CGNAT)

**Blocked ranges (IPv6):** `::1`, `::`, `::ffff:<blocked-ipv4>`, `fc00::/7`, `fe80::/10`

Non-`http`/`https` schemes (e.g. `file:`, `gopher:`, `data:`) are always rejected.

### Application Points

**Write boundary** (`investmentController.js` — `createInvestment` / `updateInvestment`):
- All three URL fields validated via `assertPublicHttpUrl(value, { resolveDns: false })` before the row is persisted.
- DNS is deliberately _not_ resolved at write time — that would couple investment writes to DNS availability. The scheme + IP-literal check is sufficient at the boundary.
- A failed check throws `ValidationError` → 400 response.

**Fetch boundary** (`priceProviderRegistry.js` — custom provider `_fetchJson`):
- `assertPublicHttpUrl` is called with full DNS resolution (`resolveDns: true`) before each fetch and again for every redirect hop (`redirect: 'manual'`).
- Response bodies are capped at **5 MB** to prevent memory exhaustion from a malicious server.
- This is the defense-in-depth layer that catches DNS-rebinding attacks and redirect chains to private hosts.

### Residual Risk

TOCTOU DNS rebinding (address changes between our lookup and Node's own TCP connection) is not fully closed by this guard. Pinning to a resolved IP via a custom `undici` dispatcher is the planned follow-up hardening if the custom-URL surface grows. See the module comment in `urlSafety.js` for details.

### Related

- [[docs/integrations/price-providers#custom-provider-url-constraints-2026-05-29|Price Providers — Custom URL constraints]]
- [[docs/reference/codebase-audit-2026-05|Codebase Audit 2026-05]] — SSRF finding that drove this fix

---

## CSS Injection Prevention (2026-05-29)

Report theme tokens are interpolated into a Puppeteer-rendered `:root {}` CSS block. Without constraints, a crafted value could inject arbitrary CSS or trigger a `url()`-based SSRF.

**Protection:** Each theme token is validated against `HSL_COMPONENT_RE` at both the Zod route boundary and the `themeCss.js` sink (defense-in-depth). Invalid tokens fall back to the mode default; the raw value is never interpolated.

```
HSL_COMPONENT_RE = /^\d{1,3}(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?%\s+\d{1,3}(?:\.\d+)?%$/
```

Valid example: `"250 84% 60%"` (bare HSL components without `hsl()` wrapper).

**Test coverage:** [[apps/node-backend/tests/themeCss.test.js]]

**Related:** [[docs/api/reports#css-injection-hardening-2026-05-29|Reports API — CSS Injection Hardening]]

---

## Related Security Topics

- [[docs/security/rate-limiting]] - Rate limiting to prevent abuse
- [[docs/adr/042-codeql-dependabot-remediation-2026-04]] - CodeQL fixes: CSV separator type coercion, path injection guards, ReDoS prevention
- [[docs/adr/002-database-schema]] - Database schema design
- [[docs/reference/code-patterns#safe-csv-export-pattern-phase-5]] - Safe CSV Export Pattern

## See Also

- [[docs/api/index]] - API Index
- [[docs/security/index]] - Security Documentation Index
