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
    public static let settingsKey = SettingKey.appSettings

    /// `defaultCurrency`: a three-letter ISO 4217 code. `storedAppSettingsSchema` accepts either
    /// case and upper-cases it (`asCurrencyCode(code.toUpperCase())`), as `migrate` does.
    public var defaultCurrency: CurrencyCode
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
    public var aiAnswerDepth: AIAnswerDepth
    public var aiDefaultModel: String?
    public var language: AppLanguage
    public var startOfWeek: StartOfWeek
    public var costBasisMethod: CostBasisMethod
    public var startupSection: StartupSection
    public var autoClearPlannedOnMatch: Bool
    public var visualEffects: VisualEffects
    public var autoAdaptDisplay: Bool
    /// `fullEffects` (ADR-244): restores effects that were turned down to save GPU work.
    /// Off by default; the design layer reads it through `NativeSettingsModel.fullEffects`.
    public var fullEffects: Bool

    public init(
        defaultCurrency: CurrencyCode = .eur, dateFormat: AppDateFormat = .dayMonthYearSlash,
        numberFormat: NumberFormat = .eu, showDecimalPlaces: Int = 2, adminMode: Bool = false,
        colorblindGainLoss: Bool = false, defaultPageSize: Int = 50,
        analysisBenchmark: String? = nil, aiAnswerDepth: AIAnswerDepth = .quick, language: AppLanguage = .en,
        aiDefaultModel: String? = nil,
        startOfWeek: StartOfWeek = .monday, costBasisMethod: CostBasisMethod = .weightedAvg,
        startupSection: StartupSection = .budgeting,
        autoClearPlannedOnMatch: Bool = true, visualEffects: VisualEffects = .standard, autoAdaptDisplay: Bool = true,
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
        if let value = fields["defaultCurrency"]?.stringValue, isCurrencyCode(value),
            let code = CurrencyCode(rawValue: value.uppercased())
        {
            settings.defaultCurrency = code
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
        if let value = knownCase(fields["aiAnswerDepth"]?.stringValue, as: AIAnswerDepth.self) {
            settings.aiAnswerDepth = value
        }
        settings.aiDefaultModel = fields["aiDefaultModel"]?.stringValue
        if let value = knownCase(fields["language"]?.stringValue, as: AppLanguage.self) { settings.language = value }
        if let value = knownCase(fields["startOfWeek"]?.stringValue, as: StartOfWeek.self) {
            settings.startOfWeek = value
        }
        if let value = knownCase(fields["costBasisMethod"]?.stringValue, as: CostBasisMethod.self) {
            settings.costBasisMethod = value
        }
        if let value = knownCase(fields["startupSection"]?.stringValue, as: StartupSection.self) {
            settings.startupSection = value
        }
        if let value = fields["autoClearPlannedOnMatch"]?.boolValue { settings.autoClearPlannedOnMatch = value }
        if let value = knownCase(fields["visualEffects"]?.stringValue, as: VisualEffects.self) {
            settings.visualEffects = value
        }
        if let value = fields["autoAdaptDisplay"]?.boolValue { settings.autoAdaptDisplay = value }
        if let value = fields["fullEffects"]?.boolValue { settings.fullEffects = value }
        return settings
    }

    /// The case of `E` stored as `raw`. A value outside the web app's union is `nil` here, so `migrate`
    /// keeps the default exactly like the store's `.catch(default)`; decoding one elsewhere (the enums'
    /// `Codable`) yields `.unknown` instead.
    static func knownCase<E: CaseIterable & RawRepresentable>(_ raw: String?, as _: E.Type) -> E?
    where E.RawValue == String {
        guard let raw else { return nil }
        return E.allCases.first { $0.rawValue == raw }
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
