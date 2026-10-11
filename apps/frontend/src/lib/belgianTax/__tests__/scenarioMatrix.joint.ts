// Scenario verification matrix, part 2: joint assessment (marital quotient, art. 134 balance
// transfer, dependants, CSSS on household income, treaty-exempt income). Partners married in
// 2015, so every income year here is jointly assessed unless stated (art. 126 §1).
// Amounts: rule matrix; IY 2025 unless stated (see part 1 for the IY 2025 figures). Flanders,
// factor 1.0000, communal surcharge 7%.

import { expect } from "vitest";
import { activity, married, partner } from "./testHousehold";
import { eur, type Scenario } from "./scenarioMatrix";

const net = (amount: number) => activity("net_professional_amount", amount);

export const JOINT_SCENARIOS: readonly Scenario[] = [
    {
        id: "JQ-01",
        description: "quotient A → B at the cap: A employee 80,000 gross, B no income",
        rows: ["mq-cap", "mq-not-higher", "hh-quotient", "decumul", "hh-balance-transfer", "csss-joint", "csss-household-base"],
        articles: "WIB 92 arts 87, 88, 126 §1, 130, 134; law 30-03-1994 arts 107, 2°, 108",
        status: "verified",
        household: {
            ...married([activity("employee", 80_000)], []),
            partners: [partner("A", [activity("employee", 80_000)]), partner("B", [])],
        },
        verify: (r) => {
            // A: SS 10,456; base 69,544 → cap 5,930; net 63,614
            // art. 87: 30% × 63,614 = 19,084.20 > cap 13,460 → transfer 13,460
            // A 50,154: 4,080 + 4,992 + 9,468 + 314 × 50% (157) = 18,697 − 2,727.50 = 15,969.50
            // B 13,460: 3,365 − 2,727.50 = 637.50                                → 16,607
            // Without: A 63,614 → 25,427; B's unused 10,910 moves to A (art. 134): A exemption
            //   21,820 → 2,865 + 1,458 + 5,500 × 40% (2,200) = 6,523 → 18,904
            // 16,607 < 18,904 → applied; benefit (18,904 − 16,607) × 1.07 = 2,457.79
            // total 16,607 × 1.07 = 17,769.49; CSSS joint on 63,614 → flat 632.39
            expect(r.quotient).toMatchObject({ applied: true, fromPartnerId: "A", toPartnerId: "B" });
            eur(r.quotient.transfer, 13_460);
            eur(r.quotient.benefit, 2_457.79);
            eur(r.partners[0]?.pitAfterExemption, 15_969.5);
            eur(r.partners[1]?.pitAfterExemption, 637.5);
            eur(r.totals.totalPIT, 17_769.49);
            expect(r.csss.scale).toBe("joint");
            eur(r.csss.total, 632.39);
        },
    },
    {
        id: "JQ-02",
        description: "quotient B → A: mirror of JQ-01 gives the same household tax",
        rows: ["mq-cap", "hh-quotient"],
        articles: "WIB 92 arts 87, 88",
        status: "verified",
        household: {
            ...married([], [activity("employee", 80_000)]),
            partners: [partner("A", []), partner("B", [activity("employee", 80_000)])],
        },
        verify: (r) => {
            // Same figures as JQ-01 with the partners swapped.
            expect(r.quotient).toMatchObject({ applied: true, fromPartnerId: "B", toPartnerId: "A" });
            eur(r.quotient.transfer, 13_460);
            eur(r.totals.totalPIT, 17_769.49);
        },
    },
    {
        id: "JQ-03",
        description: "art. 88 top-up, IY 2024: A 60,000, B 10,000 net professional income",
        rows: ["mq-art88-topup", "mq-cap", "hh-balance-transfer", "brackets", "exemption-scale"],
        articles: "WIB 92 art. 88 al. 1 (IY 2024 cap 13,050), arts 130, 131 (10,570), 134",
        status: "verified",
        household: married([net(60_000)], [net(10_000)], { taxYear: 2024 }),
        verify: (r) => {
            // 30% × 70,000 = 21,000 > cap 13,050 → own income + transfer = 13,050; transfer 3,050
            // A 56,950: 3,955 + 4,840 + 9,180 + 8,630 × 50% (4,315) = 22,290 − 2,642.50 = 19,647.50
            // B 13,050: 3,262.50 − 2,642.50 = 620                                   → 20,267.50
            // Without: A 60,000 → 23,815; B 10,000 uses 10,000 of 10,570, passes 570 to A:
            //   A exemption 11,140 → 11,120 × 25% + 20 × 30% = 2,786 → 21,029; B 0 → 21,029
            // applied; total 20,267.50 × 1.07 = 21,686.225; benefit 761.50 × 1.07 = 814.805
            eur(r.quotient.transfer, 3_050);
            eur(r.quotient.target, 13_050);
            eur(r.totals.totalPIT, 21_686.225);
            eur(r.quotient.benefit, 814.805);
        },
    },
    {
        id: "JQ-04",
        description: "quotient withheld when it raises the tax: B has no professional but 60,000 other income",
        rows: ["mq-not-higher", "hh-quotient"],
        articles: "WIB 92 arts 87, 88 al. 2 (professional income only; not applied when it raises the tax)",
        status: "verified",
        household: {
            ...married([net(30_000)], []),
            partners: [partner("A", [net(30_000)]), partner("B", [], { otherTaxableIncome: 60_000 })],
        },
        verify: (r) => {
            // transfer would be 30% × 30,000 = 9,000 (B's professional income is 0)
            // Without: A 30,000 → 9,612 − 2,727.50 = 6,884.50; B 60,000 → 23,620 − 2,727.50 =
            //   20,892.50 → 27,777
            // With: A 21,000 → 5,952 − 2,727.50 = 3,224.50; B 69,000 → 28,120 − 2,727.50 =
            //   25,392.50 → 28,617 > 27,777 → not applied
            // total 27,777 × 1.07 = 29,721.39
            expect(r.quotient.applied).toBe(false);
            eur(r.totals.totalPIT, 29_721.39);
        },
    },
    {
        id: "JQ-05",
        description: "quotient below the cap: A 40,000, B 0 net professional income",
        rows: ["mq-cap", "hh-balance-transfer"],
        articles: "WIB 92 arts 87, 134",
        status: "verified",
        household: married([net(40_000)], [net(0)]),
        verify: (r) => {
            // 30% × 40,000 = 12,000 < 13,460 → transfer 12,000
            // A 28,000: 4,080 + 11,680 × 40% (4,672) = 8,752 − 2,727.50 = 6,024.50
            // B 12,000: 3,000 − 2,727.50 = 272.50                     → 6,297 × 1.07 = 6,737.79
            // Without: A 40,000 → 14,112 − 6,523 (exemption 21,820 after the transfer) = 7,589
            // benefit 1,292 × 1.07 = 1,382.44
            eur(r.quotient.transfer, 12_000);
            eur(r.totals.totalPIT, 6_737.79);
            eur(r.quotient.benefit, 1_382.44);
        },
    },
    {
        id: "JQ-06",
        description: "IY 2026 senior cap: both spouses born before 1961 → 12,790",
        rows: ["hh-senior-cap", "mq-cap", "brackets", "basic-exemption"],
        articles: "WIB 92 arts 87-88 after the law of 15 July 2026 arts 27, 30 A (N27: 11,780 / 12,790)",
        status: "verified",
        household: {
            ...married([net(80_000)], [net(0)], { taxYear: 2026 }),
            partners: [
                partner("A", [net(80_000)], { birthYear: 1955 }),
                partner("B", [net(0)], { birthYear: 1960 }),
            ],
        },
        verify: (r) => {
            // B born 1960 is 66 on 1 Jan 2027 → senior cap 12,790; transfer 12,790
            // A 67,210: 4,180 + 5,116 + 21,560 × 45% (9,702) + 16,140 × 50% (8,070) = 27,068
            //   − 11,550 × 25% (2,887.50) = 24,180.50
            // B 12,790: 3,197.50 − 2,887.50 = 310          → 24,490.50 × 1.07 = 26,204.835
            eur(r.quotient.cap, 12_790);
            eur(r.quotient.transfer, 12_790);
            eur(r.totals.totalPIT, 26_204.835);
        },
    },
    {
        id: "JQ-07",
        description: "IY 2026 ordinary cap when one spouse is under 66 → 11,780",
        rows: ["hh-senior-cap", "mq-cap"],
        articles: "WIB 92 arts 87-88 after the law of 15 July 2026 (N27: 11,780)",
        status: "verified",
        household: {
            ...married([net(80_000)], [net(0)], { taxYear: 2026 }),
            partners: [
                partner("A", [net(80_000)], { birthYear: 1955 }),
                partner("B", [net(0)], { birthYear: 1961 }),
            ],
        },
        verify: (r) => {
            // transfer 11,780: A 68,220 → 4,180 + 5,116 + 9,702 + 17,150 × 50% (8,575) = 27,573
            //   − 2,887.50 = 24,685.50; B 11,780 → 2,945 − 2,887.50 = 57.50 → 24,743
            // × 1.07 = 26,475.01
            eur(r.quotient.transfer, 11_780);
            eur(r.totals.totalPIT, 26_475.01);
        },
    },
    {
        id: "JT-01",
        description: "art. 134 balance transfer after the quotient: A 20,000, B 6,000",
        rows: ["hh-balance-transfer", "hh-exemption-after-quotient", "mq-art88-topup"],
        articles: "WIB 92 arts 88 al. 1, 127, 1°, 134 (2011 text §1 al. 2)",
        status: "verified",
        household: married([net(20_000)], [net(6_000)]),
        verify: (r) => {
            // 30% × 26,000 = 7,800 → transfer 1,800; A 18,200, B 7,800
            // B's exemption 10,910 exceeds 7,800 → balance 3,110 to A (exemption 14,020)
            // A: 4,080 + 1,880 × 40% (752) = 4,832 − (2,865 + 2,560 × 30% = 3,633) = 1,199; B 0
            // Without: A 20,000 → 5,552 − (exemption 15,820: 2,865 + 4,360 × 30% = 4,173) = 1,379
            // applied; total 1,199 × 1.07 = 1,282.93
            const [a, b] = r.partners;
            eur(r.quotient.transfer, 1_800);
            eur(b?.exemption.transferredOut, 3_110);
            eur(a?.exemption.transferredIn, 3_110);
            eur(a?.pitAfterExemption, 1_199);
            eur(r.totals.totalPIT, 1_282.93);
        },
    },
    {
        id: "JD-01",
        description: "three children go to the higher earner under joint assessment",
        rows: ["hh-supplements-allocation", "supplements-higher-income", "children-supplements", "csss-joint", "forfait-employee"],
        articles: "WIB 92 arts 132 al. 1, 3°, 134 (2011 text §1 al. 2); law 30-03-1994 art. 108 §1 al. 3",
        status: "verified",
        household: {
            ...married([activity("employee", 60_000)], [activity("employee", 30_000)]),
            dependents: { children: 3, otherPersons: 0 },
        },
        verify: (r) => {
            // A: SS 7,842; base 52,158 → cap 5,930; net 46,228
            // B: SS 3,921; base 26,079 × 30% = 7,823.70 → cap 5,930; net 20,149
            // 30% × 66,377 = 19,913.10 → cap 13,460 < B's 20,149 → no quotient
            // A exemption 10,910 + 11,440 = 22,350 → 2,865 + 1,458 + 6,030 × 40% (2,412) = 6,735
            // A: 4,080 + 4,992 + 17,428 × 45% (7,842.60) = 16,914.60 − 6,735 = 10,179.60
            // B: 4,080 + 3,829 × 40% (1,531.60) = 5,611.60 − 2,727.50 = 2,884.10
            // total 13,063.70 × 1.07 = 13,978.159; CSSS joint on 66,377 → 632.39
            expect(r.quotient.applied).toBe(false);
            eur(r.partners[0]?.exemption.dependentSupplements, 11_440);
            eur(r.partners[1]?.exemption.dependentSupplements, 0);
            eur(r.totals.totalPIT, 13_978.159);
            eur(r.csss.total, 632.39);
        },
    },
    {
        id: "JD-02",
        description: "disabled partner B keeps their own supplement; quotient tops B up",
        rows: ["disabled-supplement", "hh-basic-each", "mq-art88-topup", "hh-balance-transfer", "csss-joint"],
        articles: "WIB 92 arts 88, 131 al. 3, 134; law 30-03-1994 art. 108 §1 al. 3",
        status: "verified",
        household: {
            ...married([activity("employee", 50_000)], [activity("employee", 20_000)]),
            partners: [
                partner("A", [activity("employee", 50_000)]),
                partner("B", [activity("employee", 20_000)], { isDisabled: true }),
            ],
        },
        verify: (r) => {
            // A net 37,535 (SC-01); B: SS 2,614; base 17,386 × 30% = 5,215.80; net 12,170.20
            // 30% × 49,705.20 = 14,911.56 → cap 13,460; transfer 13,460 − 12,170.20 = 1,289.80
            // A 36,245.20: 4,080 + 4,992 + 7,445.20 × 45% (3,350.34) = 12,422.34 − 2,727.50
            //   = 9,694.84
            // B 13,460, exemption 10,910 + 1,980 = 12,890: 3,365 − (2,865 + 1,430 × 30% = 3,294) = 71
            // Without: A 10,275.25 − extra 719.80 × 25% → exemption 11,629.80 (2,865 + 169.80 ×
            //   30% = 2,915.94) → 10,086.81; B 0 → applied (9,765.84 < 10,086.81)
            // total 9,765.84 × 1.07 = 10,449.4488
            // CSSS joint: 123.95 + (49,705.20 − 21,070.96) × 1.3% = 496.19512
            eur(r.partners[1]?.exemption.disability, 1_980);
            eur(r.partners[0]?.exemption.disability, 0);
            eur(r.quotient.transfer, 1_289.8);
            eur(r.totals.totalPIT, 10_449.4488);
            eur(r.csss.total, 496.19512);
        },
    },
    {
        id: "JD-03",
        description: "isolated-parent supplement is refused under a joint assessment",
        rows: ["hh-isolated-parent-partner", "isolated-parent"],
        articles: "WIB 92 art. 133 al. 1, 1° (\"die alleen wordt belast\")",
        status: "verified",
        household: {
            ...married([activity("employee", 50_000)], [activity("employee", 20_000)]),
            partners: [
                partner("A", [activity("employee", 50_000)], { isIsolatedParent: true }),
                partner("B", [activity("employee", 20_000)]),
            ],
            dependents: { children: 1, otherPersons: 0 },
        },
        verify: (r) => {
            eur(r.partners[0]?.exemption.isolatedParentSupplement, 0);
            expect(r.issues).toContainEqual({
                code: "isolated_parent_supplement_not_granted",
                severity: "warning",
                partnerId: "A",
            });
        },
    },
    {
        id: "JC-01",
        description: "CSSS joint scale on the household income: employees 40,000 + 20,000",
        rows: ["csss-joint", "csss-household-base", "hh-csss"],
        articles: "Law 30-03-1994 arts 106, 107, 2°, 108 §1 al. 3",
        status: "verified",
        household: married([activity("employee", 40_000)], [activity("employee", 20_000)]),
        verify: (r) => {
            // A: SS 5,228; base 34,772 → cap 5,930; net 28,842. B net 12,170.20 (JD-02)
            // household 41,012.20: 123.95 + 19,941.24 × 1.3% = 383.18612
            // How the household amount is split between the spouses is not sourced (the matrix
            // row on the pro-rata split is needs_source); only the sum is asserted.
            eur(r.csss.base, 41_012.2);
            eur(r.csss.total, 383.18612);
            eur(
                (r.partners[0]?.specialSocialSecurityContribution ?? 0) +
                    (r.partners[1]?.specialSocialSecurityContribution ?? 0),
                383.18612,
            );
        },
    },
    {
        id: "JC-02",
        description: "CSSS household cap: employees 100,000 + 20,000 → 731.28",
        rows: ["csss-joint", "csss-household-base"],
        articles: "Law 30-03-1994 art. 108 §1 al. 3",
        status: "verified",
        household: married([activity("employee", 100_000)], [activity("employee", 20_000)]),
        verify: (r) => {
            // A: SS 13,070; base 86,930 → cap 5,930; net 81,000. B 12,170.20
            // household 93,170.20 > 81,944 → 731.28
            eur(r.csss.base, 93_170.2);
            eur(r.csss.total, 731.28);
        },
    },
    {
        id: "JX-01",
        description: "treaty-exempt income 13,461 (IY 2025, \"meer dan\" 13,460) → separate assessment",
        rows: ["treaty-threshold", "hh-treaty"],
        articles: "WIB 92 art. 126 §2 al. 1, 4° (N26: 13,460)",
        status: "verified",
        household: {
            ...married([activity("employee", 50_000)], []),
            partners: [
                partner("A", [activity("employee", 50_000)]),
                partner("B", [], { treatyExemptProfessionalIncome: 13_461 }),
            ],
        },
        verify: (r) => {
            // Separate: A as SC-01 (10,994.5175, CSSS single 343.15719); B has no taxable income.
            expect(r.assessment).toMatchObject({ mode: "separate", reason: "treaty_exempt_income" });
            eur(r.totals.totalPIT, 10_994.5175);
            eur(r.csss.total, 343.15719);
            expect(r.quotient.applied).toBe(false);
        },
    },
    {
        id: "JX-02",
        description: "treaty-exempt income exactly at the threshold 13,460 → still joint",
        rows: ["treaty-threshold", "hh-treaty"],
        articles: "WIB 92 art. 126 §2 al. 1, 4°",
        status: "verified",
        household: {
            ...married([activity("employee", 50_000)], []),
            partners: [
                partner("A", [activity("employee", 50_000)]),
                partner("B", [], { treatyExemptProfessionalIncome: 13_460 }),
            ],
        },
        verify: (r) => {
            expect(r.assessment.mode).toBe("joint");
        },
    },
    {
        id: "JX-03",
        description: "IY 2026: threshold is the basic exemption 11,550; 11,551 → separate",
        rows: ["treaty-threshold", "hh-treaty"],
        articles: "WIB 92 art. 126 §2 al. 1, 4° after the law of 15 July 2026 art. 32 (N27)",
        status: "verified",
        household: {
            ...married([activity("employee", 50_000)], [], { taxYear: 2026 }),
            partners: [
                partner("A", [activity("employee", 50_000)]),
                partner("B", [], { treatyExemptProfessionalIncome: 11_551 }),
            ],
        },
        verify: (r) => {
            expect(r.assessment).toMatchObject({ mode: "separate", reason: "treaty_exempt_income" });
        },
    },
    {
        id: "JA-01",
        description: "alimony beyond the payer's income is charged on the other spouse; quotient brings no saving",
        rows: ["alimony", "hh-alimony", "mq-not-higher", "hh-balance-transfer"],
        articles: "WIB 92 arts 88, 104, 1° (IY 2025: 70%), 105, 3°, 134",
        status: "verified",
        household: {
            ...married([net(10_000)], [net(40_000)]),
            partners: [partner("A", [net(10_000)], { alimonyPaid: 20_000 }), partner("B", [net(40_000)])],
        },
        verify: (r) => {
            // alimony 20,000 × 70% = 14,000
            // Without the quotient: A 10,000 − 14,000 → 0, the 4,000 left over is charged on B
            //   (art. 105, 3°) → B 36,000; A's whole exemption 10,910 moves to B (art. 134):
            //   B exemption 21,820 → 2,865 + 1,458 + 5,500 × 40% (2,200) = 6,523
            //   B 4,080 + 4,992 + 7,200 × 45% (3,240) = 12,312 − 6,523 = 5,789
            // With the quotient: 30% × 50,000 = 15,000 → cap 13,460; transfer 3,460 B → A:
            //   A 13,460 − 14,000 → 0, 540 left over on B: 36,540 − 540 = 36,000 → same 5,789
            //   Not lower → not applied (art. 88 al. 2 / the "strictly lower" comparison).
            // total 5,789 × 1.07 = 6,194.23
            expect(r.quotient.applied).toBe(false);
            eur(r.partners[0]?.taxableIncome, 0);
            eur(r.partners[1]?.taxableIncome, 36_000);
            eur(r.partners[1]?.exemption.transferredIn, 10_910);
            eur(r.totals.totalPIT, 6_194.23);
        },
    },
    {
        id: "JR-01",
        description: "allocation of reductions between spouses under a joint assessment",
        rows: ["hh-reductions-allocation", "pension-savings"],
        articles: "WIB 92 arts 145/1 ff. (per-reduction apportionment not read)",
        status: "needs_source",
        missing: "Current per-reduction apportionment rules between jointly assessed spouses (joint_reduction_allocation_unverified)",
        household: {
            ...married([activity("employee", 50_000)], [activity("employee", 20_000)]),
            partners: [
                partner("A", [activity("employee", 50_000)]),
                partner("B", [activity("employee", 20_000)], {
                    reductions: {
                        personalPensionContributions: 1_050,
                        pensionEligible: true,
                        lifeInsurancePremiums: 0,
                        charitableDonations: 0,
                        childcareCosts: 0,
                        medicalExpenses: 0,
                    },
                }),
            ],
        },
        verify: (r) => {
            // Sourced part: pension savings 1,050 × 30% = 315 (art. 145/8, IY 2025 cap 1,050).
            eur(r.partners[1]?.reductions.pension, 315);
            expect(r.issues).toContainEqual({ code: "joint_reduction_allocation_unverified", severity: "needs_source" });
        },
    },
    {
        id: "JP-01",
        description: "two pensioners 30,000 + 15,000: the reduction for pensions per spouse, each with its own limits",
        rows: ["hh-pension-per-spouse", "pension-reduction", "pension-reduction-taper", "pension-reduction-limit"],
        articles: "WIB 92 arts 147 al. 1, 1°, 150, 151/1, 152, 153; arts 87-88",
        status: "verified",
        household: married([activity("pension", 30_000)], [activity("pension", 15_000)]),
        verify: (r) => {
            // art. 87: 30% × 45,000 = 13,500 ≤ B's own 15,000 → no quotient
            // A 30,000: 4,080 + 4,992 + 1,200 × 45% (540) = 9,612 − 2,727.50 = 6,884.50
            //   art. 152: 1/3 + 2/3 × (57,560 − 30,000) / 28,780 = 4,195 / 4,317;
            //   2,219.27 × 4,195 / 4,317 = 2,156.552617558…; no additional (≥ 28,780)
            // B 15,000: 3,750 − 2,727.50 = 1,022.50; 2,219.27 + 457.23 (≤ 19,630) = 2,676.50
            //   art. 153: limited to B's own tax 1,022.50 → B owes 0
            // art. 150: per spouse, so B's unused part does not reduce A's tax
            // (6,884.50 − 2,156.552617558) × 1.07 = 5,058.903699212…
            expect(r.quotient.applied).toBe(false);
            eur(r.partners[0]?.pensionReduction, 2_156.552617558);
            eur(r.partners[1]?.pensionReduction, 1_022.5);
            eur(r.partners[1]?.totalPIT, 0);
            eur(r.totals.totalPIT, 5_058.903699212);
            expect(r.issues.map((i) => i.code)).not.toContain("joint_reduction_allocation_unverified");
        },
    },
    {
        id: "JP-02",
        description: "pensioner 40,000 with a quotient towards a spouse without income: which taxable income the pension limits read",
        rows: ["hh-pension-quotient", "hh-quotient"],
        articles: "WIB 92 arts 87-88, 147, 151/1, 152 (\"belastbaar inkomen\" after the quotient not read)",
        status: "needs_source",
        missing:
            "Whether arts 151/1 and 152 compare the spouse's taxable income after the art. 87 quotient transfer (pension_reduction_quotient_unverified); the engine uses the income after the transfer",
        household: {
            ...married([activity("pension", 40_000)], []),
            partners: [partner("A", [activity("pension", 40_000)]), partner("B", [])],
        },
        verify: (r) => {
            // Sourced part: the quotient 30% × 40,000 = 12,000 (below the 13,460 cap) applies.
            expect(r.quotient.applied).toBe(true);
            eur(r.quotient.transfer, 12_000);
            expect(r.issues).toContainEqual({
                code: "pension_reduction_quotient_unverified",
                severity: "needs_source",
                partnerId: "A",
            });
        },
    },
    {
        id: "JG-01",
        description: "gifts 1,000 paid by A under a joint assessment: the reduction is apportioned on each spouse's taxed income",
        rows: ["hh-donations-joint", "donations", "donations-cap"],
        articles: "WIB 92 art. 145/33 §1 al. 3-5 (\"evenredig omgedeeld in functie van het overeenkomstig artikel 130 belaste inkomen\")",
        status: "verified",
        household: {
            ...married([activity("employee", 50_000)], [activity("employee", 30_000)]),
            partners: [
                partner("A", [activity("employee", 50_000)], {
                    reductions: {
                        personalPensionContributions: 0,
                        lifeInsurancePremiums: 0,
                        charitableDonations: 1_000,
                        charitableDonationsEligible: true,
                        childcareCosts: 0,
                        medicalExpenses: 0,
                    },
                }),
                partner("B", [activity("employee", 30_000)]),
            ],
        },
        verify: (r) => {
            // A net 37,535 (SC-01); B: SS 3,921, base 26,079 × 30% → cap 5,930, net 20,149
            // art. 87: 30% × 57,684 = 17,305.20 ≤ 20,149 → no quotient
            // 1,000 ≤ 10% of either spouse's net income → 1,000 × 30% = 300
            // A 300 × 37,535 / 57,684 = 195.210110256…; B 300 × 20,149 / 57,684 = 104.789889744…
            // A 13,002.75 − 2,727.50 = 10,275.25; B 4,080 + 3,829 × 40% (1,531.60) = 5,611.60
            //   − 2,727.50 = 2,884.10; (13,159.35 − 300) × 1.07 = 13,759.5045
            eur(r.partners[0]?.reductions.donations, 195.210110256);
            eur(r.partners[1]?.reductions.donations, 104.789889744);
            eur(r.totals.totalPIT, 13_759.5045);
            const codes = r.issues.map((i) => i.code);
            expect(codes).not.toContain("donation_joint_ceiling_unverified");
            expect(codes).not.toContain("joint_reduction_allocation_unverified");
        },
    },
    {
        id: "JG-02",
        description: "gifts 5,000 paid by A under a joint assessment: the 10% ceiling on whose net income",
        rows: ["hh-donations-joint-ceiling", "hh-donations-joint"],
        articles: "WIB 92 art. 145/33 §1 al. 4-5",
        status: "needs_source",
        missing:
            "Whether the 10% ceiling of art. 145/33 §1 al. 4 is taken on the spouses' combined net income or per spouse under a joint assessment (donation_joint_ceiling_unverified); the engine pools the gifts and caps them once on the combined income",
        household: {
            ...married([activity("employee", 50_000)], [activity("employee", 30_000)]),
            partners: [
                partner("A", [activity("employee", 50_000)], {
                    reductions: {
                        personalPensionContributions: 0,
                        lifeInsurancePremiums: 0,
                        charitableDonations: 5_000,
                        charitableDonationsEligible: true,
                        childcareCosts: 0,
                        medicalExpenses: 0,
                    },
                }),
                partner("B", [activity("employee", 30_000)]),
            ],
        },
        verify: (r) => {
            // A's own ceiling 3,753.50 → 1,126.05; the combined ceiling 5,768.40 → 1,500.
            // Sourced part: the apportionment of whatever reduction is granted (JG-01) and the issue.
            const a = r.partners[0]?.reductions.donations ?? 0;
            const b = r.partners[1]?.reductions.donations ?? 0;
            eur(a / (a + b), 37_535 / 57_684);
            expect(r.issues).toContainEqual({ code: "donation_joint_ceiling_unverified", severity: "needs_source" });
        },
    },
];
