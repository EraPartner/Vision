import SwiftUI
import VisionNativeCore

public struct TaxOverviewView: View {
    let screens: TaxScreens
    let shell: NativeShellModel
    @State private var customize = false
    @State private var filing = false
    @State private var history = false
    @Environment(\.visionTheme) private var theme

    public init(screens: TaxScreens, shell: NativeShellModel) {
        self.screens = screens
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private var overview: OpenAPI.BelgianTaxOverview? {
        guard let value = screens.overview.overview, value.year == (requestedYear ?? value.liveYear) else { return nil }
        return value
    }
    private var data: TaxDashboardData? {
        guard let data = screens.dashboard.data, data.year == overview?.year,
            data.currency == shell.settings.defaultCurrency
        else { return nil }
        return data
    }
    private var requestedYear: Int? { TaxYearRoute.parse(shell.route.value("year")) }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                if let error = screens.routeLoadError ?? screens.overview.error ?? screens.dashboard.error {
                    Text(strings.t("tax.page.loadError", ["msg": error])).foregroundStyle(theme.destructive)
                    Button(strings.t("common.retry")) { Task { await reload(force: true) } }
                } else if screens.overview.isLoading || screens.dashboard.isLoading || overview == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(60)
                } else if let overview {
                    content(overview)
                }
                if let error = screens.actions.error ?? screens.exportError ?? screens.profileOpenError
                    ?? screens.profile.error
                {
                    Text(error).foregroundStyle(theme.destructive)
                }
            }.padding(24).frame(maxWidth: 1280, alignment: .leading).frame(maxWidth: .infinity)
        }
        .task(id: shell.route.string + shell.settings.defaultCurrency + String(shell.settingsRevision)) {
            await reload()
        }
        .onDisappear { screens.printLocalState = .init() }
        .onChange(of: screens.profile.isPresented) { _, presented in
            if !presented { Task { await reload(force: true) } }
        }
        .onChange(of: screens.overview.overview) { _, value in
            screens.dashboard.invalidate()
            if let value {
                Task {
                    await screens.dashboard.load(
                        year: value.year, currency: shell.settings.defaultCurrency, force: true)
                }
            }
        }
        .sheet(isPresented: $customize) { TaxWidgetsSheet(model: screens.widgets, strings: strings) }
        .sheet(isPresented: $filing) {
            if let overview { TaxMarkFiledSheet(overview: overview, actions: screens.actions, shell: shell) }
        }
        .sheet(isPresented: $history) {
            if let overview { TaxHistorySheet(overview: overview, shell: shell) }
        }
        .sheet(
            isPresented: Binding(
                get: { screens.profile.isPresented },
                set: { value in if !value { Task { await screens.profile.close() } } })
        ) {
            TaxProfileSheet(
                model: screens.profile, shell: shell,
                onUnfile: { await screens.unfileProfileYear() })
        }
    }
    private var header: some View {
        VisionPageHeader(
            title: strings.t("tax.page.title"),
            subtitle: strings.t(
                "tax.page.subtitle",
                ["year": String(overview?.year ?? requestedYear ?? Calendar.current.component(.year, from: Date()))]),
            symbol: "percent"
        ) {
            if let overview, screens.overview.error == nil, screens.dashboard.error == nil {
                TaxYearSwitcherView(
                    overview: overview, availableYears: data?.yearCalculations.map(\.year) ?? [],
                    actions: screens.actions, shell: shell)
                actionsMenu(overview)
                Button(
                    strings.t(overview.hasProfile ? "tax.profile.edit" : "tax.profile.setup"),
                    systemImage: "slider.horizontal.3"
                ) {
                    openProfile(overview)
                }.buttonStyle(.borderedProminent).disabled(screens.actions.isSaving)
            }
        }
    }
    private func actionsMenu(_ overview: OpenAPI.BelgianTaxOverview) -> some View {
        let meta = TaxYearPresentation.metadata(overview)
        let filed = meta["filing"]?.objectValue != nil
        let frozen = overview.calculationSource == "frozen"
        return Menu {
            Button(strings.t("tax.menu.exportPdf"), systemImage: "arrow.down.document") { shell.openTaxReport() }
            Button(strings.t("tax.menu.customize"), systemImage: "square.grid.2x2") { customize = true }
            Divider()
            Text(strings.t("tax.yearActions.menuLabel", ["year": String(overview.year)]))
            if !filed {
                Button(
                    strings.t(frozen ? "tax.yearActions.unfreeze" : "tax.yearActions.freeze"), systemImage: "snowflake"
                ) {
                    Task { await perform(frozen ? .unfreeze : .freeze) }
                }
                if overview.isHistorical {
                    Button(strings.t("tax.yearActions.markFiled"), systemImage: "lock") { filing = true }
                }
            } else {
                Button(strings.t("tax.yearActions.unmarkFiled"), systemImage: "lock.open") {
                    Task { await perform(.unfile) }
                }
            }
            Divider()
            Button(strings.t("tax.yearActions.viewHistory"), systemImage: "clock.arrow.circlepath") { history = true }
                .disabled(!overview.hasSnapshot && !filed && !frozen)
            Button(strings.t("tax.yearActions.exportCsv"), systemImage: "arrow.down.document") {
                Task { await screens.exportYearCsv() }
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .accessibilityLabel(strings.t("tax.menu.label")).disabled(screens.actions.isSaving)
    }
    @ViewBuilder private func content(_ overview: OpenAPI.BelgianTaxOverview) -> some View {
        TaxMastheadView(overview: overview, actions: screens.actions, shell: shell)
        if screens.widgets.isVisible("trendStrip") {
            TaxTrendStripView(model: screens.dashboard, overview: overview, shell: shell)
        }
        disclaimer(overview)
        if let data {
            if data.isEmpty {
                TaxCard {
                    VisionEmptyState(
                        symbol: "person.crop.circle.badge.plus", title: strings.t("tax.noProfile.title"),
                        description: strings.t("tax.noProfile.desc")
                    ) {
                        Button(strings.t("tax.profile.setup")) { openLiveProfile(overview) }.buttonStyle(
                            .borderedProminent)
                    }
                }
            } else {
                if screens.widgets.isVisible("summaryCards") {
                    TaxComputationFlowView(
                        overview: overview, shell: shell, portfolioTaxes: data.portfolioTaxesForYear,
                        totalIncludingPortfolio: data.totalTaxIncludingPortfolio,
                        totalIncludingProperty: data.totalTaxIncludingPropertyEstimate)
                }
                if screens.widgets.isVisible("pitBreakdown") {
                    TaxPITBreakdownView(
                        overview: overview, shell: shell, portfolioTaxes: data.portfolioTaxesForYear,
                        totalIncludingPortfolio: data.totalTaxIncludingPortfolio,
                        totalIncludingProperty: data.totalTaxIncludingPropertyEstimate,
                        onExpandedChange: { screens.printLocalState.pitExpanded = $0 })
                }
                if screens.widgets.isVisible("taxRules") {
                    TaxRulesView(strings: strings, onExpandedChange: { screens.printLocalState.rulesExpanded = $0 })
                }
                if screens.widgets.isVisible("householdBreakdown") {
                    TaxHouseholdBreakdownView(
                        overview: overview, data: data, shell: shell,
                        onExpandedChange: { screens.printLocalState.householdExpanded = $0 })
                }
                if screens.widgets.isVisible("incomeBreakdown") {
                    TaxMonthlyIncomeView(
                        model: screens.dashboard, overview: overview, shell: shell,
                        openIncomeSources: { openProfile(overview, step: .incomeSources) })
                }
                TaxCurrentInputsView(overview: overview, data: data, shell: shell)
                SuggestedDeductionsView(
                    suggestions: data.suggestions, shell: shell,
                    // SuggestedDeductionsCard opens the live profile on its Deductions step.
                    onEditProfile: { openLiveProfile(overview, step: .exemptions) })
                deductions(overview)
                if screens.widgets.isVisible("yearComparison") {
                    TaxYearComparisonView(
                        model: screens.dashboard, overview: overview, shell: shell,
                        onComparisonChange: { screens.printLocalState.comparisonYear = $0 })
                }
                if screens.widgets.isVisible("yearlyOverview") {
                    TaxYearlyOverviewView(
                        model: screens.dashboard, overview: overview, shell: shell,
                        openIncomeSources: { openProfile(overview, step: .incomeSources) })
                }
                automation
            }
        }
    }
    private func disclaimer(_ overview: OpenAPI.BelgianTaxOverview) -> some View {
        TaxCard(title: strings.t("tax.belgianRulesDesc")) {
            Text(strings.t("tax.disclaimerTitle") + ": " + strings.t("tax.disclaimerText"))
                .foregroundStyle(theme.secondaryLabel)
            if overview.storedValueInvalid { Text("• " + strings.t("tax.household.storedUnreadable")) }
            if !overview.isHistorical {
                ForEach(uniqueIssues(overview), id: \.code) { issue in
                    Text(
                        "• " + strings.t("tax.household.issue.severity." + issue.severity) + ": "
                            + strings.t("tax.household.issue." + issue.code)
                    )
                    .font(.callout).foregroundStyle(issue.severity == "info" ? theme.secondaryLabel : theme.warning)
                }
            }
        }
    }
    private func uniqueIssues(_ overview: OpenAPI.BelgianTaxOverview) -> [OpenAPI.BelgianTaxHouseholdTaxIssue] {
        var seen = Set<String>()
        return overview.result.issues.filter { seen.insert($0.code).inserted }
    }
    @ViewBuilder private func deductions(_ overview: OpenAPI.BelgianTaxOverview) -> some View {
        // The two deduction cards use the live household, including on historical views.
        TaxDeductionsView(
            model: screens.deductions, shell: shell,
            household: try? TaxValue(encoding: overview.liveHousehold),
            canApply: !screens.actions.isSaving && !overview.storedValueInvalid && !screens.profile.isPresented,
            onApply: { try await screens.applyDeduction($0) })
    }
    private var automation: some View {
        TaxCard(title: strings.t("tax.automation.title")) {
            Text(strings.t("tax.automation.automatic") + ": " + strings.t("tax.automation.automaticDesc"))
            Text(strings.t("tax.automation.manualLabel") + ": " + strings.t("tax.automation.manualDesc"))
            Text(strings.t("tax.automation.investmentLabel") + ": " + strings.t("tax.automation.investmentDesc"))
        }
    }
    private func openProfile(_ overview: OpenAPI.BelgianTaxOverview, step: TaxProfileStep = .household) {
        screens.profile.begin(overview: overview, initialStep: step)
    }
    private func openLiveProfile(_ overview: OpenAPI.BelgianTaxOverview, step: TaxProfileStep = .household) {
        Task { await screens.openLiveProfile(initialStep: step) }
    }
    private func perform(_ action: TaxYearAction) async {
        if await screens.actions.perform(action) { await reload(force: true) }
    }
    private func reload(force: Bool = false) async {
        let route = shell.route
        let currency = shell.settings.defaultCurrency
        guard let canonical = await screens.loadRoute(route: route, currency: currency, force: force),
            !Task.isCancelled, shell.route == route, shell.settings.defaultCurrency == currency
        else { return }
        if canonical != route { shell.replaceQuery(canonical.query) }
    }
}
