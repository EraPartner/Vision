# TODO

Vision's live implementation queue. Completed findings and earlier planning remain in Git history
and the relevant project docs.

## Queue contract

- `- [ ]` means open. Revalidate the current code before implementing it.
- Remove completed findings after implementation and required checks; this file is not an archive.
- Record user-waived optional checks in the delivery record without describing them as passed.
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

The October codebase audit, walkthrough remediation and selective test cleanup implementation
are delivered under the user's explicit waiver of further optional verification. Implementation
results and unexecuted acceptance checks are preserved in
[the implementation delivery ledger](docs/testing/codebase-audit-delivery.md). The original audit warning's cause remains unconfirmed;
no unexecuted live check is recorded as passed.
