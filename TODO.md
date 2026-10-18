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

### Belgian tax correctness and household support

- [ ] **Revalidate all Belgian tax logic and implement household taxation with multiple income activities per partner** ⏫
  - Tracking: 🔎 partial 2026-10-10. An existing Belgian tax implementation is documented, including a single employment-type field; this is the baseline, not evidence that household or mixed-employment calculations are correct. The full rules review and support described below remain open. User-requested standalone planning item: keep this separate from the app walkthrough fixes and the missing tax-filing entry point. Budgeting, portfolio and research readiness is the user's assessment, not independently verified household support.
  - Outcome: A couple can manage family finances in one app and obtain Belgian tax calculations that correctly represent both people, their separate income activities, and their legally applicable individual or joint filing treatment. Preserve support for a single person and existing users. Deliver the rules review and implementation together; do not close this item after an investigation or a profile-form change alone.
  - Rules review: Inventory every existing Belgian tax rule and calculation path, including personal income tax, professional income and expenses, social contributions, withholding/prepayments, exemptions, dependents, deductions/credits, regional and municipal treatment, property income/tax, investment income and portfolio taxes, and historical-year calculations. Check each applicable rule against authoritative Belgian sources (FPS Finance, legislation, regional authorities and official social-security guidance as relevant). Record source links, effective dates, income year versus assessment year, eligibility, thresholds, rounding, interactions and implementation/test locations in a rule coverage matrix. Resolve discrepancies across frontend/backend calculations, estimates, exports and saved results; document unresolved interpretations and unsupported cases explicitly rather than claiming complete compliance.
  - Household model: Represent both partners independently, with income ownership, employment/activity records, relevant personal tax inputs, shared dependents and benefits, and the relationship/status dates needed to determine filing treatment. Research and implement the applicable treatment for marriage, legal cohabitation, factual cohabitation, separate assessment and joint assessment, including relevant transition years. Do not infer joint-filing eligibility merely from sharing accounts or living together, and do not treat a joint return as one combined income passed through a single person's brackets. Implement applicable partner allocations and mechanisms, including the marital quotient where legally eligible, from verified rules.
  - Multiple activities: Each person can have several concurrent or successive jobs/activities in the same income year; do not require one exclusive employment type for the entire person or household. Explicitly support the priority case of one person combining salaried employment (`in loondienst`) and self-employment (`zelfstandig`), including two part-time activities, while the other partner has their own independent activities. Research the conditions for self-employment as a main or secondary occupation rather than assuming part-time salaried work automatically establishes secondary-occupation eligibility. Track applicable income, activity dates/status, professional expenses, social contributions, withholding and prepayments per source, then apply the legally required aggregation and interactions without double counting deductions or income.
  - Financial attribution and workflow: Connect tax-relevant transactions, accounts and holdings to the appropriate person or shared ownership where needed, without assuming an account alone proves income ownership. Handle unassigned legacy data explicitly and preserve single-person calculations during migration. Support household/profile editing, year selection, per-person calculation breakdowns, household totals, supported reports/exports, and freeze/mark-as-filed/history with the full household and activity inputs preserved in each snapshot. Explain assumptions, missing inputs and unsupported scenarios in English and Dutch. Keep this focused on tax support; broader budgeting, portfolio or research changes require evidence that they are necessary for correct tax attribution.
  - Verification: Build an explicit scenario matrix covering a single salaried person; a single self-employed person; multiple salaried jobs; salaried plus self-employed work for one person; two salaried partners; salaried and self-employed partners; both partners with multiple activities; unequal/zero partner income; eligible joint versus separate filing; dependents and shared-benefit allocation; activity/relationship changes within a year; regional differences; and supported historical years. Add threshold, eligibility, allocation and rounding boundary cases. Compare results with independent official worked examples or official calculation tools where available, and record the inputs, year, expected breakdown and differences. Tests derived solely from current code or reproducing its formulas do not establish legal correctness. Validate persistence, migration/rollback, exports, saved filed results and native Demo behavior with synthetic households; never apply a migration to real user data without approval.
  - Completion: Fix confirmed rule defects and implement household/multiple-activity support, synchronize architecture, schema/API contracts and tax documentation, and run relevant tests, lint, typechecks, builds and locale validation. Report rule/scenario coverage, independently matched results, remaining limitations and unverified cases. Any unresolved rule affecting a required scenario keeps this item open; legal-source research and runtime acceptance must not be inferred from passing unit tests.
  - Starting points: `docs/features/belgian-tax.md`, `docs/features/portfolio-tax.md`, `apps/frontend/src/lib/belgianTax/`, `apps/frontend/src/contexts/BelgianTaxProfileContext.tsx`, the Belgian tax store and profile UI, corresponding backend persistence/calculations, and existing historical-year ADRs.
  - ↪ _from: User standalone Belgian tax review and household/mixed-employment feature request, 2026-10-10_
