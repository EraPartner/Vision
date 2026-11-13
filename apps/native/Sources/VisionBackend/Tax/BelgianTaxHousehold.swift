import Foundation

/// `ActivityTaxResult`.
struct ActivityTaxResult: Equatable, Sendable {
    // lint:allow raw-id an activity id is free text inside the stored household, not a database id
    var activityID: String
    var kind: HouseholdActivityKind
    var forfaitCategory: ForfaitCategory
    var grossIncome = 0.0
    var employeeSocialSecurity = 0.0
    var socialContributionsPaid = 0.0
    var professionalExpenses = 0.0
    var netProfessionalIncome = 0.0

    var jsonValue: JSValue {
        TaxJSON.object([
            ("activityId", .string(activityID)), ("kind", .string(kind.rawValue)),
            ("forfaitCategory", .string(forfaitCategory.rawValue)), ("grossIncome", TaxJSON.number(grossIncome)),
            ("employeeSocialSecurity", TaxJSON.number(employeeSocialSecurity)),
            ("socialContributionsPaid", TaxJSON.number(socialContributionsPaid)),
            ("professionalExpenses", TaxJSON.number(professionalExpenses)),
            ("netProfessionalIncome", TaxJSON.number(netProfessionalIncome)),
        ])
    }
}

/// `CategoryTaxResult`.
struct CategoryTaxResult: Equatable, Sendable {
    var category: ForfaitCategory
    var method: ExpenseMethod
    var grossAfterContributions: Double
    var professionalExpenses: Double
    var unionDuesApplied: Double
    var netIncome: Double

    var jsonValue: JSValue {
        TaxJSON.object([
            ("category", .string(category.rawValue)), ("method", .string(method.rawValue)),
            ("grossAfterContributions", TaxJSON.number(grossAfterContributions)),
            ("professionalExpenses", TaxJSON.number(professionalExpenses)),
            ("unionDuesApplied", TaxJSON.number(unionDuesApplied)), ("netIncome", TaxJSON.number(netIncome)),
        ])
    }
}

/// `PartnerTaxResult`.
struct PartnerTaxResult: Equatable, Sendable {
    var partnerID: HouseholdPartnerID
    var activities: [ActivityTaxResult]
    var categories: [CategoryTaxResult]
    var grossIncome: Double
    var employeeSocialSecurity: Double
    var professionalExpenses: Double
    var unionDuesApplied: Double
    var netProfessionalIncome: Double
    var otherTaxableIncome: Double
    var alimonyDeduction: Double
    var taxableIncomeBeforeQuotient: Double
    var quotientAdjustment: Double
    var taxableIncome: Double
    var bracketTax: BracketTax
    var exemption: ExemptionAllocation
    var exemptionBenefit: Double
    var pitAfterExemption: Double
    var reductions: TaxReductionBreakdown
    var ownHomeCreditRegime: MortgageCreditRegime
    var ownHomeCredit: Double
    var pensionReduction: Double
    var reductionsApplied: Double
    var federalPITAfterReductions: Double
    var communalSurcharge: Double
    var totalPIT: Double
    var specialSocialSecurityContribution = 0.0
    var csssSubject: Bool
    var dividendWhtReclaim: Double
    var savingsInterestTax: Double
    var marginalRate: Double

    var jsonValue: JSValue {
        let number = TaxJSON.number
        return TaxJSON.object([
            ("partnerId", .string(partnerID.rawValue)), ("activities", .array(activities.map(\.jsonValue))),
            ("categories", .array(categories.map(\.jsonValue))), ("grossIncome", number(grossIncome)),
            ("employeeSocialSecurity", number(employeeSocialSecurity)),
            ("professionalExpenses", number(professionalExpenses)), ("unionDuesApplied", number(unionDuesApplied)),
            ("netProfessionalIncome", number(netProfessionalIncome)),
            ("otherTaxableIncome", number(otherTaxableIncome)), ("alimonyDeduction", number(alimonyDeduction)),
            ("taxableIncomeBeforeQuotient", number(taxableIncomeBeforeQuotient)),
            ("quotientAdjustment", number(quotientAdjustment)), ("taxableIncome", number(taxableIncome)),
            ("bracketTax", bracketTax.jsonValue), ("exemption", exemption.jsonValue),
            ("exemptionBenefit", number(exemptionBenefit)), ("pitAfterExemption", number(pitAfterExemption)),
            ("reductions", reductions.jsonValue), ("ownHomeCreditRegime", .string(ownHomeCreditRegime.rawValue)),
            ("ownHomeCredit", number(ownHomeCredit)), ("pensionReduction", number(pensionReduction)),
            ("reductionsApplied", number(reductionsApplied)),
            ("federalPITAfterReductions", number(federalPITAfterReductions)),
            ("communalSurcharge", number(communalSurcharge)), ("totalPIT", number(totalPIT)),
            ("specialSocialSecurityContribution", number(specialSocialSecurityContribution)),
            ("csssSubject", .bool(csssSubject)), ("dividendWhtReclaim", number(dividendWhtReclaim)),
            ("savingsInterestTax", number(savingsInterestTax)), ("marginalRate", number(marginalRate)),
        ])
    }
}

/// `HouseholdTotals`.
struct HouseholdTotals: Equatable, Sendable {
    var grossIncome = 0.0
    var employeeSocialSecurity = 0.0
    var professionalExpenses = 0.0
    var netProfessionalIncome = 0.0
    var taxableIncome = 0.0
    var federalPITBeforeExemption = 0.0
    var personalExemptionBenefit = 0.0
    var taxReductions = 0.0
    var federalPITAfterReductions = 0.0
    var communalSurcharge = 0.0
    var totalPIT = 0.0
    var specialSocialSecurityContribution = 0.0
    var propertyTaxEstimate = 0.0
    var totalTaxBurden = 0.0
    var netTakeHome = 0.0
    var dividendWhtReclaim = 0.0
    var savingsInterestTax = 0.0
    var refundableChildCredit = 0.0

    var jsonValue: JSValue {
        let number = TaxJSON.number
        return TaxJSON.object([
            ("grossIncome", number(grossIncome)), ("employeeSocialSecurity", number(employeeSocialSecurity)),
            ("professionalExpenses", number(professionalExpenses)),
            ("netProfessionalIncome", number(netProfessionalIncome)), ("taxableIncome", number(taxableIncome)),
            ("federalPITBeforeExemption", number(federalPITBeforeExemption)),
            ("personalExemptionBenefit", number(personalExemptionBenefit)), ("taxReductions", number(taxReductions)),
            ("federalPITAfterReductions", number(federalPITAfterReductions)),
            ("communalSurcharge", number(communalSurcharge)), ("totalPIT", number(totalPIT)),
            ("specialSocialSecurityContribution", number(specialSocialSecurityContribution)),
            ("propertyTaxEstimate", number(propertyTaxEstimate)), ("totalTaxBurden", number(totalTaxBurden)),
            ("netTakeHome", number(netTakeHome)), ("dividendWhtReclaim", number(dividendWhtReclaim)),
            ("savingsInterestTax", number(savingsInterestTax)),
            ("refundableChildCredit", number(refundableChildCredit)),
        ])
    }
}

/// `HouseholdTaxResult`.
struct HouseholdTaxResult: Equatable, Sendable {
    /// `HouseholdCsssResult`.
    struct SpecialContribution: Equatable, Sendable {
        var scale = "none"
        var base = 0.0
        var total = 0.0
    }

    var incomeYear: Double
    var assessment: AssessmentDecision
    var partners: [PartnerTaxResult]
    var quotient: MaritalQuotientResult
    var csss: SpecialContribution
    var propertyTaxEstimate: Double
    var totals: HouseholdTotals
    var issues: [HouseholdTaxIssue]

    var jsonValue: JSValue {
        TaxJSON.object([
            ("engineVersion", .int(2)), ("incomeYear", TaxJSON.number(incomeYear)),
            ("assessment", assessment.jsonValue), ("partners", .array(partners.map(\.jsonValue))),
            ("quotient", quotient.jsonValue),
            (
                "csss",
                TaxJSON.object([
                    ("scale", .string(csss.scale)), ("base", TaxJSON.number(csss.base)),
                    ("total", TaxJSON.number(csss.total)),
                ])
            ),
            ("propertyTaxEstimate", TaxJSON.number(propertyTaxEstimate)), ("totals", totals.jsonValue),
            ("issues", .array(issues.map(\.jsonValue))),
        ])
    }
}

/// `household.ts`: the household income tax computation (engine version 2).
enum HouseholdTax {
    /// `PartnerIncome`.
    private struct Income {
        var partner: TaxHousehold.Partner
        var activities: [ActivityTaxResult] = []
        var categories: [CategoryTaxResult] = []
        var grossIncome = 0.0
        var employeeSocialSecurity = 0.0
        var professionalExpenses = 0.0
        var unionDuesApplied = 0.0
        var netProfessionalIncome = 0.0
        var csssSubject = false
        var otherTaxableIncome = 0.0
        var alimonyDeduction = 0.0
        var taxableIncomeBeforeQuotient = 0.0
        var pensionIncome = 0.0
        var activityIncome = 0.0
        var exclusionFraction = 0.0
        var pensionKindMissing = false
        var netIncome = 0.0
    }

    private static func partnerIncome(
        _ partner: TaxHousehold.Partner, _ table: BelgianTaxTable, _ issues: inout [HouseholdTaxIssue]
    ) -> Income {
        var income = Income(partner: partner)
        var grossAfter: [String: Double] = [:]
        var netAmountIncome = 0.0
        for activity in partner.activities {
            var result = ActivityTaxResult(
                activityID: activity.id, kind: activity.kind, forfaitCategory: activity.kind.forfaitCategory)
            if activity.kind == .netProfessionalAmount {
                let net = TaxMath.max(activity.netProfessionalIncome ?? 0, 0)
                netAmountIncome += net
                result.netProfessionalIncome = net
                income.activities.append(result)
                continue
            }
            let gross = TaxMath.amount(activity.grossIncome)
            let socialSecurity = TaxContributions.activitySocialSecurity(activity.kind, gross, table)
            let contributions =
                HouseholdActivityKind.selfEmployedContribution.contains(activity.kind)
                ? TaxMath.max(activity.socialContributionsPaid ?? 0, 0) : 0
            if activity.kind == .director, (activity.socialContributionsPaid ?? 0) > 0 {
                issues.append(
                    HouseholdTaxIssue(
                        "director_contributions_not_deducted", .needsSource, partner: partner.id, activity: activity.id))
            }
            income.grossIncome += gross
            income.employeeSocialSecurity += socialSecurity
            grossAfter[activity.id] = TaxMath.max(gross - TaxMath.max(socialSecurity, 0) - contributions, 0)
            result.grossIncome = gross
            result.employeeSocialSecurity = socialSecurity
            result.socialContributionsPaid = contributions
            income.activities.append(result)
        }
        var categoryNetTotal = 0.0
        for category in ForfaitCategory.all {
            let members = income.activities.indices.filter {
                income.activities[$0].forfaitCategory == category && income.activities[$0].kind != .netProfessionalAmount
            }
            if members.isEmpty { continue }
            var base = 0.0
            for member in members { base += grossAfter[income.activities[member].activityID] ?? 0 }
            let choice = partner.professionalExpenses[category]
            let method = choice?.method ?? .lumpSum
            let unionDues = category == .remuneration && method == .actual ? TaxMath.amount(partner.unionDues) : 0
            let expenses = PersonalIncomeTax.expenseClaim(
                category: category, grossAfterContributions: base, method: method,
                actualAmount: choice?.actualAmount ?? 0, unionDues: unionDues, table)
            let rawNet = base - expenses
            if rawNet < 0 { issues.append(HouseholdTaxIssue("loss_offset_not_modelled", .warning, partner: partner.id)) }
            let netIncome = TaxMath.clampAtZero(rawNet)
            income.categories.append(
                CategoryTaxResult(
                    category: category, method: method, grossAfterContributions: base, professionalExpenses: expenses,
                    unionDuesApplied: unionDues, netIncome: netIncome))
            income.professionalExpenses += expenses
            income.unionDuesApplied += unionDues
            categoryNetTotal += netIncome
            for member in members {
                let share =
                    base > 0 ? (grossAfter[income.activities[member].activityID] ?? 0) / base : 1 / Double(members.count)
                income.activities[member].professionalExpenses = expenses * share
                income.activities[member].netProfessionalIncome = netIncome * share
            }
        }
        let categories = income.categories
        if categories.contains(where: { $0.category == .remuneration }),
            categories.contains(where: { $0.category == .profits })
        {
            issues.append(
                HouseholdTaxIssue("forfait_category_aggregation_unverified", .needsSource, partner: partner.id))
        }
        if TaxMath.orZero(partner.unionDues) > 0,
            !categories.contains(where: { $0.category == .remuneration && $0.method == .actual }),
            categories.contains(where: { $0.method == .actual })
        {
            issues.append(HouseholdTaxIssue("union_dues_outside_remuneration_claim", .info, partner: partner.id))
        }
        let kinds = Set(income.activities.map(\.kind))
        income.csssSubject = !kinds.isDisjoint(with: HouseholdActivityKind.contributionSubject)
        if income.csssSubject, !kinds.isDisjoint(with: HouseholdActivityKind.otherProfessionalKinds) {
            issues.append(HouseholdTaxIssue("csss_mixed_activity_base_unverified", .needsSource, partner: partner.id))
        }
        income.netProfessionalIncome = netAmountIncome > 0 ? categoryNetTotal + netAmountIncome : categoryNetTotal
        income.otherTaxableIncome = TaxMath.amount(partner.otherTaxableIncome)
        income.pensionIncome = TaxMath.sum(income.activities.filter { $0.kind == .pension }, \.netProfessionalIncome)
        let pensions = partner.activities.filter { $0.kind == .pension }
        let grossStatutoryPension = TaxMath.sum(pensions.filter { $0.pensionKind == .statutoryFromLegalAge }) {
            TaxMath.amount($0.grossIncome)
        }
        let hasSurvivorPension = pensions.contains {
            $0.pensionKind == .survivorOrTransition && TaxMath.orZero($0.grossIncome) > 0
        }
        income.pensionKindMissing =
            !hasSurvivorPension && pensions.contains { $0.pensionKind == nil && TaxMath.orZero($0.grossIncome) > 0 }
        income.activityIncome = TaxMath.clampAtZero(income.netProfessionalIncome - income.pensionIncome)
        income.exclusionFraction =
            income.pensionKindMissing
            ? 0
            : PersonalIncomeTax.pensionActivityExclusionFraction(
                grossStatutoryPension: grossStatutoryPension, hasSurvivorPension: hasSurvivorPension,
                table.pensionReduction)
        if income.pensionKindMissing, income.pensionIncome > 0, income.activityIncome > 0 {
            issues.append(
                HouseholdTaxIssue("pension_reduction_activity_income_not_excluded", .warning, partner: partner.id))
        }
        if income.exclusionFraction > 0,
            income.activities.contains(where: {
                ($0.kind == .otherProfessional || $0.kind == .netProfessionalAmount) && $0.netProfessionalIncome > 0
            })
        {
            issues.append(
                HouseholdTaxIssue("pension_exclusion_other_income_counted_as_activity", .info, partner: partner.id))
        }
        income.alimonyDeduction = TaxMath.amount(partner.alimonyPaid) * table.alimonyDeductibleFraction
        income.taxableIncomeBeforeQuotient = TaxMath.clampAtZero(
            income.netProfessionalIncome + income.otherTaxableIncome - income.alimonyDeduction)
        income.netIncome = income.netProfessionalIncome + income.otherTaxableIncome
        return income
    }

    private static func taxableIncomes(_ incomes: [Income], joint: Bool, _ transfer: MaritalQuotient.Transfer?) -> [Double] {
        let totals = incomes.map { income -> Double in
            var adjustment = 0.0
            if let transfer {
                if income.partner.id == transfer.to {
                    adjustment = transfer.transfer
                } else if income.partner.id == transfer.from {
                    adjustment = -transfer.transfer
                }
            }
            return adjustment == 0
                ? income.netProfessionalIncome + income.otherTaxableIncome
                : TaxMath.clampAtZero(income.netProfessionalIncome + adjustment) + income.otherTaxableIncome
        }
        if !joint || incomes.count != 2 {
            return incomes.indices.map { TaxMath.clampAtZero(totals[$0] - incomes[$0].alimonyDeduction) }
        }
        var result = totals
        var overflow = [0.0, 0.0]
        for index in incomes.indices {
            let charged = TaxMath.min(incomes[index].alimonyDeduction, TaxMath.max(result[index], 0))
            result[index] -= charged
            overflow[index] = incomes[index].alimonyDeduction - charged
        }
        for (from, to) in [(0, 1), (1, 0)] {
            result[to] -= TaxMath.min(overflow[from], TaxMath.max(result[to], 0))
        }
        return result.map(TaxMath.clampAtZero)
    }

    /// `TaxStep`.
    private struct Step {
        var taxables: [Double]
        var brackets: [BracketTax] = []
        var allocations: [ExemptionAllocation] = []
        var exemptionBenefits: [Double] = []
        var pitAfterExemption: [Double] = []
        var issues: [HouseholdTaxIssue] = []
        var supplementTotalChildren = 0.0
        var unusedExemption = 0.0
        var pensionReductions: [Double] = []
        var donations: [Double] = []
        var donationCeilingReadingsDiffer = false
    }

    private static func donationReductions(
        _ incomes: [Income], joint: Bool, _ taxables: [Double], _ table: BelgianTaxTable
    ) -> (donations: [Double], readingsDiffer: Bool) {
        let gifts = incomes.map { PersonalIncomeTax.qualifyingDonations($0.partner.reductions, table) }
        let own = incomes.indices.map { PersonalIncomeTax.donationReduction(gifts[$0], incomes[$0].netIncome, table) }
        if !joint || incomes.count != 2 { return (own, false) }
        let pooled = PersonalIncomeTax.donationReduction(
            TaxMath.sum(gifts) { $0 }, TaxMath.sum(incomes, \.netIncome), table)
        let taxed = TaxMath.sum(taxables) { $0 }
        let donations = taxables.indices.map { index in
            taxed > 0 ? (pooled * taxables[index]) / taxed : index == 0 ? pooled : 0
        }
        return (donations, (pooled - TaxMath.sum(own) { $0 }).magnitude > 0.005)
    }

    private static func pensionFigures(
        _ incomes: [Income], _ transfer: MaritalQuotient.Transfer?
    ) -> (pensionIncome: [Double], netIncome: [Double], excludedActivityIncome: [Double]) {
        guard let transfer else {
            return (
                incomes.map(\.pensionIncome), incomes.map(\.netIncome),
                incomes.map { $0.exclusionFraction * $0.activityIncome }
            )
        }
        let from = incomes.first { $0.partner.id == transfer.from }
        var fraction = 0.0
        if let from, from.netProfessionalIncome > 0 {
            fraction = TaxMath.min(transfer.transfer / from.netProfessionalIncome, 1)
        }
        let moved = from.map { $0.pensionIncome * fraction } ?? 0
        let movedExcluded = from.map { $0.exclusionFraction * $0.activityIncome * fraction } ?? 0
        let excluded = incomes.map { income -> Double in
            let own = income.exclusionFraction * income.activityIncome
            if income.partner.id == transfer.from { return own * (1 - fraction) }
            if income.partner.id == transfer.to { return own + movedExcluded }
            return own
        }
        let pension = incomes.map { income -> Double in
            if income.partner.id == transfer.from { return income.pensionIncome - moved }
            if income.partner.id == transfer.to { return income.pensionIncome + moved }
            return income.pensionIncome
        }
        let net = incomes.map { income -> Double in
            if income.partner.id == transfer.from { return TaxMath.clampAtZero(income.netIncome - transfer.transfer) }
            if income.partner.id == transfer.to { return income.netIncome + transfer.transfer }
            return income.netIncome
        }
        return (pension, net, excluded)
    }

    private static func taxStep(
        _ household: TaxHousehold, _ incomes: [Income], _ mode: AssessmentDecision.Mode,
        _ transfer: MaritalQuotient.Transfer?, _ table: BelgianTaxTable
    ) -> Step {
        var step = Step(taxables: taxableIncomes(incomes, joint: mode == .joint, transfer))
        let childcareDeducted = incomes.contains { PersonalIncomeTax.isChildcareDeducted($0.partner.reductions) }
        let allocated = HouseholdExemptions.allocate(
            mode: mode,
            partners: incomes.indices.map { index in
                HouseholdExemptions.Partner(
                    id: incomes[index].partner.id, isDisabled: incomes[index].partner.isDisabled,
                    isIsolatedParent: incomes[index].partner.isIsolatedParent, taxableIncome: step.taxables[index])
            },
            dependents: household.dependents, childcareDeducted: childcareDeducted, table)
        let pension = pensionFigures(incomes, transfer)
        for index in incomes.indices {
            let taxable = step.taxables[index]
            let bracket = PersonalIncomeTax.progressiveTax(taxable, table.brackets)
            let allocation = allocated.allocations[incomes[index].partner.id] ?? ExemptionAllocation()
            let benefit = PersonalIncomeTax.exemptionBenefit(allocation.applied, table.exemptionBrackets)
            let tax = TaxMath.clampAtZero(bracket.total - benefit)
            step.brackets.append(bracket)
            step.allocations.append(allocation)
            step.exemptionBenefits.append(benefit)
            step.pitAfterExemption.append(tax)
            step.pensionReductions.append(
                PersonalIncomeTax.pensionReduction(
                    pensionIncome: pension.pensionIncome[index], netIncome: pension.netIncome[index],
                    taxableIncome: taxable, taxAfterExemption: tax,
                    excludedActivityIncome: pension.excludedActivityIncome[index], table))
        }
        let gifts = donationReductions(incomes, joint: mode == .joint, step.taxables, table)
        step.issues = allocated.issues
        step.supplementTotalChildren = allocated.supplements.children + allocated.supplements.childUnder3
        step.unusedExemption = allocated.unusedExemption
        step.donations = gifts.donations
        step.donationCeilingReadingsDiffer = gifts.readingsDiffer
        return step
    }

    /// `computeHouseholdTax(household)`.
    static func compute(_ household: TaxHousehold) throws -> HouseholdTaxResult {
        let incomeYear = household.taxYear
        let table = BelgianTaxTable.table(for: incomeYear)
        let assessed = HouseholdAssessment.derive(household, incomeYear: incomeYear)
        let decision = assessed.decision
        var issues = assessed.issues
        let mode = decision.mode
        let partners = household.partners.sorted { TaxMath.precedes($0.id.rawValue, $1.id.rawValue) }
            .filter { decision.partnerIDs.contains($0.id) }
        var incomes: [Income] = []
        for partner in partners { incomes.append(partnerIncome(partner, table, &issues)) }
        let childrenClaimant = HouseholdExemptions.claimant(partners.map(\.id), household.dependents.claimantPartnerID)
        let ownHomePartners = incomes.map {
            HouseholdOwnHome.Partner(id: $0.partner.id, taxableIncomeBeforeQuotient: $0.taxableIncomeBeforeQuotient)
        }
        func ownHome(taxRoom: [HouseholdPartnerID: Double]?) -> HouseholdOwnHome.Allocation {
            HouseholdOwnHome.allocate(
                household, partners: ownHomePartners, mode: mode, childrenClaimant: childrenClaimant, table,
                incomeYear: incomeYear, taxRoom: taxRoom)
        }
        let ownHomeBase = ownHome(taxRoom: nil)
        issues += ownHomeBase.issues
        let autonomyFactor = table.regionalAutonomyFactor[household.region] ?? 1
        let surcharge = household.communalSurchargePercent
        let partnerReductions = incomes.map {
            PersonalIncomeTax.reductions($0.partner.reductions, household.region, donationBaseIncome: $0.netIncome, table)
        }
        let fixedCredits = partnerReductions.map { $0.total - $0.donations }
        func otherCredits(_ step: Step, _ index: Int) -> Double {
            fixedCredits[index] + step.donations[index] + step.pensionReductions[index]
        }
        func ownHomeCredits(_ step: Step) -> [HouseholdPartnerID: Double] {
            var taxRoom: [HouseholdPartnerID: Double] = [:]
            for index in incomes.indices {
                taxRoom[incomes[index].partner.id] = TaxMath.clampAtZero(
                    step.pitAfterExemption[index] - otherCredits(step, index))
            }
            return ownHome(taxRoom: taxRoom).credits
        }
        func finalTax(_ step: Step) -> Double {
            let credits = ownHomeCredits(step)
            var total = 0.0
            for index in incomes.indices {
                let after = step.pitAfterExemption[index]
                let applied = TaxMath.min(otherCredits(step, index) + (credits[incomes[index].partner.id] ?? 0), after)
                total += (after - applied) * autonomyFactor * (1 + surcharge / 100)
            }
            return total
        }
        var quotient = MaritalQuotientResult(cap: table.maritalQuotientCap)
        if mode == .joint, incomes.count == 2 {
            let quotientPartners = incomes.map {
                MaritalQuotient.Partner(
                    id: $0.partner.id, netProfessionalIncome: $0.netProfessionalIncome, birthYear: $0.partner.birthYear)
            }
            let cap = MaritalQuotient.cap(quotientPartners, incomeYear: incomeYear, table)
            issues += cap.issues
            quotient = MaritalQuotient.compute(
                quotientPartners[0], quotientPartners[1], rate: table.maritalQuotientRate, cap: cap.cap
            ) { finalTax(taxStep(household, incomes, mode, $0, table)) }
        }
        var appliedTransfer: MaritalQuotient.Transfer?
        if quotient.applied, let from = quotient.fromPartnerID, let to = quotient.toPartnerID {
            appliedTransfer = MaritalQuotient.Transfer(from: from, to: to, transfer: quotient.transfer)
        }
        let step = taxStep(household, incomes, mode, appliedTransfer, table)
        issues += step.issues
        let credits = ownHomeCredits(step)
        if step.unusedExemption > 0, step.supplementTotalChildren > 0 {
            issues.append(HouseholdTaxIssue("refundable_child_credit_not_modelled", .needsSource))
        }
        if step.donationCeilingReadingsDiffer {
            issues.append(HouseholdTaxIssue("donation_joint_ceiling_unverified", .needsSource))
        }
        if let appliedTransfer {
            let from = incomes.first { $0.partner.id == appliedTransfer.from }
            let to = incomes.first { $0.partner.id == appliedTransfer.to }
            if let from, from.exclusionFraction > 0, from.exclusionFraction < 1, from.activityIncome > 0,
                from.pensionIncome > 0
            {
                issues.append(
                    HouseholdTaxIssue(
                        "pension_quotient_partial_exclusion_unverified", .needsSource, partner: appliedTransfer.to))
            }
            let notExcluded = "pension_reduction_activity_income_not_excluded"
            if let from, let to, from.pensionKindMissing, from.pensionIncome > 0, from.activityIncome > 0,
                !issues.contains(where: { $0.code == notExcluded && $0.partnerID == to.partner.id })
            {
                issues.append(HouseholdTaxIssue(notExcluded, .warning, partner: to.partner.id))
            }
        }
        var results: [PartnerTaxResult] = incomes.indices.map { index in
            let income = incomes[index]
            let id = income.partner.id
            var reductions = partnerReductions[index]
            let donations = step.donations[index]
            reductions.total = reductions.total - reductions.donations + donations
            reductions.donations = donations
            let ownHomeCredit = credits[id] ?? 0
            let after = step.pitAfterExemption[index]
            let pensionReduction = TaxMath.min(step.pensionReductions[index], after)
            let reductionsApplied = TaxMath.min(pensionReduction + reductions.total + ownHomeCredit, after)
            let federal = (after - reductionsApplied) * autonomyFactor
            let communal = federal * (surcharge / 100)
            let investment = PersonalIncomeTax.investmentSide(
                dividendIncome: income.partner.annualDividendIncome, savingsInterest: income.partner.annualSavingsInterest,
                table)
            let taxable = step.taxables[index]
            return PartnerTaxResult(
                partnerID: id, activities: income.activities, categories: income.categories,
                grossIncome: income.grossIncome, employeeSocialSecurity: income.employeeSocialSecurity,
                professionalExpenses: income.professionalExpenses, unionDuesApplied: income.unionDuesApplied,
                netProfessionalIncome: income.netProfessionalIncome, otherTaxableIncome: income.otherTaxableIncome,
                alimonyDeduction: income.alimonyDeduction,
                taxableIncomeBeforeQuotient: income.taxableIncomeBeforeQuotient,
                quotientAdjustment: appliedTransfer.map { id == $0.to ? $0.transfer : -$0.transfer } ?? 0,
                taxableIncome: taxable, bracketTax: step.brackets[index], exemption: step.allocations[index],
                exemptionBenefit: step.exemptionBenefits[index], pitAfterExemption: after, reductions: reductions,
                ownHomeCreditRegime: ownHomeBase.borrowers.contains(id) ? ownHomeBase.regime : .none,
                ownHomeCredit: ownHomeCredit, pensionReduction: pensionReduction, reductionsApplied: reductionsApplied,
                federalPITAfterReductions: federal, communalSurcharge: communal, totalPIT: federal + communal,
                csssSubject: income.csssSubject, dividendWhtReclaim: investment.dividendWhtReclaim,
                savingsInterestTax: investment.savingsInterestTax,
                marginalRate: PersonalIncomeTax.marginalRate(taxable, table.brackets))
        }
        let ownHomeCreditLost = results.contains {
            $0.ownHomeCredit > 0
                && $0.pensionReduction + $0.reductions.total + $0.ownHomeCredit > $0.pitAfterExemption + 0.005
        }
        if mode == .joint, results.count == 2,
            results.contains(where: { $0.reductions.total - $0.reductions.donations > 0 }) || ownHomeCreditLost
        {
            issues.append(HouseholdTaxIssue("joint_reduction_allocation_unverified", .needsSource))
        }
        let contributionNet = taxableIncomes(incomes, joint: mode == .joint, nil)
        let contributionBases = incomes.indices.map {
            TaxMath.clampAtZero(contributionNet[$0] - incomes[$0].pensionIncome)
        }
        var csss = HouseholdTaxResult.SpecialContribution()
        let anySubject = incomes.contains { $0.csssSubject }
        if mode == .joint, incomes.count == 2 {
            if anySubject {
                let base = TaxMath.clampAtZero(
                    TaxMath.sum(contributionNet) { $0 } - TaxMath.sum(incomes, \.pensionIncome))
                let total = TaxContributions.specialContribution(base, table.csssTableJoint)
                let weight = TaxMath.sum(contributionBases) { $0 }
                csss = HouseholdTaxResult.SpecialContribution(scale: "joint", base: base, total: total)
                for index in incomes.indices {
                    results[index].specialSocialSecurityContribution =
                        weight > 0 ? (total * contributionBases[index]) / weight : 0
                }
            }
        } else {
            var base = 0.0
            var total = 0.0
            for index in incomes.indices where incomes[index].csssSubject {
                let own = TaxContributions.specialContribution(contributionBases[index], table.csssTable)
                results[index].specialSocialSecurityContribution = own
                base += contributionBases[index]
                total += own
            }
            if anySubject { csss = HouseholdTaxResult.SpecialContribution(scale: "single", base: base, total: total) }
        }
        let propertyTax = try TaxContributions.propertyTax(household.home, household.region, table)
        var totals = HouseholdTotals()
        for partner in results {
            totals.grossIncome +=
                partner.grossIncome + partner.otherTaxableIncome
                + TaxMath.sum(partner.activities.filter { $0.kind == .netProfessionalAmount }, \.netProfessionalIncome)
            totals.employeeSocialSecurity += partner.employeeSocialSecurity
            totals.professionalExpenses += partner.professionalExpenses
            totals.netProfessionalIncome += partner.netProfessionalIncome
            totals.taxableIncome += partner.taxableIncome
            totals.federalPITBeforeExemption += partner.bracketTax.total
            totals.personalExemptionBenefit += partner.exemptionBenefit
            totals.taxReductions += partner.exemptionBenefit + partner.reductionsApplied
            totals.federalPITAfterReductions += partner.federalPITAfterReductions
            totals.communalSurcharge += partner.communalSurcharge
            totals.dividendWhtReclaim += partner.dividendWhtReclaim
            totals.savingsInterestTax += partner.savingsInterestTax
        }
        totals.totalPIT = totals.federalPITAfterReductions + totals.communalSurcharge
        totals.specialSocialSecurityContribution = csss.total
        totals.propertyTaxEstimate = propertyTax
        totals.totalTaxBurden = totals.totalPIT + totals.employeeSocialSecurity + csss.total + propertyTax
        totals.netTakeHome = totals.grossIncome - totals.totalTaxBurden
        return HouseholdTaxResult(
            incomeYear: incomeYear, assessment: decision, partners: results, quotient: quotient, csss: csss,
            propertyTaxEstimate: propertyTax, totals: totals, issues: issues)
    }
}
