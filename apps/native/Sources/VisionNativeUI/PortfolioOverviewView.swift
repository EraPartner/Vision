import SwiftUI
import VisionNativeCore

public struct PortfolioOverviewView: View {
    let model: PortfolioModel
    let editing: PortfolioEditingModel
    let shell: NativeShellModel
    @State private var customize = false
    @Environment(\.visionTheme) private var theme
    public init(model: PortfolioModel, editing: PortfolioEditingModel, shell: NativeShellModel) {
        self.model = model
        self.editing = editing
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private var currency: String { shell.settings.defaultCurrency }
    private var summary: PortfolioSummaryData? { model.summary?.currency == currency ? model.summary : nil }
    private var performance: PortfolioPerformanceData? {
        model.performance?.currency == currency ? model.performance : nil
    }
    private var subtitle: String {
        guard !model.active.isEmpty else { return "" }
        return [
            strings.tc("portfolio.investments", model.active.count),
            PortfolioPricePresentation.freshness(model.active, shell: shell),
        ].compactMap { $0 }.joined(separator: " · ")
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                VisionPageHeader(title: strings.t("nav.portfolio"), subtitle: subtitle, symbol: "chart.pie") {
                    if !model.isLoading && model.error == nil {
                        Button {
                            Task { await model.refreshPrices() }
                        } label: {
                            if model.isRefreshingPrices {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "arrow.clockwise")
                            }
                        }.accessibilityLabel(strings.t("portfolio.refreshPrices"))
                            .help(
                                strings.t(model.isOnline ? "portfolio.refreshPrices" : "portfolio.refreshPricesOffline")
                            )
                            .disabled(model.isRefreshingPrices || !model.isOnline)
                        Menu {
                            Button(strings.t("portfolio.menu.exportPdf")) { shell.openPortfolioReport() }
                            Button(strings.t("portfolio.menu.customize")) { customize = true }
                            Divider()
                            Button(strings.t("nav.portfolioImport")) { shell.navigate(to: "/portfolio/import") }
                        } label: {
                            Image(systemName: "ellipsis")
                        }.accessibilityLabel(strings.t("portfolio.menu"))
                        Button(strings.t("addInv.title"), systemImage: "plus") { editing.beginAddInvestment() }
                            .buttonStyle(.borderedProminent)
                    }
                }
                if model.isLoading {
                    ProgressView().frame(maxWidth: .infinity).padding(60)
                } else if let error = model.error {
                    Text(strings.t("stocks.pageErrorTitle")).font(.title2)
                    Text(error).foregroundStyle(theme.destructive)
                    Button(strings.t("common.retry")) { Task { await reload(force: true) } }
                } else {
                    if model.active.isEmpty {
                        AdminCard {
                            VisionEmptyState(
                                symbol: "chart.pie", title: strings.t("portfolio.noInvestments"),
                                description: strings.t("portfolio.noInvestmentsDesc")
                            ) {
                                Button(strings.t("addInv.title")) { editing.beginAddInvestment() }.buttonStyle(
                                    .borderedProminent)
                            }
                        }
                    } else if let summary {
                        PortfolioStalePricesBanner(model: model, holdings: model.active, shell: shell)
                        if model.widgets.isVisible("ticker") {
                            PortfolioTickerView(model: model, editing: editing, shell: shell)
                        }
                        hero(summary)
                        figures(summary)
                        if model.widgets.isVisible("investments") { holdings }
                        if model.widgets.isVisible("allocation") { allocation }
                        if model.widgets.isVisible("performance") { costs(summary) }
                        if model.widgets.isVisible("exposure") {
                            PortfolioExposureView(model: model, editing: editing, shell: shell)
                        }
                        PortfolioPerformanceWidgets(model: model, shell: shell)
                        if model.widgets.isVisible("news"), !model.newsSymbols.isEmpty {
                            PortfolioNewsView(model: model, shell: shell)
                        }
                    }
                    if model.widgets.isVisible("archived") { archived }
                }
            }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: currency + shell.route.string + String(shell.settingsRevision)) { await reload() }
        .sheet(isPresented: $customize) {
            PortfolioWidgetsSheet(
                definitions: PortfolioWidgetsModel.definitions, visible: model.widgets.isVisible,
                setVisible: model.widgets.setVisible, setAll: model.widgets.setAll, reset: model.widgets.reset,
                reload: model.widgets.load, isLoaded: model.widgets.isLoaded, isSaving: model.widgets.isSaving,
                error: model.widgets.error, strings: strings)
        }
    }

    private func reload(force: Bool = false) async {
        await model.load(currency: currency, route: shell.route, force: force)
    }
    private func hero(_ summary: PortfolioSummaryData) -> some View {
        AdminCard(padding: 24) {
            VStack(alignment: .leading, spacing: 24) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(strings.t("portfolio.hero.value")).font(.caption2.weight(.medium)).tracking(1.3)
                            .textCase(.uppercase)
                            .foregroundStyle(Color(token: theme.palette.mutedForeground).opacity(0.8))
                        MoneyText(
                            amount: summary.totals.totalPortfolioValue, currency: currency, settings: shell.settings,
                            signed: false, colored: false
                        ).font(.visionLargeTitle)
                        if let gain = periodGain(summary) {
                            HStack(spacing: 6) {
                                Text(money(gain.amount, signed: true)).fontWeight(.medium)
                                if let percent = gain.percent { Text(signedPercent(percent)) }
                                Text(
                                    model.period == .all
                                        ? strings.t("networth.allTime")
                                        : strings.t(
                                            "portfolio.hero.inPeriod",
                                            ["period": strings.t("performance.period." + model.period.rawValue)])
                                )
                                .foregroundStyle(theme.secondaryLabel)
                            }.font(.callout).monospacedDigit().foregroundStyle(
                                gain.amount >= 0 ? theme.gain : theme.loss)
                        } else if !model.isFetching {
                            Text(strings.t("performance.emptyTitle")).font(.callout).foregroundStyle(
                                theme.secondaryLabel)
                        }
                    }
                    Spacer()
                    Picker(
                        strings.t("portfolio.period.label"),
                        selection: Binding(
                            get: { model.period },
                            set: { shell.replaceQuery("period", with: $0 == .all ? nil : $0.rawValue) })
                    ) {
                        ForEach(PortfolioPeriod.allCases, id: \.self) { period in
                            Text(strings.t("performance.period." + period.rawValue)).tag(period)
                        }
                    }.frame(width: 150)
                }
                if let data = performance, !data.snapshots.isEmpty {
                    PortfolioSeriesChart(
                        series: [
                            InsightChartSeries(
                                id: "value", label: strings.t("portfolio.hero.value"),
                                points: data.snapshots.map { InsightChartPoint(key: $0.date, value: $0.value) }),
                            InsightChartSeries(
                                id: "invested", label: strings.t("portfolio.hero.invested"),
                                points: data.snapshots.map { InsightChartPoint(key: $0.date, value: $0.invested) },
                                dashed: true),
                        ], title: strings.t("portfolio.hero.chartAria"), currency: currency, shell: shell, area: true,
                        colors: ["value": theme.primary, "invested": theme.secondaryLabel])
                    if data.snapshots.last?.isProvisional == true {
                        Label(strings.t("performance.latestSnapshotProvisional"), systemImage: "info.circle")
                            .font(.caption).foregroundStyle(theme.secondaryLabel)
                            .help(strings.t("performance.latestSnapshotProvisionalDescription"))
                    }
                } else if let error = model.errors[currency + "|" + model.period.rawValue] {
                    Text(strings.t("common.loadError", ["msg": error])).foregroundStyle(theme.destructive)
                    Button(strings.t("common.retry")) { Task { await reload(force: true) } }
                } else if model.isFetching {
                    ProgressView().frame(maxWidth: .infinity).frame(height: 260)
                } else {
                    VisionEmptyState(
                        symbol: "chart.line.uptrend.xyaxis", title: strings.t("performance.emptyTitle"),
                        description: strings.t("performance.emptyDescription")
                    ) {
                        Button(strings.t("portfolio.refreshPrices")) { Task { await model.refreshPrices() } }
                            .disabled(model.isRefreshingPrices || !model.isOnline)
                    }.frame(height: 260)
                }
            }
        }
    }
    private func periodGain(_ summary: PortfolioSummaryData) -> (amount: Decimal, percent: Decimal?)? {
        if model.period == .all { return (summary.totals.totalGainLoss, summary.totals.totalReturnPct) }
        guard let rows = performance?.snapshots, rows.count >= 2, let first = rows.first, let last = rows.last else {
            return nil
        }
        let contributions = last.invested - first.invested
        let amount = last.value - first.value - contributions
        let base = first.value + max(contributions, 0)
        return (amount, base > 0 ? amount / base * 100 : nil)
    }
    private func figures(_ summary: PortfolioSummaryData) -> some View {
        let metrics = performance?.metrics
        let annualHint = metrics.flatMap { _ in
            model.firstInvestmentDate.map {
                strings.t(
                    "portfolio.figure.perYearHint",
                    ["date": VisionFormat.appDate($0, format: shell.settings.dateFormat)])
            }
        }
        return AdminCard(padding: 24) {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 200), alignment: .leading)], alignment: .leading, spacing: 20
            ) {
                figure(
                    "portfolio.investmentReturn", value: signedPercent(summary.totals.totalReturnPct),
                    detail: money(summary.totals.totalGainLoss, signed: true),
                    hint: strings.t("portfolio.figure.totalReturnHint"),
                    gain: summary.totals.totalGainLoss)
                figure(
                    "portfolio.figure.perYear", value: metrics.map { signedPercent($0.annualizedReturn) },
                    detail: annualHint.map { $0.hasSuffix(".") ? String($0.dropLast()) : $0 },
                    hint: annualHint ?? strings.t("performance.emptyTitle"), gain: metrics?.annualizedReturn)
                figure(
                    "performance.inflationAdjusted",
                    value: metrics.flatMap { $0.cumulativeInflation != 0 ? signedPercent($0.realReturnPct) : nil },
                    detail: metrics.flatMap {
                        $0.cumulativeInflation != 0
                            ? strings.t(
                                "performance.cumulativeInflation", ["n": unsignedPercent($0.cumulativeInflation)]) : nil
                    }
                        ?? strings.t("portfolio.figure.inflationMissing"),
                    hint: strings.t(
                        metrics?.cumulativeInflation != nil && metrics?.cumulativeInflation != 0
                            ? "portfolio.figure.afterInflationHint" : "portfolio.figure.inflationMissing"),
                    gain: metrics?.realReturnPct)
                figure(
                    "portfolio.figure.realized",
                    value: summary.totals.totalRealizedGain != 0
                        ? money(summary.totals.totalRealizedGain, signed: true) : nil,
                    detail: summary.totals.totalRealizedGain == 0 ? strings.t("portfolio.figure.noSales") : nil,
                    hint: strings.t(
                        summary.totals.totalRealizedGain == 0
                            ? "portfolio.figure.noSales" : "portfolio.figure.realizedHint"),
                    gain: summary.totals.totalRealizedGain)
            }
        }
    }
    private func figure(_ key: String, value: String?, detail: String?, hint: String, gain: Decimal?) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(strings.t(key)).font(.caption).foregroundStyle(theme.tertiaryLabel)
                PortfolioFigureInfo(title: strings.t("portfolio.figure.about", ["label": strings.t(key)]), text: hint)
            }
            Text(value ?? "—").font(Font.visionTitle3).monospacedDigit()
                .foregroundStyle(value == nil ? theme.tertiaryLabel : (gain ?? 0) >= 0 ? theme.gain : theme.loss)
            if let detail { Text(detail).font(.footnote).foregroundStyle(theme.secondaryLabel).monospacedDigit() }
        }
    }
    private var holdings: some View {
        PortfolioCard(title: strings.t("portfolio.widget.holdings")) {
            HStack {
                Picker(
                    strings.t("portfolio.sort.label"), selection: Binding(get: { model.sort }, set: { model.sort = $0 })
                ) {
                    Text(strings.t("portfolio.sort.value")).tag(PortfolioHoldingsSort.value)
                    Text(strings.t("portfolio.sort.return")).tag(PortfolioHoldingsSort.returnRate)
                }.pickerStyle(.segmented).frame(maxWidth: 250)
                Spacer()
                Picker(
                    strings.t("portfolio.brokerFilter.label"),
                    selection: Binding(get: { model.brokerFilter }, set: { model.brokerFilter = $0 })
                ) {
                    Text(strings.t("portfolio.brokerFilter.all")).tag("all")
                    ForEach(model.brokerOptions) { option in
                        Text(option.id == "unassigned" ? strings.t("portfolio.brokerFilter.unassigned") : option.name)
                            .tag(option.id)
                    }
                }.frame(maxWidth: 300).disabled(model.brokerFilterStatusKey != nil)
            }
            if model.filteredHoldings.isEmpty {
                Text(strings.t("portfolio.brokerFilter.empty")).foregroundStyle(theme.secondaryLabel).padding(20)
            }
            ForEach(model.filteredHoldings) { holding in
                let metrics = model.metrics(for: holding)
                HStack(spacing: 14) {
                    Button {
                        Task { await model.openDetail(id: holding.id) }
                    } label: {
                        HStack(spacing: 14) {
                            Image(systemName: PortfolioOverviewAsset.symbol(holding.assetClass)).foregroundStyle(
                                theme.primary
                            )
                            .frame(width: 32).accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 5) {
                                HStack {
                                    Text(holding.name).font(.callout.weight(.medium))
                                    if metrics.oversold {
                                        Label(
                                            strings.t("portfolio.oversold.label"),
                                            systemImage: "exclamationmark.triangle"
                                        )
                                        .font(.caption).foregroundStyle(theme.warning).help(
                                            strings.t("portfolio.oversold.description"))
                                    }
                                }
                                Text(
                                    [strings.t("portfolio.assetClass." + holding.assetClass), holding.symbol].compactMap
                                    {
                                        $0
                                    }.joined(separator: " · ")
                                )
                                .font(.caption).foregroundStyle(theme.secondaryLabel)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 5) {
                                MoneyText(
                                    amount: metrics.currentValue, currency: currency, settings: shell.settings,
                                    signed: false,
                                    colored: false)
                                HStack(spacing: 5) {
                                    MoneyText(amount: metrics.gainLoss, currency: currency, settings: shell.settings)
                                    Text(
                                        signedPercent(
                                            model.brokerFilter == "all"
                                                ? holding.gainLossPercent : metrics.returnPercent)
                                    )
                                    .monospacedDigit().foregroundStyle(metrics.gainLoss >= 0 ? theme.gain : theme.loss)
                                }.font(.caption)
                            }
                        }
                    }
                    .buttonStyle(.plain).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel(strings.t("invDetail.trigger") + ": " + holding.name)
                    PortfolioHoldingActionsMenu(holding: holding, model: model, editing: editing, shell: shell)
                }.padding(.vertical, 10)
                if !holding.fullyAssigned {
                    PortfolioHoldingsUnassignedView(holding: holding, model: model, editing: editing, shell: shell)
                }
            }
            Divider()
            if let status = model.brokerFilterStatusKey {
                let unavailable = status == "portfolio.brokerFilter.unavailable"
                Text(strings.t(status)).font(.footnote)
                    .foregroundStyle(unavailable ? theme.warning : theme.secondaryLabel)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            } else {
                moneyRow("portfolio.brokerFilter.holdingsSubtotal", model.brokerSubtotal.currentValue)
                moneyRow("portfolio.brokerFilter.pnlSubtotal", model.brokerSubtotal.gainLoss, signed: true)
            }
        }
    }
    private var allocation: some View {
        let groups = PortfolioOverviewAsset.groups.map { key, classes in
            (
                key: key,
                value: model.active.filter { classes.contains($0.assetClass) }.reduce(0) { $0 + $1.currentValue },
                colorIndex: PortfolioOverviewAsset.groups.firstIndex { $0.0 == key } ?? 0
            )
        }.filter { $0.value > 0 }
        let total = groups.reduce(0) { $0 + $1.value }
        return Group {
            if total > 0 {
                PortfolioCard(
                    title: strings.t("portfolio.widget.allocation"),
                    description: strings.t("portfolio.allocationByClass")
                ) {
                    GeometryReader { geometry in
                        HStack(spacing: 0) {
                            ForEach(Array(groups.enumerated()), id: \.element.key) { _, item in
                                Rectangle().fill(PortfolioOverviewAsset.color(item.colorIndex, theme: theme))
                                    .frame(
                                        width: geometry.size.width
                                            * CGFloat(NSDecimalNumber(decimal: item.value / total).doubleValue))
                            }
                        }
                    }.frame(height: 14).clipShape(Capsule()).accessibilityLabel(
                        strings.t("portfolio.allocation.legendAria"))
                    ForEach(Array(groups.enumerated()), id: \.element.key) { _, item in
                        HStack {
                            Circle().fill(PortfolioOverviewAsset.color(item.colorIndex, theme: theme)).frame(
                                width: 8, height: 8
                            )
                            .accessibilityHidden(true)
                            Text(strings.t("portfolio.assetGroup." + item.key))
                            Spacer()
                            MoneyText(
                                amount: item.value, currency: currency, settings: shell.settings, signed: false,
                                colored: false)
                            Text(
                                VisionFormat.percent(
                                    item.value / total * 100, digits: 0, locale: shell.settings.numberFormat.locale)
                            ).monospacedDigit()
                        }.font(.callout)
                    }
                    Button(strings.t("nav.rebalance")) { shell.navigate(to: "/portfolio/rebalance") }.buttonStyle(
                        .bordered)
                }
            }
        }
    }
    private func costs(_ summary: PortfolioSummaryData) -> some View {
        let totals = summary.totals
        return PortfolioCard(title: strings.t("portfolio.gainsIncomeAndCosts")) {
            moneyRow("portfolio.totalInvested", totals.totalInvested)
            moneyRow("portfolio.currentValue", totals.totalPortfolioValue)
            moneyRow("portfolio.realizedGains", totals.totalRealizedGain, signed: true)
            moneyRow("portfolio.unrealizedGains", totals.totalUnrealizedGain, signed: true)
            if model.active.contains(where: { $0.originalCurrency != currency }) {
                moneyRow("portfolio.assetGain", totals.totalAssetGain, signed: true, fallback: totals.usedFallbackRate)
                moneyRow("portfolio.fxEffect", totals.totalFxGain, signed: true, fallback: totals.usedFallbackRate)
            }
            moneyRow("portfolio.totalIncome", totals.totalIncome)
            moneyRow("portfolio.totalFees", -totals.totalFees)
            moneyRow("portfolio.totalTaxes", -totals.totalTaxes)
            if let fees = summary.brokerageCashFees, fees.total > 0 {
                Divider()
                moneyRow("portfolio.brokerAccountFees", -fees.total, fallback: fees.usedFallbackRate)
                moneyRow(
                    "portfolio.gainAfterAccountFees", fees.gainAfterFees, signed: true, fallback: fees.usedFallbackRate)
            }
        }
    }
    private func moneyRow(_ key: String, _ amount: Decimal, signed: Bool = false, fallback: Bool = false) -> some View {
        HStack {
            Text(strings.t(key)).font(.footnote).foregroundStyle(theme.secondaryLabel)
            if fallback {
                PortfolioFigureInfo(
                    title: strings.t("portfolio.fxFallbackNote"), text: strings.t("portfolio.fxFallbackNote"),
                    symbol: "exclamationmark.circle"
                ).foregroundStyle(theme.warning)
            }
            Spacer()
            let tone = signed ? amount >= 0 ? theme.gain : theme.loss : theme.foreground
            MoneyText.styled(
                money(amount, signed: signed),
                decimalSeparator: shell.settings.numberFormat.locale.decimalSeparator?.first, color: tone
            ).font(.body.weight(.medium)).monospacedDigit().foregroundStyle(tone)
        }.padding(.vertical, 6)
    }
    @ViewBuilder private var archived: some View {
        if let error = model.errors["archive"] {
            PortfolioCard(title: strings.t("portfolio.archivedInvestments")) {
                Text(error).foregroundStyle(theme.destructive)
                Button(strings.t("common.retry")) { Task { await reload(force: true) } }
            }
        } else if !model.archived.isEmpty {
            AdminCard {
                DisclosureGroup {
                    Text(strings.t("portfolio.archivedInvestmentsDesc")).font(.footnote).foregroundStyle(
                        theme.secondaryLabel)
                    ForEach(model.archived) { holding in
                        HStack {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(holding.name).font(.callout.weight(.medium))
                                Text(
                                    strings.t(
                                        "portfolio.archivedHistory",
                                        ["count": holding.transactionCount.map(String.init) ?? "—"])
                                )
                                .font(.caption).foregroundStyle(theme.secondaryLabel)
                            }
                            VisionBadge(text: strings.t("portfolio.archived"), tone: .outline, small: true)
                            Spacer()
                            Button(strings.t("invDetail.trigger")) { Task { await model.openDetail(id: holding.id) } }
                                .buttonStyle(.bordered)
                            Button(strings.t("portfolio.restoreInvestment"), systemImage: "arrow.counterclockwise") {
                                Task { await editing.restoreInvestment(id: holding.id) }
                            }.buttonStyle(.bordered).disabled(editing.isMutating)
                        }.padding(.vertical, 10)
                    }
                } label: {
                    HStack {
                        Label(strings.t("portfolio.archivedInvestments"), systemImage: "archivebox").font(.headline)
                        Spacer()
                        Text(String(model.archived.count)).font(.caption).monospacedDigit()
                    }
                }
            }
        }
    }
    private func money(_ value: Decimal, signed: Bool = false) -> String {
        MoneyText.text(value, currency: currency, settings: shell.settings, signed: signed)
    }
    private func unsignedPercent(_ value: Decimal) -> String {
        VisionFormat.percent(value, locale: shell.settings.numberFormat.locale)
    }
    private func signedPercent(_ value: Decimal) -> String { (value > 0 ? "+" : "") + unsignedPercent(value) }
}

private struct PortfolioFigureInfo: View {
    let title: String
    let text: String
    var symbol = "info.circle"
    @State private var open = false
    var body: some View {
        Button {
            open = true
        } label: {
            Image(systemName: symbol).font(.caption)
        }
        .buttonStyle(.plain).help(text).accessibilityLabel(title)
        .popover(isPresented: $open) { Text(text).font(.callout).padding(16).frame(maxWidth: 340) }
    }
}

enum PortfolioOverviewAsset {
    static let groups: [(String, [String])] = [
        ("stocksEtfs", ["stock", "etf"]), ("crypto", ["crypto"]),
        ("metals", ["metals"]), ("realEstate", ["real_estate"]), ("savingsBonds", ["savings", "bond"]),
    ]
    static func symbol(_ asset: String) -> String {
        switch asset {
        case "crypto": "bitcoinsign.circle"
        case "metals": "diamond"
        case "real_estate": "building.2"
        case "savings", "bond": "banknote"
        default: "chart.line.uptrend.xyaxis"
        }
    }
    static func color(_ index: Int, theme: VisionTheme) -> Color {
        Color(
            token: [
                theme.palette.chart1, theme.palette.chart2, theme.palette.chart3, theme.palette.chart4,
                theme.palette.chart5,
            ][index % 5])
    }
}
