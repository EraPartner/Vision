import Foundation

/// `APP_DATE_FORMATS` in apps/frontend/src/stores/settingsStore.ts.
public enum AppDateFormat: String, CaseIterable, Sendable {
    case dayMonthYearSlash = "DD/MM/YYYY"
    case monthDayYearSlash = "MM/DD/YYYY"
    case isoDate = "YYYY-MM-DD"
    case dayMonthYearDot = "DD.MM.YYYY"
    case dayMonthYearDash = "DD-MM-YYYY"
}

/// `NUMBER_FORMATS` in apps/frontend/src/utils/currency.ts.
public enum NumberFormat: String, CaseIterable, Sendable {
    case eu
    case us
    case ch
    case `in`

    /// `numberFormatToLocale`: the locale whose separators the format uses.
    public var locale: Locale {
        switch self {
        case .eu: return Locale(identifier: "de_DE")
        case .us: return Locale(identifier: "en_US")
        case .ch: return Locale(identifier: "de_CH")
        case .in: return Locale(identifier: "en_IN")
        }
    }
}

/// The part of the web app's `app_settings` that native screens read.
public struct NativeAppSettings: Equatable, Sendable {
    public static let settingsKey = "app_settings"

    /// `defaultCurrency`: a three-letter ISO 4217 code, as stored (the page does not
    /// change its case).
    public var defaultCurrency: String
    public var dateFormat: AppDateFormat
    public var numberFormat: NumberFormat
    /// 0 to 20 fraction digits for money.
    public var showDecimalPlaces: Int
    public var adminMode: Bool
    public var colorblindGainLoss: Bool
    /// `defaultPageSize`: the page size of server-paged tables such as `/transactions`.
    public var defaultPageSize: Int
    /// Application defaults participate below explicit run and saved-analysis preferences.
    public var analysisBenchmark: String?
    public var aiAnswerDepth: String
    public var aiDefaultModel: String?
    public var language: String
    public var startOfWeek: String
    public var costBasisMethod: String
    public var startupSection: String
    public var autoClearPlannedOnMatch: Bool
    public var visualEffects: String
    public var autoAdaptDisplay: Bool
    /// `fullEffects` (ADR-244): restores effects that were turned down to save GPU work.
    /// Off by default; the design layer reads it through `NativeSettingsModel.fullEffects`.
    public var fullEffects: Bool

    public init(
        defaultCurrency: String = "EUR", dateFormat: AppDateFormat = .dayMonthYearSlash,
        numberFormat: NumberFormat = .eu, showDecimalPlaces: Int = 2, adminMode: Bool = false,
        colorblindGainLoss: Bool = false, defaultPageSize: Int = 50,
        analysisBenchmark: String? = nil, aiAnswerDepth: String = "quick", language: String = "en",
        aiDefaultModel: String? = nil,
        startOfWeek: String = "monday", costBasisMethod: String = "weighted_avg", startupSection: String = "budgeting",
        autoClearPlannedOnMatch: Bool = true, visualEffects: String = "standard", autoAdaptDisplay: Bool = true,
        fullEffects: Bool = false
    ) {
        self.defaultCurrency = defaultCurrency
        self.dateFormat = dateFormat
        self.numberFormat = numberFormat
        self.showDecimalPlaces = showDecimalPlaces
        self.adminMode = adminMode
        self.colorblindGainLoss = colorblindGainLoss
        self.defaultPageSize = defaultPageSize
        self.analysisBenchmark = analysisBenchmark
        self.aiAnswerDepth = aiAnswerDepth
        self.aiDefaultModel = aiDefaultModel
        self.language = language
        self.startOfWeek = startOfWeek
        self.costBasisMethod = costBasisMethod
        self.startupSection = startupSection
        self.autoClearPlannedOnMatch = autoClearPlannedOnMatch
        self.visualEffects = visualEffects
        self.autoAdaptDisplay = autoAdaptDisplay
        self.fullEffects = fullEffects
    }

    /// `DEFAULT_APP_SETTINGS`.
    public static let defaults = NativeAppSettings()

    /// `migrateAppSettings`: each field is validated on its own and falls back to its
    /// default; a value that is not an object yields the defaults.
    public static func migrate(_ raw: JSONValue?) -> NativeAppSettings {
        guard let fields = raw?.objectValue else { return defaults }
        var settings = defaults
        if let value = fields["defaultCurrency"]?.stringValue, isCurrencyCode(value) {
            settings.defaultCurrency = value
        }
        if let value = fields["dateFormat"]?.stringValue.flatMap(AppDateFormat.init(rawValue:)) {
            settings.dateFormat = value
        }
        if let value = fields["numberFormat"]?.stringValue.flatMap(NumberFormat.init(rawValue:)) {
            settings.numberFormat = value
        }
        if let value = fields["showDecimalPlaces"]?.intValue, (0...20).contains(value) {
            settings.showDecimalPlaces = value
        }
        if let value = fields["adminMode"]?.boolValue { settings.adminMode = value }
        if let value = fields["colorblindGainLoss"]?.boolValue { settings.colorblindGainLoss = value }
        if let value = fields["defaultPageSize"]?.intValue, value > 0 { settings.defaultPageSize = value }
        if let value = fields["analysisBenchmark"]?.stringValue {
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            if normalized.range(of: "^[A-Z0-9][A-Z0-9._:-]{0,31}$", options: .regularExpression) != nil {
                settings.analysisBenchmark = normalized
            }
        }
        if let value = fields["aiAnswerDepth"]?.stringValue, ["quick", "detailed"].contains(value) {
            settings.aiAnswerDepth = value
        }
        settings.aiDefaultModel = fields["aiDefaultModel"]?.stringValue
        if let value = fields["language"]?.stringValue, ["en", "nl"].contains(value) { settings.language = value }
        if let value = fields["startOfWeek"]?.stringValue, ["monday", "sunday"].contains(value) {
            settings.startOfWeek = value
        }
        if let value = fields["costBasisMethod"]?.stringValue, ["weighted_avg", "fifo", "lifo"].contains(value) {
            settings.costBasisMethod = value
        }
        if let value = fields["startupSection"]?.stringValue,
            ["budgeting", "portfolio", "research", "ai-chat", "last"].contains(value)
        {
            settings.startupSection = value
        }
        if let value = fields["autoClearPlannedOnMatch"]?.boolValue { settings.autoClearPlannedOnMatch = value }
        if let value = fields["visualEffects"]?.stringValue, ["reduced", "standard", "enhanced"].contains(value) {
            settings.visualEffects = value
        }
        if let value = fields["autoAdaptDisplay"]?.boolValue { settings.autoAdaptDisplay = value }
        if let value = fields["fullEffects"]?.boolValue { settings.fullEffects = value }
        return settings
    }

    /// `/^[A-Za-z]{3}$/` of `storedAppSettingsSchema`.
    static func isCurrencyCode(_ text: String) -> Bool {
        text.unicodeScalars.count == 3
            && text.unicodeScalars.allSatisfy { scalar in
                (65...90).contains(scalar.value) || (97...122).contains(scalar.value)
            }
    }
}

extension APIClient {
    /// `GET /api/settings/app_settings`, migrated like the web app's hydration.
    public func appSettings() async throws -> NativeAppSettings {
        let setting = try await send(OpenAPIOperations.GetSetting(key: NativeAppSettings.settingsKey))
        return NativeAppSettings.migrate(setting.value)
    }
}
