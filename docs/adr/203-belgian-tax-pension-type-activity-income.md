---
title: "ADR-203: The pension type follows the tax return and decides the art. 147 exclusion of activity income"
type: adr
status: accepted
date: 2026-10-12
tags: [adr, belgian-tax, household, pension-reduction, marital-quotient, adr-200]
description: "Adds the optional `pensionKind` to a household pension activity, split as in box V of the tax return (codes 1228 / 1229 / 1211). The engine leaves a pensioner's activity income out of the art. 147 al. 1, 2° proportion (art. 147 al. 1, 2°, b-c), tests the statutory-pension limit on the gross amount (AAFisc 40/2011 no. 22), keeps the art. 153 limit on the total net income and applies AAFisc 40/2011 no. 19 under the marital quotient."
aliases: [adr-203, pension type, art. 147 activity income exclusion]
---

# ADR-203: The pension type follows the tax return and decides the art. 147 exclusion of activity income

## Status

Accepted on 2026-10-12. Extends [[docs/adr/200-belgian-tax-household-model|ADR-200]]; supersedes
nothing.

## Date

2026-10-12

## Context

The reduction for pensions of a taxpayer whose net income is only partly pensions is the
proportion net pensions / net income. WIB 92 art. 147 al. 1, 2°, b-c leave the activity income
out of that net income in full for a taxpayer who has reached the legal pension age and receives
a statutory pension of at most 10,160 (base; 19,630 for income 2025), or who receives a survivor's
pension or transition allowance, and in part, (upper − pension) / (upper − lower) (al. 3), for a
statutory pension up to 14,900 (base; 28,780). The FPS indexation notices publish the al. 3
denominator as an indexed amount of its own (base 4,740): 8,880 for income 2024, 9,160 for income
2025 and 9,380 for income 2026, where the literal upper − lower gives 8,870, 9,150 and 9,380 (N25,
N26, N27). Until now the household recorded neither the statutory pension nor the pension age, so
the engine used the plain proportion and raised `pension_reduction_activity_income_not_excluded`.

The tax return already asks the taxpayer to make that classification: part 1, box V, A.1 has
separate lines for statutory pensions received from the legal pension age (code 1228/2228),
survivor's pensions and transition allowances (1229/2229) and other jointly taxable pensions
(1211/2211), each with a line for the public-sector pension of December (1314, 1315, 1316) that is
also jointly taxable, and a line for arrears (1230, 1231, 1212). Sources: A147, C82 (no. 11), C40
(nos 17-22 and the worked example), N25-N27 and the return (RET26) in [[docs/reference/belgian-tax-rule-matrix|the rule matrix]].

## Decision

1. **Input.** `IncomeActivity.pensionKind` (`statutory_from_legal_age`, `survivor_or_transition`,
   `other`), optional and only allowed on a `pension` activity (both zod schemas). The user picks
   the return line, so the engine needs no birth date or pension age. Undefined keeps the old
   behaviour; the v1 upgrade never sets it, and a kind change away from `pension` (editor or v1
   patch) drops it. The tax dialog offers "Not entered", which stores no type. The type covers the
   ordinary line and the December public-sector line of each sub-line (1228/1314, 1229/1315,
   1211/1316). Arrears (1230, 1231, 1212) are taxed separately (art. 171) and stay outside the
   engine's jointly taxable model, so they are not entered as a pension activity.
2. **Limit test on the gross.** The statutory pension compared with the limits is the sum of the
   gross amounts of the `statutory_from_legal_age` activities (AAFisc 40/2011 no. 22). The limits
   are a separate table field, `pensionReduction.statutoryPensionLimits`, although their values
   equal the art. 151/1 limits. Its `difference` is the al. 3 denominator as the FPS notice
   publishes it (8,880 / 9,160 / 9,380), not upper − lower (8,870 / 9,150 / 9,380): the notices
   are the administration's indexed amounts and the engine follows them. The partial fraction is
   (upper − gross statutory pension) / `difference`, capped to [0, 1].
3. **Activity income.** Art. 147 al. 2: "Onder activiteitsinkomsten als bedoeld in het eerste
   lid, 2°, wordt verstaan de beroepsinkomsten verminderd met: 1° de in artikel 23, § 1, 5°,
   bedoelde inkomsten; 2° de vergoedingen verkregen tot volledig of gedeeltelijk herstel van een
   tijdelijke derving van inkomsten." AAFisc 40/2011 no. 20 reads it as the net professional
   income less "het nettobedrag van de pensioenen, renten en als zodanig geldende toelagen" and
   "het nettobedrag van de vergoedingen verkregen tot volledig of gedeeltelijk herstel van een
   tijdelijke derving van inkomsten". So pensions and other replacement income (sickness,
   invalidity, unemployment) are not activity income. The `pension` activity kind holds
   "pensions and replacement income (art. 34)", so replacement income must be recorded there; the
   engine computes activity income as the net professional income less the net income of the
   `pension` activities. Income under `other_professional` or `net_professional_amount` counts as
   activity income, and when an exclusion applies the engine raises the info issue
   `pension_exclusion_other_income_counted_as_activity` so the user can move replacement income
   recorded there. A survivor's pension excludes the activity income in full whatever the
   statutory pension (no. 18: the lowest denominator wins).
4. **Art. 153 keeps the total net income.** Only the art. 147 proportion uses the reduced
   denominator; the limit "tax × pensions / total net income" does not (AAFisc 40/2011, worked
   example: 22,014.47 against 22,014.47 − 3,131.12).
5. **Marital quotient** (AAFisc 40/2011 no. 19). The receiving spouse also leaves out the
   transferor's activity income contained in the quotient (transfer × activity income / net
   professional income of the transferor, times the transferor's exclusion fraction; no. 19, a)
   and their own excluded activity income (no. 19, c). The transferor's own figures are measured
   after the transfer. No. 19 a only covers a transferor who meets no. 17 a or b, that is a full
   exclusion; the partial exclusion of al. 3 exists since AY 2020 and circular 2020/C/82 does not
   address the quotient. Carrying a partial transferor's fraction over pro rata is therefore an
   interpretation: the engine keeps it and raises `pension_quotient_partial_exclusion_unverified`
   (`needs_source`, for the receiving spouse) when a quotient applies and the transferor's
   fraction is strictly between 0 and 1. The other readings are the strict no. 19 a (nothing of
   a partial transferor's activity income leaves the receiver's proportion) and, for a receiver
   who meets no. 19 c, all the activity income contained in the quotient (scenario JP-04).
6. **Issues.** `pension_reduction_activity_income_not_excluded` (warning) is raised only when a
   pension activity has no type and activity income is in the proportion, for the partner and, under
   the quotient, for the receiving spouse. With typed and untyped pensions side by side, the
   untyped one leaves the outcome open unless the partner also has a survivor's pension: without
   one the engine uses fraction 0 (the plain proportion the warning describes); with one the
   exclusion is full whatever the untyped pension is, so the warning is not raised.
   `pension_exclusion_other_income_counted_as_activity` (info) and
   `pension_quotient_partial_exclusion_unverified` (needs_source) are described above.

## Consequences

- A pensioner with activity income who enters the pension type gets the reduction the law gives;
  stored households keep their results until the type is entered.
- The v1 engine is unchanged: a v1 person is either retired or active, so nothing is excluded.
- Other replacement income (sickness, unemployment) recorded as a `pension` activity is treated
  as pensions for the reduction (its own reductions, art. 147 al. 1, 3°-10°, are not modelled) and
  is kept out of the activity income as al. 2 requires. The art. 147 cases for bridging-pension
  supplements (AAFisc 40/2011 no. 17 c-d) stay out of scope.
- Separately taxed pension arrears (box V codes 1230, 1231, 1212) are outside the engine's
  jointly taxable model.

## Related

- [[docs/adr/200-belgian-tax-household-model|ADR-200]]
- [[docs/reference/belgian-tax-rule-matrix|Belgian Tax Rule Coverage Matrix]]
- [[docs/reference/belgian-tax-scenario-matrix|Belgian Tax Scenario Matrix]]
- [[docs/features/belgian-tax]]
- [[docs/adr/index|All ADRs]]
