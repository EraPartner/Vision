---
title: Belgian Tax Scenario Matrix
type: reference
status: active
date: 2026-10-11
updated: 2026-10-11
tags: [reference, belgian-tax, tax-rules, verification, tests, household]
description: Law-derived scenario tests for the Belgian household tax engine. Each scenario cites the WIB 92 articles and rule-matrix rows it rests on, carries hand-derived expected figures and is marked verified or needs_source.
aliases: [belgian tax scenarios, tax scenario matrix]
---

# Belgian Tax Scenario Matrix

> [!abstract] Overview
> The scenario matrix runs whole households through `computeHouseholdTax` (and
> `computeBelgianPIT` where one taxpayer allows the comparison) and checks the result against
> figures worked out by hand from the cited WIB 92 article and the indexed amounts recorded in
> [[docs/reference/belgian-tax-rule-matrix|the rule matrix]]. The arithmetic is written next to
> every scenario in the test file; no expected figure is copied from the engine.
> 93 scenarios: 84 verified, 9 needs_source.

## How to read it

- **Code**: `apps/frontend/src/lib/belgianTax/__tests__/scenarioMatrix.*.test.ts` run the
  scenarios listed in `scenarioMatrix.<part>.ts` (single, joint, assessment, regions, and the
  invariant metadata); the shared `Scenario` type and runner are in `scenarioMatrix.ts`. Run them with
  `bunx vitest run src/lib/belgianTax` from `apps/frontend`.
- **Status**: `verified` = every asserted figure follows from verified rule-matrix rows.
  `needs_source` = the correct result depends on a rule the matrix does not carry, or on an
  input the household leaves empty (RG-15); the scenario asserts only the sourced parts (and the
  issue the engine raises) and states what is missing.
- **Matrix rows**: the row keys below; the rule matrix shows the same key and the scenario ids in
  its `Scenarios` column.
- **Defaults** unless a scenario says otherwise: income year (IY) 2025, Flemish Region (factor
  1.0000), 7% communal surcharge, couples married in 2015 (joint assessment), an
  employee pays 13.07% personal social security.
- `scenarioMatrix.docs.test.ts` keeps this page and the scenario lists in sync both ways: every
  scenario row needs a scenario with the same status and matrix rows, every scenario (IN-01 to
  IN-04 included) needs a row, the Needs source table lists exactly the `needs_source` scenarios,
  and the Row keys table lists every cited key with exactly the scenarios that cite it.

## Scenarios

### One taxpayer

`scenarioMatrix.single.test.ts`. Every activity kind, two activities, dependants, the reduction for pensions, the gift ceiling, IY 2024-2026.

| Id | What it verifies | Articles | Matrix rows | Status |
| -- | ---------------- | -------- | ----------- | ------ |
| SC-01 | employee 50,000 gross, IY 2025 | WIB 92 arts 51, 130, 131, 134 §2; law 29-06-1981 art. 38; law 30-03-1994 art. 108 | `employee-ss`, `forfait-base`, `forfait-employee`, `brackets`, `basic-exemption`, `exemption-scale`, `factor-flanders-wallonia`, `surcharge`, `csss-single` | verified |
| SC-02 | statutory civil servant 50,000 gross, IY 2025 | WIB 92 arts 51, 130, 131; law 29-06-1981 art. 38 §2, 4°; law 15-05-1984 art. 60 | `civil-servant-ss`, `forfait-base`, `forfait-employee`, `brackets`, `basic-exemption`, `csss-single` | verified |
| SC-03 | company director 60,000, IY 2025: 3% forfait, no CSSS | WIB 92 arts 51 al. 2, 2°, 130, 131; law 30-03-1994 art. 106 | `forfait-director`, `brackets`, `basic-exemption`, `csss-subject` | verified |
| SC-04 | self-employed trading profits 40,000, contributions 8,000, IY 2025 | WIB 92 arts 51 al. 1 and al. 2, 1°, 52, 7°, 130, 131 | `forfait-employee`, `hh-self-employed-contrib`, `brackets`, `csss-subject` | verified |
| SC-05 | liberal-profession fees 30,000, contributions 5,000, IY 2025: degressive forfait | WIB 92 arts 51 al. 2, 4°, 52, 7°, 130, 131 | `forfait-fees`, `hh-self-employed-contrib`, `brackets` | verified |
| SC-06 | helping spouse 20,000, contributions 3,000, IY 2025: 5% forfait | WIB 92 arts 51 al. 2, 3°, 52, 7°, 130, 131 | `forfait-helping-spouse`, `hh-helping-spouse`, `hh-self-employed-contrib`, `brackets` | verified |
| SC-07 | pension 25,000, IY 2025: no forfait, no CSSS; full base and tapered additional reduction for pensions | WIB 92 arts 51 al. 1, 130, 131, 147 al. 1, 1°, 151/1, 152, 153; law 30-03-1994 art. 106 | `forfait-none-pensions`, `csss-subject`, `pension-reduction`, `pension-reduction-taper`, `pension-reduction-limit` | verified |
| SC-08 | already-net professional amount 30,000, IY 2025 | WIB 92 arts 130, 131, 134 §2 | `brackets`, `basic-exemption`, `exemption-scale` | verified |
| SC-09 | one person: employee 40,000 + fees 20,000 (contributions 4,000): one forfait per category | WIB 92 art. 51 al. 2, 1° and 4°, al. 3; art. 130 | `hh-forfait-category`, `forfait-employee`, `forfait-fees`, `hh-csss-mixed` | verified |
| SC-10 | one person: employee + trading profits; whether art. 51 al. 3 caps them together is open | WIB 92 art. 51 al. 2, 1° and al. 3 | `hh-profits-category` | needs_source |
| SC-11 | two jobs 30,000 + 30,000 share one remuneration forfait, IY 2024 | WIB 92 art. 51 al. 3; art. 130 (IY 2024: 15,820 / 27,920 / 48,320); art. 131 (10,570) | `hh-forfait-category`, `forfait-employee`, `brackets`, `basic-exemption`, `csss-single` | verified |
| SC-12 | isolated parent, two children, employee 50,000, IY 2025 | WIB 92 arts 132 al. 1, 2°, 133 al. 1, 1°, 134 §2 | `children-supplements`, `isolated-parent`, `exemption-scale` | verified |
| SC-13 | IY 2026: employee 50,000, one child under 3, no childcare deduction | WIB 92 arts 130-132, 134 §2 after the law of 15 July 2026 (N27) | `brackets`, `basic-exemption`, `children-supplements`, `child-under-3`, `exemption-scale`, `forfait-employee` | verified |
| SC-14 | single parent with children but no supplement request: refundable credit stays an open item | WIB 92 art. 134 §3 | `refundable-child-credit` | needs_source |
| SC-15 | IY 2024: one disabled child and one disabled other dependant each count twice | WIB 92 arts 132 al. 1, 2° and 8°, 132bis; art. 134 §2 (IY 2024 scale 11,120 / 15,820) | `disabled-dependent`, `children-supplements`, `other-dependent`, `exemption-scale`, `csss-single` | verified |
| SC-16 | five children, IY 2025: the fifth child adds 7,070 | WIB 92 art. 132 al. 1, 4°-5°, art. 134 §2 | `children-supplements`, `children-fifth`, `exemption-scale` | verified |
| SC-17 | donation 500, IY 2024: 45% (the 30% rate starts in IY 2025) | WIB 92 art. 145/33; law of 18 December 2025 art. 67 | `donations` | verified |
| SC-18 | pension 40,000, IY 2025: base reduction tapered towards one third, no additional reduction | WIB 92 arts 147 al. 1, 1°, 151/1, 152 (N26 limits 28,780 / 57,560) | `pension-reduction`, `pension-reduction-taper` | verified |
| SC-19 | pension 20,000 and other income 5,000, IY 2025: reduction in proportion to the pensions | WIB 92 art. 147 al. 1, 2°; arts 151/1, 152, 153; Com.IB 146/15 | `pension-reduction`, `pension-reduction-share`, `pension-reduction-taper` | verified |
| SC-20 | pension 65,000, IY 2026: art. 151/2 tapers the last third of the base reduction | WIB 92 arts 147 al. 1, 1°, 151/1, 151/2 (N27: 2,182.06; limits 60,260 / 72,310) | `pension-reduction`, `pension-reduction-taper` | verified |
| SC-21 | pension 18,000, IY 2024: the reduction is limited to the tax on the pensions | WIB 92 arts 147 al. 1, 1° (N25: 2,151.72 / 444.78), 153 | `pension-reduction`, `pension-reduction-limit` | verified |
| SC-22 | pension with employee income: the art. 147 al. 1, 2°, b-c exclusions cannot be applied | WIB 92 art. 147 al. 1, 2°, a-c | `pension-reduction-share`, `pension-activity-income` | needs_source |
| SC-23 | gifts 4,000 with alimony paid: the 10% ceiling is on the net income before the alimony deduction | WIB 92 art. 145/33 §1 al. 4 ("10 % van het totale netto-inkomen"); art. 104, 1°; Com.IB 146/15 | `donations`, `donations-cap`, `alimony` | verified |

### Joint assessment

`scenarioMatrix.joint.test.ts`. The reduction for pensions per spouse, gifts under a joint assessment, marital quotient in both directions, the cap and the IY 2026 senior cap, the art. 88 comparison, the art. 134 balance transfer, dependants, alimony, CSSS on household income, treaty-exempt income.

| Id | What it verifies | Articles | Matrix rows | Status |
| -- | ---------------- | -------- | ----------- | ------ |
| JA-01 | alimony beyond the payer's income is charged on the other spouse; quotient brings no saving | WIB 92 arts 88, 104, 1° (IY 2025: 70%), 105, 3°, 134 | `alimony`, `hh-alimony`, `mq-not-higher`, `hh-balance-transfer` | verified |
| JC-01 | CSSS joint scale on the household income: employees 40,000 + 20,000 | Law 30-03-1994 arts 106, 107, 2°, 108 §1 al. 3 | `csss-joint`, `csss-household-base`, `hh-csss` | verified |
| JC-02 | CSSS household cap: employees 100,000 + 20,000 → 731.28 | Law 30-03-1994 art. 108 §1 al. 3 | `csss-joint`, `csss-household-base` | verified |
| JD-01 | three children go to the higher earner under joint assessment | WIB 92 arts 132 al. 1, 3°, 134 (2011 text §1 al. 2); law 30-03-1994 art. 108 §1 al. 3 | `hh-supplements-allocation`, `supplements-higher-income`, `children-supplements`, `csss-joint`, `forfait-employee` | verified |
| JD-02 | disabled partner B keeps their own supplement; quotient tops B up | WIB 92 arts 88, 131 al. 3, 134; law 30-03-1994 art. 108 §1 al. 3 | `disabled-supplement`, `hh-basic-each`, `mq-art88-topup`, `hh-balance-transfer`, `csss-joint` | verified |
| JD-03 | isolated-parent supplement is refused under a joint assessment | WIB 92 art. 133 al. 1, 1° ("die alleen wordt belast") | `hh-isolated-parent-partner`, `isolated-parent` | verified |
| JQ-01 | quotient A → B at the cap: A employee 80,000 gross, B no income | WIB 92 arts 87, 88, 126 §1, 130, 134; law 30-03-1994 arts 107, 2°, 108 | `mq-cap`, `mq-not-higher`, `hh-quotient`, `decumul`, `hh-balance-transfer`, `csss-joint`, `csss-household-base` | verified |
| JQ-02 | quotient B → A: mirror of JQ-01 gives the same household tax | WIB 92 arts 87, 88 | `mq-cap`, `hh-quotient` | verified |
| JQ-03 | art. 88 top-up, IY 2024: A 60,000, B 10,000 net professional income | WIB 92 art. 88 al. 1 (IY 2024 cap 13,050), arts 130, 131 (10,570), 134 | `mq-art88-topup`, `mq-cap`, `hh-balance-transfer`, `brackets`, `exemption-scale` | verified |
| JQ-04 | quotient withheld when it raises the tax: B has no professional but 60,000 other income | WIB 92 arts 87, 88 al. 2 (professional income only; not applied when it raises the tax) | `mq-not-higher`, `hh-quotient` | verified |
| JQ-05 | quotient below the cap: A 40,000, B 0 net professional income | WIB 92 arts 87, 134 | `mq-cap`, `hh-balance-transfer` | verified |
| JQ-06 | IY 2026 senior cap: both spouses born before 1961 → 12,790 | WIB 92 arts 87-88 after the law of 15 July 2026 arts 27, 30 A (N27: 11,780 / 12,790) | `hh-senior-cap`, `mq-cap`, `brackets`, `basic-exemption` | verified |
| JQ-07 | IY 2026 ordinary cap when one spouse is under 66 → 11,780 | WIB 92 arts 87-88 after the law of 15 July 2026 (N27: 11,780) | `hh-senior-cap`, `mq-cap` | verified |
| JR-01 | allocation of reductions between spouses under a joint assessment | WIB 92 arts 145/1 ff. (per-reduction apportionment not read) | `hh-reductions-allocation`, `pension-savings` | needs_source |
| JT-01 | art. 134 balance transfer after the quotient: A 20,000, B 6,000 | WIB 92 arts 88 al. 1, 127, 1°, 134 (2011 text §1 al. 2) | `hh-balance-transfer`, `hh-exemption-after-quotient`, `mq-art88-topup` | verified |
| JX-01 | treaty-exempt income 13,461 (IY 2025, "meer dan" 13,460) → separate assessment | WIB 92 art. 126 §2 al. 1, 4° (N26: 13,460) | `treaty-threshold`, `hh-treaty` | verified |
| JX-02 | treaty-exempt income exactly at the threshold 13,460 → still joint | WIB 92 art. 126 §2 al. 1, 4° | `treaty-threshold`, `hh-treaty` | verified |
| JX-03 | IY 2026: threshold is the basic exemption 11,550; 11,551 → separate | WIB 92 art. 126 §2 al. 1, 4° after the law of 15 July 2026 art. 32 (N27) | `treaty-threshold`, `hh-treaty` | verified |
| JP-01 | two pensioners 30,000 + 15,000: the reduction for pensions per spouse, each with its own limits | WIB 92 arts 147 al. 1, 1°, 150, 151/1, 152, 153; arts 87-88 | `hh-pension-per-spouse`, `pension-reduction`, `pension-reduction-taper`, `pension-reduction-limit` | verified |
| JP-02 | pensioner 40,000 with a quotient towards a spouse without income: the transferred part stays pension income and the limits read the income after the transfer | WIB 92 arts 87-88, 147 al. 1, 1°, 150, 151/1, 152, 153; Com.IB 87/22-23; FPS circular AAFisc 40/2011 nos 19, 27, example 4 | `hh-pension-quotient`, `hh-quotient`, `hh-pension-per-spouse`, `pension-reduction`, `pension-reduction-taper`, `pension-reduction-limit` | verified |
| JG-01 | gifts 1,000 paid by A under a joint assessment: the reduction is apportioned on each spouse's taxed income | WIB 92 art. 145/33 §1 al. 3-5 ("evenredig omgedeeld in functie van het overeenkomstig artikel 130 belaste inkomen") | `hh-donations-joint`, `donations`, `donations-cap` | verified |
| JG-02 | gifts 5,000 paid by A under a joint assessment: the 10% ceiling on whose net income | WIB 92 art. 145/33 §1 al. 4-5 | `hh-donations-joint-ceiling`, `hh-donations-joint` | needs_source |

### Assessment mode (art. 126)

`scenarioMatrix.assessment.test.ts`. Year of marriage or declaration, legal cohabitants who marry, end of legal cohabitation, factual separation and the year after, divorce, death with and without the survivor's election, factual cohabitants.

| Id | What it verifies | Articles | Matrix rows | Status |
| -- | ---------------- | -------- | ----------- | ------ |
| AS-01 | year of marriage → separate; each partner on the single CSSS scale | WIB 92 art. 126 §2 al. 1, 1°; law 30-03-1994 art. 108 §1 al. 2 | `hh-union-year`, `decumul`, `csss-single`, `hh-csss` | verified |
| AS-02 | year after the marriage → joint | WIB 92 art. 126 §1 | `hh-union-year`, `art126-joint` | verified |
| AS-03 | year of the legal-cohabitation declaration → separate | WIB 92 art. 126 §2 al. 1, 1° | `hh-union-year` | verified |
| AS-04 | legal cohabitants (2023) who marry in 2025 stay joint in 2025 | WIB 92 art. 126 §2 al. 2 | `hh-union-year` | verified |
| AS-05 | declaration and marriage in the same year → separate | WIB 92 art. 126 §2 al. 2 ("tenzij … tijdens hetzelfde jaar") | `hh-union-year` | verified |
| AS-06 | year the legal cohabitation ends → separate | WIB 92 art. 126 §2 al. 1, 3° | `hh-dissolution` | verified |
| AS-07 | year of factual separation → still joint | WIB 92 art. 126 §2 al. 1, 2° | `hh-factual-separation` | verified |
| AS-08 | year after the factual separation → separate | WIB 92 art. 126 §2 al. 1, 2° ("vanaf het jaar na dat waarin") | `hh-factual-separation` | verified |
| AS-09 | year of divorce → separate; the year before stays joint | WIB 92 art. 126 §2 al. 1, 3° | `hh-dissolution` | verified |
| AS-10 | year of death without election → separate (electable) | WIB 92 art. 126 §2 al. 1, 3° and §3 | `hh-death` | verified |
| AS-11 | year of death with the survivor's election → joint (quotient of JQ-05) | WIB 92 art. 126 §3, art. 87 | `hh-death`, `mq-cap` | verified |
| AS-12 | year after the death → only the survivor is assessed | WIB 92 art. 126 §2 al. 1, 3° | `hh-death` | verified |
| AS-13 | factual cohabitants: separate; dependants with the claimant partner B (figures before the art. 134 §3 refundable credit) | WIB 92 arts 126 §1, 132 al. 1, 1° | `hh-no-union`, `hh-supplements-allocation`, `children-supplements` | needs_source |
| AS-14 | isolated-parent supplement under a separate assessment with a partner | WIB 92 art. 133 al. 1, 1°; law of 15 July 2026 art. 9 | `hh-isolated-parent-partner` | needs_source |

### Regions

`scenarioMatrix.regions.test.ts`. State/regional factor, communal surcharge, Flemish woonbonus, Walloon chèque habitat (formula, halving from the eleventh period, twenty-period window, loan dates), a basket per borrower, the region that decides the regime, service vouchers per region and income year.

| Id | What it verifies | Articles | Matrix rows | Status |
| -- | ---------------- | -------- | ----------- | ------ |
| RG-01 | Brussels factor 0.9950 on the tax after reductions, IY 2025 | Special finance law arts 5/2, 81quater; BQ104 (Brussels opcentiemen 32.591%) | `factor-brussels`, `surcharge` | verified |
| RG-02 | Wallonia factor 1.0000 with a 7.5% communal surcharge, IY 2025 | Walloon decree 13-12-2017 art. 33; WIB 92 arts 465-469 | `factor-flanders-wallonia`, `surcharge` | verified |
| RG-03 | Brussels: regional reduction deducted before the 0.9950 factor | Special finance law art. 5/2 (where federal and regional reductions are charged) | `factor-brussels`, `service-voucher-brussels` | needs_source |
| RG-04 | Flemish woonbonus, loan of 2012, IY 2024: base 2,280 at the 45% marginal rate | WIB 92 Flemish art. 145/37 §2; art. 178 §5, 4° (not indexed) | `woonbonus-pre2015`, `woonbonus-extra`, `brackets` | verified |
| RG-05 | integrated woonbonus, loan of 2018, three children on 1 January 2019, IY 2025 | WIB 92 Flemish art. 145/38/2 §2 al. 3, §3; art. 132 al. 1, 3° | `woonbonus-integrated`, `woonbonus-extra`, `children-supplements` | verified |
| RG-06 | no woonbonus for a Flemish loan signed in 2020 | FPS circular 2026/C/63 | `woonbonus-post2020` | verified |
| RG-07 | chèque habitat, tenth period (IY 2025): full amount between the income limits | WIB 92 Walloon art. 145/46ter §§2-4 (N26 limits 27,353 / 105,503) | `cheque-habitat-formula`, `cheque-habitat-periods`, `children-supplements` | verified |
| RG-08 | chèque habitat, eleventh period (IY 2026): halved | WIB 92 Walloon art. 145/46ter §3 (N27 limits 28,024 / 108,093) | `cheque-habitat-formula`, `cheque-habitat-periods`, `children-supplements` | verified |
| RG-09 | chèque habitat: nothing from the twenty-first period (first period 2016 → income 2036) | WIB 92 Walloon art. 145/46quinquies (twenty assessment years) | `cheque-habitat-periods` | verified |
| RG-10 | chèque habitat: nothing before the first qualifying year | WIB 92 Walloon art. 145/46quinquies | `cheque-habitat-periods` | verified |
| RG-11 | chèque habitat: loans signed from 1 January 2025 do not qualify | WIB 92 Walloon art. 145/46quater §1, 3° (decree of 5 Dec 2024); FPS circular 2026/C/18 | `cheque-habitat-loans` | verified |
| RG-12 | separate assessment: the chèque habitat child increase follows the partner the child is a dependant of | WIB 92 Walloon art. 145/46ter §2 ("par enfant à charge"); WIB 92 arts 126 §1, 136 | `cheque-habitat-formula`, `hh-supplements-allocation` | verified |
| RG-13 | separate assessment: the woonbonus +80 follows the borrower's children on 1 January after the loan year, not this year's claimant | WIB 92 Flemish art. 145/38/2 §2 al. 3 ("op 1 januari van het jaar na dat waarin de leningsovereenkomst wordt afgesloten"); WIB 92 arts 126 §1, 136 | `woonbonus-extra`, `hh-supplements-allocation` | verified |
| RG-14 | Flemish woonbonus, loan signed in 2015, eleventh period (IY 2025): base 1,520 at 40% | WIB 92 Flemish art. 145/37 §3 | `woonbonus-2015`, `woonbonus-extra` | verified |
| RG-15 | woonbonus +80 without the children at the loan start: this year's children of the claimant stand in, with an info issue | WIB 92 Flemish art. 145/38/2 §2 al. 3; WIB 92 arts 126 §1, 136 | `woonbonus-extra`, `hh-supplements-allocation` | needs_source |
| RG-16 | joint assessment, both spouses borrowers (B pays 25%): woonbonus basket per spouse, payments divided freely | WIB 92 Flemish art. 145/38/2 §2 ("per belastingplichtige"), §3 ("vrij verdelen binnen de begrenzingen"); C63 | `hh-own-home-borrowers`, `woonbonus-integrated`, `woonbonus-extra` | verified |
| RG-17 | separate assessment, both partners borrowers (B pays 25%): each claims their own payments | WIB 92 Flemish art. 145/38/2 §§2-3; art. 126 §1 | `hh-own-home-borrowers`, `woonbonus-integrated`, `woonbonus-extra` | verified |
| RG-18 | joint assessment, chèque habitat for two owners (50% each): own income per borrower, child increase where it fits | WIB 92 Walloon art. 145/46ter §§2-4 ("forfaitaire et individuelle", "au prorata de la part de propriété"); C18 | `hh-own-home-borrowers`, `cheque-habitat-formula`, `cheque-habitat-periods` | verified |
| RG-19 | the household region decides the own-home regime: a Flemish resident's home recorded as Walloon | Special finance law of 16 January 1989 arts 5/1 §2 (fiscal domicile on 1 January of the assessment year), 5/5 §4 | `region-competence`, `woonbonus-integrated` | verified |
| RG-20 | joint assessment, both spouses borrowers (50% each), B's tax smaller than B's woonbonus: payments go where the tax can absorb the credit | WIB 92 Flemish art. 145/38/2 §2 ("per belastingplichtige"), §3 ("vrij verdelen binnen de begrenzingen"); arts 87-88; C63 | `hh-own-home-borrowers`, `woonbonus-integrated`, `woonbonus-extra`, `hh-quotient` | verified |
| SV-2024-brussels | service vouchers, Brussels, IY 2024, spend 2,000: 15% × 1,790 = 268.50 | WIB 92 art. 145/21 (regional versions); FPS circulars 2025/C/20, 2026/C/34 | `service-voucher-rule`, `service-voucher-brussels` | verified |
| SV-2024-flanders | service vouchers, Flanders, IY 2024, spend 2,000: 20% × 1,790 = 358 | WIB 92 art. 145/21 (regional versions); FPS circulars 2025/C/20, 2026/C/34 | `service-voucher-rule`, `service-voucher-flanders` | verified |
| SV-2024-wallonia | service vouchers, Wallonia, IY 2024, spend 2,000: 30% × 1,790 = 537 | WIB 92 art. 145/21 (regional versions); FPS circulars 2025/C/20, 2026/C/34 | `service-voucher-rule`, `service-voucher-wallonia` | verified |
| SV-2025-brussels | service vouchers, Brussels, IY 2025, spend 2,000: 15% × 1,850 = 277.50 | WIB 92 art. 145/21 (regional versions); FPS circulars 2025/C/20, 2026/C/34 | `service-voucher-rule`, `service-voucher-brussels` | verified |
| SV-2025-flanders | service vouchers, Flanders, IY 2025, spend 2,000: abolished | WIB 92 art. 145/21 (regional versions); FPS circulars 2025/C/20, 2026/C/34 | `service-voucher-rule`, `service-voucher-flanders` | verified |
| SV-2025-wallonia | service vouchers, Wallonia, IY 2025, spend 2,000: 30% × 1,850 = 555 | WIB 92 art. 145/21 (regional versions); FPS circulars 2025/C/20, 2026/C/34 | `service-voucher-rule`, `service-voucher-wallonia` | verified |
| SV-2026-brussels | service vouchers, Brussels, IY 2026, spend 2,000: abolished | WIB 92 art. 145/21 (regional versions); FPS circulars 2025/C/20, 2026/C/34 | `service-voucher-rule`, `service-voucher-brussels` | verified |
| SV-2026-flanders | service vouchers, Flanders, IY 2026, spend 2,000: abolished | WIB 92 art. 145/21 (regional versions); FPS circulars 2025/C/20, 2026/C/34 | `service-voucher-rule`, `service-voucher-flanders` | verified |
| SV-2026-wallonia | service vouchers, Wallonia, IY 2026, spend 2,000: 30% × 1,890 = 567 | WIB 92 art. 145/21 (regional versions); FPS circulars 2025/C/20, 2026/C/34 | `service-voucher-rule`, `service-voucher-wallonia` | verified |
| SV-W-TOTAL | Wallonia IY 2025: service-voucher reduction in the final tax | WIB 92 Walloon art. 145/21 | `service-voucher-wallonia`, `factor-flanders-wallonia` | verified |

### Invariants

`scenarioMatrix.invariants.test.ts`. Properties that follow from the law for every input; IN-01 to IN-03 run 300 generated couples each.

| Id | What it verifies | Articles | Matrix rows | Status |
| -- | ---------------- | -------- | ----------- | ------ |
| IN-01 | without dependants, joint PIT never exceeds the same couple's separate PIT (property, 300 runs) | WIB 92 arts 87-88, 126, 134 | `mq-not-higher`, `hh-balance-transfer`, `hh-per-spouse` | verified |
| IN-02 | per-partner PIT, taxable income, CSSS and contributions sum to the household totals (property) | WIB 92 arts 126 §1 al. 2, 130 | `hh-per-spouse`, `decumul` | verified |
| IN-03 | exemption balances and quotient transfers are conserved between partners (property) | WIB 92 arts 87-88, 134 | `hh-balance-transfer`, `mq-art88-topup` | verified |
| IN-04 | one partner with one activity equals computeBelgianPIT (golden parity harness, nine profiles) | — | `hh-per-spouse` | verified |

## Needs source

| Id | What is missing |
| -- | --------------- |
| SC-10 | Whether employee remuneration and trading profits (both art. 51 al. 2, 1°) share one art. 51 al. 3 cap (`forfait_category_aggregation_unverified`). |
| SC-14 | The art. 134 §3 refundable child tax credit formula (`refundable_child_credit_not_modelled`). |
| AS-13 | B's child supplement is not used in full (exemption 12,890 against taxable income 12,170.20), so B is owed the art. 134 §3 refundable child tax credit, whose formula the matrix does not carry (`refundable_child_credit_not_modelled`). The asserted figures hold before that credit. |
| RG-15 | The borrower's dependent children on 1 January of the year after the loan year (`home.woonbonusChildrenAtLoanStart`) are not entered. The engine falls back to this year's dependent children of the claimant, disabled counted twice, and raises `woonbonus_children_at_loan_start_missing` (info); the law does not use this year's children. |
| JR-01 | How reductions are apportioned between jointly assessed spouses (`joint_reduction_allocation_unverified`). |
| AS-14 | Whether a separately assessed taxpayer living with a partner is "alone" for art. 133 al. 1, 1° after L2 art. 9 (`isolated_parent_supplement_not_granted`). |
| RG-03 | Where regional and federal reductions are charged relative to the state/regional factor (special finance law art. 5/2). The engine deducts every reduction from the tax before multiplying by the combined factor, which differs from charging federal reductions on the reduced state tax and regional reductions on the regional surcharge by 0.5% of the reductions in Brussels. |
| SC-22 | The statutory pension amount and the legal pension age that art. 147 al. 1, 2°, b-c use to leave a pensioner's activity income out of the proportion are not inputs (`pension_reduction_activity_income_not_excluded`, warning). The engine applies the plain proportion of art. 147 al. 1, 2°. |
| JG-02 | Whether the 10% ceiling of art. 145/33 §1 al. 4 is taken on the spouses' combined net income or per spouse under a joint assessment (`donation_joint_ceiling_unverified`). The engine pools the gifts and caps them once on the combined income; only the apportionment is asserted. |

## Scope notes

- Co-parenting (art. 132bis, children whose dependency is shared between parents who live apart)
  is not modelled: the household has one claimant for all dependants, so RG-12 covers the
  sole-claimant case only.
- The IY 2026 senior quotient cap (JQ-06, JQ-07) compares birth years only. Someone born on
  1 January 1961 is 66 on 1 January 2027, yet the engine applies the ordinary cap to them.
- Two chèque-habitat borrowers (RG-18) share one `home.firstQualifyingYear`. The Walloon
  periods (art. 145/46ter §3, art. 145/46quinquies) run per taxpayer, so a co-borrower who first
  claimed in another year would need a value of their own; the household has one field for both.

## Engine fixes found by the matrix

- **Own-home child increases under a separate assessment** (RG-12, RG-13; fixed 2026-10-11).
  Outside a joint assessment a child is the dependant of one taxpayer, the partner who claims the
  art. 132 supplements (rule-matrix row `hh-supplements-allocation`). The Walloon chèque habitat
  adds €125 "par enfant à charge" (art. 145/46ter §2) and the Flemish woonbonus adds €80 with
  three or more dependent children (arts 145/37, 145/38/2), both for the claiming taxpayer. The
  household engine gave these increases to the mortgage partner even when the other partner
  claimed the children. `computeHouseholdTax` now passes the children to the own-home credit only
  under a joint assessment or when the mortgage partner is also the dependants' claimant. For the
  woonbonus this now applies only to the proxy below.
- **Woonbonus +80 on the children at the loan start** (RG-05, RG-13, RG-15; fixed 2026-10-11). The
  Flemish arts 145/37 §2 al. 3 and 145/38/2 §2 al. 3 grant the +80 when the taxpayer has three or
  more dependent children on 1 January of the year after the loan year, a disabled child counted
  twice (rule-matrix source W1). The engine counted this year's dependent children and did not
  count disabled children twice. It now uses `home.woonbonusChildrenAtLoanStart` when entered;
  without it, this year's children of the claimant (disabled counted twice) stand in and the
  engine raises `woonbonus_children_at_loan_start_missing` (info).

- **Joint woonbonus split ignored the spouses' tax** (RG-20; fixed 2026-10-11). Under a joint
  assessment "kunnen de echtgenoten deze uitgaven vrij verdelen binnen de begrenzingen" (Flemish
  arts 145/37 §3, 145/38/2 §3), yet each borrower kept their own payments even when that
  spouse's tax could not absorb the credit (147.269 lost in RG-20). The payments now go first to
  the part of each basket the spouse's tax can absorb; credit that is still lost raises
  `joint_reduction_allocation_unverified`.
- **The quotient keeps the nature of the income** (JP-02; fixed 2026-10-11). Com.IB 87/23 and
  FPS circular AAFisc 40/2011 (nos 19 and 36, example 4) treat the transferred part as the
  receiving spouse's own income, made up pro rata of the transferring spouse's categories. The
  receiving spouse now has pension income for arts 147-153 and the transferring spouse's
  pensions are measured after the transfer.

## Row keys

| Key | Matrix section | Rule | Scenarios |
| --- | -------------- | ---- | --------- |
| `brackets` | [[docs/reference/belgian-tax-rule-matrix#Progressive tax and exemptions\|Progressive tax and exemptions]] | Bracket boundaries… | JQ-03, JQ-06, RG-04, SC-01, SC-02, SC-03, SC-04, SC-05, SC-06, SC-08, SC-11, SC-13 |
| `exemption-scale` | [[docs/reference/belgian-tax-rule-matrix#Progressive tax and exemptions\|Progressive tax and exemptions]] | Exemption valuation scale… | JQ-03, SC-01, SC-08, SC-12, SC-13, SC-15, SC-16 |
| `basic-exemption` | [[docs/reference/belgian-tax-rule-matrix#Progressive tax and exemptions\|Progressive tax and exemptions]] | Basic exemption… | JQ-06, SC-01, SC-02, SC-03, SC-08, SC-11, SC-13 |
| `disabled-supplement` | [[docs/reference/belgian-tax-rule-matrix#Progressive tax and exemptions\|Progressive tax and exemptions]] | Disabled taxpayer / spouse supplement… | JD-02 |
| `children-supplements` | [[docs/reference/belgian-tax-rule-matrix#Progressive tax and exemptions\|Progressive tax and exemptions]] | Children supplements 1-4… | AS-13, JD-01, RG-05, RG-07, RG-08, SC-12, SC-13, SC-15, SC-16 |
| `children-fifth` | [[docs/reference/belgian-tax-rule-matrix#Progressive tax and exemptions\|Progressive tax and exemptions]] | Each child beyond the fourth… | SC-16 |
| `child-under-3` | [[docs/reference/belgian-tax-rule-matrix#Progressive tax and exemptions\|Progressive tax and exemptions]] | Child under 3 without childcare reduction… | SC-13 |
| `other-dependent` | [[docs/reference/belgian-tax-rule-matrix#Progressive tax and exemptions\|Progressive tax and exemptions]] | Other dependent… | SC-15 |
| `dependent-66` | [[docs/reference/belgian-tax-rule-matrix#Progressive tax and exemptions\|Progressive tax and exemptions]] | Dependent 66+… | — |
| `disabled-dependent` | [[docs/reference/belgian-tax-rule-matrix#Progressive tax and exemptions\|Progressive tax and exemptions]] | Disabled dependent counts twice… | SC-15 |
| `isolated-parent` | [[docs/reference/belgian-tax-rule-matrix#Progressive tax and exemptions\|Progressive tax and exemptions]] | Isolated parent supplement… | JD-03, SC-12 |
| `refundable-child-credit` | [[docs/reference/belgian-tax-rule-matrix#Progressive tax and exemptions\|Progressive tax and exemptions]] | Refundable child tax credit… | SC-14 |
| `decumul` | [[docs/reference/belgian-tax-rule-matrix#Progressive tax and exemptions\|Progressive tax and exemptions]] | Each spouse's taxable income… | AS-01, JQ-01, IN-02 |
| `supplements-higher-income` | [[docs/reference/belgian-tax-rule-matrix#Progressive tax and exemptions\|Progressive tax and exemptions]] | Supplements go to the spouse… | JD-01 |
| `forfait-employee` | [[docs/reference/belgian-tax-rule-matrix#Professional expenses (forfait)\|Professional expenses (forfait)]] | Employees, civil servants and trading profits… | JD-01, SC-01, SC-02, SC-04, SC-09, SC-11, SC-13 |
| `forfait-base` | [[docs/reference/belgian-tax-rule-matrix#Professional expenses (forfait)\|Professional expenses (forfait)]] | Forfait base… | SC-01, SC-02 |
| `forfait-director` | [[docs/reference/belgian-tax-rule-matrix#Professional expenses (forfait)\|Professional expenses (forfait)]] | Company directors… | SC-03 |
| `forfait-fees` | [[docs/reference/belgian-tax-rule-matrix#Professional expenses (forfait)\|Professional expenses (forfait)]] | Fees (baten)… | SC-05, SC-09 |
| `forfait-helping-spouse` | [[docs/reference/belgian-tax-rule-matrix#Professional expenses (forfait)\|Professional expenses (forfait)]] | Helping spouse… | SC-06 |
| `forfait-none-pensions` | [[docs/reference/belgian-tax-rule-matrix#Professional expenses (forfait)\|Professional expenses (forfait)]] | Pensions and replacement income… | SC-07 |
| `alimony` | [[docs/reference/belgian-tax-rule-matrix#Deductions from the taxable base\|Deductions from the taxable base]] | Alimony paid… | JA-01, SC-23 |
| `pension-savings` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Pension savings… | JR-01 |
| `life-insurance` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Long-term savings… | — |
| `donations` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Donations: rate… | SC-17, JG-01, SC-23 |
| `donations-cap` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Donations capped… | JG-01, SC-23 |
| `childcare` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Childcare 45%… | — |
| `domestic-help` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Domestic personnel… | — |
| `service-voucher-rule` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Service vouchers: reduction… | SV-2024-flanders, SV-2024-wallonia, SV-2024-brussels, SV-2025-flanders, SV-2025-wallonia, SV-2025-brussels, SV-2026-flanders, SV-2026-wallonia, SV-2026-brussels |
| `service-voucher-flanders` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Service vouchers: Flanders… | SV-2024-flanders, SV-2025-flanders, SV-2026-flanders |
| `service-voucher-wallonia` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Service vouchers: Wallonia… | SV-2024-wallonia, SV-2025-wallonia, SV-2026-wallonia, SV-W-TOTAL |
| `service-voucher-brussels` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Service vouchers: Brussels… | RG-03, SV-2024-brussels, SV-2025-brussels, SV-2026-brussels |
| `group-insurance` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Employee group insurance… | — |
| `art126-joint` | [[docs/reference/belgian-tax-rule-matrix#Marital quotient and joint assessment\|Marital quotient and joint assessment]] | Joint assessment from the year after… | AS-02 |
| `treaty-threshold` | [[docs/reference/belgian-tax-rule-matrix#Marital quotient and joint assessment\|Marital quotient and joint assessment]] | Separate assessment when a spouse has treaty-exempt… | JX-01, JX-02, JX-03 |
| `mq-cap` | [[docs/reference/belgian-tax-rule-matrix#Marital quotient and joint assessment\|Marital quotient and joint assessment]] | Quotient: 30%… | AS-11, JQ-01, JQ-02, JQ-03, JQ-05, JQ-06, JQ-07 |
| `mq-art88-topup` | [[docs/reference/belgian-tax-rule-matrix#Marital quotient and joint assessment\|Marital quotient and joint assessment]] | Quotient: spouse below 30%… | JQ-03, JT-01, JD-02, IN-03 |
| `mq-not-higher` | [[docs/reference/belgian-tax-rule-matrix#Marital quotient and joint assessment\|Marital quotient and joint assessment]] | Quotient not applied… | JQ-01, JQ-04, JA-01, IN-01 |
| `employee-ss` | [[docs/reference/belgian-tax-rule-matrix#Social security\|Social security]] | Employee contribution… | SC-01 |
| `civil-servant-ss` | [[docs/reference/belgian-tax-rule-matrix#Social security\|Social security]] | Statutory civil servant… | SC-02 |
| `csss-single` | [[docs/reference/belgian-tax-rule-matrix#Social security\|Social security]] | CSSS single scale… | AS-01, SC-01, SC-02, SC-11, SC-15 |
| `csss-joint` | [[docs/reference/belgian-tax-rule-matrix#Social security\|Social security]] | CSSS joint scale… | JQ-01, JD-01, JD-02, JC-01, JC-02 |
| `csss-household-base` | [[docs/reference/belgian-tax-rule-matrix#Social security\|Social security]] | CSSS base under joint… | JQ-01, JC-01, JC-02 |
| `csss-subject` | [[docs/reference/belgian-tax-rule-matrix#Social security\|Social security]] | CSSS only for employees… | SC-03, SC-04, SC-07 |
| `self-employed-contrib-estimate` | [[docs/reference/belgian-tax-rule-matrix#Social security\|Social security]] | Self-employed contributions… | — |
| `autonomy-factor` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Reduced state tax… | — |
| `factor-flanders-wallonia` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Flanders and Wallonia… | RG-02, SV-W-TOTAL, SC-01 |
| `factor-brussels` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Brussels: opcentiemen… | RG-01, RG-03 |
| `surcharge` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Communal surcharge… | RG-01, RG-02, SC-01 |
| `cadastral-coefficient` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Cadastral income indexation… | — |
| `property-flanders` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Property tax base rate, Flanders… | — |
| `property-wallonia-brussels` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Property tax base rate, Wallonia… | — |
| `property-centimes` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Property tax centimes… | — |
| `woonbonus-pre2015` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Flemish woonbonus, loans before 2015… | RG-04 |
| `woonbonus-2015` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Flemish woonbonus, loans signed in 2015… | RG-14 |
| `woonbonus-integrated` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Integrated woonbonus… | RG-05, RG-16, RG-17, RG-19, RG-20 |
| `woonbonus-extra` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Woonbonus +760… | RG-04, RG-05, RG-13, RG-14, RG-15, RG-16, RG-17, RG-20 |
| `woonbonus-post2020` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | No woonbonus for loans… | RG-06 |
| `cheque-habitat-formula` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Chèque habitat: 1,520… | RG-07, RG-08, RG-12, RG-18 |
| `cheque-habitat-periods` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Chèque habitat halved… | RG-07, RG-08, RG-09, RG-10, RG-18 |
| `cheque-habitat-loans` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Chèque habitat only for loans… | RG-11 |
| `own-home-income` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | Income for the woonbonus rate… | — |
| `dividend-exemption` | [[docs/reference/belgian-tax-rule-matrix#Investment income\|Investment income]] | Dividend exemption… | — |
| `savings-interest` | [[docs/reference/belgian-tax-rule-matrix#Investment income\|Investment income]] | Savings-deposit interest… | — |
| `capital-gains` | [[docs/reference/belgian-tax-rule-matrix#Investment income\|Investment income]] | Capital gains tax… | — |
| `tob-tacr-reynders` | [[docs/reference/belgian-tax-rule-matrix#Investment income\|Investment income]] | TOB, TACR, Reynders… | — |
| `hh-per-spouse` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Income is determined and taxed per spouse… | IN-01, IN-02, IN-04 |
| `hh-no-union` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | One taxpayer, or two partners… | AS-13 |
| `hh-union-year` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Year of marriage… | AS-01, AS-02, AS-03, AS-04, AS-05 |
| `hh-factual-separation` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Factual separation… | AS-07, AS-08 |
| `hh-dissolution` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Year of divorce… | AS-06, AS-09 |
| `hh-death` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Year of death… | AS-10, AS-11, AS-12 |
| `hh-treaty` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Treaty-exempt professional income… | JX-01, JX-02, JX-03 |
| `hh-legacy-joint` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Migrated `married_joint`… | — |
| `hh-forfait-category` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | One forfait per art. 51 category… | SC-09, SC-11 |
| `hh-profits-category` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Trading profits (winsten)… | SC-10 |
| `hh-helping-spouse` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Helping spouse… | SC-06 |
| `hh-self-employed-contrib` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Self-employed social contributions paid… | SC-04, SC-05, SC-06 |
| `hh-director-contrib` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | A company director's own… | — |
| `hh-union-dues` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Union dues… | — |
| `hh-category-loss` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | A category whose actual expenses… | — |
| `hh-alimony` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Alimony is charged… | JA-01 |
| `hh-quotient` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Quotient on net professional income… | JQ-01, JQ-02, JQ-04, JP-02, RG-20 |
| `hh-senior-cap` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | IY 2026 quotient cap… | JQ-06, JQ-07 |
| `hh-exemption-after-quotient` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Tax-free sum and supplements are allocated after… | JT-01 |
| `hh-basic-each` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Each spouse gets the basic amount… | JD-02 |
| `hh-supplements-allocation` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Joint: dependent supplements… | AS-13, JD-01, RG-12, RG-13, RG-15 |
| `hh-balance-transfer` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Joint: the part of a spouse… | JQ-01, JQ-03, JQ-05, JT-01, JD-02, JA-01, IN-01, IN-03 |
| `hh-isolated-parent-partner` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Isolated-parent supplement when… | AS-14, JD-03 |
| `hh-reductions-allocation` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Tax reductions stay… | JR-01 |
| `hh-csss` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | CSSS: joint scale… | AS-01, JC-01 |
| `hh-csss-mixed` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | CSSS base for a spouse who combines… | SC-09 |
| `hh-investment-side` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Dividend and savings side… | — |
| `pension-reduction` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Reduction for pensions… | JP-01, JP-02, SC-07, SC-18, SC-19, SC-20, SC-21 |
| `pension-reduction-share` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Pension reduction in proportion… | SC-19, SC-22 |
| `pension-reduction-taper` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Pension reduction tapers… | JP-01, JP-02, SC-07, SC-18, SC-19, SC-20 |
| `pension-reduction-limit` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Pension reduction limited… | JP-01, JP-02, SC-07, SC-21 |
| `pension-activity-income` | [[docs/reference/belgian-tax-rule-matrix#Tax reductions\|Tax reductions]] | Activity income left out… | SC-22 |
| `region-competence` | [[docs/reference/belgian-tax-rule-matrix#Regional layer, surcharge, property\|Regional layer, surcharge, property]] | The own-home regime follows… | RG-19 |
| `hh-pension-per-spouse` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Reduction for pensions per spouse… | JP-01, JP-02 |
| `hh-pension-quotient` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | The quotient keeps the nature of the income… | JP-02 |
| `hh-donations-joint` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Joint: gifts apportioned… | JG-01, JG-02 |
| `hh-donations-joint-ceiling` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Joint: 10% gift ceiling… | JG-02 |
| `hh-own-home-borrowers` | [[docs/reference/belgian-tax-rule-matrix#Household taxation\|Household taxation]] | Two borrowers: a basket each… | RG-16, RG-17, RG-18, RG-20 |

## Related

- [[docs/reference/belgian-tax-rule-matrix|Belgian Tax Rule Coverage Matrix]]
- [[docs/features/belgian-tax]]
- [[docs/adr/199-belgian-tax-source-verification|ADR-199]]
- [[docs/adr/202-belgian-tax-region-and-own-home-baskets|ADR-202]]
- [[docs/adr/200-belgian-tax-household-model|ADR-200]]
- [[docs/reference/index|Reference index]]
