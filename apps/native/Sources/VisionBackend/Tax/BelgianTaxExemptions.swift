import Foundation

/// One partner's tax-free amount (`ExemptionAllocation`).
struct ExemptionAllocation: Equatable, Sendable {
    var basic = 0.0
    var disability = 0.0
    var dependentSupplements = 0.0
    var isolatedParentSupplement = 0.0
    var ownTotal = 0.0
    var transferredIn = 0.0
    var transferredOut = 0.0
    var total = 0.0
    var applied = 0.0

    var jsonValue: JSValue {
        TaxJSON.object([
            ("basic", TaxJSON.number(basic)), ("disability", TaxJSON.number(disability)),
            ("dependentSupplements", TaxJSON.number(dependentSupplements)),
            ("isolatedParentSupplement", TaxJSON.number(isolatedParentSupplement)),
            ("ownTotal", TaxJSON.number(ownTotal)), ("transferredIn", TaxJSON.number(transferredIn)),
            ("transferredOut", TaxJSON.number(transferredOut)), ("total", TaxJSON.number(total)),
            ("applied", TaxJSON.number(applied)),
        ])
    }
}

/// `exemptions.ts`: the tax-free amounts and who carries the dependents' supplements.
enum HouseholdExemptions {
    /// `DependentSupplements`.
    struct Supplements {
        var childCount: Double
        var children: Double
        var childUnder3: Double
        var otherDependents: Double
        var total: Double
    }

    /// `ExemptionPartnerInput`.
    struct Partner {
        var id: HouseholdPartnerID
        var isDisabled: Bool
        var isIsolatedParent: Bool?
        var taxableIncome: Double
    }

    /// `AllocateExemptionsResult`.
    struct Result {
        var allocations: [HouseholdPartnerID: ExemptionAllocation]
        var supplements: Supplements
        var unusedExemption: Double
        var issues: [HouseholdTaxIssue]
    }

    /// `array[index] ?? 0` for a JavaScript number index.
    private static func element(_ values: [Double], at index: Double) -> Double {
        guard index >= 0, index < Double(values.count), index.rounded(.down) == index else { return 0 }
        return values[Int(index)]
    }

    /// `computeDependentSupplements(dependents, childcareDeducted, table)`.
    static func supplements(
        _ dependents: TaxHousehold.Dependents, childcareDeducted: Bool, _ table: BelgianTaxTable
    ) -> Supplements {
        let rawChildren = TaxMath.amount(dependents.children)
        let disabledChildren = TaxMath.min(TaxMath.amount(dependents.childrenDisabled), rawChildren)
        let childCount = rawChildren + disabledChildren
        let increases = table.dependentChildExemptionIncreases
        let children =
            childCount <= 4
            ? element(increases, at: childCount)
            : element(increases, at: 4) + (childCount - 4) * table.extraChildExemptionFromFifth
        let childUnder3 = childcareDeducted ? 0 : TaxMath.amount(dependents.childrenUnder3) * table.childUnder3Supplement
        let rawOther = TaxMath.amount(dependents.otherPersons)
        let disabledOther = TaxMath.min(TaxMath.amount(dependents.otherPersonsDisabled), rawOther)
        let otherDependents = (rawOther + disabledOther) * table.otherDependentExemption
        return Supplements(
            childCount: childCount, children: children, childUnder3: childUnder3, otherDependents: otherDependents,
            total: children + childUnder3 + otherDependents)
    }

    /// `resolveDependentsClaimant(partners, claimantPartnerId)`.
    static func claimant(_ partners: [HouseholdPartnerID], _ claimant: HouseholdPartnerID?) -> HouseholdPartnerID? {
        if let claimant, partners.contains(claimant) { return claimant }
        return partners.first
    }

    /// `allocateExemptions(input)`.
    static func allocate(
        mode: AssessmentDecision.Mode, partners: [Partner], dependents: TaxHousehold.Dependents,
        childcareDeducted: Bool, _ table: BelgianTaxTable
    ) -> Result {
        var issues: [HouseholdTaxIssue] = []
        let supplements = supplements(dependents, childcareDeducted: childcareDeducted, table)
        var supplementPartner = claimant(partners.map(\.id), dependents.claimantPartnerID) ?? .a
        let jointPair = mode == .joint && partners.count == 2
        if jointPair {
            if partners[0].taxableIncome > partners[1].taxableIncome {
                supplementPartner = partners[0].id
            } else if partners[1].taxableIncome > partners[0].taxableIncome {
                supplementPartner = partners[1].id
            }
        }
        let coAssessed = partners.count == 2
        var allocations: [HouseholdPartnerID: ExemptionAllocation] = [:]
        for partner in partners {
            let carries = partner.id == supplementPartner
            var allocation = ExemptionAllocation()
            allocation.basic = table.basicPersonalExemption
            allocation.dependentSupplements = carries ? supplements.total : 0
            allocation.disability = partner.isDisabled ? table.disabledSupplement : 0
            if partner.isIsolatedParent == true, supplements.childCount > 0 {
                if !coAssessed, mode == .single {
                    allocation.isolatedParentSupplement = table.isolatedParentSupplement
                } else {
                    issues.append(
                        HouseholdTaxIssue(
                            "isolated_parent_supplement_not_granted", mode == .joint ? .warning : .needsSource,
                            partner: partner.id))
                }
            }
            allocation.ownTotal =
                allocation.basic + (carries ? supplements.children : 0) + (carries ? supplements.childUnder3 : 0)
                + (carries ? supplements.otherDependents : 0) + allocation.disability
                + allocation.isolatedParentSupplement
            allocation.total = allocation.ownTotal
            allocation.applied = TaxMath.min(allocation.ownTotal, TaxMath.max(partner.taxableIncome, 0))
            allocations[partner.id] = allocation
        }
        if jointPair, var first = allocations[partners[0].id], var second = allocations[partners[1].id] {
            let firstShort = TaxMath.max(partners[0].taxableIncome, 0) < first.ownTotal
            let secondShort = TaxMath.max(partners[1].taxableIncome, 0) < second.ownTotal
            if firstShort != secondShort {
                func transfer(
                    _ giver: Partner, _ giving: inout ExemptionAllocation, _ receiver: Partner,
                    _ receiving: inout ExemptionAllocation
                ) {
                    let balance = giving.ownTotal - TaxMath.max(giver.taxableIncome, 0)
                    giving.transferredOut = balance
                    giving.total = giving.ownTotal - balance
                    giving.applied = TaxMath.min(giving.total, TaxMath.max(giver.taxableIncome, 0))
                    receiving.transferredIn = balance
                    receiving.total = receiving.ownTotal + balance
                    receiving.applied = TaxMath.min(receiving.total, TaxMath.max(receiver.taxableIncome, 0))
                }
                if firstShort {
                    transfer(partners[0], &first, partners[1], &second)
                } else {
                    transfer(partners[1], &second, partners[0], &first)
                }
                allocations[partners[0].id] = first
                allocations[partners[1].id] = second
            }
        }
        var unused = 0.0
        for partner in partners {
            if let allocation = allocations[partner.id] { unused += allocation.total - allocation.applied }
        }
        return Result(allocations: allocations, supplements: supplements, unusedExemption: unused, issues: issues)
    }
}

/// `MaritalQuotientResult`.
struct MaritalQuotientResult: Equatable, Sendable {
    var applied = false
    var transfer = 0.0
    var fromPartnerID: HouseholdPartnerID?
    var toPartnerID: HouseholdPartnerID?
    var target = 0.0
    var cap: Double
    var benefit = 0.0

    var jsonValue: JSValue {
        TaxJSON.object([
            ("applied", .bool(applied)), ("transfer", TaxJSON.number(transfer)),
            ("fromPartnerId", fromPartnerID.map { .string($0.rawValue) }),
            ("toPartnerId", toPartnerID.map { .string($0.rawValue) }), ("target", TaxJSON.number(target)),
            ("cap", TaxJSON.number(cap)), ("benefit", TaxJSON.number(benefit)),
        ])
    }
}

/// `maritalQuotient.ts` (WIB 92 arts 87-88).
enum MaritalQuotient {
    /// `QuotientPartnerInput`.
    struct Partner {
        var id: HouseholdPartnerID
        var netProfessionalIncome: Double
        var birthYear: Double?
    }

    /// `QuotientTransfer`.
    struct Transfer {
        var from: HouseholdPartnerID
        var to: HouseholdPartnerID
        var transfer: Double
    }

    /// `resolveMaritalQuotientCap(partners, incomeYear, table)`.
    static func cap(
        _ partners: [Partner], incomeYear: Double, _ table: BelgianTaxTable
    ) -> (cap: Double, issues: [HouseholdTaxIssue]) {
        guard let seniorCap = table.maritalQuotientCapBothSenior else { return (table.maritalQuotientCap, []) }
        var birthYears: [Double] = []
        for partner in partners {
            guard let year = partner.birthYear else {
                return (
                    table.maritalQuotientCap, [HouseholdTaxIssue("senior_quotient_cap_birth_years_missing", .info)]
                )
            }
            birthYears.append(year)
        }
        let bothSenior = partners.count == 2 && birthYears.allSatisfy { $0 <= incomeYear - 66 }
        return (bothSenior ? seniorCap : table.maritalQuotientCap, [])
    }

    /// `computeMaritalQuotient(input)`: `evaluate` answers the household's tax for a transfer.
    static func compute(
        _ first: Partner, _ second: Partner, rate: Double, cap: Double, evaluate: (Transfer?) throws -> Double
    ) rethrows -> MaritalQuotientResult {
        let firstIncome = TaxMath.max(first.netProfessionalIncome, 0)
        let secondIncome = TaxMath.max(second.netProfessionalIncome, 0)
        let household = firstIncome + secondIncome
        var result = MaritalQuotientResult(cap: cap)
        if household <= 0 { return result }
        let (giver, receiver, receiverIncome) =
            firstIncome >= secondIncome ? (first, second, secondIncome) : (second, first, firstIncome)
        let target = TaxMath.min(household * rate, cap)
        let transfer = TaxMath.max(0, target - receiverIncome)
        result.target = target
        if transfer <= 0 { return result }
        let baseline = try evaluate(nil)
        let withQuotient = try evaluate(Transfer(from: giver.id, to: receiver.id, transfer: transfer))
        if withQuotient >= baseline { return result }
        result.applied = true
        result.transfer = transfer
        result.fromPartnerID = giver.id
        result.toPartnerID = receiver.id
        result.benefit = baseline - withQuotient
        return result
    }
}
