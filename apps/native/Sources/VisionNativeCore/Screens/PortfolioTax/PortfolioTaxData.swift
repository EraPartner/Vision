import Foundation

/// The server runs the existing portfolio-tax TypeScript estimators. Native code only
/// displays their results; settings values retain Decimal precision independently of CAS tokens.
public struct PortfolioTaxDashboard: Codable, Equatable, Sendable {
    public let year: Int
    public let currency: String
    public let isEmpty: Bool
    public let hasProfile: Bool
    public let hasInKindIncomeUnclassified: Bool
    public let totals: PortfolioTaxTotals
    public let taxBreakdown: [PortfolioTaxCostBreakdown]
    public let feeBreakdown: [PortfolioTaxCostBreakdown]
    public let taxByAssetClass: [PortfolioTaxAssetClassCost]
    public let investmentBreakdown: [PortfolioTaxInvestmentCost]
    public let yearlyCostTrend: [PortfolioTaxMonthlyCost]
    public let dividend: PortfolioTaxDividend
    public let estimates: PortfolioTaxEstimates
    public let taxTable: PortfolioTaxRates
    public let summaries: [PortfolioTaxInvestment]
    public let records: [PortfolioTaxSetting]

    public func validate(year: Int, currency: String) throws {
        guard self.year == year, self.currency.uppercased() == currency.uppercased(),
            Set(summaries.map(\.id)).count == summaries.count,
            summaries.allSatisfy({ $0.id > 0 }),
            investmentBreakdown.allSatisfy({ $0.id > 0 && $0.currency.uppercased() == currency.uppercased() }),
            dividend.unknownDividendConventionCount >= 0,
            dividend.unknownDividendConventionCount == 0
                || (dividend.dividendWhtReclaim == nil && dividend.dividendWhtNetCost == nil)
        else {
            throw APIError.contract(
                APIContractError(
                    endpoint: "/api/belgian-tax/portfolio-dashboard",
                    issues: ["Invalid year, currency, investment identity or dividend completeness"]))
        }
    }
}

public struct PortfolioTaxTotals: Codable, Equatable, Sendable {
    public let totalTaxes: Decimal
    public let totalFees: Decimal
    public let totalTaxesAndFees: Decimal
    public let totalRecordedTaxes: Decimal
    public let totalRecordedFees: Decimal
    public let totalManualTaxes: Decimal
    public let totalManualFees: Decimal
    public let totalManualCosts: Decimal
    public let totalRealizedGain: Decimal
    public let totalUnrealizedGain: Decimal
    public let effectiveTaxRate: Decimal
    public let totalPIT: Decimal
    public let portfolioTaxesPlusPIT: Decimal
}
public struct PortfolioTaxCostBreakdown: Codable, Equatable, Sendable {
    public let nameKey: String
    public let value: Decimal
}
public struct PortfolioTaxAssetClassCost: Codable, Equatable, Sendable {
    public let assetClass: String
    public let taxes: Decimal
    public let fees: Decimal
    public let total: Decimal
}
public struct PortfolioTaxMonthlyCost: Codable, Equatable, Sendable {
    public let period: String
    public let taxes: Decimal
    public let fees: Decimal
}
public struct PortfolioTaxInvestmentCost: Codable, Equatable, Sendable, Identifiable {
    public let id: Int
    public let name: String
    public let symbol: String?
    public let assetClass: String
    public let recordedTaxes: Decimal
    public let recordedFees: Decimal
    public let manualTaxes: Decimal
    public let manualFees: Decimal
    public let taxes: Decimal
    public let fees: Decimal
    public let total: Decimal
    /// Already converted by the backend, like the other monetary values in this row.
    public let realizedGain: Decimal
    public let currency: String
}
public struct PortfolioTaxDividend: Codable, Equatable, Sendable {
    public let totalDividendIncome: Decimal
    public let grossDividendWht: Decimal
    public let dividendWhtReclaim: Decimal?
    public let dividendWhtNetCost: Decimal?
    public let unknownDividendConventionCount: Int
    public let dividendExemption: Decimal
}
public struct PortfolioTaxEstimates: Codable, Equatable, Sendable {
    public let tobRecorded: Decimal
    public let tobAutoEstimate: Decimal
    public let tacrEstimate: Decimal
    public let reyndersEstimate: Decimal
    public let cgtEstimate: Decimal
}
public struct PortfolioTaxRates: Codable, Equatable, Sendable {
    public let securitiesAccountTaxRate: Decimal
    public let capitalGainsTaxRate: Decimal
    public let reyndersTaxRate: Decimal
    public let dividendWHTRate: Decimal
    public let securitiesAccountTaxThreshold: Decimal
    public let badgePercent: PortfolioTaxBadgePercent
}
public struct PortfolioTaxBadgePercent: Codable, Equatable, Sendable {
    public let securitiesAccountTaxRate: Decimal
    public let capitalGainsTaxRate: Decimal
    public let reyndersTaxRate: Decimal
    public let dividendWHTRate: Decimal
}
public struct PortfolioTaxInvestment: Codable, Equatable, Sendable, Identifiable {
    public let id: Int
    public let name: String
    public let symbol: String?
    public let assetClass: String
    public let currency: String
}

public struct PortfolioTaxSetting: Codable, Equatable, Sendable {
    public let key: String
    public let value: TaxValue
    public let expected: JSONValue
    public init(key: String, value: TaxValue, expected: JSONValue) {
        self.key = key
        self.value = value
        self.expected = expected
    }
    public func validate(key: String) throws {
        guard self.key == key, value.objectValue != nil || value == .null,
            let fields = expected.objectValue, let exists = fields["exists"]?.boolValue,
            Set(fields.keys) == (exists ? ["exists", "value"] : ["exists"])
        else {
            throw APIError.contract(
                APIContractError(
                    endpoint: "/api/settings/\(key)", issues: ["Invalid setting value or complete concurrency baseline"]
                ))
        }
    }
}
