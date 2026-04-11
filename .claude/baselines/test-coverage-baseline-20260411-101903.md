# Test/Coverage Baseline

- Created: 2026-04-11 10:19:03 (local)
- Objective: `/test-coverage` loop baseline for sequential safe mode
- Branch at baseline creation: `loop/test-coverage-safe-20260411-101746`

## Baseline quality snapshot

### Required test gate (pre-loop)

- Command: `bun run test`
- Result: **PASS**
- Test files: **54 passed**
- Tests: **827 passed**

### Coverage snapshot

- Command: `bun vitest run --coverage` (from `apps/node-backend`)
- Result: **PASS**
- Statements: **81.81%** (4989/6098)
- Branches: **67.61%** (3259/4820)
- Functions: **85.42%** (639/748)
- Lines: **85.25%** (4642/5445)

## Baseline artifacts used

- Coverage directory: `apps/node-backend/coverage/`
- Coverage JSON: `apps/node-backend/coverage/coverage-final.json`
- Coverage HTML index: `apps/node-backend/coverage/index.html`

## Notes

- Existing repo changes were preserved (no stash/reset/revert used).
- Baseline intended for comparison at each loop checkpoint.
