import Foundation
import VisionNativeCore

/// A payload `normalizeTransactionPayload` refuses (`makeValidationError`).
struct TransactionPayloadError: Error, Equatable, Sendable {
    let message: String
}

/// The staged values of one row as `normalizedSource` of
/// `portfolioImportReconciliationService.ts` produces them: the values
/// `normalizeTransactionPayload` (`services/portfolio/portfolioTransactionRules.ts`) derives,
/// printed as JavaScript prints a number. Two rows are the same source when every field is
/// equal, which is what the TypeScript `JSON.stringify` comparison checks.
struct NormalizedSource: Equatable, Sendable {
    var kind: PortfolioEventKind?
    var day: String?
    var amount: String?
    var units: String?
    var pricePerUnit: String?
    var fees: String
    var taxes: String
    var currency: CurrencyCode
    var fxRateToEUR: String?
    var dividendAmountConvention: String

    static let unknownConvention = "unknown"
    private static let grossConvention = "gross"
    /// `UNIT_BASED_ASSET_CLASSES` of `packages/types/src/assetClasses.ts`.
    private static let unitBasedAssetClasses: Set<String> = ["stock", "etf", "crypto", "metals"]
    private static let grossDividendFormats: Set<ImportFormat> = [.saxoTransactionHistory, .ibkrTransactionHistory]

    /// `parseOptionalNumber`: nullish and the empty string are absent; `Number(text)` otherwise.
    private static func optionalNumber(_ text: String?, _ field: String) throws -> Double? {
        guard let text, !text.isEmpty else { return nil }
        let parsed = JavaScriptNumber.fromString(text)
        if parsed.isNaN { throw TransactionPayloadError(message: "\(field) must be a valid number") }
        return parsed
    }

    /// `roundMoney(value, places)`: half-even at `places` decimals, back to a double.
    private static func roundMoney(_ value: DecimalJS, _ places: Int) -> Double {
        value.toDecimalPlaces(places, .halfEven).toNumber
    }

    private static func roundMoney(_ value: Double, _ places: Int) throws -> Double {
        roundMoney(try DecimalJS(value), places)
    }

    /// `normalizeBuySellMath`: any two of amount, units and price give the third; the three
    /// must agree within one cent.
    private static func buySellMath(amount: Double?, units: Double?, pricePerUnit: Double?) throws -> (
        amount: Double, units: Double, pricePerUnit: Double
    ) {
        let provided = [amount, units, pricePerUnit].compactMap { $0 }
        if provided.count < 2 {
            throw TransactionPayloadError(
                message: "For buy/sell transactions, provide at least two of amount, units, and price_per_unit")
        }
        if provided.contains(where: { $0 <= 0 }) {
            throw TransactionPayloadError(
                message: "For buy/sell transactions, amount, units, and price_per_unit must be positive")
        }
        var nextAmount = amount
        var nextUnits = units
        var nextPrice = pricePerUnit
        func decimal(_ value: Double?) throws -> DecimalJS {
            guard let value else { return .zero }
            return try DecimalJS(value)
        }
        if nextAmount == nil { nextAmount = roundMoney(try decimal(nextUnits).times(try decimal(nextPrice)), 4) }
        if nextUnits == nil { nextUnits = roundMoney(try decimal(nextAmount).dividedBy(try decimal(nextPrice)), 8) }
        if nextPrice == nil { nextPrice = roundMoney(try decimal(nextAmount).dividedBy(try decimal(nextUnits)), 6) }
        let expectedAmount = roundMoney(try decimal(nextUnits).times(try decimal(nextPrice)), 4)
        let comparableAmount = roundMoney(try decimal(nextAmount), 4)
        let difference = try DecimalJS(expectedAmount).minus(try DecimalJS(comparableAmount)).abs
        if difference.gt(try DecimalJS("0.01")) {
            throw TransactionPayloadError(message: "amount must equal units * price_per_unit for buy/sell transactions")
        }
        return (comparableAmount, roundMoney(try decimal(nextUnits), 8), roundMoney(try decimal(nextPrice), 6))
    }

    /// `normalizedSource(row)`. Throws what the TypeScript function throws for: an unknown
    /// type, a value that is not a number, or amounts the transaction rules refuse. The plan
    /// reports any of them as `invalid_source_values`.
    init(_ row: ReconciliationSourceRow) throws {
        if let kind = row.kind, !PortfolioEventKind.transactionTypes.contains(kind.rawValue) {
            throw TransactionPayloadError(message: "Invalid transaction type: \(kind)")
        }
        let amount = try Self.optionalNumber(row.amount, "amount")
        let units = try Self.optionalNumber(row.units, "units")
        let pricePerUnit = try Self.optionalNumber(row.pricePerUnit, "price_per_unit")
        let fees = try Self.optionalNumber(row.fees, "fees") ?? 0
        let taxes = try Self.optionalNumber(row.taxes, "taxes") ?? 0
        let fxRateToEUR = try Self.optionalNumber(row.fxRateToEUR, "fx_rate_to_eur")
        if let fxRateToEUR, fxRateToEUR <= 0 { throw TransactionPayloadError(message: "fx_rate_to_eur must be positive") }
        let assetClass = row.assetClass.flatMap { $0.isEmpty ? nil : $0 }
        let unitBased = assetClass.map(Self.unitBasedAssetClasses.contains) ?? false

        let normalized: (amount: Double?, units: Double?, pricePerUnit: Double?, fees: Double, taxes: Double)
        if row.kind == .buy || row.kind == .sell {
            if unitBased {
                let math = try Self.buySellMath(amount: amount, units: units, pricePerUnit: pricePerUnit)
                normalized = (math.amount, math.units, math.pricePerUnit, fees, taxes)
            } else {
                guard let amount, amount > 0 else { throw TransactionPayloadError(message: "amount is required") }
                normalized = (amount, units, pricePerUnit, fees, taxes)
            }
        } else if row.kind == .gift {
            if assetClass != nil, !unitBased {
                throw TransactionPayloadError(message: "gift transactions are only supported for unit-based investments")
            }
            guard let units, units > 0 else { throw TransactionPayloadError(message: "gift transactions require units > 0") }
            if fees != 0 || taxes != 0 {
                throw TransactionPayloadError(message: "gift transactions must have 0 fees and 0 taxes")
            }
            if let amount, amount < 0 {
                throw TransactionPayloadError(message: "gift transaction amount cannot be negative")
            }
            normalized = (
                amount ?? 0, try Self.roundMoney(units, 8), try pricePerUnit.map { try Self.roundMoney($0, 6) }, 0, 0
            )
        } else {
            guard let amount else { throw TransactionPayloadError(message: "amount is required") }
            normalized = (amount, units, pricePerUnit, fees, taxes)
        }

        kind = row.kind
        day = row.day
        self.amount = normalized.amount.map(SQLArguments.javaScriptText)
        self.units = normalized.units.map(SQLArguments.javaScriptText)
        self.pricePerUnit = normalized.pricePerUnit.map(SQLArguments.javaScriptText)
        self.fees = SQLArguments.javaScriptText(normalized.fees)
        self.taxes = SQLArguments.javaScriptText(normalized.taxes)
        currency = row.currency ?? row.investmentCurrency ?? .eur
        self.fxRateToEUR = fxRateToEUR.map(SQLArguments.javaScriptText)
        dividendAmountConvention =
            row.kind == .dividend && row.customConfig.parsedFormat.map(Self.grossDividendFormats.contains) == true
            ? Self.grossConvention : Self.unknownConvention
    }
}
