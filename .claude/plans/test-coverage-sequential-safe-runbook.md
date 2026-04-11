# Loop Runbook: Test Coverage (Sequential Safe)

## Loop config

- Pattern: `sequential`
- Mode: `safe`
- Objective: repeatedly run `/test-coverage` and add/fix tests until coverage targets are met while suite remains green.

## Preflight checks (must pass)

1. Quality gates active and passing
   - `bun run test`
2. Eval baseline exists
   - `.claude/baselines/test-coverage-baseline-20260411-101903.md`
3. Rollback path exists
   - Return branch target: `main`
4. Branch/worktree isolation configured
   - Working branch: `loop/test-coverage-safe-20260411-101746`
5. ECC hooks profile not globally disabled
   - Session env must resolve to `ECC_HOOK_PROFILE=standard` (or stricter)

## Explicit stop condition

Stop the loop when **all** are true:

1. Coverage target met (minimum):
   - Statements >= 85%
   - Branches >= 75%
   - Functions >= 88%
   - Lines >= 88%
2. `bun run test` passes
3. `bun vitest run --coverage` passes
4. No regressions versus baseline in critical areas under active modification

## Start command (safe sequential loop)

```bash
ECC_HOOK_PROFILE=standard /loop-start sequential --mode safe
```

## Per-iteration command set

1. Run coverage and identify gaps:

```bash
bun vitest run --coverage
```

2. Implement only test-focused changes.

3. Verify quality gates:

```bash
bun run test && bun vitest run --coverage
```

4. Record checkpoint:
   - coverage deltas vs baseline
   - changed test files
   - pass/fail outcome

## Monitor commands

```bash
git status --short --branch
```

```bash
bun run test
```

```bash
cd apps/node-backend && bun vitest run --coverage
```

```bash
ls .claude/baselines
```

## Escalation rules

Escalate/pause and reduce scope when any occurs:

- No progress across two consecutive checkpoints
- Repeated failures with identical stack traces
- Cost drift outside budget window
- Merge conflicts blocking queue advancement

## Recovery actions

1. Pause loop execution.
2. Narrow scope to one failing module or route at a time.
3. Re-run `bun run test` and targeted coverage check.
4. Resume only after verification passes.
