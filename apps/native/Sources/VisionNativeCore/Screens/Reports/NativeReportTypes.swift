import Foundation

public enum NativeReportType: String, CaseIterable, Sendable, Identifiable {
    case financial, portfolio, tax
    public var id: String { rawValue }
    public var labelKey: String { "export.reportType.\(rawValue)" }
    public var sections: [NativeReportSection] {
        let ids: [String]
        switch self {
        case .financial:
            ids = [
                "executiveSummary", "cashflowTrend", "categoryBreakdown", "topRecipients", "bankBalances",
                "rollingAverages", "plannedOutlook",
            ]
        case .portfolio:
            ids = [
                "portfolioExecutiveSummary", "portfolioAllocation", "topHoldings", "performanceTrend",
                "assetClassDetail", "dividendIncome",
            ]
        case .tax:
            ids = [
                "taxExecutiveSummary", "taxTypeBreakdown", "taxByAssetClass", "taxMonthlyTrend", "topInvestmentsByCost",
                "feeBreakdown", "belgianRulesSummary",
            ]
        }
        return ids.map { NativeReportSection(id: $0) }
    }
}

public struct NativeReportSection: Identifiable, Equatable, Sendable {
    public let id: String
    public var labelKey: String { "export.section.\(id)" }
    public init(id: String) { self.id = id }
}

public enum NativeReportPeriodPreset: String, CaseIterable, Sendable, Identifiable {
    case ytd, rolling3, rolling12, year, custom
    public var id: String { rawValue }
    public var labelKey: String { "export.period.\(rawValue)" }
}

public enum NativeReportPeriod: Equatable, Sendable {
    case ytd
    case rolling(months: Int)
    case year(Int)
    case custom(from: String, to: String)
    public var value: TaxValue {
        switch self {
        case .ytd: return .object(["kind": .string("ytd")])
        case .rolling(let months): return .object(["kind": .string("rolling"), "months": .number(Decimal(months))])
        case .year(let year): return .object(["kind": .string("year"), "year": .number(Decimal(year))])
        case .custom(let from, let to):
            return .object(["kind": .string("custom"), "from": .string(from), "to": .string(to)])
        }
    }
    /// Source taxReportHousehold.ts chooses the matching frozen calculation; no tax is computed here.
    public func taxYear(today: String) -> Int? {
        switch self {
        case .year(let year): return year
        case .custom(let from, _): return Int(from.prefix(4))
        case .ytd, .rolling: return Int(today.prefix(4))
        }
    }
}

public struct NativeReportPreferences: Equatable, Sendable {
    public var currency: String
    public var exclusionScope: String
    public var excludedCategoryIds: [Int]
    public var excludedRecipientIds: [Int]
    public init(
        currency: String = "EUR", exclusionScope: String = "everywhere", excludedCategoryIds: [Int] = [],
        excludedRecipientIds: [Int] = []
    ) {
        self.currency = currency
        self.exclusionScope = exclusionScope
        self.excludedCategoryIds = excludedCategoryIds
        self.excludedRecipientIds = excludedRecipientIds
    }
    public func exclusionsApply(type: NativeReportType) -> Bool {
        type == .financial && ["everywhere", "statistics"].contains(exclusionScope)
    }
}

public enum NativeReportForm {
    public static let currencies = ["EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "CZK"]
    public static func isValidYear(_ text: String, currentYear: Int) -> Bool {
        text.range(of: "^[0-9]{4}$", options: .regularExpression) != nil
            && Int(text).map { $0 >= 2000 && $0 <= currentYear + 1 } == true
    }
    public static func isValidCustomRange(from: String, to: String) -> Bool {
        let pattern = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
        return from.range(of: pattern, options: .regularExpression) != nil
            && to.range(of: pattern, options: .regularExpression) != nil && from <= to
    }
    public static func day(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}

public enum NativeReportOutput: Sendable { case download, print }
