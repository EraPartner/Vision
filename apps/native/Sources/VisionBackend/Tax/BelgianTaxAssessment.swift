import Foundation

/// A caveat the engine attaches to a result (`HouseholdTaxIssue`).
struct HouseholdTaxIssue: Equatable, Sendable {
    enum Severity: String, Sendable {
        case info
        case warning
        case needsSource = "needs_source"
    }

    var code: String
    var severity: Severity
    var partnerID: HouseholdPartnerID?
    // lint:allow raw-id an activity id is free text inside the stored household, not a database id
    var activityID: String?

    init(_ code: String, _ severity: Severity, partner: HouseholdPartnerID? = nil, activity: String? = nil) {
        self.code = code
        self.severity = severity
        partnerID = partner
        activityID = activity
    }

    var jsonValue: JSValue {
        TaxJSON.object([
            ("code", .string(code)), ("severity", .string(severity.rawValue)),
            ("partnerId", partnerID.map { .string($0.rawValue) }), ("activityId", activityID.map(JSValue.string)),
        ])
    }
}

/// How the household is assessed (`AssessmentDecision`).
struct AssessmentDecision: Equatable, Sendable {
    enum Mode: String, Sendable {
        case single
        case separate
        case joint
    }

    var mode: Mode
    var reason: String
    var legalBasis: String
    var electable = false
    var partnerIDs: [HouseholdPartnerID]

    var jsonValue: JSValue {
        TaxJSON.object([
            ("mode", .string(mode.rawValue)), ("reason", .string(reason)), ("legalBasis", .string(legalBasis)),
            ("partnerIds", .array(partnerIDs.map { .string($0.rawValue) })),
            ("electable", electable ? .bool(true) : nil),
        ])
    }
}

/// `assessment.ts`: whether partners are assessed alone, separately or jointly in a year
/// (WIB 92 art. 126).
enum HouseholdAssessment {
    struct Outcome {
        var decision: AssessmentDecision
        var issues: [HouseholdTaxIssue]
    }

    private static let article = "WIB 92 art. 126"

    /// `deriveAssessment(household, incomeYear)`.
    static func derive(_ household: TaxHousehold, incomeYear: Double) -> Outcome {
        typealias Kind = TaxHousehold.Event.Kind
        let ids = household.partners.map(\.id)
        var issues: [HouseholdTaxIssue] = []
        func decide(
            _ mode: AssessmentDecision.Mode, _ reason: String, _ basis: String, electable: Bool = false,
            partners: [HouseholdPartnerID]? = nil
        ) -> Outcome {
            Outcome(
                decision: AssessmentDecision(
                    mode: mode, reason: reason, legalBasis: article + " " + basis, electable: electable,
                    partnerIDs: partners ?? ids),
                issues: issues)
        }
        if household.partners.count < 2 { return decide(.single, "one_partner", "§1") }
        let events = household.events.sorted { a, b in
            a.date == b.date ? TaxMath.precedes(a.id, b.id) : TaxMath.precedes(a.date, b.date)
        }
        if let earlierDeath = events.first(where: { $0.kind == .death && $0.year < incomeYear }) {
            let survivors = ids.filter { $0 != earlierDeath.partnerID }
            issues.append(HouseholdTaxIssue("deceased_partner_not_assessed", .info, partner: earlierDeath.partnerID))
            return decide(
                .single, "surviving_partner", "§2 al. 1, 3°", partners: survivors.isEmpty ? ids : survivors)
        }
        if events.isEmpty {
            if household.legacyAssumedJoint {
                issues.append(HouseholdTaxIssue("relationship_dates_missing", .warning))
                return withTreatyCheck(household, incomeYear, decide(.joint, "legacy_assumed_joint", "§1"))
            }
            return decide(.separate, "no_legal_union", "§1")
        }
        let upToYear = events.filter { $0.year <= incomeYear }
        guard let start = upToYear.last(where: { $0.kind == .marriage || $0.kind == .legalCohabitation }) else {
            return decide(.separate, "no_legal_union", "§1")
        }
        let end = upToYear.first { event in
            event.date >= start.date
                && (event.kind == .death || (event.kind == .divorce && start.kind == .marriage)
                    || (event.kind == .legalCohabitationEnded && start.kind == .legalCohabitation))
        }
        if let end {
            if end.year < incomeYear { return decide(.separate, "dissolved", "§2 al. 1, 3°") }
            if end.kind == .death {
                if household.deathYearElection == .joint {
                    return decide(.joint, "death_year_joint_election", "§3", electable: true)
                }
                return decide(.separate, "death_year", "§2 al. 1, 3° and §3", electable: true)
            }
            return decide(.separate, "dissolution_year", "§2 al. 1, 3°")
        }
        if start.year == incomeYear {
            let priorLegalCohabitation =
                start.kind == .marriage
                && events.contains { event in
                    event.kind == .legalCohabitation && event.year < incomeYear
                        && !events.contains { other in
                            other.kind == .legalCohabitationEnded && other.date >= event.date && other.date < start.date
                        }
                }
            if !priorLegalCohabitation { return decide(.separate, "union_year", "§2 al. 1, 1°") }
            return withTreatyCheck(
                household, incomeYear, decide(.joint, "union_year_after_legal_cohabitation", "§2 al. 2"))
        }
        let separation = upToYear.last { $0.kind == .factualSeparation && $0.date >= start.date }
        if let separation, separation.year < incomeYear {
            return decide(.separate, "factually_separated", "§2 al. 1, 2°")
        }
        return withTreatyCheck(
            household, incomeYear,
            separation != nil
                ? decide(.joint, "factual_separation_year", "§2 al. 1, 2°") : decide(.joint, "union_in_force", "§1"))
    }

    /// `filesJointly(household)`.
    static func filesJointly(_ household: TaxHousehold) -> Bool {
        if household.legacyAssumedJoint, household.events.isEmpty { return true }
        return derive(household, incomeYear: household.taxYear).decision.mode == .joint
    }

    private static func withTreatyCheck(_ household: TaxHousehold, _ incomeYear: Double, _ outcome: Outcome) -> Outcome {
        let threshold = BelgianTaxTable.table(for: incomeYear).treatyExemptSeparateThreshold
        guard let over = household.partners.first(where: { ($0.treatyExemptProfessionalIncome ?? 0) > threshold })
        else { return outcome }
        var issues = outcome.issues
        issues.append(HouseholdTaxIssue("treaty_exempt_separate_assessment", .info, partner: over.id))
        return Outcome(
            decision: AssessmentDecision(
                mode: .separate, reason: "treaty_exempt_income", legalBasis: article + " §2 al. 1, 4°",
                partnerIDs: outcome.decision.partnerIDs),
            issues: issues)
    }
}
