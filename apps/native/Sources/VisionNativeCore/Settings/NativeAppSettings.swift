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

    public var dateFormat: AppDateFormat
    public var numberFormat: NumberFormat
    /// 0 to 20 fraction digits for money.
    public var showDecimalPlaces: Int
    public var adminMode: Bool
    public var colorblindGainLoss: Bool

    public init(
        dateFormat: AppDateFormat = .dayMonthYearSlash, numberFormat: NumberFormat = .eu, showDecimalPlaces: Int = 2,
        adminMode: Bool = false, colorblindGainLoss: Bool = false
    ) {
        self.dateFormat = dateFormat
        self.numberFormat = numberFormat
        self.showDecimalPlaces = showDecimalPlaces
        self.adminMode = adminMode
        self.colorblindGainLoss = colorblindGainLoss
    }

    /// `DEFAULT_APP_SETTINGS`.
    public static let defaults = NativeAppSettings()

    /// `migrateAppSettings`: each field is validated on its own and falls back to its
    /// default; a value that is not an object yields the defaults.
    public static func migrate(_ raw: JSONValue?) -> NativeAppSettings {
        guard let fields = raw?.objectValue else { return defaults }
        var settings = defaults
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
        return settings
    }
}

extension APIClient {
    /// `GET /api/settings/app_settings`, migrated like the web app's hydration.
    public func appSettings() async throws -> NativeAppSettings {
        let setting = try await send(OpenAPIOperations.GetSetting(key: NativeAppSettings.settingsKey))
        return NativeAppSettings.migrate(setting.value)
    }
}
