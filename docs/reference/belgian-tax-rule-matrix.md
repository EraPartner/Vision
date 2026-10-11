---
title: Belgian Tax Rule Coverage Matrix
type: reference
status: active
date: 2026-10-11
updated: 2026-10-11
tags: [reference, belgian-tax, tax-rules, sources, verification]
description: One row per Belgian personal income tax rule the engine applies, with the legal basis, the primary source opened for each income year (2024-2026), the code location, the regression test and the verification status.
aliases: [belgian tax rule matrix, tax rule coverage, tax sources]
---

# Belgian Tax Rule Coverage Matrix

> [!abstract] Overview
> This matrix is the audit trail for every rule in the Belgian personal income tax (PIT) engine
> under `apps/frontend/src/lib/belgianTax/`. A value may only enter `constants.ts` when a row here
> names the primary page it was read from. Rows marked **unverified** keep their previous value
> and are listed in [[#Open items]]. Income year (IY) = the year the income is earned;
> assessment year (AY) = IY + 1. The feature itself is described in
> [[docs/features/belgian-tax]]; the decision to source-verify is
> [[docs/adr/199-belgian-tax-source-verification|ADR-199]].

## Sources

All pages were opened on 2026-10-11 from the agent sandbox. The FPS Finance indexation notices are
the authoritative list of indexed amounts per assessment year; the consumer pages on
fin.belgium.be explain the rules; the laws give the rule text.

| Id  | Source                                                                                                                         | Covers                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| N25 | FPS Finance, *Avis relatif à l'indexation automatique — exercice d'imposition 2025* (Fisconetplus `15618a3b-1ef1-4baa-a454-bdc34e1c5586`, 2024-02-28) | Every indexed amount for IY 2024                                   |
| N26 | FPS Finance, *Avis … exercice d'imposition 2026* (Fisconetplus `934106e5-36bd-4f61-8928-ba9ca100727f`, 2025-01-21, updated 2026-01-19 for the freeze) | Every indexed amount for IY 2025, with "après gel" values          |
| N27 | FPS Finance, *Avis … exercice d'imposition 2027* (Fisconetplus `042cb526-403e-4f40-9a45-dbccd0a12583`, 2026-08-03)            | Every indexed amount for IY 2026, after the law of 15 July 2026    |
| F1  | fin.belgium.be › Belastingtarieven                                                                                              | Brackets and basic exemption IY 2025/2026 (pre-reform IY 2026)     |
| F2  | fin.belgium.be › Huwelijk en samenwonen                                                                                         | Joint vs separate assessment, marital quotient cap (pre-reform IY 2026) |
| F3  | fin.belgium.be › Kinderen ten laste; › Andere personen ten laste; › Zware handicap                                             | Dependent and disability supplements, child tax credit             |
| F4  | fin.belgium.be › Beroepsinkomen                                                                                                 | Professional-expense forfaits IY 2025/2026                         |
| F5  | fin.belgium.be › Vrijstellingen dividenden; › Spaargeld en beleggingen                                                         | Dividend and savings-interest exemptions                           |
| F6  | fin.belgium.be › Pensioensparen; › Giften; › Kinderopvang; › Betaald onderhoudsgeld; › Diensten- of PWA-cheques; › Hypothecaire lening | Tax reductions                                                     |
| F7  | fin.belgium.be › Bedragen van voorgaande jaren                                                                                 | IY 2024 and IY 2023 amounts                                        |
| L1  | Law of 18 December 2025 *houdende diverse bepalingen* (BS 30-12-2025, Justel 2025009647)                                         | Indexation freeze AY 2026-2030, donations 30%, alimony 70/60/50%, domestic-help reduction abolished, child tax credit 550 |
| L2  | Law of 15 July 2026 *tot hervorming van de personenbelasting* (BS 29-07-2026, Justel 2026005724)                                 | Arts 131-134, 87-88, 126 from AY 2027; CSSS and surcharge changes from AY 2029 |
| L3  | Law of 30 March 1994 *houdende sociale bepalingen*, arts 106-110 (Justel 1994021117, consolidated)                               | Special social security contribution (CSSS)                        |
| L4  | WIB 92 on Justel (1992041050; text not updated since 2002, wording only) and Codex Vlaanderen (2011 consolidation)              | Article structure of arts 51, 86-89, 126, 131-134                  |
| R1  | RSVZ, *Hoeveel sociale bijdragen moet ik betalen?*                                                                              | Self-employed social contributions 2026                            |
| P1  | PwC Worldwide Tax Summaries, Belgium — Individual (taxes on personal income, deductions, other taxes, sample calculation; reviewed 10 Sep 2026) | Secondary cross-check only                                         |

> [!warning] PwC figures that disagree with the primary sources
> PwC lists IY 2025 dividends 859, savings interest 1,050 and life insurance 2,530. N26 prints
> these as "1.050 — après gel: 1.020", "860 — après gel: 833" and "2.530 — après gel: 2.450": the
> law of 18 December 2025 froze them at the AY 2025 level. The engine follows N26.

> [!note] IY 2026 (AY 2027)
> N27 (3 Aug 2026) already applies the law of 15 July 2026. On 2026-10-11 the consumer pages F1,
> F2 and F3 still showed pre-reform IY 2026 figures (basic exemption 11,180, one child 2,030,
> quotient cap 13,800). The engine follows N27, and N27 is reproducible from the law: L2 art. 2
> sets the art. 131 base amount to 4,945 and N27 point A states the art. 178 §2 coefficient for
> AY 2027 as 2.3356 (average 2025 index 135.30 / average 1988 index 57.93); 4,945 × 2.3356 =
> 11,549.5, rounded to 11,550. N27 table I lists base and indexed amounts for every art. 131-134 figure used here.

## Legend

- **Status**: `verified` = read on the named primary page; `derived` = computed from a verified
  rule and stated as such; `unverified` = value kept from before this audit, no primary page
  reached yet; `not modelled` = rule known, not in the engine.
- **Code**: file under `apps/frontend/src/lib/belgianTax/` unless stated.
- **Tests**: `pit.test.ts` under `apps/frontend/src/lib/belgianTax/__tests__/` unless stated.

## Progressive tax and exemptions

| Rule                                            | Legal basis                     | IY 2024                             | IY 2025                             | IY 2026                               | Source        | Code                                      | Tests                                        | Status   |
| ----------------------------------------------- | ------------------------------- | ----------------------------------- | ----------------------------------- | ------------------------------------- | ------------- | ----------------------------------------- | -------------------------------------------- | -------- |
| Bracket boundaries (25/40/45/50%)               | WIB 92 art. 130                 | 15,820 / 27,920 / 48,320            | 16,320 / 28,800 / 49,840            | 16,720 / 29,510 / 51,070              | N25, N26, N27, F1 | `constants.ts` `brackets`              | "IY 2024 tables apply", "IY 2026 table carries…" | verified |
| Exemption valuation scale (25/30/40/45/50%)     | WIB 92 art. 134 §2 al. 2        | 11,120 / 15,820 / 26,360 / 48,320   | 11,460 / 16,320 / 27,190 / 49,840   | 11,750 / 16,720 / 27,860 / 51,070     | N25, N26, N27; P1 sample confirms IY 2025 | `constants.ts` `exemptionBrackets`, `pit.ts` `computeExemptionBenefit` | "exemption straddling two brackets", "IY 2024 exemption valuation brackets" | verified (IY 2024 corrected from 11,110) |
| Basic exemption                                 | WIB 92 art. 131 al. 1           | 10,570                              | 10,910                              | 11,550 (base 4,945 after L2 art. 2)   | N25, N26, N27 | `basicPersonalExemption`                  | "IY 2024 tables apply", "IY 2026 table carries…" | verified |
| Disabled taxpayer / spouse supplement           | WIB 92 art. 131 al. 3           | 1,920                               | 1,980                               | 2,030                                 | N25, N26, N27, F3 | `disabledSupplement`                   | —                                            | verified |
| Children supplements 1-4                        | WIB 92 art. 132 al. 1, 1°-4°    | 1,920 / 4,950 / 11,090 / 17,940     | 1,980 / 5,110 / 11,440 / 18,510     | 2,130 / 5,130 / 11,440 / 18,510 (L2 arts 5, 13) | N25, N26, N27, F3 | `dependentChildExemptionIncreases`  | PwC sample test (2 children)                 | verified |
| Each child beyond the fourth                    | art. 132 al. 1, 5°              | 6,850                               | 7,070                               | 7,070                                 | N25, N26, N27, F3 | `extraChildExemptionFromFifth`         | —                                            | verified |
| Child under 3 without childcare reduction       | art. 132 al. 1, 6°              | 720                                 | 740                                 | 740                                   | N25, N26, N27, F3 | `childUnder3Supplement`                | "child under 3" tests                        | verified |
| Other dependent                                 | art. 132 al. 1, 8°              | 1,920                               | 1,980                               | 1,980                                 | N25, N26, N27, F3 | `otherDependentExemption`              | —                                            | verified |
| Dependent 66+ in a situation of dependence      | art. 132 al. 1, 7°              | 5,770                               | 5,950                               | 5,950                                 | N25, N26, N27, F3 | —                                      | —                                            | not modelled (profile has one "other dependent" count) |
| Disabled dependent counts twice                 | WIB 92 art. 132bis / 136        | ×2                                  | ×2                                  | ×2                                    | F3 ("twee kinderen ten laste") | `computePersonalExemption`     | "disabled child" tests                       | verified (rule) |
| Isolated parent supplement                      | art. 133 al. 1, 1°              | 1,920                               | 1,980                               | 1,980                                 | N25, N26, N27, F3 | `isolatedParentSupplement`             | —                                            | verified; the extra low-income supplement of art. 133 al. 2-3 (1,290 max) is not modelled |
| Refundable child tax credit                     | art. 134 §3 al. 2               | 550 per child                       | 550 (L1 art. 42, no longer indexed) | 550                                   | N25, N26, F3, L1 | —                                      | —                                            | not modelled |
| Each spouse's taxable income is set and taxed separately under the joint assessment (décumul) | art. 126 §1 al. 2 ("het belastbare inkomen van elke echtgenoot afzonderlijk wordt vastgesteld"), art. 127 | rule | rule | rule | L4 | `applyMaritalQuotient` (no-quotient baseline now includes the spouse's own tax) | "joint assessment taxes the spouse's own income even when no quotient applies" | verified (previously the spouse's tax was dropped when no quotient applied, and the art. 88 comparison was made against the earner's tax alone) |
| Supplements go to the spouse with the higher taxable income | art. 134 §4             | rule                                | rule                                | rule (L2 art. 10 l) from AY 2030)     | L4, P1 sample | `applyMaritalQuotient` (spouse keeps basic exemption only) | PwC sample test              | verified for the single-earner case; general allocation is Phase B |

## Professional expenses (forfait)

| Rule                                    | Legal basis                 | IY 2024                              | IY 2025                              | IY 2026                              | Source        | Code                                   | Tests                                        | Status   |
| --------------------------------------- | --------------------------- | ------------------------------------ | ------------------------------------ | ------------------------------------ | ------------- | -------------------------------------- | -------------------------------------------- | -------- |
| Employees, civil servants and trading profits (winsten): 30%, capped | art. 51 al. 2, 1° and al. 3 | cap 5,750                 | cap 5,930                            | cap 6,070                            | N25, N26, N27, F4 | `employeeProfessionalExpense*`, `computeProfessionalExpenses` | "employee forfait", "self-employed trading profits" | verified (self-employed profits previously got no forfait) |
| Forfait base = gross income minus the art. 52, 7° social contributions | art. 51 al. 1 ("vooraf verminderd met voormelde bijdragen") | rule | rule | rule | L4 art. 51 al. 1, F4 ("brutoberoepsinkomen (verminderd met bijdragen)") | `computeProfessionalExpenses` (receives `employeeSS`) | "employee forfait is computed on gross pay after the 13.07% contribution" | verified (previously computed on gross pay before contributions; affects pay below about 22,700 in IY 2025) |
| Company directors: 3%, capped           | art. 51 al. 2, 2° and al. 3 | cap 3,030                            | cap 3,130                            | cap 3,200                            | N25, N26, N27, F4 | `directorProfessionalExpense*`      | "director forfait"                           | verified |
| Fees (baten): 28.7% / 10% / 5% / 3%, capped | art. 51 al. 2, 4° and al. 3 | 7,310 / 14,520 / 24,160; cap 5,050 | 7,540 / 14,970 / 24,920; cap 5,210  | 7,720 / 15,340 / 25,530; cap 5,340   | N25, N26, N27 (boundaries, caps); L4 (rates) | `selfEmployedFeesExpense*`     | "self-employed fees (baten)"                 | verified; the rates come from the 2011 consolidation and L2 does not amend them |
| Helping spouse: 5%, capped              | art. 51 al. 2, 3°           | cap 5,050                            | cap 5,210                            | cap 5,340                            | N25, N26, N27, F4 | —                                   | —                                            | not modelled (Phase B) |
| Pensions and replacement income: no forfait | art. 51 al. 1           | 0                                    | 0                                    | 0                                    | L4            | `computeProfessionalExpenses`          | "pensions and other income carry no forfait" | verified (rule) |

## Deductions from the taxable base

| Rule                      | Legal basis    | IY 2024 | IY 2025 | IY 2026 | Source  | Code                         | Tests                                  | Status   |
| ------------------------- | -------------- | ------- | ------- | ------- | ------- | ---------------------------- | -------------------------------------- | -------- |
| Alimony paid, deductible share | art. 104, 1°-2° | 80%  | 70%     | 60% (50% from 2027) | L1 art. 35, F6 | `alimonyDeductibleFraction` | "alimony deductible at 80% (2024), 70% (2025) and 60% (2026)" | verified (IY 2025 corrected from 80%) |

## Tax reductions

| Rule                                       | Legal basis            | IY 2024                 | IY 2025                      | IY 2026                      | Source             | Code                               | Tests                                           | Status   |
| ------------------------------------------ | ---------------------- | ----------------------- | ---------------------------- | ---------------------------- | ------------------ | ---------------------------------- | ----------------------------------------------- | -------- |
| Pension savings 30% / 25%                  | art. 145/8 §1 al. 2-3  | 1,020 / 1,310           | 1,050 / 1,350                | 1,050 / 1,350 (L1 art. 43 d) | N26, N27, F6, F7   | `pensionSavings*`                  | "pension savings" tests                         | verified |
| Long-term savings / life insurance 30%     | art. 145/1, 145/6      | 2,450 (15% to 2,040 + 6%) | 2,450 ("après gel")        | 2,450                        | N25, N26, N27      | `lifeInsuranceCap`, `lifeInsuranceRate` | "life insurance reduction cap is €2,450"   | verified for the cap (IY 2025 corrected from 2,530); the two-step 15%/6% formula is simplified to a cap |
| Donations: rate, minimum, cap              | art. 145/33            | 45%, 40, 408,130        | 30%, 40, 408,130             | 30%, 40, 408,130             | L1 art. 67, F6, F7, N26, N27 | `charitableDonation*`     | "donations" tests                               | verified |
| Donations capped at 10% of net income      | art. 145/33 §1 al. 4   | rule                    | rule                         | rule                         | F6                 | `pit.ts` donation block            | —                                               | verified (rule) |
| Childcare 45%, daily cap                   | art. 145/35            | 16.40                   | 16.90                        | 17.30                        | N25, N26, N27, F6  | `childcare*`                       | "childcare" tests                               | verified; the 75% rate for low-income isolated parents is not modelled |
| Domestic personnel 30%, wage cap           | art. 145/34            | 8,160                   | abolished (L1 art. 68, from AY 2026 per art. 90) | abolished             | N25, N26, L1       | `domesticHelp*`                    | "domestic help credit: €8,160 wage cap for IY 2024, abolished from IY 2025" | verified (IY 2024 corrected from 8,030) |
| Service and PWA vouchers: federal expense cap per taxpayer | art. 145/21 (regionalised) | 1,790     | 1,850                        | 1,890                        | F6, F7             | —                                  | —                                               | not modelled (the engine caps by voucher count) |
| Service vouchers: Flanders abolished from 2025 | Flemish decree, via F6 | 20% (regional)        | 0                            | 0                            | F6                 | `serviceVoucherRegional.flanders`  | —                                               | verified for 2025+; IY 2024 Flemish rate unverified |
| Service vouchers: Wallonia €0.90 × 150, Brussels 15% × 172 | regional decrees | as code              | as code                      | as code                      | —                  | `serviceVoucherRegional`           | "service vouchers" tests                        | unverified (wallonie.be and Brussels pages not reachable) |
| Employee group insurance 30%               | art. 145/1, 1°         | 30%, no cap             | 30%                          | 30%                          | —                  | `groupInsuranceRate`               | —                                               | unverified (cap missing; see open items) |

## Marital quotient and joint assessment

| Rule                                        | Legal basis                       | IY 2024 | IY 2025 | IY 2026                                       | Source            | Code                        | Tests                                               | Status   |
| ------------------------------------------- | --------------------------------- | ------- | ------- | --------------------------------------------- | ----------------- | --------------------------- | --------------------------------------------------- | -------- |
| Joint assessment from the year after marriage or legal cohabitation; separate in the year itself, on separation and for factual cohabitants | art. 126 §§1-2 | rule | rule | rule | F2, L4 | `filingStatus` (user-chosen) | — | verified (rule); automatic derivation from dates is Phase B |
| Separate assessment when a spouse has treaty-exempt income above the threshold | art. 126 §2 al. 1, 4° | 13,050 | 13,460 | basic exemption (L2 art. 32) | N25, N26, L2 | — | — | not modelled |
| Quotient: 30% of the earner's income to a spouse without income, capped | art. 87 | cap 13,050 | cap 13,460 | cap 11,780; 12,790 when both spouses are 66+ (L2 arts 27, 30) | N25, N26, N27, F2, F7 | `maritalQuotientCap`, `applyMaritalQuotient` | "single-earner couple", "IY 2024 … (€13,050)", "IY 2026 … €11,780" | verified (IY 2024 corrected from 13,070); the 66+ cap needs birth years (Phase B) |
| Quotient: spouse below 30% is topped up so that own income + transfer reaches 30%, the SUM capped | art. 88 al. 1 (text restated in L2 art. 29) | rule | rule | rule | L2, L4 | `applyMaritalQuotient` | "art. 88 caps own income PLUS transfer" | verified (previously the transfer alone was capped) |
| Quotient not applied when it raises the total tax | art. 88 al. 2 / art. 87 (L2 wording) | rule | rule | rule | L2, F2 | `applyMaritalQuotient` | "does not apply when spouse already earns ≥30%" | verified (rule) |

## Social security

| Rule                                            | Legal basis                              | IY 2024 | IY 2025 | IY 2026 | Source | Code                                   | Tests                                           | Status   |
| ----------------------------------------------- | ---------------------------------------- | ------- | ------- | ------- | ------ | -------------------------------------- | ----------------------------------------------- | -------- |
| Employee contribution 13.07%                    | Law 29 June 1981 / RSZ                   | 13.07%  | 13.07%  | 13.07%  | P1 (other taxes) | `employeeSSRate`              | "employee SS = 13.07%"                          | verified on P1 only (secondary) |
| Statutory civil servant contribution            | —                                        | 11.07%  | 11.07%  | 11.07%  | —      | `civilServantSSRate`                   | `socialSecurity.test.ts`                        | unverified (RSZ instructions are a JS application; no page read) |
| CSSS single scale: 0 to 18,592.02; 5%; 123.95 + 1.3%; 335.50 + 4.009% to 40,997.26; 481.96 + 1.2996% to 60,181.95; 731.28 | L3 art. 108 §1 al. 2 (laws of 28-03-2022 and 20-11-2022) | same | same | same (L2 art. 91 rewrites it from AY 2029) | L3 | `csssTable` | "tier 4 single", "tier 5 single", "joint pays less than single at €50,000" | verified (tiers 4-5 corrected: the code ended tier 4 at 47,215.31) |
| CSSS joint scale: 5%; 123.95 + 1.3% to 60,181.95; 632.39 to 74,688; 632.39 + 1.3629% to 81,944; 731.28 | L3 art. 108 §1 al. 3 | same | same | same | L3, P1 sample (422.93 at 44,070) | `csssTableJoint` | "joint flat €632.39", PwC sample test | verified (upper bound corrected from 81,944.96 to 81,944.00) |
| CSSS base under joint assessment = household income (sum of both spouses' net income, before the quotient) | L3 art. 107, 2° | rule | rule | rule | L3 | `pit.ts` step 10 | "joint assessment: CSSS is computed on the household income" | verified (previously the earner's income alone) |
| CSSS only for employees under art. 106 (not self-employed, not pensioners) | L3 art. 106 | rule | rule | rule | L3 | `computeSpecialSocialSecurityContribution` | "returns 0 for self-employed" | verified (rule) |
| Self-employed contributions: 20.50% to 75,024.54; 14.16% to 110,562.42; minimum income 17,374.08 | RSVZ 2026 | — | — | 2026 rates | R1 | — | — | not modelled (Phase B; 2024 and 2025 tables still to be read) |

## Regional layer, surcharge, property

| Rule                                            | Legal basis                     | IY 2024 | IY 2025 | IY 2026 | Source | Code                        | Tests                            | Status   |
| ----------------------------------------------- | ------------------------------- | ------- | ------- | ------- | ------ | --------------------------- | -------------------------------- | -------- |
| Reduced state tax 75.043% + Flemish regional surtax 33.257% with 2% Flemish reduction → combined factor 0.9950 | Special finance law, art. 5/1 ff. | 0.9951 | 0.9951 | 0.9951 | P1 sample (433.56 / 577.75; 141.30) | `regionalAutonomyFactor.flanders` | "regional autonomy factor 0.9951" | derived from P1 (0.99501); primary text not read |
| Wallonia 0.9951, Brussels 0.9945 factors        | regional surtax rates           | as code | as code | as code | —      | `regionalAutonomyFactor`    | —                                | unverified |
| Communal surcharge 0-9% on the tax, default 7%  | WIB 92 arts 465-469             | 7%      | 7%      | 7% (L2 art. 99 adds a correction factor from AY 2029) | P1, L2 | `communalSurchargePercent` | surcharge tests | verified (rule); the L2 correction factor is not modelled |
| Cadastral income indexation coefficient         | WIB 92 art. 518                 | 2.1763  | 2.2446  | 2.3000  | N25 point H, N26 point H, N27 point J; F7 | `cadastralIndexationCoefficient` | `pit.test.ts` "cadastral indexation coefficient" | verified (IY 2026 corrected from the copied 2.2446) |
| Property tax base rates and centimes            | regional codes                  | as code | as code | as code | —      | `regionPropertyTax`         | `propertyTax.test.ts`            | unverified (vlaanderen.be and wallonie.be not reachable) |
| Flemish woonbonus / Walloon chèque habitat      | regional codes                  | as code | as code | as code | F6 (no advantage for loans from 1 Jan 2025) | `computeOwnHomeCredit` | own-home tests | unverified amounts; the 2025 cut-off is verified |

## Investment income

| Rule                                   | Legal basis         | IY 2024 | IY 2025 | IY 2026 | Source            | Code                                              | Tests                                        | Status   |
| -------------------------------------- | ------------------- | ------- | ------- | ------- | ----------------- | ------------------------------------------------- | -------------------------------------------- | -------- |
| Dividend exemption, 30% WHT reclaim    | art. 21, 14°; art. 269 | 833  | 833 ("après gel") | 833 | N25, N26, N27, F5, F7 | `dividendExemption`, backend `services/reports/belgianTaxTables.ts` | "dividend WHT reclaim" | verified (IY 2025/2026 corrected from 859) |
| Savings-deposit interest exemption, 15% above | art. 21, 5°; art. 171, 3°quinquies | 1,020 | 1,020 ("après gel") | 1,020 | N25, N26, N27, F5, F7 | `savingsInterestExemption`, `savingsInterestExcessRate` | "savings interest tax" | verified (IY 2025/2026 corrected from 1,050) |
| Capital gains tax 10%, 10,000 / 20,000 exemption from 2026 | law of 2026 on capital gains | 0 | 0 | 10% | — | `capitalGainsTax*` | CGT tests | unverified (law text not read in this pass) |
| TOB, TACR, Reynders                    | Code of miscellaneous duties and taxes; art. 19bis | as code | as code | as code | — | `portfolioTax.ts` | `portfolioTax.test.ts` | unverified in this pass |

## Open items

1. **Regional sources are unreachable** from the sandbox (vlaanderen.be, wallonie.be; the Brussels
   tax pages 404 after the fiscalite.brussels redirect). Property tax, own-home credits, service
   voucher amounts and the Wallonia/Brussels surtax factors stay unverified until those domains
   are allowed.
2. **Civil servant contribution rate** (11.07% in code) has no readable primary page yet.
3. **Rules known but not modelled**: refundable child tax credit (art. 134 §3), low-income
   isolated-parent supplement (art. 133 al. 2-3), dependent 66+ supplement (art. 132 7°), helping
   spouse forfait, 66+ marital quotient cap, the federal voucher expense cap, the 75% childcare
   rate, the L2 surcharge correction factor, self-employed social contributions.
4. **Employee group insurance** has no cap in the engine; art. 145/1 and 145/3 limit it through
   the 80% rule, which needs a pension-promise input.
5. **IY 2026 consumer pages** of FPS Finance still show pre-reform values; re-check F1-F3 when
   they are updated and confirm N27 is unchanged.

## Related

- [[docs/features/belgian-tax]]
- [[docs/adr/199-belgian-tax-source-verification|ADR-199]]
- [[docs/reference/index|Reference index]]
