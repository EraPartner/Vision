---
title: "ADR-199: Belgian tax rules are verified against primary sources per income year"
type: adr
status: accepted
date: 2026-10-11
tags: [adr, belgian-tax, tax-rules, sources, verification, adr-053, adr-056]
description: "Every rule and amount in the Belgian PIT engine must be traced to a primary source (FPS Finance indexation notices, fin.belgium.be, the laws) in a rule coverage matrix before it enters the code; PwC is a secondary cross-check only. Records the corrections the first audit produced: self-employed forfait, art. 88 quotient cap on the sum, CSSS single scale and household base, IY 2025 amounts frozen by the law of 18 December 2025, and the post-reform IY 2026 table."
aliases: [adr-199, belgian tax source verification, tax rule matrix]
---

# ADR-199: Belgian tax rules are verified against primary sources per income year

## Status

Accepted. The owner asked on 2026-10-11 that "the calculations have to be source verified".
Extends [[docs/adr/053-belgian-pit-exemption-bracket-correction|ADR-053]] and
[[docs/adr/056-belgian-tax-audit-fixes-ay2026|ADR-056]], whose figures came from PwC and
practitioner newsletters.

## Date

2026-10-11

## Context

The engine under `apps/frontend/src/lib/belgianTax/` carried amounts taken from secondary
sources (PwC Worldwide Tax Summaries, KPMG/Vialto/Loyens notes, Partena infoflashes) and several
estimates ("de-indexed", "typical year-over-year indexation"). Reading the primary sources showed
that some of those figures were wrong for the year they were attached to:

- PwC's IY 2025 dividend exemption (859), savings-interest exemption (1,050) and life-insurance
  cap (2,530) ignore the indexation freeze of the law of 18 December 2025; the FPS Finance
  indexation notice for AY 2026 prints 833, 1,020 and 2,450 "après gel".
- The special social security contribution (CSSS) single scale used the March 2022 wording and
  missed the 40,997.26 cut inserted by the law of 20 November 2022, overcharging incomes between
  40,997 and 60,182 by up to €132 a year. The joint scale was applied to the earner's income
  instead of the household income of art. 107, 2° of the law of 30 March 1994.
- Self-employed taxpayers got no lump-sum forfait, although art. 51 WIB 92 grants trading
  profits the employee forfait and fees a degressive scale.
- The marital quotient capped the transfer, while art. 88 caps the sum of the spouse's own
  income and the transferred part.
- Alimony stayed at 80% for 2025 (70% by law), the domestic-personnel reduction survived its
  abolition, and the IY 2024 quotient cap (13,070), exemption valuation cut (11,110) and
  domestic-help cap (8,030) were estimates (13,050 / 11,120 / 8,160 in the notice).
- The IY 2026 table was a copy of IY 2025, while the FPS indexation notice for AY 2027
  (3 August 2026) already applies the law of 15 July 2026 reforming the PIT.

## Decision

1. **Primary sources only.** A rule or amount enters `constants.ts`, `pit.ts` or
   `socialSecurity.ts` only when [[docs/reference/belgian-tax-rule-matrix]] names the primary
   page it was read from: the FPS Finance *Avis relatif à l'indexation automatique* for the
   assessment year (Fisconetplus), a fin.belgium.be page, or the law text on ejustice. PwC and
   practitioner notes are cross-checks and may not override a primary page.
2. **One matrix row per rule.** Each row carries the legal basis, the value per income year,
   the source id, the code location, the regression test and a status (`verified`, `derived`,
   `unverified`, `not modelled`). A value without a primary page keeps its previous value and is
   marked `unverified`, never silently re-estimated.
3. **Indexation notices win over consumer pages.** When fin.belgium.be and the indexation notice
   disagree (IY 2026 after the reform), the notice that post-dates the published law is used and
   the disagreement is recorded in the matrix.
4. **Corrections applied with this ADR** (all with regression tests citing the source):
   - IY 2024: exemption valuation cut 11,120; marital quotient cap 13,050; domestic-help cap
     8,160; fees forfait scale 7,310 / 14,520 / 24,160, cap 5,050.
   - IY 2025: dividends 833; savings interest 1,020; life insurance 2,450; alimony 70%;
     domestic-personnel reduction 0; fees forfait scale 7,540 / 14,970 / 24,920, cap 5,210.
   - IY 2026: brackets 16,720 / 29,510 / 51,070; exemption valuation 11,750 / 16,720 / 27,860 /
     51,070; basic exemption 11,550; children 2,130 / 5,130 / 11,440 / 18,510; disabled 2,030;
     forfait caps 6,070 / 3,200 / 5,340; childcare 17.30; alimony 60%; quotient cap 11,780.
   - CSSS single scale: 335.50 + 4.009% to 40,997.26, then 481.96 + 1.2996% to 60,181.95, then
     731.28; joint upper cut 81,944.00; joint base = earner net professional income + spouse
     professional income.
   - Self-employed forfait: new optional profile field `selfEmployedIncomeKind`
     (`profits` default → employee forfait; `fees` → art. 51 al. 2, 4° scale). The backend
     settings schema accepts the field.
   - Marital quotient: target = min(30% of household professional income, cap); transfer =
     target − spouse income.
   - Backend `services/reports/belgianTaxTables.ts` dividend exemption 833 for 2025 and 2026.
   - User-facing EN/NL copy with hard-coded amounts updated (dividends, savings, life
     insurance, pension savings, alimony).

## Consequences

- Positive: every number in the engine is auditable; wrong secondary figures were removed;
  IY 2026 estimates now follow the published reform.
- Negative: rows marked `unverified` (civil-servant rate 11.07%, regional property tax,
  regional own-home credits, Wallonia/Brussels surtax factors, cadastral coefficients after
  2024, service-voucher regional amounts) stay as they were until the regional sites
  (vlaanderen.be, wallonie.be, Brussels) are reachable from the sandbox; they are listed in the
  matrix's open items.
- Neutral: the quotient's 66+ cap, the refundable child tax credit, the low-income
  isolated-parent supplement, the helping-spouse forfait and self-employed social
  contributions are documented as not modelled; they belong to the household work that follows
  this ADR.
- Frozen or filed years are unaffected: as-filed calculations stay as captured
  ([[docs/adr/059-belgian-tax-historical-year-extensions|ADR-059]]); live recomputation of
  past years changes with the corrected tables.

## Related

- [[docs/reference/belgian-tax-rule-matrix]]
- [[docs/features/belgian-tax]]
- [[docs/adr/053-belgian-pit-exemption-bracket-correction|ADR-053]]
- [[docs/adr/056-belgian-tax-audit-fixes-ay2026|ADR-056]]
- [[docs/adr/index|All ADRs]]
