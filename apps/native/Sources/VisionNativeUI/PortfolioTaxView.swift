import SwiftUI
import VisionNativeCore

public struct PortfolioTaxView: View {
    let model: PortfolioTaxModel
    let tax: TaxScreens
    let shell: NativeShellModel
    let dataRevision: Int
    @State private var customize = false
    @State private var filing = false
    @State private var history = false
    @Environment(\.visionTheme) private var theme

    public init(model: PortfolioTaxModel, tax: TaxScreens, shell: NativeShellModel, dataRevision: Int = 0) {
        self.model = model
        self.tax = tax
        self.shell = shell
        self.dataRevision = dataRevision
    }
    private var strings: any Localizing { shell.strings }
    private var requestedYear: Int? { TaxYearRoute.parse(shell.route.value("year")) }
    private var currency: String { shell.settings.defaultCurrency.uppercased() }
    private var overview: OpenAPI.BelgianTaxOverview? {
        guard let source = tax.overview.overview, source.year == (requestedYear ?? source.liveYear) else { return nil }
        return source
    }
    private var data: PortfolioTaxDashboard? {
        guard let data = model.dashboard, data.year == overview?.year, data.currency == currency else { return nil }
        return data
    }
    private var taxData: TaxDashboardData? {
        guard let value = tax.dashboard.data, value.year == overview?.year, value.currency == currency else {
            return nil
        }
        return value
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                if let error = tax.routeLoadError ?? tax.overview.error ?? model.error ?? tax.dashboard.error {
                    Text(strings.t("tax.page.loadError", ["msg": error])).foregroundStyle(theme.destructive)
                    Button(strings.t("common.retry")) { Task { await reload(force: true) } }
                } else if let overview, let data {
                    content(data, overview: overview)
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(60)
                }
                if let error = tax.actions.error ?? tax.exportError ?? tax.profileOpenError ?? tax.profile.error {
                    Text(error).foregroundStyle(theme.destructive)
                }
                if !model.settingsLoaded, let error = model.adjustmentsError {
                    Text(error).foregroundStyle(theme.destructive)
                    Button(strings.t("common.retry")) { Task { await reload(force: true) } }
                }
            }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: shell.route.string + currency + String(shell.settingsRevision) + "|" + String(dataRevision)) {
            await reload()
        }
        .onDisappear { model.closeAdjustments() }
        .onChange(of: tax.profile.isPresented) { _, presented in
            if !presented { Task { await reload(force: true) } }
        }
        .onChange(of: tax.overview.overview) { _, source in
            guard let source, source.year == (requestedYear ?? source.liveYear) else { return }
            let route = shell.route
            let requestedCurrency = currency
            Task {
                await tax.dashboard.load(year: source.year, currency: requestedCurrency, force: true)
                guard !Task.isCancelled, shell.route == route, currency == requestedCurrency,
                    overview?.year == source.year
                else { return }
                await model.load(year: source.year, liveYear: source.liveYear, currency: requestedCurrency, force: true)
            }
        }
        .sheet(isPresented: $customize) {
            PortfolioWidgetsSheet(
                definitions: PortfolioTaxWidgetsModel.definitions, visible: model.widgets.isVisible,
                setVisible: model.widgets.setVisible, setAll: model.widgets.setAll, reset: model.widgets.reset,
                reload: model.widgets.load, isLoaded: model.widgets.isLoaded, isSaving: model.widgets.isSaving,
                error: model.widgets.error, strings: strings)
        }
        .sheet(isPresented: $filing) {
            if let overview { TaxMarkFiledSheet(overview: overview, actions: tax.actions, shell: shell) }
        }
        .sheet(isPresented: $history) {
            if let overview { TaxHistorySheet(overview: overview, shell: shell) }
        }
        .sheet(
            isPresented: Binding(
                get: { tax.profile.isPresented },
                set: { value in
                    if !value { Task { await tax.profile.close() } }
                })
        ) {
            TaxProfileSheet(model: tax.profile, shell: shell, onUnfile: { await tax.unfileProfileYear() })
        }
        .sheet(
            isPresented: Binding(
                get: { model.isAdjustmentsPresented },
                set: { value in
                    if !value { model.closeAdjustments() }
                })
        ) {
            PortfolioTaxAdjustmentsSheet(model: model, shell: shell)
        }
        .overlay(alignment: .bottom) {
            ActionToast(
                notice: model.notice, strings: strings, actionTitle: nil, duration: .seconds(4),
                action: {}, clear: model.clearNotice)
        }
    }

    private var header: some View {
        VisionPageHeader(
            title: strings.t("tax.portfolioTitle"), subtitle: strings.t("tax.portfolioDesc"), symbol: "percent"
        ) {
            if let overview, tax.overview.error == nil {
                TaxYearSwitcherView(
                    overview: overview, availableYears: taxData?.yearCalculations.map(\.year) ?? [],
                    actions: tax.actions, shell: shell)
                // YearActionsMenu: filing and CSV export are visible buttons beside the switcher.
                if TaxYearPresentation.metadata(overview)["filing"]?.objectValue == nil {
                    Button(strings.t("tax.yearActions.markFiled"), systemImage: "lock") { filing = true }
                        .disabled(tax.actions.isSaving)
                }
                Button(strings.t("tax.yearActions.exportCsv"), systemImage: "arrow.down.document") {
                    Task { await tax.exportYearCsv() }
                }.disabled(tax.actions.isSaving || tax.isExporting)
                actionsMenu(overview)
            }
            // PortfolioTaxPage always shows the button; the sheet needs loaded data, so it waits for it.
            Button(strings.t("tax.manualAdjustments"), systemImage: "slider.horizontal.3") {
                model.beginAdjustments(numberFormat: shell.settings.numberFormat)
            }.buttonStyle(.visionPrimary)
                .disabled(
                    !model.settingsLoaded || model.isSavingAdjustments || tax.actions.isSaving || data == nil
                        || model.error != nil)
        }
    }

    private func actionsMenu(_ overview: OpenAPI.BelgianTaxOverview) -> some View {
        let filed = TaxYearPresentation.metadata(overview)["filing"]?.objectValue != nil
        let frozen = overview.calculationSource == "frozen"
        return Menu {
            Button(strings.t(data?.hasProfile == true ? "tax.menu.editProfile" : "tax.menu.setupProfile")) {
                tax.profile.begin(overview: overview)
            }
            Button(strings.t("tax.menu.customize"), systemImage: "square.grid.2x2") { customize = true }
            Divider()
            Text(strings.t("tax.yearActions.menuLabel", ["year": String(overview.year)]))
            if !filed {
                Button(
                    strings.t(frozen ? "tax.yearActions.unfreeze" : "tax.yearActions.freeze"), systemImage: "snowflake"
                ) {
                    Task { await perform(frozen ? .unfreeze : .freeze) }
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
                Task { await tax.exportYearCsv() }
            }.disabled(tax.isExporting)
        } label: {
            Image(systemName: "ellipsis")
        }
        .accessibilityLabel(strings.t("tax.menu.label"))
        .disabled(tax.actions.isSaving || model.isSavingAdjustments)
    }

    @ViewBuilder private func content(_ data: PortfolioTaxDashboard, overview: OpenAPI.BelgianTaxOverview) -> some View
    {
        if overview.isHistorical { historicalBanner(overview) }
        if data.isEmpty {
            TaxCard {
                VisionEmptyState(
                    symbol: "percent", title: strings.t("tax.noData"), description: strings.t("tax.noDataDesc")
                ) {
                    Button(strings.t("tax.noDataCta")) { shell.navigate(to: "/portfolio") }.buttonStyle(.visionOutline)
                }
            }
        } else {
            TaxCard(title: strings.t("tax.portfolioDisclaimerTitle")) {
                Text(strings.t("tax.portfolioDisclaimerText")).font(.callout).foregroundStyle(theme.secondaryLabel)
            }
            sectionHeading("tax.costsSection", description: "tax.costsHelp")
            if model.widgets.isVisible("summaryCards") { PortfolioTaxSummaryView(data: data, shell: shell) }
            if model.widgets.isVisible("taxByAssetClass"), !data.taxByAssetClass.isEmpty {
                PortfolioTaxAssetClassChart(data: data, shell: shell)
            }
            if model.widgets.isVisible("taxTypes"), !data.taxBreakdown.isEmpty || !data.feeBreakdown.isEmpty {
                PortfolioTaxCostTypesView(data: data, shell: shell)
            }
            PortfolioTaxRecordedManualView(data: data, shell: shell)
            if model.widgets.isVisible("yearlyTaxFeeTrend"), !data.yearlyCostTrend.isEmpty {
                PortfolioTaxMonthlyCostChart(data: data, shell: shell)
            }
            if model.widgets.isVisible("investmentBreakdown"), !data.investmentBreakdown.isEmpty {
                PortfolioTaxInvestmentBreakdownView(data: data, shell: shell)
            }
            Divider().padding(.top, 6)
            HStack(alignment: .top) {
                sectionHeading("tax.estimatesSection", description: "tax.estimatesHelp")
                Spacer()
                Button(
                    strings.t(data.hasProfile ? "tax.profile.edit" : "tax.profile.setup"),
                    systemImage: "slider.horizontal.3"
                ) {
                    tax.profile.begin(overview: overview)
                }.buttonStyle(.visionOutline).disabled(tax.actions.isSaving || model.isSavingAdjustments)
            }
            PortfolioTaxBudgetView(data: data, shell: shell)
            if model.widgets.isVisible("profileInputs"), let taxData {
                PortfolioTaxProfileInputsView(inputs: taxData.currentInputs, overview: overview, shell: shell)
            }
            if data.hasInKindIncomeUnclassified {
                Text(strings.t("tax.inKindIncomeUnclassified")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
            if model.widgets.isVisible("belgianRules") { PortfolioTaxRulesView(data: data, shell: shell) }
        }
    }

    private func historicalBanner(_ overview: OpenAPI.BelgianTaxOverview) -> some View {
        let status = TaxYearPresentation.status(overview)
        return TaxCard(title: strings.t("tax.historical.banner." + status + "Title", ["year": String(overview.year)])) {
            Text(strings.t("tax.historical.banner." + status + "Desc", ["year": String(overview.year)]))
                .foregroundStyle(theme.secondaryLabel)
            if let reference = TaxYearPresentation.metadata(overview)["filing"]?["reference"]?.stringValue {
                Text(strings.t("tax.historical.banner.filedReferencePrefix") + " " + reference).font(.caption)
            }
            HStack {
                if status == "estimate" {
                    Button(strings.t("tax.historical.banner.createCta", ["year": String(overview.year)])) {
                        Task { await perform(.createSnapshot) }
                    }.disabled(tax.actions.isSaving)
                }
                Button(strings.t("tax.historical.banner.returnCta", ["year": String(overview.liveYear)])) {
                    shell.replaceQuery("year", with: String(overview.liveYear))
                }
            }
        }
    }
    private func sectionHeading(_ title: String, description: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(strings.t(title)).font(.visionCardTitle).accessibilityAddTraits(.isHeader)
            Text(strings.t(description)).foregroundStyle(theme.secondaryLabel)
        }
    }
    private func perform(_ action: TaxYearAction) async {
        if await tax.actions.perform(action) { await reload(force: true) }
    }
    private func reload(force: Bool = false) async {
        let route = shell.route
        let requestedCurrency = currency
        guard let canonical = await tax.loadRoute(route: route, currency: requestedCurrency, force: force),
            !Task.isCancelled, shell.route == route, currency == requestedCurrency
        else { return }
        if canonical != route {
            shell.replaceQuery(canonical.query)
            return
        }
        guard tax.overview.error == nil, let overview else { return }
        await model.load(year: overview.year, liveYear: overview.liveYear, currency: requestedCurrency, force: force)
    }
}
