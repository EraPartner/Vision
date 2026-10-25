import Foundation

/// Server-owned monetary data: never reconstruct tax estimates from input fields in Swift.
public struct TaxDashboardData: Decodable, Sendable {
    public let year: Int
    public let currency: CurrencyCode
    public let isHistorical: Bool
    public let hasIncomeSources: Bool
    public let hasStatsData: Bool
    public let isEmpty: Bool
    public let portfolioTaxesForYear: Decimal
    public let totalTaxIncludingPortfolio: Decimal
    public let totalTaxIncludingPropertyEstimate: Decimal?
    public let yearlyIncome: [TaxYearlyIncomeDatum]
    public let monthlyIncomeTax: [TaxMonthlyIncomeDatum]
    public let recordedIncomeByPartner: TaxRecordedPartnerIncome?
    public let yearCalculations: [TaxDashboardYearCalculation]
    public let currentInputs: TaxDashboardCurrentInputs
    public let exportProfile: TaxValue
    public let suggestions: [TaxDeductionSuggestion]
    public let householdBreakdownRows: [TaxDashboardHouseholdRow]
    public let rules: [TaxDashboardRuleSection]
    /// Currencies of amounts left out because no stored rate converts them (#308); empty or
    /// absent when everything converted.
    public let unconvertedCurrencies: [CurrencyCode]?
    /// Response fields that miss such an amount.
    public let incompleteFigures: [String]?
}
public struct TaxYearlyIncomeDatum: Decodable, Sendable, Identifiable {
    public let year: String
    public let income: Decimal
    public let estimatedTax: Decimal
    public let netAfterTax: Decimal
    public let isApproximated: Bool
    public var id: String { year }
}
public struct TaxMonthlyIncomeDatum: Decodable, Sendable, Identifiable {
    public let period: String
    public let income: Decimal
    public let estimatedTax: Decimal
    public var id: String { period }
}
public struct TaxRecordedPartnerIncome: Decodable, Sendable {
    public let A: Decimal
    public let B: Decimal
}
public struct TaxDashboardYearCalculation: Decodable, Sendable, Identifiable {
    public let year: Int
    public let calculation: OpenAPI.BelgianTaxHistoricalCalculation
    public let isFiled: Bool
    public let hasFrozenCalculation: Bool
    public let isCurrent: Bool
    public let hasSnapshot: Bool
    public let hasTransactions: Bool
    public var id: Int { year }
}
public struct TaxDashboardCurrentInputs: Decodable, Sendable {
    public let employmentType: String
    public let grossAnnualIncome: Decimal
    public let otherTaxableIncome: Decimal
    public let professionalExpenseMethod: String
    public let actualProfessionalExpenses: Decimal
    public let dependentChildren: Int
    public let dependentOtherPersons: Int
    public let isDisabled: Bool
    public let isSpouseDisabled: Bool
}
public struct TaxDashboardHouseholdRow: Decodable, Sendable, Identifiable {
    public let key: String
    public let tone: String
    public let partnerAmounts: [String: Decimal]
    public let household: Decimal
    public var id: String { key }
}
public struct TaxDashboardRuleSection: Decodable, Sendable, Identifiable {
    public let titleKey: String
    public let itemKeys: [String]
    public var id: String { titleKey }
}
