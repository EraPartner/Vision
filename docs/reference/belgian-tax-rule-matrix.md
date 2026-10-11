---
title: Belgian Tax Rule Coverage Matrix
type: reference
status: active
date: 2026-10-11
updated: 2026-10-11
tags: [reference, belgian-tax, tax-rules, sources, verification]
description: One row per Belgian personal income tax rule the engine applies, including the household (two-partner) rules of ADR-200, with the legal basis, the primary source opened for each income year (2024-2026), the code location, the regression test and the verification status.
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
| R1  | RSVZ, *Hoeveel sociale bijdragen moet ik betalen?* and the folder *Sociale bijdragen* (January 2026)                            | Self-employed social contributions 2026                            |
| R38 | Royal Decree no. 38 of 27 July 1967 *houdende inrichting van het sociaal statuut der zelfstandigen*, arts 12 §1, 13bis, 14 (Justel 1967072702) | Self-employed contribution rates and base amounts (15,831.12 / 23,330.06 / 3,666.15 at index 142.75) |
| R14 | Yearly art. 14 royal decrees: RD 17-12-2023 (numac 2023206853, fraction 656.54/142.75), RD 29-11-2024 (2024205904, 662.28/142.75), RD 25-11-2025 (2025203558, 676.50/142.75) | Self-employed contribution thresholds 2024, 2025, 2026 |
| W1  | WIB 92, Flemish Region version, arts 145/37 and 145/38/2 (Fisconetplus `2cea1dd2-9260-4e01-a287-7407c9d1884b`, `4de78004-13bc-4858-b519-4312c09f38c8`) | Flemish woonbonus and geïntegreerde woonbonus; amounts not indexed (art. 178 §5, 4°) |
| W2  | WIB 92 art. 145/21, regional versions (Fisconetplus): Flanders income 2024 `bcb41a3c-bdb5-4b67-879a-72f538ffe4c8`; Wallonia income 2024 `360e95ff-2899-4037-9f23-7deaac95794d`, 2025 `19a6ca22-88a1-4777-9961-de056536adc6`, 2026 `bbda59c3-b9c5-4d4b-a838-0913695d355e`; Brussels income 2024 `a747184a-d367-4a5f-8066-ffaa5f7f75df`, 2025 `7c0161d3-42e2-4dcf-a0da-fcda6fea8979` | Service-voucher reduction rate and expense cap per region and year |
| W3  | WIB 92 art. 255, Walloon and Brussels versions (Fisconetplus `47b520a5-dca5-4454-a6ee-f47dfdd89ecf`, `83ade4ce-e808-4a3b-8741-a6a4a464482a`; FPS consolidated texts titled "historisch") | Walloon and Brussels property-tax base rate 1.25% |
| V1  | Vlaamse Codex Fiscaliteit art. 2.1.4.0.1 (decree of 13-12-2013, Justel 2013036154, consolidated to 30-06-2026) | Flemish property-tax base rate 3.97% |
| C63 | FPS circular 2026/C/63 on the mortgage-loan reductions in the Flemish Region (Fisconetplus `7ffb1e80-32b2-4714-9961-c87aca7394b7`) | Woonbonus amounts AY 2026; no integrated woonbonus for loans from 1 Jan 2020 |
| Q5  | WIB 92 art. 145/46quinquies, Walloon version (Fisconetplus `d3d26522-b35e-4730-99b8-518118308de2`) | Chèque habitat granted for twenty assessment years from the first |
| C18 | FPS circular 2026/C/18 on the end of the Chèque Habitat (Fisconetplus `ca250aba-f172-4eb3-83ab-ac476883bb99`, 16-01-2026), with the coordinated arts 145/46ter-quater | Chèque habitat formula, halving, cap; loans from 1 Jan 2025 excluded |
| C20 | FPS circular 2025/C/20 on reductions abolished by the Flemish Region (Fisconetplus `b8383bc8-f4c0-4f71-85f8-cab07881d481`) | Flemish service-voucher reduction abolished for periods starting after 31-12-2024 |
| C34 | FPS circular 2026/C/34 on the abolition of the Brussels reduction for ALE cheques and service vouchers (Fisconetplus `0b274dac-47a2-45ba-a899-9cf884cedf03`); Brussels ordinance of 18-12-2025 (BS 31-12-2025, numac 2025009750) | Brussels service-voucher reduction abolished from AY 2027 |
| C74 | FPS circular 2026/C/74 on the tax on capital gains on financial assets (Fisconetplus `7f6b62c6-1baa-487a-8f59-c883dd5485c4`) | Capital gains tax rate, exemption, carry-forward |
| L5  | Law of 6 April 2026 introducing a tax on capital gains on financial assets (BS 21-04-2026, numac 2026002780), arts 10, 14, 35 | Capital gains tax from 1 Jan 2026 |
| RD17 | Royal Decree of 19 December 2017 fixing the autonomy factor (Justel 2017032216) | Autonomy factor 24.957% from AY 2018 |
| LSF | Special finance law of 16 January 1989, arts 5/2 and 81quater (Justel eli/wet/1989/01/16/1989021010) | Reduced state tax; default regional opcentiemen = factor / (1 − factor) |
| WD17 | Walloon decree of 13 December 2017, art. 33 (Fisconetplus extract `96617d24-11ec-4943-b65c-4b075a06c16c`) | Walloon opcentiemen 33.257% |
| BQ104 | Brussels Finance Minister's answer to written question no. 104, Brussels Parliament, web-published 24-10-2025 (Fisconetplus `711156ec-1171-458e-82bf-6ee59396fbba`) | Opcentiemen 33.257% in the other regions, 32.591% in Brussels |
| S1  | Law of 29 June 1981, art. 38 §2 (Justel 1981001048); RSZ administrative instructions 2026/3, social security contributions | Employee contribution 7.5 + 1.15 + 0.87 + 3.55 = 13.07% |
| S2  | RSZ administrative instructions, limited insurance, public sector ("beperkt tot de sector ZIV-geneeskundige verzorging"); law of 15 May 1984, art. 60 (Justel 1984022160) | Statutory civil servant contribution (3.55% health care + 7.5% survivors' pension) |
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
| Refundable child tax credit                     | art. 134 §3 al. 2               | 550 per child                       | 550 (L1 art. 42, no longer indexed) | 550                                   | N25, N26, F3, L1 | `refundableChildCreditCapPerChild`; the household engine returns 0 | `household.test.ts` "low income with children raises the refundable-credit open item" | not modelled; the household engine raises `refundable_child_credit_not_modelled` (needs_source) when child supplements stay unused |
| Each spouse's taxable income is set and taxed separately under the joint assessment (décumul) | art. 126 §1 al. 2 ("het belastbare inkomen van elke echtgenoot afzonderlijk wordt vastgesteld"), art. 127 | rule | rule | rule | L4 | `applyMaritalQuotient` (no-quotient baseline now includes the spouse's own tax) | "joint assessment taxes the spouse's own income even when no quotient applies" | verified (previously the spouse's tax was dropped when no quotient applied, and the art. 88 comparison was made against the earner's tax alone) |
| Supplements go to the spouse with the higher taxable income | art. 134 §4             | rule                                | rule                                | rule (L2 art. 10 l) from AY 2030)     | L4, P1 sample | `applyMaritalQuotient` (spouse keeps basic exemption only) | PwC sample test              | verified for the single-earner case; the general allocation is in [[#Household taxation]] |

## Professional expenses (forfait)

| Rule                                    | Legal basis                 | IY 2024                              | IY 2025                              | IY 2026                              | Source        | Code                                   | Tests                                        | Status   |
| --------------------------------------- | --------------------------- | ------------------------------------ | ------------------------------------ | ------------------------------------ | ------------- | -------------------------------------- | -------------------------------------------- | -------- |
| Employees, civil servants and trading profits (winsten): 30%, capped | art. 51 al. 2, 1° and al. 3 | cap 5,750                 | cap 5,930                            | cap 6,070                            | N25, N26, N27, F4 | `employeeProfessionalExpense*`, `computeProfessionalExpenses` | "employee forfait", "self-employed trading profits" | verified (self-employed profits previously got no forfait) |
| Forfait base = gross income minus the art. 52, 7° social contributions | art. 51 al. 1 ("vooraf verminderd met voormelde bijdragen") | rule | rule | rule | L4 art. 51 al. 1, F4 ("brutoberoepsinkomen (verminderd met bijdragen)") | `computeProfessionalExpenses` (receives `employeeSS`) | "employee forfait is computed on gross pay after the 13.07% contribution" | verified (previously computed on gross pay before contributions; affects pay below about 22,700 in IY 2025) |
| Company directors: 3%, capped           | art. 51 al. 2, 2° and al. 3 | cap 3,030                            | cap 3,130                            | cap 3,200                            | N25, N26, N27, F4 | `directorProfessionalExpense*`      | "director forfait"                           | verified |
| Fees (baten): 28.7% / 10% / 5% / 3%, capped | art. 51 al. 2, 4° and al. 3 | 7,310 / 14,520 / 24,160; cap 5,050 | 7,540 / 14,970 / 24,920; cap 5,210  | 7,720 / 15,340 / 25,530; cap 5,340   | N25, N26, N27 (boundaries, caps); L4 (rates) | `selfEmployedFeesExpense*`     | "self-employed fees (baten)"                 | verified; the rates come from the 2011 consolidation and L2 does not amend them |
| Helping spouse: 5%, capped              | art. 51 al. 2, 3°           | cap 5,050                            | cap 5,210                            | cap 5,340                            | N25, N26, N27, F4; L4 (rate) | `helpingSpouseProfessionalExpenseRate`, `personPit.ts` `computeLumpSumForfait` | `household.test.ts` "helping spouse: 5% forfait …" | verified (rule, 2011 text); household engine only, the v1 profile has no helping-spouse type |
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
| Service vouchers: reduction = rate × min(spend, cap per taxpayer); spend from `serviceVoucherSpend`, else legacy count × `voucherPrice` | art. 145/21 (regional versions) | rule | rule | rule | W2 ("uitgaven tot ten hoogste … per belastingplichtige") | `serviceVoucherRegional`, `personPit.ts` `computeServiceVoucherCredit` | "service vouchers: spend overrides the count …"; `household.test.ts` "service-voucher spend is capped per partner …" | verified (rule; replaces the count-based model); the count conversion price is the earlier assumption, not sourced |
| Service vouchers: Flanders 20%                 | Flemish art. 145/21; C20 | 20% to 1,790 | abolished                 | abolished                    | W2, C20            | `serviceVoucherRegional.flanders`  | "service vouchers: spend overrides the count …" | verified |
| Service vouchers: Wallonia 30%                 | Walloon art. 145/21      | 30% to 1,790 | 30% to 1,850              | 30% to 1,890                 | W2                 | `serviceVoucherRegional.wallonia`  | same                                            | verified (previously €0.90 × 150 vouchers) |
| Service vouchers: Brussels 15%                 | Brussels art. 145/21; ordinance 18-12-2025 | 15% to 1,790 | 15% to 1,850 | abolished (from AY 2027) | W2, C34            | `serviceVoucherRegional.brussels`  | same                                            | verified (previously 15% × 172 × €10, still applied in IY 2026) |
| Employee group insurance 30%               | art. 145/1, 1°         | 30%, no cap             | 30%                          | 30%                          | —                  | `groupInsuranceRate`               | —                                               | unverified (cap missing; see open items) |

## Marital quotient and joint assessment

| Rule                                        | Legal basis                       | IY 2024 | IY 2025 | IY 2026                                       | Source            | Code                        | Tests                                               | Status   |
| ------------------------------------------- | --------------------------------- | ------- | ------- | --------------------------------------------- | ----------------- | --------------------------- | --------------------------------------------------- | -------- |
| Joint assessment from the year after marriage or legal cohabitation; separate in the year itself, on separation and for factual cohabitants | art. 126 §§1-2 | rule | rule | rule | F2, L4 | v1: `filingStatus` (user-chosen); household: `assessment.ts` `deriveAssessment` | `assessment.test.ts` | verified (rule); derived from dates in the household engine, see [[#Household taxation]] |
| Separate assessment when a spouse has treaty-exempt income above the threshold | art. 126 §2 al. 1, 4° | 13,050 | 13,460 | 11,550 (basic exemption, L2 art. 32) | N25, N26, N27, L2 | `treatyExemptSeparateThreshold`, `assessment.ts` | `assessment.test.ts` "IY %i treaty-exempt income …" | verified; household engine only (issue `treaty_exempt_separate_assessment`, info) |
| Quotient: 30% of the earner's income to a spouse without income, capped | art. 87 | cap 13,050 | cap 13,460 | cap 11,780; 12,790 when both spouses are 66+ (L2 arts 27, 30) | N25, N26, N27, F2, F7 | `maritalQuotientCap`, `maritalQuotientCapBothSenior`, `applyMaritalQuotient`, `maritalQuotient.ts` | "single-earner couple", "IY 2024 … (€13,050)", "IY 2026 … €11,780"; `maritalQuotient.test.ts` "IY 2026: both spouses 66+ …" | verified (IY 2024 corrected from 13,070); the 66+ cap is applied only by the household engine, from birth years |
| Quotient: spouse below 30% is topped up so that own income + transfer reaches 30%, the SUM capped | art. 88 al. 1 (text restated in L2 art. 29) | rule | rule | rule | L2, L4 | `applyMaritalQuotient` | "art. 88 caps own income PLUS transfer" | verified (previously the transfer alone was capped) |
| Quotient not applied when it raises the total tax ("the assessment": compared on the tax after reductions, factor and surcharge) | art. 88 al. 2 / art. 87 (L2 wording) | rule | rule | rule | L2, F2 | `applyMaritalQuotient`; `household.ts` `finalTaxOf` | "does not apply when spouse already earns ≥30%"; `household.test.ts` "quotient is withheld when a partner's reductions already clear the household tax" | verified (rule); until 2026-10-11 the household engine compared the tax after the tax-free sum only |

## Social security

| Rule                                            | Legal basis                              | IY 2024 | IY 2025 | IY 2026 | Source | Code                                   | Tests                                           | Status   |
| ----------------------------------------------- | ---------------------------------------- | ------- | ------- | ------- | ------ | -------------------------------------- | ----------------------------------------------- | -------- |
| Employee contribution 13.07%                    | Law 29 June 1981 art. 38 §2 / RSZ        | 13.07%  | 13.07%  | 13.07%  | S1, P1 | `employeeSSRate`                       | "employee SS = 13.07%"                          | verified (7.5 + 1.15 + 0.87 + 3.55) |
| Statutory civil servant contribution: 3.55% (health care only) + 7.5% (survivors' pension) | Law 29 June 1981 art. 38 §2, 4°; law 15 May 1984 art. 60 | 11.05% | 11.05% | 11.05% | S1, S2 | `civilServantSSRate` | `socialSecurity.test.ts` "gives statutory civil servants 3.55% + 7.5% = 11.05%" | verified (derived from two sources; no page states the sum; corrected from 11.07%) |
| CSSS single scale: 0 to 18,592.02; 5%; 123.95 + 1.3%; 335.50 + 4.009% to 40,997.26; 481.96 + 1.2996% to 60,181.95; 731.28 | L3 art. 108 §1 al. 2 (laws of 28-03-2022 and 20-11-2022) | same | same | same (L2 art. 91 rewrites it from AY 2029) | L3 | `csssTable` | "tier 4 single", "tier 5 single", "joint pays less than single at €50,000" | verified (tiers 4-5 corrected: the code ended tier 4 at 47,215.31) |
| CSSS joint scale: 5%; 123.95 + 1.3% to 60,181.95; 632.39 to 74,688; 632.39 + 1.3629% to 81,944; 731.28 | L3 art. 108 §1 al. 3 | same | same | same | L3, P1 sample (422.93 at 44,070) | `csssTableJoint` | "joint flat €632.39", PwC sample test | verified (upper bound corrected from 81,944.96 to 81,944.00) |
| CSSS base under joint assessment = household income (sum of both spouses' net income, before the quotient) | L3 art. 107, 2° | rule | rule | rule | L3 | `pit.ts` step 10 | "joint assessment: CSSS is computed on the household income" | verified (previously the earner's income alone) |
| CSSS only for employees under art. 106 (not self-employed, not pensioners) | L3 art. 106 | rule | rule | rule | L3 | `computeSpecialSocialSecurityContribution` | "returns 0 for self-employed" | verified (rule) |
| Self-employed contributions (main occupation): 20.50% up to threshold 1 on at least the minimum income; 14.16% between threshold 1 and threshold 2; nothing above | RD no. 38 art. 12 §1, art. 14 | 72,810.95 / 107,300.30 / 16,861.46 | 73,447.52 / 108,238.40 / 17,008.88 | 75,024.54 / 110,562.42 / 17,374.08 | R38, R14, R1 (2026) | `selfEmployedContributions`, `socialSecurity.ts` `estimateSelfEmployedContributions` | `socialSecurity.test.ts` "self-employed contribution estimate …" | verified (rule); 2024/2025 euro amounts computed from the decrees (base × fraction, cent rounding inferred; 2026 matches R1 exactly). Estimate helper only: the household engine deducts the user-entered `socialContributionsPaid` (see [[#Household taxation]]) |

## Regional layer, surcharge, property

| Rule                                            | Legal basis                     | IY 2024 | IY 2025 | IY 2026 | Source | Code                        | Tests                            | Status   |
| ----------------------------------------------- | ------------------------------- | ------- | ------- | ------- | ------ | --------------------------- | -------------------------------- | -------- |
| Reduced state tax 75.043% (autonomy factor 24.957%) | LSF art. 5/2; RD17          | 75.043% | 75.043% | 75.043% | RD17, LSF | `regionalAutonomyFactor` docstring | "state + regional factor …" | verified |
| Flanders and Wallonia: opcentiemen 33.257% → combined factor 0.75043 × 1.33257 = 1.0000 | LSF art. 81quater, 1° (default); Walloon decree 13-12-2017 art. 33 | 1.0000 | 1.0000 | 1.0000 | WD17, LSF, BQ104 | `regionalAutonomyFactor.flanders`, `.wallonia` | "state + regional factor …", PwC sample tests | verified (corrected from 0.9951; no Flemish reduction appears in the sources read; the Flemish rate rests on BQ104 and the LSF default) |
| Brussels: opcentiemen 32.591% → 0.75043 × 1.32591 = 0.9950 | Brussels opcentiemen | 0.9950 | 0.9950 | 0.9950 | BQ104 | `regionalAutonomyFactor.brussels` | same | verified on BQ104 (corrected from 0.9951 / 0.9945); the PwC AY 2026 sample's 0.99501 equals this Brussels product |
| Communal surcharge 0-9% on the tax, default 7%  | WIB 92 arts 465-469             | 7%      | 7%      | 7% (L2 art. 99 adds a correction factor from AY 2029) | P1, L2 | `communalSurchargePercent` | surcharge tests | verified (rule); the L2 correction factor is not modelled |
| Cadastral income indexation coefficient         | WIB 92 art. 518; V1 art. 1.1.0.0.2, 11° (Flemish KI indexed under art. 518) | 2.1763  | 2.2446  | 2.3000  | N25 point H, N26 point H, N27 point J ("2,3000 pour l'année des revenus 2026"); F7 | `cadastralIndexationCoefficient` | `pit.test.ts` "cadastral indexation coefficient" | verified |
| Property tax base rate, Flanders 3.97%          | V1 art. 2.1.4.0.1 §1            | 3.97%   | 3.97%   | 3.97%   | V1     | `regionPropertyTax.flanders.baseRate` | `propertyTax.test.ts` | verified |
| Property tax base rate, Wallonia and Brussels 1.25% | WIB 92 art. 255 (regional versions) | 1.25% | 1.25% | 1.25% | W3 | `regionPropertyTax.*.baseRate` | `propertyTax.test.ts` | verified on the FPS consolidated texts only (the Walloon decree and Brussels ordinance were not read) |
| Property tax centimes (communal + provincial)   | communal and provincial decisions | estimate | estimate | estimate | — | `regionPropertyTax.*.centimes` | `propertyTax.test.ts` | unverified (median estimates; the user can override) |
| Flemish woonbonus, loans before 2015: base 2,280 at the highest art. 130 rate, minimum 30% | Flemish art. 145/37 §2 | 2,280; max(marginal, 30%) | same | same | W1, C63 | `flemishWoonbonusBaseCap`, `flemishWoonbonusPre2015MinimumRate`, `computeOwnHomeCredit` | "Flemish woonbonus, loan signed before 2015 …" | verified (corrected from a flat 40%) |
| Flemish woonbonus, loans signed in 2015: base 1,520 at 40% | Flemish art. 145/37 §3 | 1,520; 40% | same | same | W1, C63 | `flemishWoonbonus2015BaseCap` | "Flemish woonbonus, loan signed in 2015 …" | verified (corrected from 2,280) |
| Integrated woonbonus, loans 2016-2019: base 1,520 at 40% | Flemish art. 145/38/2 §§2-3 | 1,520; 40% | same | same | W1, C63 | `flemishIntegratedWoonbonusBaseCap`, `flemishWoonbonusRate` | "geïntegreerde woonbonus" tests | verified |
| Woonbonus +760 in the first ten periods, +80 more with 3+ children (only together with the 760); amounts frozen | Flemish arts 145/37 §§2-3, 145/38/2 §2; art. 178 §5, 4° | 760 / 80 | 760 / 80 | 760 / 80 | W1, C63 | `flemishWoonbonusExtra*` | "the €80 for 3+ children applies only with …" | verified (the 80 was previously added after year 10 as well) |
| No woonbonus for loans from 1 Jan 2020           | C63                             | rule    | rule    | rule    | C63, F6 | `resolveMortgageRegime`    | "Post-2020 Flemish mortgage"     | verified |
| Chèque habitat: 1,520 at or below the lower limit; 1,520 − 1.275% × (income − lower limit) between the limits; 0 above the upper limit; +125 per dependent child (disabled ×2) except above the upper limit | Walloon art. 145/46ter §2 | limits 26,394 / 101,805 | 27,353 / 105,503 | 28,024 / 108,093 | C18 (formula, base 21,000 / 81,000), N25, N26, N27 ("Règle spécifique art. 178, § 6bis") | `walloonChequeHabitat*`, `computeOwnHomeCredit` | "Walloon chèque habitat between the income limits …", "… at or below the lower limit …", "… above the upper limit …" | verified (the formula is explicit in C18; the indexed limits replace 21,000 / 81,000; previously no phase-out) |
| Chèque habitat halved from the eleventh taxable period; never more than the interest, capital and premiums paid; nothing from the twenty-first period (twenty assessment years); loan age counted from the requested income year, with the loan year as proxy for the first qualifying year | Walloon art. 145/46ter §§3-4, art. 145/46quinquies | rule | rule | rule | C18, Q5 | `computeOwnHomeCredit` (`incomeYear` of the claimant) | "Walloon chèque habitat: halved from the eleventh period, capped …", "… twenty assessment years at most …" | verified (previously 0 from year 11 and no cap; until 2026-10-11 the half credit never ended and the loan age used the table's year) |
| Chèque habitat only for loans signed 2016-2024  | Walloon art. 145/46quater §1, 3° (decree 05-12-2024) | rule | rule | rule | C18, F6 | `resolveMortgageRegime` | "Walloon chèque habitat: loans signed from 1 Jan 2025 do not qualify" | verified (previously no upper bound) |
| Income for the woonbonus rate and the chèque habitat limits = the claimant's taxable income before the marital quotient | arts 145/37 §2, 145/46ter §2 last al. | rule | rule | rule | W1, C18 | `pit.ts`, `household.ts` (`mortgageCreditPartnerId`) | `household.test.ts` "own-home credit uses the claiming partner's income …" | derived (art. 6 income without non-professional movable income; the engine's taxable income excludes dividends and interest; whether the quotient applies first was not read) |

## Investment income

| Rule                                   | Legal basis         | IY 2024 | IY 2025 | IY 2026 | Source            | Code                                              | Tests                                        | Status   |
| -------------------------------------- | ------------------- | ------- | ------- | ------- | ----------------- | ------------------------------------------------- | -------------------------------------------- | -------- |
| Dividend exemption, 30% WHT reclaim    | art. 21, 14°; art. 269 | 833  | 833 ("après gel") | 833 | N25, N26, N27, F5, F7 | `dividendExemption`, backend `services/reports/belgianTaxTables.ts` | "dividend WHT reclaim" | verified (IY 2025/2026 corrected from 859) |
| Savings-deposit interest exemption, 15% above | art. 21, 5°; art. 171, 3°quinquies | 1,020 | 1,020 ("après gel") | 1,020 | N25, N26, N27, F5, F7 | `savingsInterestExemption`, `savingsInterestExcessRate` | "savings interest tax" | verified (IY 2025/2026 corrected from 1,050) |
| Capital gains tax 10%, exemption 10,000 per taxpayer (20,000 for two spouses) from 2026 | L5 arts 10 (art. 96/2, 2°, base 4,855), 14 (art. 171, 2°, e)), 35 | 0 | 0 | 10%; 10,000 per taxpayer | L5, C74, N27 | `capitalGainsTax*` | CGT tests | verified; the per-taxpayer carry-forward of art. 96/2, 3° (base 480 per year, set at €1,000 for AY 2028; at most base 2,426 used per period) is not modelled; there is no 20,000 carry-forward |
| TOB, TACR, Reynders                    | Code of miscellaneous duties and taxes; art. 19bis | as code | as code | as code | — | `portfolioTax.ts` | `portfolioTax.test.ts` | unverified in this pass |

## Household taxation

Rules of the household engine ([[docs/adr/200-belgian-tax-household-model|ADR-200]]). Code is
under `apps/frontend/src/lib/belgianTax/`; tests are the named files in `__tests__/`. A rule
marked `needs_source` is implemented with the stated default and returns an issue with that
severity; each one is listed in [[#Open items]]. Amounts are those of the tables above.

| Rule | Legal basis | Source | Code | Tests | Status |
| ---- | ----------- | ------ | ---- | ----- | ------ |
| Income is determined and taxed per spouse; the joint assessment adds the results | art. 126 §1 al. 2, art. 130 | L4 | `household.ts` `computeHouseholdTax`, `personPit.ts` | `household.test.ts`; parity harness `householdParity.ts` | verified (rule) |
| One taxpayer, or two partners without marriage or legal cohabitation → assessed alone / separately | art. 126 §1 | L4, F2 | `assessment.ts` `deriveAssessment` | `assessment.test.ts` "one partner …", "two partners without …" | verified (rule) |
| Year of marriage or legal-cohabitation declaration → separate; legal cohabitants who marry → joint unless the declaration was made in the same year | art. 126 §2 al. 1, 1° and al. 2 | L4, F2 | `assessment.ts` | `assessment.test.ts` (event table) | verified (rule) |
| Factual separation → joint in that year, separate from the following year | art. 126 §2 al. 1, 2° | L4 | `assessment.ts` | `assessment.test.ts` (event table) | verified (rule, 2011 text; F2 does not cover it) |
| Year of divorce or end of legal cohabitation → separate | art. 126 §2 al. 1, 2° | L4, F2 | `assessment.ts` | `assessment.test.ts` (event table) | verified (rule) |
| Year of death → separate by default; the survivor may elect joint; later years → survivor alone | art. 126 §2 al. 1, 3° and §3 | L4 | `assessment.ts` (`deathYearElection`) | `assessment.test.ts` "year of death …", "after the year of death …" | verified (rule, 2011 text); issue `deceased_partner_not_assessed` (info) after the year of death |
| Treaty-exempt professional income above the threshold → separate | art. 126 §2 al. 1, 4°; L2 art. 32 | N25, N26, N27, L2 | `treatyExemptSeparateThreshold` (13,050 / 13,460 / 11,550) | `assessment.test.ts` "IY %i treaty-exempt income …" | verified |
| Migrated `married_joint` profile without dates → assumed joint | — (migration default) | — | `assessment.ts`, `householdMigration.ts` | `assessment.test.ts` "a migrated married_joint profile …" | default; issue `relationship_dates_missing` (warning) |
| One forfait per art. 51 category per spouse, capped on the whole category (two jobs share one cap) | art. 51 al. 3 | L4 | `household.ts`, `personPit.ts` `computeLumpSumForfait` | `household.test.ts` "two part-time jobs share one remuneration forfait …" | verified (rule) |
| Trading profits (winsten) form a category of their own next to remuneration, each with its own cap | art. 51 al. 2, 1° and al. 3 | L4 (wording only) | `household.ts` `forfaitCategoryOf` | `household.test.ts` "employee 40k + trading profits 15k …" | needs_source (`forfait_category_aggregation_unverified`) |
| Helping spouse: 5%, capped at the fees cap | art. 51 al. 2, 3° | L4; N25-N27 (cap) | `helpingSpouseProfessionalExpenseRate`, `computeLumpSumForfait` | `household.test.ts` "helping spouse: 5% forfait …" | verified (rule, 2011 text) |
| Self-employed social contributions paid are deducted from gross before the forfait (profits, fees, helping spouse) | art. 52, 7° ("de persoonlijke bijdragen ter uitvoering van de sociale wetgeving…"); art. 51 al. 1 | L4 | `household.ts` (`socialContributionsPaid`) | `household.test.ts` "self-employed contributions come off the gross …" | verified (rule); the RSVZ amount is an input, not computed |
| A company director's own social contributions are not deducted | art. 52, 7° (application to directors not read) | — | `household.ts` | — | needs_source (`director_contributions_not_deducted`) |
| Union dues are deducted only inside an actual remuneration expense claim | art. 51 al. 1 (forfait covers all expenses) | L4 | `household.ts` | `household.test.ts` "union dues deduct only inside …" | derived; issue `union_dues_outside_remuneration_claim` (info) |
| A category whose actual expenses exceed its income is clamped at 0; no loss offset between categories or spouses | loss-offset rules not read | — | `household.ts` | `household.test.ts` "actual expenses above the income …" | default; issue `loss_offset_not_modelled` (warning) |
| Alimony is charged on the payer's income first, the balance on the other spouse | art. 105, 3° | L4 | `household.ts` | `household.test.ts` "alimony beyond the payer's income …" | verified (rule, 2011 text) |
| Quotient on net professional income only; the receiver is the lower earner; applied only if it lowers the tax of both spouses together | arts 87-88; L2 art. 87 ("voor beide echtgenoten samengenomen") | L2, L4 | `maritalQuotient.ts` `computeMaritalQuotient` | `maritalQuotient.test.ts` | verified (rule) |
| IY 2026 quotient cap 12,790 when both spouses are 66 or older on 1 January of the assessment year | L2 arts 27, 30 A | N27, L2 | `maritalQuotientCapBothSenior`, `resolveMaritalQuotientCap` | `maritalQuotient.test.ts` "IY 2026: both spouses 66+ …", "the senior cap does not exist before IY 2026" | verified; birth year ≤ IY − 66 is exact for an age on 1 January of the next year; issue `senior_quotient_cap_birth_years_missing` (info) when a birth year is missing |
| Tax-free sum and supplements are allocated after the quotient | art. 127, 1° (income after arts 86-89) | L4 | `household.ts`, `exemptions.ts` | `exemptions.test.ts` | verified (rule, 2011 text) |
| Each spouse gets the basic amount and their own disability supplement | arts 131, 134 | L4 | `exemptions.ts` `allocateExemptions` | `exemptions.test.ts` "each partner gets the basic amount …" | verified (rule) |
| Joint: dependent supplements go to the spouse with the higher taxable income; separate: to the claimant | art. 134 §1 al. 2 (2011 text); now §4 al. 1, 3° (L2 art. 10 l)) | L4, L2 | `exemptions.ts` | `exemptions.test.ts` "joint: supplements go …", "separate: supplements go to the claimant" | verified (rule, 2011 text); current wording not read |
| Joint: the part of a spouse's tax-free sum above their taxable income is added to the other spouse's | art. 134 §1 al. 2 (2011 text) | L4 | `exemptions.ts` | `exemptions.test.ts` "joint: the unused balance …", "no balance transfer outside a joint assessment" | verified (rule, 2011 text) |
| Isolated-parent supplement when a partner is present | art. 133 al. 1, 1° ("alleen wordt belast"); L2 art. 9 | L4, L2 | `exemptions.ts` | `exemptions.test.ts` "isolated-parent supplement …" | joint: refused (warning `isolated_parent_supplement_not_granted`); separate: refused, needs_source |
| Tax reductions stay with the spouse who paid them, capped at that spouse's tax; the own-home credit goes to `mortgageCreditPartnerId` (default A) | arts 145/1 ff.; the 2011 text apportions some reductions pro rata under a joint assessment | L4 | `household.ts`, `personPit.ts` `computeTaxReductions` | `household.test.ts` "reductions stay with the partner …" | needs_source (`joint_reduction_allocation_unverified`) |
| CSSS: joint scale on the household's net professional income, pensions excluded; separate: single scale per subject spouse | L3 arts 106, 107, 2°, 108 | L3 | `household.ts`, `socialSecurity.ts` `computeActivitySocialSecurity` | `household.test.ts` "joint: A employee + B self-employed …", "PwC AY 2026 sample …", "separate: each subject partner …", "pension: no social security …" | verified (rule) |
| CSSS base for a spouse who combines an employee activity with other professional activities; joint amount split pro rata | L3 art. 107 | — | `household.ts` | — | needs_source (`csss_mixed_activity_base_unverified`) |
| Dividend and savings side calculation per spouse | art. 21, 5° and 14° (exemption per taxpayer) | F5 | `personPit.ts` `computeInvestmentSideCalc` | — | derived |

## Open items

1. **Regional sources read through FPS texts.** vlaanderen.be and wallonie.be stay unreachable
   from the sandbox; the regional rules come from the regional WIB 92 versions on Fisconetplus,
   the FPS circulars and Justel.
   - Brussels/Walloon property-tax rates read only from the FPS consolidated texts (W3); the
     Walloon decree and the Brussels ordinance themselves were not read. The communal centimes
     are estimates.
   - Flemish and Brussels opcentiemen rest on the October 2025 ministerial answer (BQ104); the
     Flemish rate also equals the special finance law default. Later Walloon amendments to
     33.257% were not checked.
2. **RSVZ cent rounding**: the 2024 and 2025 self-employed thresholds are computed from R38 and
   R14 with half-up rounding to the cent, inferred from the exact 2026 match; no published 2024 or
   2025 table was reachable.
3. **Rules known but not modelled**: refundable child tax credit (art. 134 §3), low-income
   isolated-parent supplement (art. 133 al. 2-3), dependent 66+ supplement (art. 132 7°), the
   75% childcare rate, the L2 surcharge correction factor, the chèque habitat halving for a second
   home and its free split of the child increase between spouses, the capital-gains
   carry-forward, a separate "first qualifying year" for the chèque habitat (art. 145/46quinquies
   counts the twenty years from the first year the conditions are met; the engine uses the loan
   year, which differs when the home qualifies later, for example after construction). `estimateSelfEmployedContributions` exists but no engine uses it yet. The
   helping-spouse forfait and the 66+ marital quotient cap are modelled in the household engine
   (2026-10-11), not in `computeBelgianPIT`.
4. **Employee group insurance** has no cap in the engine; art. 145/1 and 145/3 limit it through
   the 80% rule, which needs a pension-promise input.
5. **IY 2026 consumer pages** of FPS Finance still show pre-reform values; re-check F1-F3 when
   they are updated and confirm N27 is unchanged.
6. **Household engine `needs_source` defaults** (ADR-200; each returns an issue with that severity):
   - `forfait_category_aggregation_unverified`: trading profits are a category of their own next
     to remuneration, each with its own cap. Confirm whether art. 51 al. 3 caps winsten and
     bezoldigingen together.
   - `joint_reduction_allocation_unverified`: reductions stay with the payer. The 2011 text
     apportions some reductions (for example art. 145/21) pro rata under a joint assessment; the
     current per-reduction rules have not been read.
   - `csss_mixed_activity_base_unverified`: which income enters the CSSS base for a spouse who
     combines employee and other professional activities, and the pro-rata split of the joint
     amount.
   - `refundable_child_credit_not_modelled`: the art. 134 §3 formula for unused child
     supplements; the engine returns 0.
   - `isolated_parent_supplement_not_granted` under a separate assessment with a partner: L2
     art. 9 adds a household test that has not been checked against cohabitation.
   - `director_contributions_not_deducted`: whether a director's own social contributions fall
     under art. 52, 7° like other self-employed contributions.
7. **Household rules not modelled or not read**: the current wording of art. 134 §4 after L2 (only
   the 2011 §1 al. 2 text was read); the art. 127, 4° 50% split of income that cannot be
   attributed to one spouse; the art. 133 al. 1, 2° supplement in the year of marriage; loss
   offset between categories and spouses.

## Related

- [[docs/features/belgian-tax]]
- [[docs/adr/199-belgian-tax-source-verification|ADR-199]]
- [[docs/reference/index|Reference index]]
