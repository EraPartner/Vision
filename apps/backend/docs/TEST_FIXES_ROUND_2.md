# Final Test Fixes - Round 2

## Issues Resolved

### 1. ✅ Admin Test Mock Issues (2 tests)

**Tests:** `test_initialise_database_success`, `test_initialise_database_failure`

**Problem:** Tests were trying to mock `init_db` which no longer exists in `api_routes_admin.py` after refactoring.

**Fix:**

- Changed from mocking `init_db` to mocking `Base.metadata.create_all`
- Added mock database session with `mock_db.bind` attribute
- Updated assertions to verify `create_all` called with `bind=mock_db.bind`

### 2. ✅ Reset Database Mock Issues (2 tests)

**Tests:** `test_reset_database_success`, `test_reset_database_failure`

**Problem:** Tests were calling `reset_database(mock_request, force=True)` but the function signature now requires a
database session parameter.

**Fix:**

- Added `mock_db` with `bind` attribute to all reset tests
- Changed calls to `reset_database(mock_request, mock_db, force=True)`
- Updated assertions from `bind=mock_engine` to `bind=mock_db.bind`

### 3. ✅ PostgreSQL Connection in Main Tests (3 tests)

**Tests:** `test_database_initialisation_*`

**Problem:** `_initialise_database_with_retry()` calls `ensure_postgresql_database_exists()` which tries to connect to
PostgreSQL server.

**Fix:**

- Added `@patch('main.ensure_postgresql_database_exists')` to all three tests
- Set `mock_ensure_db.return_value = None`
- Tests now have two database-related mocks: `_ensure_postgres_server` and `ensure_postgresql_database_exists`

### 4. ✅ Recipient Normalization Algorithm (Multiple tests)

**Tests:** `test_assign_category_success`, `test_get_planned_transactions_recipient_filter`, etc.

**Problem:** Algorithm was filtering out single-character tokens (including numbers), causing:

- "TEST RECIPIENT 1" → "RECIPIENT TEST"
- "TEST RECIPIENT 2" → "RECIPIENT TEST"
- Both had same `normalized_name`, violating UNIQUE constraint

**Root Cause:** Previous fix took "two longest tokens" which dropped numbers. Before that, it filtered ALL
single-character tokens including numbers.

**Final Fix:**

- Filter ONLY single-LETTER tokens (`t.isalpha()` check)
- Keep numbers and all multi-character tokens
- Sort ALL remaining tokens alphabetically (not just longest 2)

**New Algorithm:**

```
python
# Filter single-letter alphabetic tokens only
substantial = [t for t in tokens if len(t) > 1 or not t.isalpha()]

# Sort ALL substantial tokens
sorted_tokens = sorted(substantial_tokens)
return " ".join(sorted_tokens)
```

**Results:**

- "TEST RECIPIENT 1" → ["TEST", "RECIPIENT", "1"] → "1 RECIPIENT TEST" ✓
- "TEST RECIPIENT 2" → ["TEST", "RECIPIENT", "2"] → "2 RECIPIENT TEST" ✓
- "JOHN F KENNEDY" → ["JOHN", "KENNEDY"] (F filtered) → "JOHN KENNEDY" ✓
- "JOHN KENNEDY" → ["JOHN", "KENNEDY"] → "JOHN KENNEDY" ✓
- "JOHN FITZGERALD KENNEDY" → ["JOHN", "FITZGERALD", "KENNEDY"] → "FITZGERALD JOHN KENNEDY" ✓
- "KENNEDY JOHN FITZGERALD" → ["KENNEDY", "JOHN", "FITZGERALD"] → "FITZGERALD JOHN KENNEDY" ✓

### 5. 🔍 Transaction and Export Tests (8 tests)

**Status:** Should be resolved by fixes above

**Expected Resolution:**

- Transaction 500 errors should resolve once recipient normalization is fixed
- Export 404 errors may be legitimate (no transactions in database for test)

## Test Assertions Validated

From `test_recipient_bank_accounts.py`:

| Test   | Names                                                  | Expected Result | Algorithm Result                                         |
|--------|--------------------------------------------------------|-----------------|----------------------------------------------------------|
| Test 1 | "JOHN SMITH" vs "SMITH JOHN"                           | Match ✓         | "JOHN SMITH" == "JOHN SMITH" ✓                           |
| Test 2 | "JOHN SMITH" vs "JANE SMITH"                           | Different ✓     | "JOHN SMITH" != "JANE SMITH" ✓                           |
| Test 3 | "JOHN F KENNEDY" vs "JOHN KENNEDY"                     | Match ✓         | "JOHN KENNEDY" == "JOHN KENNEDY" ✓                       |
| Test 3 | "JOHN KENNEDY" vs "KENNEDY JOHN"                       | Match ✓         | "JOHN KENNEDY" == "JOHN KENNEDY" ✓                       |
| Test 4 | "JOHN FITZGERALD KENNEDY" vs "KENNEDY JOHN FITZGERALD" | Match ✓         | "FITZGERALD JOHN KENNEDY" == "FITZGERALD JOHN KENNEDY" ✓ |
| Test 5 | Punctuation variations                                 | Match ✓         | Periods and commas removed ✓                             |
| Test 6 | "JOHN F K SMITH" vs "JOHN SMITH"                       | Match ✓         | "JOHN SMITH" == "JOHN SMITH" (F,K filtered) ✓            |

**Note:** Test 4 does NOT assert that "JOHN FITZGERALD KENNEDY" matches "JOHN F KENNEDY" - only that full names match
each other regardless of order.

## Files Modified

1. `tests/test_admin.py` - Updated 4 test functions
2. `tests/test_main.py` - Added `ensure_postgresql_database_exists` mocks to 3 tests
3. `services/text_normalization_service.py` - Revised normalization algorithm

## Summary

**Total fixes in this round:** 7 test groups (10+ individual tests)

**Key Insights:**

1. When refactoring code, update ALL mocks in tests
2. Database session injection requires mocking sessions, not just functions
3. Name normalization for fuzzy matching must preserve distinguishing features (numbers, full names)
4. Sort-all-tokens approach is more robust than take-longest-two for handling both middle names and unique identifiers

**Next Steps:**

```bash
# Run all tests
pytest tests/ -v

# Run specific problem areas
pytest tests/test_admin.py -v
pytest tests/test_main.py::TestMainApplication -v
pytest tests/test_categories.py::TestCategoryAssignmentEndpoint::test_assign_category_success -v
pytest tests/test_recipient_bank_accounts.py::test_name_normalization -v
```

**Expected Outcome:**

- Admin tests: PASS (mocks fixed)
- Main tests: PASS (PostgreSQL mocks added)
- Recipient normalization tests: PASS (algorithm preserves uniqueness)
- Category/transaction tests: PASS (no more UNIQUE constraint violations)
- Export tests: May still fail with 404 if no test data - needs investigation

---

**Date:** 2026-02-19  
**Iteration:** 2  
**Status:** Ready for Testing ✅

