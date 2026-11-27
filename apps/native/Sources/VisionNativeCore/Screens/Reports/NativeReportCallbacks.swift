import Foundation

@MainActor public struct NativeReportCallbacks {
    public var preferences: @MainActor () -> NativeReportPreferences
    /// The exclusions a financial report sends, resolved at submit exactly as Statistics resolves
    /// them (`homeExclusions(scope: "statistics")`: stored ids plus hidden categories, fetched fresh).
    /// Nil sends the ids `preferences` holds.
    public var exclusions: (@MainActor () async throws -> InsightExclusions)?
    public var theme: @MainActor () async throws -> TaxValue
    /// Source-authoritative fields: taxProfile/precomputedPIT/household/precomputedHousehold.
    /// The host resolves the selected year's frozen/live data and localized bracket labels.
    public var taxContext: @MainActor (Int) async throws -> TaxValue
    public var save: @MainActor (Data, String) async throws -> Bool
    public var print: (@MainActor (Data, String) async throws -> Bool)?
    public var close: @MainActor () -> Void
    public var notice: @MainActor (ScreenNotice) -> Void
    public init(
        preferences: @escaping @MainActor () -> NativeReportPreferences,
        exclusions: (@MainActor () async throws -> InsightExclusions)? = nil,
        theme: @escaping @MainActor () async throws -> TaxValue,
        taxContext: @escaping @MainActor (Int) async throws -> TaxValue = { _ in .object([:]) },
        save: @escaping @MainActor (Data, String) async throws -> Bool,
        print: (@MainActor (Data, String) async throws -> Bool)? = nil,
        close: @escaping @MainActor () -> Void,
        notice: @escaping @MainActor (ScreenNotice) -> Void
    ) {
        self.preferences = preferences
        self.exclusions = exclusions
        self.theme = theme
        self.taxContext = taxContext
        self.save = save
        self.print = print
        self.close = close
        self.notice = notice
    }
}
