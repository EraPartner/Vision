import type {
    ActivityKind,
    BelgianTaxHouseholdV2,
    HouseholdPartner,
    IncomeActivity,
    PartnerId,
    RelationshipEvent,
} from "../householdTypes";

let seq = 0;

export function activity(
    kind: ActivityKind,
    amount: number,
    extra: Partial<IncomeActivity> = {},
): IncomeActivity {
    seq += 1;
    return kind === "net_professional_amount"
        ? { id: `act_t${seq}`, kind, grossIncome: 0, netProfessionalIncome: amount, ...extra }
        : { id: `act_t${seq}`, kind, grossIncome: amount, ...extra };
}

export function partner(
    id: PartnerId,
    activities: IncomeActivity[],
    extra: Partial<HouseholdPartner> = {},
): HouseholdPartner {
    return {
        id,
        isDisabled: false,
        activities,
        professionalExpenses: {},
        unionDues: 0,
        otherTaxableIncome: 0,
        alimonyPaid: 0,
        reductions: {
            personalPensionContributions: 0,
            lifeInsurancePremiums: 0,
            charitableDonations: 0,
            childcareCosts: 0,
            medicalExpenses: 0,
        },
        ...extra,
    };
}

export function event(
    kind: RelationshipEvent["kind"],
    date: string,
    partnerId?: PartnerId,
): RelationshipEvent {
    seq += 1;
    return partnerId
        ? { id: `evt_${seq}`, kind, date, partnerId }
        : { id: `evt_${seq}`, kind, date };
}

export function household(
    partners: HouseholdPartner[],
    extra: Partial<BelgianTaxHouseholdV2> = {},
): BelgianTaxHouseholdV2 {
    return {
        version: 2,
        taxYear: 2025,
        profileConfigured: true,
        region: "flanders",
        communalSurchargePercent: 7,
        partners,
        relationship: { events: [] },
        dependents: { children: 0, otherPersons: 0 },
        home: { cadastralIncome: 0, mortgageInterestPaid: 0 },
        ...extra,
    };
}

/** Two partners married since 2015 (joint assessment from 2016 on). */
export function married(
    a: IncomeActivity[],
    b: IncomeActivity[],
    extra: Partial<BelgianTaxHouseholdV2> = {},
): BelgianTaxHouseholdV2 {
    return household([partner("A", a), partner("B", b)], {
        relationship: { events: [event("marriage", "2015-05-02")] },
        ...extra,
    });
}
