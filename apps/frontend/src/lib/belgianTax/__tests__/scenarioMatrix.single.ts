// Scenario verification matrix, part 1: one taxpayer, every activity kind, two activities.
// Amounts: rule matrix, IY 2025 unless stated (brackets 16,320 / 28,800 / 49,840; exemption
// scale 11,460 / 16,320 / 27,190 / 49,840; basic exemption 10,910; employee 13.07%; forfait 30%
// capped at 5,930; Flanders factor 1.0000; communal surcharge 7%).

import { expect } from "vitest";
import { activity, household, partner } from "./testHousehold";
import { eur, type Scenario } from "./scenarioMatrix";

const single = (...activities: ReturnType<typeof activity>[]) =>
    household([partner("A", activities)]);

/** IY 2025 exemption benefit of the basic amount alone: 10,910 × 25% (all below 11,460). */
const BASIC_2025 = 2_727.5;

export const SINGLE_SCENARIOS: readonly Scenario[] = [
    {
        id: "SC-01",
        description: "employee 50,000 gross, IY 2025",
        rows: ["employee-ss", "forfait-base", "forfait-employee", "brackets", "basic-exemption", "exemption-scale", "factor-flanders-wallonia", "surcharge", "csss-single"],
        articles: "WIB 92 arts 51, 130, 131, 134 §2; law 29-06-1981 art. 38; law 30-03-1994 art. 108",
        status: "verified",
        household: single(activity("employee", 50_000)),
        verify: (r) => {
            // SS 50,000 × 13.07% = 6,535; forfait base 43,465 × 30% = 13,039.50 → cap 5,930
            // net 43,465 − 5,930 = 37,535
            // art. 130: 16,320 × 25% = 4,080; 12,480 × 40% = 4,992; 8,735 × 45% = 3,930.75
            //           → 13,002.75; exemption 10,910 × 25% = 2,727.50 → 10,275.25
            // × 1.0000 × 1.07 = 10,994.5175
            // CSSS single: 335.50 + (37,535 − 37,344) × 4.009% = 343.15719
            const a = r.partners[0];
            eur(a?.employeeSocialSecurity, 6_535);
            eur(a?.professionalExpenses, 5_930);
            eur(a?.taxableIncome, 37_535);
            eur(a?.bracketTax.total, 13_002.75);
            eur(a?.exemptionBenefit, BASIC_2025);
            eur(r.totals.totalPIT, 10_994.5175);
            eur(r.csss.total, 343.15719);
        },
    },
    {
        id: "SC-02",
        description: "statutory civil servant 50,000 gross, IY 2025",
        rows: ["civil-servant-ss", "forfait-base", "forfait-employee", "brackets", "basic-exemption", "csss-single"],
        articles: "WIB 92 arts 51, 130, 131; law 29-06-1981 art. 38 §2, 4°; law 15-05-1984 art. 60",
        status: "verified",
        household: single(activity("civil_servant", 50_000)),
        verify: (r) => {
            // SS 50,000 × 11.05% = 5,525; base 44,475 → forfait cap 5,930; net 38,545
            // tax 4,080 + 4,992 + 9,745 × 45% (4,385.25) = 13,457.25 − 2,727.50 = 10,729.75
            // × 1.07 = 11,480.8325; CSSS 335.50 + 1,201 × 4.009% = 383.64809
            eur(r.partners[0]?.taxableIncome, 38_545);
            eur(r.totals.totalPIT, 11_480.8325);
            eur(r.csss.total, 383.64809);
        },
    },
    {
        id: "SC-03",
        description: "company director 60,000, IY 2025: 3% forfait, no CSSS",
        rows: ["forfait-director", "brackets", "basic-exemption", "csss-subject"],
        articles: "WIB 92 arts 51 al. 2, 2°, 130, 131; law 30-03-1994 art. 106",
        status: "verified",
        household: single(activity("director", 60_000)),
        verify: (r) => {
            // forfait 60,000 × 3% = 1,800 (< cap 3,130); net 58,200
            // tax 4,080 + 4,992 + 21,040 × 45% (9,468) + 8,360 × 50% (4,180) = 22,720
            // − 2,727.50 = 19,992.50 × 1.07 = 21,391.975; no CSSS outside art. 106
            eur(r.partners[0]?.professionalExpenses, 1_800);
            eur(r.totals.totalPIT, 21_391.975);
            eur(r.csss.total, 0);
        },
    },
    {
        id: "SC-04",
        description: "self-employed trading profits 40,000, contributions 8,000, IY 2025",
        rows: ["forfait-employee", "hh-self-employed-contrib", "brackets", "csss-subject"],
        articles: "WIB 92 arts 51 al. 1 and al. 2, 1°, 52, 7°, 130, 131",
        status: "verified",
        household: single(activity("self_employed_profits", 40_000, { socialContributionsPaid: 8_000 })),
        verify: (r) => {
            // base 40,000 − 8,000 = 32,000; 30% = 9,600 → cap 5,930; net 26,070
            // tax 4,080 + 9,750 × 40% (3,900) = 7,980 − 2,727.50 = 5,252.50 × 1.07 = 5,620.175
            eur(r.partners[0]?.taxableIncome, 26_070);
            eur(r.totals.totalPIT, 5_620.175);
            eur(r.csss.total, 0);
        },
    },
    {
        id: "SC-05",
        description: "liberal-profession fees 30,000, contributions 5,000, IY 2025: degressive forfait",
        rows: ["forfait-fees", "hh-self-employed-contrib", "brackets"],
        articles: "WIB 92 arts 51 al. 2, 4°, 52, 7°, 130, 131",
        status: "verified",
        household: single(activity("self_employed_fees", 30_000, { socialContributionsPaid: 5_000 })),
        verify: (r) => {
            // base 25,000: 7,540 × 28.7% = 2,163.98; 7,430 × 10% = 743; 9,950 × 5% = 497.50;
            // 80 × 3% = 2.40 → 3,406.88 (< cap 5,210); net 21,593.12
            // tax 4,080 + 5,273.12 × 40% (2,109.248) = 6,189.248 − 2,727.50 = 3,461.748
            // × 1.07 = 3,704.07036
            eur(r.partners[0]?.professionalExpenses, 3_406.88);
            eur(r.totals.totalPIT, 3_704.07036);
        },
    },
    {
        id: "SC-06",
        description: "helping spouse 20,000, contributions 3,000, IY 2025: 5% forfait",
        rows: ["forfait-helping-spouse", "hh-helping-spouse", "hh-self-employed-contrib", "brackets"],
        articles: "WIB 92 arts 51 al. 2, 3°, 52, 7°, 130, 131",
        status: "verified",
        household: single(activity("helping_spouse", 20_000, { socialContributionsPaid: 3_000 })),
        verify: (r) => {
            // base 17,000 × 5% = 850 (< cap 5,210); net 16,150
            // tax 16,150 × 25% = 4,037.50 − 2,727.50 = 1,310 × 1.07 = 1,401.70
            eur(r.partners[0]?.professionalExpenses, 850);
            eur(r.totals.totalPIT, 1_401.7);
        },
    },
    {
        id: "SC-07",
        description: "pension 25,000, IY 2025: no forfait, no CSSS; tax not asserted",
        rows: ["forfait-none-pensions", "csss-subject"],
        articles: "WIB 92 art. 51 al. 1; law 30-03-1994 art. 106; art. 147 not in the matrix",
        status: "needs_source",
        missing:
            "WIB 92 art. 147 (tax reduction for pensions and replacement income) is not in the rule matrix or the engine, so the final tax of a pensioner is not law-complete",
        household: single(activity("pension", 25_000)),
        verify: (r) => {
            // Sourced parts only: no forfait, taxable 25,000, no CSSS.
            eur(r.partners[0]?.professionalExpenses, 0);
            eur(r.partners[0]?.taxableIncome, 25_000);
            eur(r.csss.total, 0);
        },
    },
    {
        id: "SC-08",
        description: "already-net professional amount 30,000, IY 2025",
        rows: ["brackets", "basic-exemption", "exemption-scale"],
        articles: "WIB 92 arts 130, 131, 134 §2",
        status: "verified",
        household: single(activity("net_professional_amount", 30_000)),
        verify: (r) => {
            // tax 4,080 + 4,992 + 1,200 × 45% (540) = 9,612 − 2,727.50 = 6,884.50 × 1.07 = 7,366.415
            eur(r.totals.totalPIT, 7_366.415);
            eur(r.csss.total, 0);
        },
    },
    {
        id: "SC-09",
        description: "one person: employee 40,000 + fees 20,000 (contributions 4,000): one forfait per category",
        rows: ["hh-forfait-category", "forfait-employee", "forfait-fees", "hh-csss-mixed"],
        articles: "WIB 92 art. 51 al. 2, 1° and 4°, al. 3; art. 130",
        status: "verified",
        household: single(
            activity("employee", 40_000),
            activity("self_employed_fees", 20_000, { socialContributionsPaid: 4_000 }),
        ),
        verify: (r) => {
            // remuneration: SS 5,228; base 34,772 × 30% = 10,431.60 → cap 5,930; net 28,842
            // fees: base 16,000: 2,163.98 + 743 + 1,030 × 5% (51.50) = 2,958.48; net 13,041.52
            // net 41,883.52: tax 4,080 + 4,992 + 13,083.52 × 45% (5,887.584) = 14,959.584
            // − 2,727.50 = 12,232.084 × 1.07 = 13,088.32988
            // The CSSS of a mixed employee/self-employed person is needs_source; not asserted.
            const a = r.partners[0];
            expect(a?.categories.map((c) => c.category)).toEqual(["remuneration", "fees"]);
            eur(a?.categories[0]?.professionalExpenses, 5_930);
            eur(a?.categories[1]?.professionalExpenses, 2_958.48);
            eur(r.totals.totalPIT, 13_088.32988);
            expect(r.issues).toContainEqual({
                code: "csss_mixed_activity_base_unverified",
                severity: "needs_source",
                partnerId: "A",
            });
        },
    },
    {
        id: "SC-10",
        description: "one person: employee + trading profits; whether art. 51 al. 3 caps them together is open",
        rows: ["hh-profits-category"],
        articles: "WIB 92 art. 51 al. 2, 1° and al. 3",
        status: "needs_source",
        missing:
            "Whether remuneration and trading profits (both art. 51 al. 2, 1°) share one cap under art. 51 al. 3 (forfait_category_aggregation_unverified)",
        household: single(activity("employee", 40_000), activity("self_employed_profits", 15_000)),
        verify: (r) => {
            expect(r.issues).toContainEqual({
                code: "forfait_category_aggregation_unverified",
                severity: "needs_source",
                partnerId: "A",
            });
        },
    },
    {
        id: "SC-11",
        description: "two jobs 30,000 + 30,000 share one remuneration forfait, IY 2024",
        rows: ["hh-forfait-category", "forfait-employee", "brackets", "basic-exemption", "csss-single"],
        articles: "WIB 92 art. 51 al. 3; art. 130 (IY 2024: 15,820 / 27,920 / 48,320); art. 131 (10,570)",
        status: "verified",
        household: household([partner("A", [activity("employee", 30_000), activity("employee", 30_000)])], {
            taxYear: 2024,
        }),
        verify: (r) => {
            // SS 2 × 3,921 = 7,842; base 52,158 × 30% = 15,647.40 → one cap 5,750; net 46,408
            // tax 15,820 × 25% = 3,955; 12,100 × 40% = 4,840; 18,488 × 45% = 8,319.60 → 17,114.60
            // exemption 10,570 × 25% = 2,642.50 → 14,472.10 × 1.07 = 15,485.147
            // CSSS single 481.96 + 5,410.74 × 1.2996% = 552.27797704
            eur(r.partners[0]?.professionalExpenses, 5_750);
            eur(r.totals.totalPIT, 15_485.147);
            eur(r.csss.total, 552.27797704);
        },
    },
    {
        id: "SC-12",
        description: "isolated parent, two children, employee 50,000, IY 2025",
        rows: ["children-supplements", "isolated-parent", "exemption-scale"],
        articles: "WIB 92 arts 132 al. 1, 2°, 133 al. 1, 1°, 134 §2",
        status: "verified",
        household: {
            ...single(activity("employee", 50_000)),
            partners: [partner("A", [activity("employee", 50_000)], { isIsolatedParent: true })],
            dependents: { children: 2, otherPersons: 0 },
        },
        verify: (r) => {
            // exemption 10,910 + 5,110 + 1,980 = 18,000:
            //   11,460 × 25% = 2,865; 4,860 × 30% = 1,458; 1,680 × 40% = 672 → 4,995
            // 13,002.75 (SC-01) − 4,995 = 8,007.75 × 1.07 = 8,568.2925
            eur(r.partners[0]?.exemption.ownTotal, 18_000);
            eur(r.partners[0]?.exemptionBenefit, 4_995);
            eur(r.totals.totalPIT, 8_568.2925);
        },
    },
    {
        id: "SC-13",
        description: "IY 2026: employee 50,000, one child under 3, no childcare deduction",
        rows: ["brackets", "basic-exemption", "children-supplements", "child-under-3", "exemption-scale", "forfait-employee"],
        articles: "WIB 92 arts 130-132, 134 §2 after the law of 15 July 2026 (N27)",
        status: "verified",
        household: {
            ...single(activity("employee", 50_000)),
            taxYear: 2026,
            dependents: { children: 1, childrenUnder3: 1, otherPersons: 0 },
        },
        verify: (r) => {
            // SS 6,535; base 43,465 → cap 6,070; net 37,395
            // tax 16,720 × 25% = 4,180; 12,790 × 40% = 5,116; 7,885 × 45% = 3,548.25 → 12,844.25
            // exemption 11,550 + 2,130 + 740 = 14,420: 11,750 × 25% = 2,937.50; 2,670 × 30% = 801
            // → 3,738.50; 9,105.75 × 1.07 = 9,743.1525
            // CSSS 335.50 + 51 × 4.009% = 337.54459
            eur(r.partners[0]?.taxableIncome, 37_395);
            eur(r.partners[0]?.exemptionBenefit, 3_738.5);
            eur(r.totals.totalPIT, 9_743.1525);
            eur(r.csss.total, 337.54459);
        },
    },
    {
        id: "SC-15",
        description: "IY 2024: one disabled child and one disabled other dependant each count twice",
        rows: ["disabled-dependent", "children-supplements", "other-dependent", "exemption-scale", "csss-single"],
        articles: "WIB 92 arts 132 al. 1, 2° and 8°, 132bis; art. 134 §2 (IY 2024 scale 11,120 / 15,820)",
        status: "verified",
        household: {
            ...single(activity("employee", 50_000)),
            taxYear: 2024,
            dependents: { children: 1, childrenDisabled: 1, otherPersons: 1, otherPersonsDisabled: 1 },
        },
        verify: (r) => {
            // SS 6,535; base 43,465 → cap 5,750; net 37,715
            // tax 3,955 + 4,840 + 9,795 × 45% (4,407.75) = 13,202.75
            // exemption 10,570 + 4,950 (two children) + 2 × 1,920 = 19,360:
            //   11,120 × 25% = 2,780; 4,700 × 30% = 1,410; 3,540 × 40% = 1,416 → 5,606
            // 7,596.75 × 1.07 = 8,128.5225; CSSS 335.50 + 371 × 4.009% = 350.37339
            eur(r.partners[0]?.exemption.ownTotal, 19_360);
            eur(r.totals.totalPIT, 8_128.5225);
            eur(r.csss.total, 350.37339);
        },
    },
    {
        id: "SC-16",
        description: "five children, IY 2025: the fifth child adds 7,070",
        rows: ["children-supplements", "children-fifth", "exemption-scale"],
        articles: "WIB 92 art. 132 al. 1, 4°-5°, art. 134 §2",
        status: "verified",
        household: {
            ...single(activity("employee", 50_000)),
            dependents: { children: 5, otherPersons: 0 },
        },
        verify: (r) => {
            // exemption 10,910 + 18,510 + 7,070 = 36,490 (≤ taxable 37,535):
            //   11,460 × 25% = 2,865; 4,860 × 30% = 1,458; 10,870 × 40% = 4,348;
            //   9,300 × 45% = 4,185 → 12,856
            // 13,002.75 − 12,856 = 146.75 × 1.07 = 157.0225
            eur(r.partners[0]?.exemption.ownTotal, 36_490);
            eur(r.partners[0]?.exemptionBenefit, 12_856);
            eur(r.totals.totalPIT, 157.0225);
        },
    },
    {
        id: "SC-17",
        description: "donation 500, IY 2024: 45% (the 30% rate starts in IY 2025)",
        rows: ["donations"],
        articles: "WIB 92 art. 145/33; law of 18 December 2025 art. 67",
        status: "verified",
        household: household(
            [
                partner("A", [activity("employee", 50_000)], {
                    reductions: {
                        personalPensionContributions: 0,
                        lifeInsurancePremiums: 0,
                        charitableDonations: 500,
                        charitableDonationsEligible: true,
                        childcareCosts: 0,
                        medicalExpenses: 0,
                    },
                }),
            ],
            { taxYear: 2024 },
        ),
        verify: (r) => {
            // IY 2024: 500 ≥ 40 and ≤ 10% of net income → 500 × 45% = 225
            eur(r.partners[0]?.reductions.donations, 225);
        },
    },
    {
        id: "SC-14",
        description: "single parent with children but no supplement request: refundable credit stays an open item",
        rows: ["refundable-child-credit"],
        articles: "WIB 92 art. 134 §3",
        status: "needs_source",
        missing: "The art. 134 §3 refundable child tax credit formula (engine returns 0)",
        household: {
            ...single(activity("employee", 9_000)),
            dependents: { children: 2, otherPersons: 0 },
        },
        verify: (r) => {
            expect(r.totals.refundableChildCredit).toBe(0);
            expect(r.issues).toContainEqual({
                code: "refundable_child_credit_not_modelled",
                severity: "needs_source",
            });
        },
    },
];
