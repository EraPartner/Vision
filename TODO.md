# TODO

Vision's live implementation queue. Priority: 🔺 highest, ⏫ high, 🔼 medium, 🔽 low,
⏬ lowest.

## Queue contract

- `- [ ]` means open. Revalidate the current code before implementing it.
- A completed and independently verified item is removed. Git history, tests, and the merged pull
  request are the completion record; this file is not an archive.
- Put evidence or a blocker on an indented `Tracking:` line. Do not put history in the title.
- Every finding has one owner-sized outcome. A dependency may be named, but unrelated work must be
  a separate item.
- `🔎 verified-present YYYY-MM-DD` means the issue was reproduced on that date.
- `🔎 partial YYYY-MM-DD` means only the stated remainder is open.
- `🔎 decision-needed YYYY-MM-DD` means implementation waits for a product or data decision.
- `🔎 runtime-unverified YYYY-MM-DD` means source work is complete but a live environment check is
  still required.
- `🔎 needs-GitHub-check YYYY-MM-DD` means the current platform state must be read from GitHub.

Run `bun run todo:list` for the concise queue and `bun run todo:check` for ledger hygiene.

## Continuation checkpoint — 2026-09-08

This is the current hand-off point after the complete TODO normalization audit. Do not repeat a
repository-wide audit before selecting work. The queue contains **5 open records and no checked
records**. The records are intentionally independent and fall into these states:

- **1 verified-present**: source work is still required; revalidate the named evidence, then
  implement one item at a time.
- **4 runtime-unverified**: source work is complete or substantially complete; perform only the
  named live database, Demo, browser, Electron, or external acceptance check.

Continue as follows:

1. Run `bun run todo:list -- --state verified` and choose one item by priority and subsystem.
2. Read its `Tracking:` line and source evidence. If it is `decision-needed`, stop and record the
   decision before implementation. If it is `runtime-unverified`, perform the named acceptance
   instead of reopening the implementation audit.
3. Keep one owner-sized outcome per change. Run the focused tests, `bun run todo:check`, and the
   relevant typecheck/lint before removing the item from this file.
4. Remove an item only after its complete stated scope is implemented and independently verified.
   Leave it here when a required external check is unavailable, with the exact blocker on
   `Tracking:`.

Important current hand-off facts:

- Portfolio per-broker history is deliberately last. Do not start it before the current-point
  broker surfaces have shipped and soaked.
- The queue includes real-export, live-database, and host-tool acceptance obligations. These are
  not reopened implementation defects; complete the named acceptance or leave the record open.
- No publication was performed. Inspect the working-tree diff and preserve unrelated changes
  before making the next implementation change.

## Binding constraints

- Keep the rich aurora, glass, jewel-accent, and hover design direction from ADR-105. Visual work
  refines that system; it does not flatten it into generic defaults.
- Use the Vision Demo app with synthetic data for browser and visual acceptance. Never use the real
  financial stack for UI testing.
- Database migrations require a downgrade path and disposable-database proof. Never apply a
  destructive migration or live-data cleanup without the user's explicit approval.
- Portfolio account work follows ADR-108: whole-lot broker tagging, global tax and cost-basis truth,
  and no synthetic trade cash legs.
- Per-broker history stays last. Do not start it before the current-point broker surfaces have
  shipped and soaked.

## Findings

### 🔒 Security and access control

### 💶 Financial and data correctness

### ⚡ Performance and scale

### 🧠 Insights and product semantics

### 🎨 User interface and accessibility

### 🏛️ API and architecture

### 🏦 Accounts and portfolio features

- [ ] **Build forward-only persisted per-broker history after current-point surfaces have soaked** 🔽
  - Tracking: 🔎 verified-present 2026-09-08 (the current-point broker surfaces are still working-tree changes, not an installed real-data build; soak means at least one week of normal local use with checks on three separate days, no partition/global-total discrepancy, and no broker-assignment defect)
  - ↪ _from: ADR-108 implementation plan · WP-C7_
  - Add a dedicated snapshot-by-account table, writer, endpoint, chart, backup coverage, downgrade,
    and per-date sum invariant. Do not retroactively synthesize history.

### 🧪 Runtime and external acceptance

- [ ] **Validate the portfolio import adapter against a real Degiro export** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-05 (requires a user-provided sanitized Degiro export)
  - ↪ _from: ADR-108 · WP-C2 acceptance_
  - Pin real column names, locale decimals, instrument-less rows, and noisy symbol cells in a fixture.

- [ ] **Validate the portfolio import adapter against a real IBKR export** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-05 (requires a user-provided sanitized IBKR export)
  - ↪ _from: ADR-108 · WP-C2 acceptance_
  - Pin real column names, locale decimals, instrument-less rows, and noisy symbol cells in a fixture.

- [ ] **Validate the portfolio import adapter against a real Bolero export** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-05 (requires a user-provided sanitized Bolero export)
  - ↪ _from: ADR-108 · WP-C2 acceptance_
  - Pin real column names, locale decimals, instrument-less rows, and noisy symbol cells in a fixture.

- [ ] **Validate the portfolio import adapter against a real Bitvavo export** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-05 (requires a user-provided sanitized Bitvavo export)
  - ↪ _from: ADR-108 · WP-C2 acceptance_
  - Pin real column names, locale decimals, instrument-less rows, and noisy symbol cells in a fixture.
