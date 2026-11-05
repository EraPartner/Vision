import Foundation

public struct TaxDeductionSuggestion: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let titleKey: String
    public let descriptionKey: String
    public let descriptionParams: [String: Decimal]?
    public let estimate: Decimal?
    public let noteKey: String?
}

public struct TaxDeductionCandidates: Decodable, Equatable, Sendable {
    public let year: Int
    public let from: String
    public let to: String
    public let currency: CurrencyCode
    public let byDeductionType: [TaxDeductionGroup]
}

public struct TaxDeductionGroup: Decodable, Equatable, Sendable, Identifiable {
    public var id: String { deductionType }
    public let deductionType: String
    public let total: Decimal
    public let byOwner: [String: Decimal]?
    public let partnerShares: [String: Decimal]?
    public let categoryCount: Int
    public let categories: [Category]
    public struct Category: Decodable, Equatable, Sendable {
        public let category: String
        public let total: Decimal
        public let count: Int
    }
    public var mapping: TaxDeductionMapping? { TaxDeductionMapping.forType(deductionType) }
}

/// Field placement is a structural profile edit; rates, caps and owner shares stay in TypeScript.
public struct TaxDeductionMapping: Equatable, Sendable {
    public let amountField: String
    public let eligibilityField: String?
    public var isHome: Bool { amountField == "mortgageInterestPaid" }
    public var isPartnerField: Bool { amountField == "alimonyPaid" || amountField == "unionDues" }
    public static func forType(_ type: String) -> Self? {
        switch type {
        case "pensionSavings": .init(amountField: "personalPensionContributions", eligibilityField: "pensionEligible")
        case "lifeInsurance": .init(amountField: "lifeInsurancePremiums", eligibilityField: "lifeInsuranceEligible")
        case "groupInsurance":
            .init(
                amountField: "employeeGroupInsuranceContributions", eligibilityField: "employeeGroupInsuranceEligible")
        case "charitableDonations":
            .init(amountField: "charitableDonations", eligibilityField: "charitableDonationsEligible")
        case "childcare": .init(amountField: "childcareCosts", eligibilityField: "childcareEligible")
        case "alimony": .init(amountField: "alimonyPaid", eligibilityField: nil)
        case "unionDues": .init(amountField: "unionDues", eligibilityField: nil)
        case "mortgageInterest": .init(amountField: "mortgageInterestPaid", eligibilityField: nil)
        default: nil
        }
    }
    public func currentValue(in household: TaxValue, partner id: String = "A") -> Decimal {
        if isHome { return household["home"]?[amountField]?.decimalValue ?? 0 }
        let partner = household["partners"]?.arrayValue?.first { $0["id"]?.stringValue == id }
        return (isPartnerField ? partner?[amountField] : partner?["reductions"]?[amountField])?.decimalValue ?? 0
    }
}

public struct TaxDeductionApplication: Equatable, Sendable {
    public let year: Int
    public let group: TaxDeductionGroup
    public init(year: Int, group: TaxDeductionGroup) {
        self.year = year
        self.group = group
    }

    public func applying(to household: TaxValue) throws -> TaxValue {
        guard let mapping = group.mapping, group.total > 0, household.objectValue != nil else {
            throw APIError.invalidRequest("Invalid deduction candidate")
        }
        var draft = TaxProfileDraft(value: household)
        if mapping.isHome {
            draft.set(["home", mapping.amountField], .number(group.total))
            return draft.value
        }
        let twoPartners = draft.partners.contains { $0["id"]?.stringValue == "B" }
        if twoPartners {
            guard let shares = group.partnerShares, let a = shares["A"], let b = shares["B"], a >= 0, b >= 0,
                a + b == group.total
            else {
                throw APIError.invalidRequest("Deduction candidate needs backend partner attribution")
            }
        }
        for partner in draft.partners {
            guard let id = partner["id"]?.stringValue else { throw APIError.invalidRequest("Invalid tax partner") }
            let amount = twoPartners ? (group.partnerShares?[id] ?? 0) : group.total
            let path = draft.partnerPath(id) + (mapping.isPartnerField ? [] : ["reductions"])
            draft.set(path + [mapping.amountField], .number(amount))
            if let eligible = mapping.eligibilityField, amount > 0 { draft.set(path + [eligible], .bool(true)) }
        }
        return draft.value
    }

    /// Candidates edit the live profile even while a historical year is being viewed.
    /// Read the original whole setting so unknown fields survive the conditional replacement.
    public func patch(overview: OpenAPI.BelgianTaxOverview) throws -> TaxSettingsPatch {
        guard year == overview.liveYear, !overview.storedValueInvalid else {
            throw APIError.invalidRequest("Deduction candidate does not match the live profile")
        }
        let canonical = try TaxValue(encoding: overview.liveHousehold)
        var household = canonical
        if let raw = overview.records.first(where: { $0.key == TaxYearMutation.householdKey })?.value, raw != .null {
            let stored = try TaxValue(encoding: raw)
            guard stored.objectValue != nil else {
                throw APIError.invalidRequest("Unreadable stored household settings")
            }
            household = Self.merge(stored, canonical: canonical)
        }
        return try TaxSettingsPatch(
            settings: [TaxYearMutation.householdKey: applying(to: household)], records: overview.records)
    }

    private static func merge(_ raw: TaxValue, canonical: TaxValue) -> TaxValue {
        if var fields = raw.objectValue, let normalized = canonical.objectValue {
            for (key, value) in normalized { fields[key] = merge(fields[key] ?? value, canonical: value) }
            return .object(fields)
        }
        if let rows = canonical.arrayValue, let originals = raw.arrayValue {
            return .array(
                rows.enumerated().map { index, value in
                    let stored =
                        value["id"]?.stringValue.flatMap { id in originals.first { $0["id"]?.stringValue == id } }
                        ?? (originals.indices.contains(index) ? originals[index] : value)
                    return merge(stored, canonical: value)
                })
        }
        return canonical
    }
}
