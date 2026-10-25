import Foundation

public enum NativeSettingsDefaults {
    /// About Reset replaces these envelopes, including dropping unknown fields, just like the source store.
    public static let app: TaxValue = .object([
        "defaultCurrency": .string("EUR"), "dateFormat": .string("DD/MM/YYYY"), "numberFormat": .string("eu"),
        "defaultPageSize": .number(50), "startOfWeek": .string("monday"), "showDecimalPlaces": .number(2),
        "language": .string("en"), "costBasisMethod": .string("weighted_avg"), "adminMode": .bool(false),
        "visualEffects": .string("standard"), "autoAdaptDisplay": .bool(true), "startupSection": .string("budgeting"),
        "autoClearPlannedOnMatch": .bool(true), "colorblindGainLoss": .bool(false),
    ])
    public static let dashboard: TaxValue = .object([
        "excludedCategoryIds": .array([]), "excludedRecipientIds": .array([]),
        "excludeHiddenCategories": .bool(true), "exclusionScope": .string("everywhere"),
    ])
    public static let theme: TaxValue = .object([
        "mode": .string("dark"), "schedule": .object(["lightFrom": .string("07:00"), "darkFrom": .string("20:00")]),
        "variant": .string("default"), "systemAccent": .bool(false),
    ])
    /// The source migrates editable state; raw CAS expected.value remains untouched in the writer.
    public static func migrateApp(_ raw: TaxValue?) -> TaxValue {
        guard var fields = raw?.objectValue else { return app }
        for key in app.objectValue!.keys { fields[key] = appValue(key, raw: raw) }
        for key in ["aiDefaultModel", "aiAnswerDepth", "analysisBenchmark"] {
            fields[key] = appValue(key, raw: raw)
        }
        // Retired with the OpenAI route (ADR-229); not carried forward.
        fields["openAiDefaultModel"] = nil
        return .object(fields)
    }
    public static func migrateDashboard(_ raw: TaxValue?) -> TaxValue {
        guard var fields = raw?.objectValue else { return dashboard }
        for key in ["excludedCategoryIds", "excludedRecipientIds"] {
            if let values = fields[key]?.arrayValue, values.allSatisfy({ $0.decimalValue != nil }) { continue }
            fields[key] = .array([])
        }
        if fields["excludeHiddenCategories"]?.boolValue == nil { fields["excludeHiddenCategories"] = .bool(true) }
        if !["everywhere", "dashboard", "statistics"].contains(fields["exclusionScope"]?.stringValue ?? "") {
            fields["exclusionScope"] = .string("everywhere")
        }
        return .object(fields)
    }
    public static func integer(_ value: TaxValue?) -> Int? {
        guard let decimal = value?.decimalValue, !decimal.isNaN,
            decimal >= Decimal(Int.min), decimal <= Decimal(Int.max)
        else { return nil }
        let result = NSDecimalNumber(decimal: decimal).intValue
        return Decimal(result) == decimal ? result : nil
    }
    public static func appValue(_ key: String, raw: TaxValue?) -> TaxValue? {
        guard let value = raw?[key] else { return app[key] }
        let choices: [String: [String]] = [
            "dateFormat": AppDateFormat.allCases.map(\.rawValue), "numberFormat": NumberFormat.allCases.map(\.rawValue),
            "language": ["en", "nl"], "startOfWeek": ["monday", "sunday"],
            "costBasisMethod": ["weighted_avg", "fifo", "lifo"], "visualEffects": ["reduced", "standard", "enhanced"],
            "startupSection": ["budgeting", "portfolio", "research", "ai-chat", "last"],
            "aiAnswerDepth": ["quick", "detailed"],
        ]
        if let allowed = choices[key] { return value.stringValue.map(allowed.contains) == true ? value : app[key] }
        switch key {
        case "defaultCurrency":
            return value.stringValue.map(NativeAppSettings.isCurrencyCode) == true ? value : app[key]
        case "defaultPageSize": return integer(value).map { $0 > 0 } == true ? value : app[key]
        case "showDecimalPlaces": return integer(value).map { (0...20).contains($0) } == true ? value : app[key]
        case "adminMode", "autoAdaptDisplay", "autoClearPlannedOnMatch", "colorblindGainLoss":
            return value.boolValue != nil ? value : app[key]
        case "analysisBenchmark":
            guard let raw = value.stringValue, let symbol = ResearchCompareURLState.normalizeSymbol(raw),
                symbol.utf16.count <= 32
            else { return nil }
            return .string(symbol)
        case "aiDefaultModel": return value.stringValue != nil ? value : nil
        default: return value
        }
    }
}
