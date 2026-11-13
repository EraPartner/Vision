import Foundation

/// `householdOwnHome.ts`: who claims the regional own-home credit and for how much.
enum HouseholdOwnHome {
    /// `OwnHomePartner`.
    struct Partner {
        var id: HouseholdPartnerID
        var taxableIncomeBeforeQuotient: Double
    }

    /// `OwnHomeAllocation`.
    struct Allocation {
        var regime: MortgageCreditRegime
        var borrowers: [HouseholdPartnerID]
        var credits: [HouseholdPartnerID: Double]
        var issues: [HouseholdTaxIssue]
    }

    /// `twoBorrowerShareB(home, partners)`: partner B's share when both partners borrow.
    static func twoBorrowerShareB(_ home: TaxHousehold.Home, _ partners: [Partner]) -> Double? {
        guard let share = home.mortgageSharePartnerB, share > 0, share < 100 else { return nil }
        guard partners.contains(where: { $0.id == .a }), partners.contains(where: { $0.id == .b }) else { return nil }
        return share / 100
    }

    private static func singleBorrower(_ home: TaxHousehold.Home, _ partners: [Partner]) -> HouseholdPartnerID? {
        let named: HouseholdPartnerID =
            home.mortgageSharePartnerB == 100 ? .b : home.mortgageSharePartnerB == 0 ? .a : home.mortgageCreditPartnerID ?? .a
        return partners.contains { $0.id == named } ? named : partners.first?.id
    }

    /// `splitJointWoonbonus(payments, own, caps, rates, useful)`.
    static func splitJointWoonbonus(
        payments: Double, own: [Double], caps: [Double], rates: [Double], useful: [Double]
    ) -> [Double] {
        var claimed = [0.0, 0.0]
        let phases = [[TaxMath.min(useful[0], caps[0]), TaxMath.min(useful[1], caps[1])], caps]
        if rates[0] != rates[1] {
            let order = rates[0] > rates[1] ? [0, 1] : [1, 0]
            var pool = payments
            for limits in phases {
                for index in order {
                    let add = TaxMath.max(TaxMath.min(pool, limits[index] - claimed[index]), 0)
                    claimed[index] += add
                    pool -= add
                }
            }
            return claimed
        }
        var left = [own[0], own[1]]
        let steps = [(0, 0), (1, 1), (0, 1), (1, 0)]
        for limits in phases {
            for (index, from) in steps {
                let add = TaxMath.max(TaxMath.min(left[from], limits[index] - claimed[index]), 0)
                claimed[index] += add
                left[from] -= add
            }
        }
        return claimed
    }

    private static func splitChildSupplement(
        _ parts: [PersonalIncomeTax.ChequeHabitatParts?], own: [Double]
    ) -> [Double] {
        let total = (parts[0] ?? parts[1])?.childSupplement ?? 0
        let room = (0..<2).map { index in
            parts[index].map { TaxMath.max(own[index] / $0.factor - $0.base, 0) } ?? -1
        }
        let first = room[1] > room[0] ? 1 : 0
        let second = 1 - first
        var result = [0.0, 0.0]
        var left = total
        if parts[first] != nil {
            result[first] = parts[second] != nil ? TaxMath.min(left, room[first]) : left
            left -= result[first]
        }
        if parts[second] != nil { result[second] = left }
        return result
    }

    /// `allocateOwnHomeCredit(args)`.
    static func allocate(
        _ household: TaxHousehold, partners: [Partner], mode: AssessmentDecision.Mode,
        childrenClaimant: HouseholdPartnerID?, _ table: BelgianTaxTable, incomeYear: Double,
        taxRoom: [HouseholdPartnerID: Double]? = nil
    ) -> Allocation {
        let home = household.home
        var issues: [HouseholdTaxIssue] = []
        if let mortgageRegion = home.mortgageRegion, mortgageRegion != household.region {
            issues.append(HouseholdTaxIssue("mortgage_region_not_used", .info))
        }
        func inputs(_ id: HouseholdPartnerID) -> PersonalIncomeTax.OwnHomeInputs {
            let hasChildren = mode == .joint || childrenClaimant == id
            return PersonalIncomeTax.OwnHomeInputs(
                home: home, region: household.region,
                dependentChildren: hasChildren ? household.dependents.children : 0,
                dependentChildrenDisabled: hasChildren ? household.dependents.childrenDisabled ?? 0 : 0)
        }
        func taxpayer(_ partner: Partner) -> PersonalIncomeTax.OwnHomeTaxpayer {
            PersonalIncomeTax.OwnHomeTaxpayer(
                taxableIncome: partner.taxableIncomeBeforeQuotient,
                marginalRatePercent: PersonalIncomeTax.marginalRate(partner.taxableIncomeBeforeQuotient, table.brackets),
                incomeYear: incomeYear)
        }
        let regime = PersonalIncomeTax.mortgageRegime(inputs(.a))
        let shareB = twoBorrowerShareB(home, partners)
        let borrowers: [HouseholdPartnerID] = shareB == nil ? [singleBorrower(home, partners)].compactMap { $0 } : [.a, .b]
        if regime == .flemishWoonbonus, home.woonbonusChildrenAtLoanStart == nil,
            incomeYear - (home.mortgageStartYear ?? 0) < 10
        {
            for id in borrowers {
                issues.append(HouseholdTaxIssue("woonbonus_children_at_loan_start_missing", .info, partner: id))
            }
        }
        var credits: [HouseholdPartnerID: Double] = [:]
        for partner in partners { credits[partner.id] = 0 }
        func borrower(_ id: HouseholdPartnerID) -> Partner? { partners.first { $0.id == id } }
        guard let shareB else {
            if let id = borrowers.first, let partner = borrower(id) {
                credits[id] = PersonalIncomeTax.ownHomeCredit(inputs(id), table, regime, taxpayer(partner))
            }
            return Allocation(regime: regime, borrowers: borrowers, credits: credits, issues: issues)
        }
        guard regime != .none, let partnerA = borrower(.a), let partnerB = borrower(.b) else {
            return Allocation(regime: regime, borrowers: borrowers, credits: credits, issues: issues)
        }
        let payments = PersonalIncomeTax.mortgagePayments(home)
        let own = [payments * (1 - shareB), payments * shareB]
        if regime == .flemishWoonbonus {
            let baskets = [
                PersonalIncomeTax.woonbonusBasket(inputs(.a), table, taxpayer(partnerA)),
                PersonalIncomeTax.woonbonusBasket(inputs(.b), table, taxpayer(partnerB)),
            ]
            var claimed = [TaxMath.min(own[0], baskets[0].cap), TaxMath.min(own[1], baskets[1].cap)]
            if mode == .joint {
                func useful(_ id: HouseholdPartnerID, _ rate: Double) -> Double {
                    guard let room = taxRoom?[id] else { return .infinity }
                    return rate > 0 ? TaxMath.max(room, 0) / rate : 0
                }
                claimed = splitJointWoonbonus(
                    payments: payments, own: own, caps: baskets.map(\.cap), rates: baskets.map(\.rate),
                    useful: [useful(.a, baskets[0].rate), useful(.b, baskets[1].rate)])
            }
            credits[.a] = claimed[0] * baskets[0].rate
            credits[.b] = claimed[1] * baskets[1].rate
            return Allocation(regime: regime, borrowers: borrowers, credits: credits, issues: issues)
        }
        let parts = [
            PersonalIncomeTax.chequeHabitatParts(inputs(.a), table, taxpayer(partnerA)),
            PersonalIncomeTax.chequeHabitatParts(inputs(.b), table, taxpayer(partnerB)),
        ]
        let children =
            mode == .joint
            ? splitChildSupplement(parts, own: own) : [parts[0]?.childSupplement ?? 0, parts[1]?.childSupplement ?? 0]
        func credit(_ index: Int) -> Double {
            parts[index].map { TaxMath.min(($0.base + children[index]) * $0.factor, own[index]) } ?? 0
        }
        credits[.a] = credit(0)
        credits[.b] = credit(1)
        return Allocation(regime: regime, borrowers: borrowers, credits: credits, issues: issues)
    }
}
