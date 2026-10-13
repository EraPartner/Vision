import Foundation

public enum NativeTaxPrintSection: String, CaseIterable, Identifiable, Sendable {
    case header, masthead, trendStrip, disclaimer, noProfile, summaryCards, pitBreakdown, taxRules
    case householdBreakdown, incomeBreakdown, currentInputs, suggestions, deductionCandidates
    case yearComparison, yearlyOverview, automation
    public var id: String { rawValue }
}

/// Immutable values currently displayed by the Tax page. Printing never refreshes or recomputes them.
public struct NativeTaxPrintSnapshot: Sendable {
    public let overview: OpenAPI.BelgianTaxOverview
    public let dashboard: TaxDashboardData
    public let settings: NativeAppSettings
    public let strings: any Localizing
    public let theme: ThemeSelection
    public let visibleWidgets: Set<String>
    public let deductionData: TaxDeductionCandidates?
    public let deductionGroups: [TaxDeductionGroup]
    public let appliedDeductionTypes: Set<String>
    public let deductionError: String?
    public let deductionApplyError: String?
    public var year: Int { overview.year }
    public var sections: [NativeTaxPrintSection] {
        var sections: [NativeTaxPrintSection] = [.header, .masthead]
        if visibleWidgets.contains("trendStrip") { sections.append(.trendStrip) }
        sections.append(.disclaimer)
        if dashboard.isEmpty {
            sections.append(.noProfile)
            return sections
        }
        for section in [
            NativeTaxPrintSection.summaryCards, .pitBreakdown, .taxRules, .householdBreakdown, .incomeBreakdown,
        ] {
            if visibleWidgets.contains(section.rawValue) { sections.append(section) }
        }
        sections += [.currentInputs, .suggestions, .deductionCandidates]
        for section in [NativeTaxPrintSection.yearComparison, .yearlyOverview] {
            if visibleWidgets.contains(section.rawValue) { sections.append(section) }
        }
        sections.append(.automation)
        return sections
    }
    public init(
        overview: OpenAPI.BelgianTaxOverview, dashboard: TaxDashboardData,
        settings: NativeAppSettings, strings: any Localizing, theme: ThemeSelection,
        visibleWidgets: Set<String>, deductionData: TaxDeductionCandidates? = nil,
        deductionGroups: [TaxDeductionGroup] = [], appliedDeductionTypes: Set<String> = [],
        deductionError: String? = nil, deductionApplyError: String? = nil
    ) throws {
        guard dashboard.year == overview.year, dashboard.currency == settings.defaultCurrency else {
            throw APIError.invalidRequest("Tax print year/currency does not match the displayed page")
        }
        self.overview = overview
        self.dashboard = dashboard
        self.settings = settings
        self.strings = strings
        self.theme = theme
        self.visibleWidgets = visibleWidgets
        self.deductionData = deductionData
        self.deductionGroups = deductionGroups
        self.appliedDeductionTypes = appliedDeductionTypes
        self.deductionError = deductionError
        self.deductionApplyError = deductionApplyError
    }
    @MainActor public static func capture(shell: NativeShellModel) throws -> NativeTaxPrintSnapshot {
        guard shell.route.path == "/tax", let screens = shell.tax,
            screens.routeLoadError == nil, screens.overview.error == nil, screens.dashboard.error == nil,
            !screens.overview.isLoading, !screens.dashboard.isLoading,
            let overview = screens.overview.overview,
            overview.year == (TaxYearRoute.parse(shell.route.value("year")) ?? overview.liveYear),
            let dashboard = screens.dashboard.data
        else { throw APIError.invalidRequest("Tax print requires the currently loaded page") }
        return try NativeTaxPrintSnapshot(
            overview: overview, dashboard: dashboard, settings: shell.settings, strings: shell.strings,
            theme: shell.theme,
            visibleWidgets: Set(TaxWidgetsModel.definitions.filter { screens.widgets.isVisible($0.id) }.map(\.id)),
            deductionData: screens.deductions.data, deductionGroups: screens.deductions.groups,
            appliedDeductionTypes: screens.deductions.appliedTypes, deductionError: screens.deductions.error,
            deductionApplyError: screens.deductions.applyError)
    }
}
