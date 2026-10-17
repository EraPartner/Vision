import Foundation

public enum PortfolioTaxETFStructure: String, CaseIterable, Codable, Sendable {
    case accumulating, distributing
}
public enum PortfolioTaxReyndersChoice: String, CaseIterable, Sendable {
    case auto, yes, no
}
public struct PortfolioTaxAdjustmentDraft: Equatable, Sendable, Identifiable {
    public let id: Int
    public let name: String
    public let symbol: String?
    public let assetClass: String
    public var taxes: String
    public var fees: String
    public var etfStructure: PortfolioTaxETFStructure?
    public var reynders: PortfolioTaxReyndersChoice
    public var interestPortion: String
    public var treatmentExpanded = false
    public var showsETFStructure: Bool { assetClass == "etf" }
    public var showsReynders: Bool { assetClass == "etf" || assetClass == "bond" }
    public var reyndersResolved: Bool { reynders == .yes || (reynders == .auto && assetClass == "bond") }

    init(investment: PortfolioTaxInvestment, year: Int, values: PortfolioTaxSettingsDraft, format: NumberFormat) {
        id = investment.id
        name = investment.name
        symbol = investment.symbol
        assetClass = investment.assetClass
        let amounts = values.adjustments["\(year):\(id)"]
        let cls = values.classifications[String(id)]
        taxes = Self.amountText(Self.storedAmount(amounts?["taxes"]), format: format)
        fees = Self.amountText(Self.storedAmount(amounts?["fees"]), format: format)
        etfStructure = cls?["etfStructure"]?.stringValue.flatMap(PortfolioTaxETFStructure.init(rawValue:))
        reynders = cls?["subjectToReynders"]?.boolValue.map { $0 ? .yes : .no } ?? .auto
        if var percent = cls?["reyndersInterestPortion"]?.decimalValue.map({ $0 * 100 }) {
            var rounded = Decimal()
            NSDecimalRound(&rounded, &percent, 0, .plain)
            interestPortion = VisionFormat.plain(rounded)
        } else {
            interestPortion = ""
        }
    }
    private static func amountText(_ value: Decimal?, format: NumberFormat) -> String {
        guard let value, value != 0 else { return "" }
        return LocaleNumber.editable(value, format: format)
    }
    /// The web reads persisted amounts through Number(value), independently of the
    /// current editing locale. Legacy numeric strings therefore use a decimal point.
    private static func storedAmount(_ value: TaxValue?) -> Decimal? {
        switch value {
        case .number(let amount): return amount
        case .bool(let value): return value ? 1 : 0
        case .string(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard
                trimmed.range(
                    of: "^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$",
                    options: .regularExpression) != nil
            else { return nil }
            return Decimal(string: trimmed, locale: Locale(identifier: "en_US_POSIX"))
        default: return nil
        }
    }
    /// Matches the number input's min/max/step constraints when that field is mounted.
    public var hasInvalidInterestPortion: Bool {
        guard showsReynders, reyndersResolved, !interestPortion.isEmpty else { return false }
        guard let value = Decimal(string: interestPortion, locale: Locale(identifier: "en_US_POSIX")),
            !value.isNaN, value >= 0, value <= 100
        else { return true }
        var input = value
        var integer = Decimal()
        NSDecimalRound(&integer, &input, 0, .plain)
        return integer != value
    }
}

/// Structural edits only. Unknown top-level entries and unknown fields of each investment
/// remain intact, including entries belonging to another year or archived holdings.
public struct PortfolioTaxSettingsDraft: Equatable, Sendable {
    public static let adjustmentsKey = "portfolio_tax_adjustments_v1"
    public static let classificationsKey = "portfolio_tax_classifications_v1"
    public var adjustments: TaxValue
    public var classifications: TaxValue
    public let records: [PortfolioTaxSetting]
    public init(records: [PortfolioTaxSetting]) throws {
        func record(_ key: String) throws -> PortfolioTaxSetting {
            let matches = records.filter { $0.key == key }
            guard matches.count == 1, let result = matches.first else {
                throw APIError.invalidRequest("Missing portfolio tax setting baseline")
            }
            try result.validate(key: key)
            return result
        }
        let amounts = try record(Self.adjustmentsKey)
        let classes = try record(Self.classificationsKey)
        adjustments = amounts.value == .null ? .object([:]) : amounts.value
        classifications = classes.value == .null ? .object([:]) : classes.value
        self.records = [amounts, classes]
    }
    public mutating func apply(rows: [PortfolioTaxAdjustmentDraft], year: Int, format: NumberFormat) throws {
        for row in rows {
            guard row.id > 0, !row.hasInvalidInterestPortion else {
                throw APIError.invalidRequest("Invalid investment tax treatment")
            }
            let key = "\(year):\(row.id)"
            var amount = adjustments[key]?.objectValue.map(TaxValue.object) ?? .object([:])
            amount["taxes"] = .number(LocaleNumber.parseOrZero(row.taxes, format: format))
            amount["fees"] = .number(LocaleNumber.parseOrZero(row.fees, format: format))
            adjustments[key] = amount
            let classKey = String(row.id)
            var cls = classifications[classKey]?.objectValue.map(TaxValue.object) ?? .object([:])
            cls["etfStructure"] = row.etfStructure.map { .string($0.rawValue) }
            cls["subjectToReynders"] = row.reynders == .auto ? nil : .bool(row.reynders == .yes)
            let percent = LocaleNumber.parseOrZero(row.interestPortion, format: format)
            // `portionPct > 0 && portionPct <= 100`: 100% is a full interest portion.
            cls["reyndersInterestPortion"] = percent > 0 && percent <= 100 ? .number(percent / 100) : nil
            classifications[classKey] = cls.objectValue?.isEmpty == true ? nil : cls
        }
    }
    public var patch: PortfolioTaxSettingsPatch {
        PortfolioTaxSettingsPatch(
            settings: [Self.adjustmentsKey: adjustments, Self.classificationsKey: classifications],
            expected: Dictionary(uniqueKeysWithValues: records.map { ($0.key, $0.expected) }))
    }
}
public struct PortfolioTaxSettingsPatch: Encodable, Equatable, Sendable {
    public let settings: [String: TaxValue]
    public let expected: [String: JSONValue]
    init(settings: [String: TaxValue], expected: [String: JSONValue]) {
        self.settings = settings
        self.expected = expected
    }
}
