import Foundation

public enum AnalysisValueDisplayMode: String, CaseIterable, Sendable {
    case exact, formatted, raw
}

/// Presentation checks inspect returned metadata and retain every financial value as returned.
public enum AnalysisPresentation {
    public static func isComplete(_ result: TaxValue) -> Bool {
        let window = result["window"]
        return window?["kind"] == .string("page") && window?["offset"] == .number(0)
            && window?["hasMore"] == .bool(false) && result["complete"] != .bool(false)
            && result["coverage"]?["complete"] != .bool(false) && result["coverage"]?["status"] != .string("partial")
            && !(result["transformationCoverage"]?.arrayValue ?? []).contains { $0["complete"] == .bool(false) }
            && (result["transformationErrors"]?.arrayValue ?? []).isEmpty
    }
    public static func effectiveColumns(_ result: TaxValue) -> [TaxValue] {
        let declared = result["declaredColumns"]?.arrayValue ?? []
        return declared.isEmpty ? result["columns"]?.arrayValue ?? [] : declared
    }
    public static func isNumeric(_ type: String) -> Bool {
        ["decimal", "number", "integer", "numeric", "float", "double"].contains(type)
    }
    public static func rawText(_ value: TaxValue?) -> String {
        switch value {
        case .string(let text): text
        case .number(let number): NSDecimalNumber(decimal: number).stringValue
        case .bool(let bool): String(bool)
        case nil, .null: "—"
        case .array(let values): values.map { $0 == .null ? "" : rawText($0) }.joined(separator: ",")
        case .object: "[object Object]"
        }
    }
    public static func format(
        value: TaxValue?, type: String, id: String, numberFormat: String,
        mode: AnalysisValueDisplayMode = .exact, decimalPlaces: Int = 2
    ) -> String {
        let original = rawText(value)
        guard value != nil, value != .null, mode != .raw, isNumeric(type),
            id.range(of: #"(^|[_.])id$"#, options: .regularExpression) == nil,
            original.range(of: #"^-?[0-9]+(?:\.[0-9]+)?$"#, options: .regularExpression) != nil
        else { return original }
        let text = mode == .formatted ? round(original, places: max(0, min(20, decimalPlaces))) : original
        let negative = text.hasPrefix("-")
        let pieces = (negative ? String(text.dropFirst()) : text).split(
            separator: ".", omittingEmptySubsequences: false)
        // Group the integer as text, avoiding both binary floating point and Decimal's digit limit.
        let whole = String(pieces[0].drop(while: { $0 == "0" }))
        let digits = Array(whole.isEmpty ? "0" : whole)
        let groupSeparator = numberFormat == "eu" ? "." : numberFormat == "ch" ? "’" : ","
        var groups: [String] = []
        var end = digits.count
        var size = 3
        while end > 0 {
            let begin = max(0, end - size)
            groups.append(String(digits[begin..<end]))
            end = begin
            if numberFormat == "in" { size = 2 }
        }
        let fraction = pieces.count > 1 ? (numberFormat == "eu" ? "," : ".") + pieces[1] : ""
        return (negative ? "-" : "") + groups.reversed().joined(separator: groupSeparator) + fraction
    }
    private static func round(_ text: String, places: Int) -> String {
        let negative = text.hasPrefix("-")
        let pieces = (negative ? String(text.dropFirst()) : text).split(
            separator: ".", omittingEmptySubsequences: false)
        let integer = String(pieces[0])
        let fraction = pieces.count > 1 ? String(pieces[1]) : ""
        let padded = fraction + String(repeating: "0", count: max(0, places - fraction.count))
        var kept = Array(integer + padded.prefix(places))
        let omitted = Array(fraction.dropFirst(places))
        if let first = omitted.first {
            let odd = (kept.last?.wholeNumberValue ?? 0) % 2 == 1
            if first > "5" || (first == "5" && (odd || omitted.dropFirst().contains { $0 != "0" })) {
                var index = kept.count - 1
                while index >= 0 && kept[index] == "9" {
                    kept[index] = "0"
                    index -= 1
                }
                if index < 0 {
                    kept.insert("1", at: 0)
                } else {
                    kept[index] = Character(String((kept[index].wholeNumberValue ?? 0) + 1))
                }
            }
        }
        let wholeCount = kept.count - places
        let whole = String(kept.prefix(wholeCount))
        let decimal = places > 0 ? "." + String(kept.suffix(places)) : ""
        return (negative ? "-" : "") + whole + decimal
    }
    public static func compatibleChartUnits(result: TaxValue, series: [String]) -> Bool {
        let rows = result["rows"]?.arrayValue ?? []
        let columns = effectiveColumns(result)
        let currencies = unique(rows.compactMap { nonnull($0["currency"], $0["reporting_currency"]) })
        if currencies.count > 1 { return false }
        if series.contains(where: { $0.range(of: "units|quantity", options: .regularExpression) != nil }),
            unique(rows.compactMap { nonnull($0["investment_id"], $0["instrument_id"]) }).count > 1
        {
            return false
        }
        var scopes: [TaxValue] = []
        for id in series {
            guard let unit = columns.first(where: { $0["id"] == .string(id) })?["unit"], unit != .null else {
                scopes.append(.string("unspecified"))
                continue
            }
            if unit.stringValue != nil {
                scopes.append(unit)
                continue
            }
            let currencyColumn = unit["currencyColumn"]?.stringValue
            var currency: TaxValue = unit["currency"] ?? currencyColumn.flatMap { rows.first?[$0] } ?? .string("")
            if unit["kind"] == .string("money"), !truthy(unit["currency"]) {
                guard let column = unit["currencyColumn"]?.stringValue,
                    rows.allSatisfy({ truthy($0[column]) }), unique(rows.compactMap { $0[column] }).count <= 1
                else { return false }
                currency = rows.first?[column] ?? .string("")
            }
            var instrument: TaxValue = .string("")
            if let column = unit["instrumentColumn"]?.stringValue, !column.isEmpty {
                guard rows.allSatisfy({ $0[column] != nil && $0[column] != .null }),
                    unique(rows.compactMap { $0[column] }).count <= 1
                else { return false }
                instrument = rows.first?[column] ?? .null
            }
            scopes.append(
                .array([unit["kind"] ?? .null, currency, instrument, unit["percentageBasis"] ?? .string("")]))
        }
        return unique(scopes).count <= 1
    }
    private static func nonnull(_ first: TaxValue?, _ second: TaxValue?) -> TaxValue? {
        let value = first == nil || first == .null ? second : first
        return value == .null ? nil : value
    }
    private static func truthy(_ value: TaxValue?) -> Bool {
        switch value {
        case nil, .null: false
        case .string(let text): !text.isEmpty
        case .number(let number): number != 0
        case .bool(let bool): bool
        default: true
        }
    }
    private static func unique(_ values: [TaxValue]) -> [TaxValue] {
        values.reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
    }
    public static func columnLabel(result: TaxValue, id: String, datasets: [TaxValue], strings: any Localizing)
        -> String
    {
        let declared = result["declaredColumns"]?.arrayValue?.first { $0["id"] == .string(id) }?["label"]?.stringValue
        var candidates: [TaxValue] = []
        for dataset in datasets {
            candidates += dataset["fields"]?.arrayValue ?? []
            candidates += dataset["measures"]?.arrayValue ?? []
        }
        let matchingFields = candidates.filter { $0["id"] == .string(id) }
        let matches = matchingFields.compactMap { $0["label"]?.stringValue }
        if let declared, declared != id {
            return matches.contains(declared) ? catalogLabel(declared, strings: strings) : declared
        }
        let labels = Array(Set(matches))
        return labels.count == 1 ? catalogLabel(labels[0], strings: strings) : id
    }
    public static func catalogLabel(_ label: String, strings: any Localizing) -> String {
        let known: Set<String> = [
            "Transactions", "Accounts", "Holding events", "Cash flows", "Transaction ID", "Date", "Month",
            "Amount", "Currency", "Account ID", "Account", "Recipient", "Category", "Category detail", "Category path",
            "Category path segments", "Category path IDs", "Memo", "Comment", "Transfer", "Active",
            "Account display name",
            "Account institution", "Transaction count", "Net amount", "Display name", "Institution", "Account type",
            "Owner",
            "Account count", "Event ID", "Investment", "Symbol", "Asset class", "Event type", "Units", "Event count",
            "Raw event amount total", "Raw event units total", "Investment ID", "Cash-flow ID", "Signed amount",
            "Spending",
            "Income and refunds", "Flow type", "Cash-flow count", "Net cash flow",
        ]
        return known.contains(label)
            ? strings.t(
                "analysis.catalog."
                    + label.replacingOccurrences(of: " ", with: "_").replacingOccurrences(of: "-", with: "_")) : label
    }
}
