import AppKit
import SwiftUI
import VisionNativeCore

public struct StatisticsView: View {
    let screens: StatisticsScreens
    let shell: NativeShellModel
    @State private var customize = false
    private let printSection: NativeStatisticsPrintSection?
    @Environment(\.visionTheme) private var theme
    @Environment(\.nativePrintPageWidth) private var printPageWidth

    public init(screens: StatisticsScreens, shell: NativeShellModel) {
        self.screens = screens
        self.shell = shell
        printSection = nil
    }
    init(screens: StatisticsScreens, shell: NativeShellModel, printSection: NativeStatisticsPrintSection) {
        self.screens = screens
        self.shell = shell
        self.printSection = printSection
    }
    private var model: StatisticsModel { screens.model }
    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }
    private var currency: String { settings.defaultCurrency }
    private var languageLocale: Locale { LanguageLocale.locale(strings.language) }
    private func periodLabel(_ period: String) -> String {
        StatisticsPeriodFormat.label(period, locale: languageLocale)
    }
    private func periodShort(_ period: String) -> String {
        StatisticsPeriodFormat.short(period, locale: languageLocale)
    }

    private var includesPivot: Bool {
        guard let printSection else { return true }
        if case .pivotTable = printSection { return true }
        return false
    }
    private var displayedPivotPeriods: [String] {
        guard case .pivotTable(let page) = printSection else { return model.pivotPeriods }
        return Array(model.pivotPeriods.dropFirst(page * 4).prefix(4))
    }
    private var pivotLabelWidth: CGFloat {
        guard isPrinting else { return 200 }
        return min(120, max(0, (printPageWidth ?? 544) - 32) * 0.25)
    }
    private var pivotColumnWidth: CGFloat {
        guard isPrinting else { return 110 }
        let available = max(0, (printPageWidth ?? 544) - 32 - pivotLabelWidth)
        return min(72, available / CGFloat(displayedPivotPeriods.count + 1))
    }
    private var isPrinting: Bool { printSection != nil }
    private func includes(_ section: NativeStatisticsPrintSection) -> Bool {
        printSection == nil || printSection == section
    }
    public var body: some View {
        if let printSection {
            printContent(printSection)
        } else {
            liveContent
        }
    }
    private var liveContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VisionPageHeader(
                    title: strings.t("statsPage.title"), subtitle: strings.t("statsPage.subtitle"), symbol: "chart.bar"
                ) {
                    Picker(
                        strings.t("statsPage.window.label"),
                        selection: Binding(
                            get: { model.window },
                            set: { value in
                                shell.replaceQuery("window", with: value == .all ? "all" : nil)
                            })
                    ) {
                        Text(strings.t("statsPage.window.rolling24")).tag(StatisticsWindow.rolling24)
                        Text(strings.t("statsPage.window.allTime")).tag(StatisticsWindow.all)
                    }.pickerStyle(.segmented).labelsHidden().fixedSize()
                    Menu {
                        if model.hasData {
                            Button(strings.t("statsPage.menu.exportPdf")) { shell.openStatisticsReport() }
                        }
                        Button(strings.t("statsPage.menu.customize")) { customize = true }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .menuIndicator(.hidden)
                    .accessibilityLabel(strings.t("statsPage.menu.label"))
                }
                if model.isLoading {
                    ProgressView().frame(maxWidth: .infinity).padding(60)
                } else if let error = model.error, !model.hasData {
                    Text(strings.t("statsPage.error", ["msg": error])).foregroundStyle(theme.destructive)
                    Button(strings.t("common.retry")) { Task { await reload(force: true) } }
                } else if !model.hasData {
                    Text(strings.t("statsPage.noDataTitle")).font(.title2)
                    Text(strings.t("statsPage.noDataDesc")).foregroundStyle(theme.secondaryLabel)
                    Button(strings.t("statsPage.importBtn")) { shell.navigate(to: "/import") }.buttonStyle(.visionPrimary)
                } else {
                    Picker(
                        strings.t("statsPage.title"),
                        selection: Binding(
                            get: { model.tab },
                            set: { value in
                                shell.replaceQuery("tab", with: value.rawValue)
                            })
                    ) {
                        ForEach(StatisticsTab.allCases, id: \.self) { tab in Text(strings.t(tab.labelKey)).tag(tab) }
                    }.pickerStyle(.segmented).labelsHidden().fixedSize()
                    content
                }
            }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: shell.route.string + currency + String(shell.settingsRevision)) { await reload() }
        // Saved-chart toasts go to the shell's notice host, like the screens it wires itself.
        .onDisappear {
            model.printLocalState = .init()
            screens.saved.printLocalState = .init()
        }
        .sheet(isPresented: $customize) { StatisticsWidgetsSheet(model: model, strings: strings) }
        .onChange(of: model.recipientQuery) { _, _ in model.recipientVisibleCount = settings.defaultPageSize }
    }

    @ViewBuilder private var content: some View {
        switch model.tab {
        case .overview: overview
        case .categories: categories
        case .recipients:
            if model.isVisible("topRecipients") { recipients }
        case .yearly: yearly
        case .flow: flow
        case .custom:
            if let snapshot = model.filtered {
                SavedChartsView(model: screens.saved, snapshot: snapshot, settings: settings, strings: strings)
            }
        }
    }
    private func reload(force: Bool = false) async {
        async let stats: Void = model.appear(settings: settings, route: shell.route, force: force)
        async let digest: Void = screens.digest.load(force: force)
        _ = await (stats, digest)
    }
    private func money(_ value: Decimal) -> String {
        MoneyText.text(value, currency: currency, settings: settings, signed: false)
    }
    private func chart(
        _ series: [InsightChartSeries], key: String, bars: Bool = false, areas: Bool = false,
        rangeComparison: Bool = true
    ) -> some View {
        InsightTimelineChart(
            series: series, currency: currency, settings: settings, title: strings.t("statsPage.title"),
            bars: bars, areas: areas, stackedAreas: false, rangeComparison: rangeComparison,
            selection: isPrinting
                ? .constant(model.printLocalState.selection[key])
                : Binding(
                    get: { model.printLocalState.selection[key] }, set: { model.printLocalState.selection[key] = $0 }),
            rangeStart: isPrinting
                ? .constant(model.printLocalState.rangeStart[key])
                : Binding(
                    get: { model.printLocalState.rangeStart[key] }, set: { model.printLocalState.rangeStart[key] = $0 })
        )
    }
    private var overview: some View {
        VStack(alignment: .leading, spacing: 20) {
            if includes(.rhythm), model.isVisible("summaryCards"), let snapshot = model.filtered { rhythm(snapshot) }
            if includes(.digest) {
                StatisticsDigestView(
                    model: screens.digest, settings: settings, strings: strings, isPrinting: isPrinting)
            }
            if includes(.monthly), model.isVisible("monthly") {
                card("statsPage.widget.monthly", graph: "monthly") {
                    if !isPrinting {
                        Toggle(
                            strings.t("statsPage.toggleRollingAvg", ["n": "3"]),
                            isOn: Binding(
                                get: { model.printLocalState.rollingAverage },
                                set: { model.printLocalState.rollingAverage = $0 })
                        ).toggleStyle(
                            .button)
                    }
                    chart(
                        monthlySeries(model.data(for: "monthly"), average: model.printLocalState.rollingAverage),
                        key: "monthly", bars: true)
                }
            }
            if includes(.netTrend), model.isVisible("netTrend") {
                card("statsPage.widget.netTrend", graph: "netTrend") {
                    chart(
                        [
                            InsightChartSeries(
                                id: "net", label: strings.t("statsPage.net"),
                                points: (model.data(for: "netTrend")?.monthly.orderedMonths ?? []).map {
                                    InsightChartPoint(key: $0.id, value: $0.total_income - abs($0.total_spending))
                                })
                        ], key: "netTrend", areas: true)
                }
            }
        }
    }
    private func rhythm(_ snapshot: StatisticsSnapshot) -> some View {
        StatisticsRhythmCard(
            snapshot: snapshot, currentPeriod: model.currentPeriod, currency: currency, settings: settings,
            strings: strings, isPrinting: isPrinting,
            selection: isPrinting
                ? .constant(model.printLocalState.selection["rhythm"])
                : Binding(
                    get: { model.printLocalState.selection["rhythm"] },
                    set: { model.printLocalState.selection["rhythm"] = $0 }),
            periodLabel: periodLabel)
    }
    private func monthlySeries(_ snapshot: StatisticsSnapshot?, average: Bool) -> [InsightChartSeries] {
        let months = snapshot?.monthly.orderedMonths ?? []
        let income = months.map { InsightChartPoint(key: $0.id, value: $0.total_income) }
        let spending = months.map { InsightChartPoint(key: $0.id, value: abs($0.total_spending)) }
        var series = [
            InsightChartSeries(id: "income", label: strings.t("statsPage.income"), points: income),
            InsightChartSeries(id: "spending", label: strings.t("statsPage.spending"), points: spending),
        ]
        if average {
            let mean: ([InsightChartPoint]) -> [InsightChartPoint] = { points in
                points.indices.filter { $0 >= 2 }.map { index in
                    InsightChartPoint(
                        key: points[index].key, value: points[(index - 2)...index].reduce(0) { $0 + $1.value } / 3)
                }
            }
            series += [
                InsightChartSeries(
                    id: "incomeAvg", label: strings.t("statsPage.incomeAvg", ["n": "3"]), points: mean(income),
                    dashed: true),
                InsightChartSeries(
                    id: "spendingAvg", label: strings.t("statsPage.spendingAvg", ["n": "3"]), points: mean(spending),
                    dashed: true),
            ]
        }
        return series
    }

    private var categories: some View {
        VStack(alignment: .leading, spacing: 20) {
            if includes(.categoryPie), model.isVisible("categoryPie") {
                card("statsPage.widget.categoryPie", graph: "categoryPie") {
                    HStack {
                        Spacer()
                        yearPicker(Binding(get: { model.categoryYear }, set: { model.categoryYear = $0 }))
                    }
                    let snapshot = model.data(for: "categoryPie")
                    let periods = snapshot?.periods.filter { period in
                        model.categoryYear.map { year in period.hasPrefix(String(year) + "-") } ?? true
                    }
                    StatisticsCategoryDonut(
                        rows: Array(
                            (snapshot?.categories(metric: .expense, periods: periods.map(Set.init)) ?? []).filter {
                                $0.total > 0
                            }.prefix(10)),
                        settings: settings, currency: currency, strings: strings,
                        initialSelection: model.printLocalState.selection["categoryPie"],
                        onSelectionChange: { if !isPrinting { model.printLocalState.selection["categoryPie"] = $0 } })
                }
            }
            if includes(.categoryTrend), model.isVisible("categoryTrend") {
                card("statsPage.widget.categoryTrend", graph: "categoryTrend") {
                    let snapshot = model.data(for: "categoryTrend")
                    let rows = Array((snapshot?.categories(metric: .expense) ?? []).filter { $0.total > 0 }.prefix(5))
                    chart(
                        rows.map { row in
                            InsightChartSeries(
                                id: row.id, label: row.name,
                                points: (snapshot?.periods ?? []).map {
                                    InsightChartPoint(key: $0, value: row.values[$0] ?? 0)
                                })
                        }, key: "categoryTrend")
                }
            }
            if includesPivot, model.isVisible("pivotTable") { pivot }
        }
    }
    private var pivot: some View {
        card("statsPage.pivotTitle", graph: "pivotTable") {
            if !isPrinting {
                HStack {
                    Picker(
                        strings.t("statsPage.pivot.metric"),
                        selection: Binding(get: { model.categoryMetric }, set: { model.categoryMetric = $0 })
                    ) {
                        ForEach(StatisticsMetric.allCases, id: \.self) { metric in
                            Text(strings.t("statsPage.pivot.metric.\(metric.rawValue)")).tag(metric)
                        }
                    }.frame(maxWidth: 220)
                    yearPicker(Binding(get: { model.pivotYear }, set: { model.pivotYear = $0 }))
                    if !model.pivotExpandableGroupIds.isEmpty {
                        Button(
                            strings.t(
                                model.pivotAllCollapsed ? "statsPage.pivot.expandAll" : "statsPage.pivot.collapseAll")
                        ) { model.toggleAllGroups() }
                    }
                }
            } else {
                Text(
                    strings.t("statsPage.pivot.metric.\(model.categoryMetric.rawValue)") + " · "
                        + (model.pivotYear.map(String.init) ?? strings.t("statsPage.allYears")))
            }
            if isPrinting {
                Text(
                    displayedPivotPeriods.first.map { periodShort($0) + " – " + periodShort(displayedPivotPeriods.last ?? $0) }
                        ?? "—"
                ).font(.caption)
            } else if model.pivotPageCount > 1 {
                HStack {
                    Button(strings.t("common.previous")) { model.pivotPage += 1 }
                        .disabled(!model.pivotHasPrevious)
                    Text(
                        displayedPivotPeriods.first.map { first in
                            periodShort(first) + " – " + periodShort(displayedPivotPeriods.last ?? first)
                        } ?? "—"
                    ).font(.caption).monospacedDigit()
                    Button(strings.t("common.next")) { model.pivotPage = max(0, model.pivotPage - 1) }.disabled(
                        model.pivotPage == 0)
                }
            }
            if isPrinting {
                printPivotGrid
            } else {
                // The label column stays outside the scrolling month columns, preserving the
                // web table's sticky category labels in narrow windows.
                HStack(alignment: .top, spacing: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(strings.t("categories.title")).font(.caption.weight(.semibold)).frame(height: 32)
                        ForEach(model.pivotGroups) { group in
                            HStack {
                                if group.isExpandable, !isPrinting {
                                    Button {
                                        model.toggleGroup(group.id)
                                    } label: {
                                        Image(
                                            systemName: model.isGroupExpanded(group.id)
                                                ? "chevron.down" : "chevron.right")
                                    }.buttonStyle(.plain)
                                        .accessibilityLabel(
                                            strings.t(
                                                model.isGroupExpanded(group.id)
                                                    ? "statsPage.pivot.collapseGroup" : "statsPage.pivot.expandGroup",
                                                ["name": group.name]))
                                }
                                Text(group.name).fontWeight(.semibold)
                            }.frame(height: 32)
                            if group.isExpandable, model.isGroupExpanded(group.id) {
                                ForEach(group.children) { child in
                                    Text(child.name).padding(.leading, CGFloat(max(1, child.path.count - 1)) * 10)
                                        .frame(
                                            height: 32)
                                }
                            }
                        }
                        Text(strings.t("statsPage.total")).fontWeight(.semibold).frame(height: 32)
                    }.frame(width: pivotLabelWidth, alignment: .leading)
                    horizontalContent {
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(spacing: 0) {
                                ForEach(displayedPivotPeriods, id: \.self) { period in
                                    Text(periodShort(period)).padding(.horizontal, 8)
                                        .frame(width: pivotColumnWidth, height: 32, alignment: .trailing)
                                        .foregroundStyle(theme.secondaryLabel)
                                }
                                Text(strings.t("statsPage.total")).padding(.horizontal, 8)
                                    .frame(width: pivotColumnWidth, height: 32, alignment: .trailing)
                            }.font(.caption.weight(.semibold))
                            ForEach(model.pivotGroups) { group in
                                pivotRow(
                                    values: group.values, ids: group.categoryIds, name: group.name,
                                    uncategorised: group.categoryIds.isEmpty)
                                if group.isExpandable, model.isGroupExpanded(group.id) {
                                    ForEach(group.children) { child in
                                        pivotRow(values: child.values, ids: child.categoryIds, name: child.name)
                                    }
                                }
                            }
                            HStack(spacing: 0) {
                                ForEach(displayedPivotPeriods, id: \.self) { period in
                                    pivotCell(
                                        model.pivotGroups.reduce(0) { $0 + ($1.values[period] ?? 0) }, ids: [],
                                        period: period, name: strings.t("statsPage.total"))
                                }
                                if isPrinting {
                                    Text(money(model.pivotGroups.reduce(0) { $0 + $1.total })).frame(
                                        width: pivotColumnWidth, height: 32)
                                } else {
                                    let total = model.pivotGroups.reduce(0) { $0 + $1.total }
                                    Button {
                                        shell.navigate(to: "/transactions")
                                    } label: {
                                        Text(money(total)).lineLimit(1).minimumScaleFactor(0.8)
                                            .foregroundStyle(pivotColor(total)).padding(.horizontal, 8)
                                            .frame(width: pivotColumnWidth, height: 32, alignment: .trailing)
                                            .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain).monospacedDigit()
                                }
                            }.fontWeight(.semibold)
                        }
                    }
                }
            }
        }
    }
    private var printPivotGrid: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 10) {
            GridRow {
                printPivotLabel(strings.t("categories.title"))
                ForEach(displayedPivotPeriods, id: \.self) { period in
                    Text(periodShort(period)).frame(width: pivotColumnWidth).fixedSize(horizontal: false, vertical: true)
                }
                Text(strings.t("statsPage.total")).frame(width: pivotColumnWidth)
                    .fixedSize(horizontal: false, vertical: true)
            }.font(.caption.weight(.semibold))
            ForEach(model.pivotGroups) { group in
                printPivotRow(name: group.name, values: group.values).fontWeight(.semibold)
                if group.isExpandable, model.isGroupExpanded(group.id) {
                    ForEach(group.children) { child in
                        printPivotRow(
                            name: child.name, values: child.values,
                            indentation: CGFloat(max(1, child.path.count - 1)) * 10)
                    }
                }
            }
            GridRow {
                printPivotLabel(strings.t("statsPage.total"))
                ForEach(displayedPivotPeriods, id: \.self) { period in
                    printPivotAmount(model.pivotGroups.reduce(0) { $0 + ($1.values[period] ?? 0) })
                }
                printPivotAmount(model.pivotGroups.reduce(0) { $0 + $1.total })
            }.fontWeight(.semibold)
        }
    }
    private func printPivotRow(name: String, values: [String: Decimal], indentation: CGFloat = 0) -> some View {
        GridRow {
            printPivotLabel(name, indentation: indentation)
            ForEach(displayedPivotPeriods, id: \.self) { period in printPivotAmount(values[period] ?? 0) }
            printPivotAmount(values.values.reduce(0, +))
        }
    }
    private func printPivotLabel(_ text: String, indentation: CGFloat = 0) -> some View {
        Text(text).padding(.leading, indentation).frame(width: pivotLabelWidth, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
    private func printPivotAmount(_ value: Decimal) -> some View {
        Text(money(value)).monospacedDigit().frame(width: pivotColumnWidth, alignment: .trailing)
            .fixedSize(horizontal: false, vertical: true)
    }
    private func pivotRow(values: [String: Decimal], ids: [Int], name: String, uncategorised: Bool = false) -> some View
    {
        HStack(spacing: 0) {
            ForEach(displayedPivotPeriods, id: \.self) { period in
                pivotCell(values[period] ?? 0, ids: ids, period: period, name: name, uncategorised: uncategorised)
            }
            pivotCell(values.values.reduce(0, +), ids: ids, period: nil, name: name, uncategorised: uncategorised)
        }
    }
    private func pivotCell(_ value: Decimal, ids: [Int], period: String?, name: String, uncategorised: Bool = false)
        -> some View
    {
        Group {
            if isPrinting {
                printPivotAmount(value)
            } else {
                // The web DrillCellLink (`tone="inherit"`): right-aligned foreground figures, not
                // link green, so a negative net reads as a loss.
                Button {
                    shell.navigate(
                        to: model.pivotDrill(
                            categoryIds: ids, period: period, label: name, uncategorised: uncategorised
                        ).string
                    )
                } label: {
                    Text(money(value))
                        .lineLimit(1).minimumScaleFactor(0.8)
                        .foregroundStyle(pivotColor(value))
                        .padding(.horizontal, 8)
                        .frame(width: pivotColumnWidth, height: 32, alignment: .trailing)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(value == 0).monospacedDigit()
                .help(money(value)).accessibilityLabel(strings.t("statsPage.pivot.drillAria", ["label": name]))
            }
        }
    }

    private func pivotColor(_ value: Decimal) -> Color {
        if value == 0 { return theme.tertiaryLabel }
        return model.categoryMetric == .net && value < 0 ? theme.loss : theme.foreground
    }

    private var recipients: some View {
        VStack(alignment: .leading, spacing: 20) {
            recipientOverview
            if let data = model.filtered?.recipients {
                if isPrinting {
                    recipientPrintTable
                } else {
                    LocalDataTable(
                        title: strings.t("insights.detailsTitle"), subtitle: strings.t("insights.detailsSubtitle"),
                        columns: recipientColumns,
                        rows: Array(model.recipientRows.prefix(model.recipientVisibleCount)),
                        totalCount: data.topMerchants.count,
                        query: Binding(get: { model.recipientQuery }, set: { model.recipientQuery = $0 }),
                        filterValues: model.recipientFilterValues, strings: strings,
                        serverTotal: model.recipientRows.count,
                        hasMore: model.recipientVisibleCount < model.recipientRows.count
                    ) {
                        Text(
                            strings.t(
                                model.recipientQuery.isNarrowed ? "table.noFilterResults" : "insights.detailsEmpty"))
                    }.rowAppeared { id in
                        if model.recipientRows.prefix(model.recipientVisibleCount).suffix(5).contains(where: {
                            $0.id == id
                        }
                        ) {
                            model.loadMoreRecipients(pageSize: settings.defaultPageSize)
                        }
                    }
                }
            }
            recipientMonthChanges
        }
    }
    private var recipientOverview: some View {
        VStack(alignment: .leading, spacing: 20) {
            if model.isVisible("topRecipients") {
                card("statsPage.widget.topRecipients", graph: "topRecipients") {
                    HStack {
                        Spacer()
                        yearPicker(Binding(get: { model.recipientYear }, set: { model.recipientYear = $0 }))
                    }
                    let snapshot = model.data(for: "topRecipients")
                    let rows = recipientBars(snapshot)
                    InsightRankedChart(
                        rows: rows, settings: settings, currency: currency, strings: strings,
                        initialSelection: model.printLocalState.selection["topRecipients"],
                        onSelectionChange: { if !isPrinting { model.printLocalState.selection["topRecipients"] = $0 } })
                }
            }
            if let data = model.filtered?.recipients {
                // The web KPI cards (StatCard): a label with its icon, the figure, a footnote.
                let top10 = Array(data.topMerchants.prefix(10))
                let total = top10.reduce(Decimal(0)) { $0 + $1.totalSpend }
                let transactions = top10.reduce(0) { $0 + $1.transactionCount }
                HStack(alignment: .top, spacing: 16) {
                    StatisticsStatCard(title: strings.t("insights.topRecipient"), symbol: "storefront") {
                        Text(top10.first?.name ?? "—").lineLimit(1).truncationMode(.tail)
                    } subtitle: {
                        if let first = top10.first {
                            MoneyText(
                                amount: first.totalSpend, currency: currency, settings: settings, signed: false,
                                colored: false)
                        } else {
                            Text(strings.t("insights.noDataFallback"))
                        }
                    }
                    StatisticsStatCard(title: strings.t("insights.top10Total"), symbol: "banknote") {
                        MoneyText(amount: total, currency: currency, settings: settings, signed: false, colored: false)
                    } subtitle: {
                        Text("\(transactions) " + strings.t("insights.transactionCount").lowercased())
                    }
                    StatisticsStatCard(title: strings.t("insights.avgTransaction"), symbol: "number") {
                        MoneyText(
                            amount: transactions > 0 ? total / Decimal(transactions) : 0, currency: currency,
                            settings: settings, signed: false, colored: false)
                    } subtitle: {
                        Text(strings.t("insights.acrossTop10"))
                    }
                }
            }
        }
    }
    /// The web "Month-over-month changes" card: increases (loss arrow) then decreases (gain
    /// arrow), each a list row "You spent n more at name this month" over "previous → current".
    @ViewBuilder private var recipientMonthChanges: some View {
        if let data = model.filtered?.recipients, !data.monthOverMonth.isEmpty {
            let increases = data.monthOverMonth.filter { $0.changePercent > 0 }
            let decreases = data.monthOverMonth.filter { $0.changePercent < 0 }
            AdminCard(padding: VisionPageLayout.padding) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(strings.t("insights.momChanges")).font(Font.visionTitle3).accessibilityAddTraits(.isHeader)
                    Text(strings.t("insights.momDesc")).font(.callout).foregroundStyle(theme.secondaryLabel)
                }
                if !increases.isEmpty { momList(increases, increase: true) }
                if !decreases.isEmpty { momList(decreases, increase: false) }
            }
        }
    }
    private func momList(_ changes: [StatisticsRecipientInsights.Change], increase: Bool) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(changes.enumerated()), id: \.element.id) { position, change in
                if position > 0 { Divider().padding(.leading, 44) }
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: increase ? "chart.line.uptrend.xyaxis" : "chart.line.downtrend.xyaxis")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(increase ? theme.loss : theme.gain)
                        .frame(width: 20)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(
                            strings.t(
                                increase ? "insights.spentMoreAt" : "insights.spentLessAt",
                                [
                                    "n": VisionFormat.decimal(
                                        abs(change.changePercent), fractionDigits: 1,
                                        locale: settings.numberFormat.locale) + "%",
                                    "name": change.name,
                                ])
                        )
                        .font(.body)
                        HStack(spacing: 4) {
                            Text(money(change.previousSpend))
                            Image(systemName: "arrow.right").font(.system(size: 9, weight: .semibold))
                                .accessibilityHidden(true)
                            Text(money(change.currentSpend))
                        }
                        .font(.footnote).monospacedDigit().foregroundStyle(theme.secondaryLabel)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .accessibilityElement(children: .combine)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                .fill(theme.foreground.opacity(0.03)))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                .strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
    }
    private func recipientBars(_ snapshot: StatisticsSnapshot?) -> [CustomChartEntity] {
        if let year = model.recipientYear {
            return (snapshot?.recipientYears.recipientsByYear[String(year)] ?? []).prefix(10).map {
                CustomChartEntity(id: String($0.id), name: $0.name, values: ["total": $0.totalSpend])
            }
        }
        return (snapshot?.recipients.topMerchants.prefix(10) ?? []).map {
            CustomChartEntity(id: String($0.id), name: $0.name, values: ["total": $0.totalSpend])
        }
    }
    private var recipientColumns: [LocalDataColumn<StatisticsRecipientInsights.Merchant>] {
        let headers = [
            "name": "txPage.col.recipient", "totalSpend": "insights.col.totalSpend",
            "transactionCount": "insights.transactionCount", "avgAmount": "insights.col.avgAmount",
            "firstSeen": "insights.col.firstSeen", "lastSeen": "insights.col.lastSeen",
        ]
        return StatisticsRecipientInsights.Merchant.tableKeys.map { key in
            LocalDataColumn(
                key: key, title: strings.t(headers[key] ?? key), width: key == "name" ? 240 : 150,
                minWidth: 90, flexible: key == "name", alignment: key == "name" ? .leading : .trailing
            ) { row in
                if key == "totalSpend" || key == "avgAmount" {
                    return AnyView(
                        MoneyText(
                            amount: key == "totalSpend" ? row.totalSpend : row.avgAmount,
                            currency: currency, settings: settings, signed: false, colored: false))
                }
                if key == "firstSeen" || key == "lastSeen" {
                    return AnyView(
                        Text(
                            VisionFormat.appDate(
                                key == "firstSeen" ? row.firstSeen : row.lastSeen, format: settings.dateFormat)))
                }
                return AnyView(Text(row.rawValue(key).string ?? ""))
            }
        }
    }
    private var yearly: some View {
        VStack(alignment: .leading, spacing: 20) {
            if includes(.yearlyComparison), model.isVisible("yearlyComparison") {
                card("statsPage.widget.yearlyComparison", graph: "yearlyComparison") {
                    let years = model.data(for: "yearlyComparison")?.years ?? []
                    chart(
                        [
                            InsightChartSeries(
                                id: "income", label: strings.t("statsPage.income"),
                                points: years.map { InsightChartPoint(key: String($0.year), value: $0.income) }),
                            InsightChartSeries(
                                id: "spending", label: strings.t("statsPage.spending"),
                                points: years.map { InsightChartPoint(key: String($0.year), value: $0.spending) }),
                        ], key: "yearlyComparison", bars: true)
                }
            }
            if includes(.yearlySummary), model.isVisible("yearlySummary") {
                card("statsPage.yearly.title") {
                    Grid(alignment: .trailing, horizontalSpacing: 28, verticalSpacing: 12) {
                        GridRow {
                            ForEach(["year", "income", "spending", "net", "transactions"], id: \.self) {
                                Text(strings.t("statsPage.yearly.\($0)")).font(.caption.weight(.semibold))
                            }
                        }
                        ForEach(model.filtered?.years ?? []) { year in
                            GridRow {
                                Text(String(year.year))
                                Text(money(year.income))
                                Text(money(year.spending))
                                Text(money(year.net))
                                Text(String(year.count))
                            }
                        }
                    }.monospacedDigit().textSelection(.enabled)
                }
            }
        }
    }
    private var flow: some View {
        card("statsPage.sankey.title", graph: "sankey") {
            if !isPrinting {
                HStack {
                    Spacer()
                    Picker(
                        strings.t("statistics.selectYear"),
                        selection: Binding(
                            get: { model.flowYear },
                            set: { value in
                                model.flowYear = value
                                Task { await model.loadFlow() }
                            })
                    ) {
                        ForEach(
                            Array(
                                Set(
                                    (model.filtered?.years.map(\.year) ?? []) + [
                                        Calendar.current.component(.year, from: Date())
                                    ])
                            ).sorted(by: >), id: \.self
                        ) { Text(String($0)).tag($0) }
                    }
                    .labelsHidden().pickerStyle(.menu).fixedSize()
                    .accessibilityLabel(strings.t("statistics.selectYear"))
                }
            } else {
                Text(String(model.flowYear))
            }
            if model.isFlowLoading {
                ProgressView().frame(height: 380)
            } else if let flow = model.flow {
                if flow.nodes.isEmpty {
                    Text(strings.t("statsPage.sankey.noData")).foregroundStyle(theme.secondaryLabel)
                } else {
                    // No horizontal scroll view: inside one the flow took its 720 pt minimum
                    // instead of the card's width.
                    Group {
                        StatisticsFlowView(
                            flow: flow, settings: settings, currency: currency, strings: strings,
                            initialNode: model.printLocalState.selection["flowNode"],
                            initialLink: model.printLocalState.selection["flowLink"],
                            onHoverChange: { node, link in
                                if !isPrinting {
                                    model.printLocalState.selection["flowNode"] = node
                                    model.printLocalState.selection["flowLink"] = link
                                }
                            }
                        ).frame(
                            minWidth: isPrinting ? 0 : 720)
                    }.frame(height: 440)
                }
            } else if let error = model.flowError {
                Text(error).foregroundStyle(theme.destructive)
                if !isPrinting { Button(strings.t("common.retry")) { Task { await model.loadFlow() } } }
            }
        }
    }
    @ViewBuilder private func yearPicker(_ binding: Binding<Int?>) -> some View {
        if isPrinting {
            Text(binding.wrappedValue.map(String.init) ?? strings.t("statsPage.allYears"))
        } else {
            Picker(strings.t("statistics.selectYear"), selection: binding) {
                Text(strings.t("statsPage.allYears")).tag(nil as Int?)
                ForEach((model.unfiltered?.years.map(\.year) ?? []).sorted(by: >), id: \.self) {
                    Text(String($0)).tag(Optional($0))
                }
            }
            // The web ChartControls `w-[140px]` select: no visible "Select year" label.
            .labelsHidden().pickerStyle(.menu).fixedSize()
            .accessibilityLabel(strings.t("statistics.selectYear"))
        }
    }
    @ViewBuilder private func horizontalContent<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        if isPrinting { content() } else { ScrollView(.horizontal) { content() } }
    }
    private var recipientPrintTable: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(strings.t("insights.detailsTitle")).font(.headline)
            Text(strings.t("insights.detailsSubtitle")).font(.caption)
            if !model.recipientQuery.search.isEmpty { Text(model.recipientQuery.search) }
            ForEach(model.recipientQuery.filters) { filter in Text(filter.key + ": " + filter.value) }
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                GridRow { ForEach(recipientColumns) { column in Text(column.title).font(.caption.weight(.semibold)) } }
                ForEach(Array(model.recipientRows.prefix(model.recipientVisibleCount))) { row in
                    GridRow {
                        ForEach(recipientColumns) { column in column.cell(row).font(.caption).minimumScaleFactor(0.5) }
                    }
                }
            }
            let rows = Array(model.recipientRows.prefix(model.recipientVisibleCount))
            let totalCount = model.filtered?.recipients.topMerchants.count ?? 0
            Text(
                rows.count != totalCount
                    ? strings.t(
                        "table.shownOfFiltered",
                        ["shown": String(rows.count), "total": String(model.recipientRows.count)])
                    : strings.t(
                        "table.loadedOf", ["loaded": String(totalCount), "total": String(model.recipientRows.count)])
            )
            .font(.footnote)
            if model.recipientRows.isEmpty {
                Text(strings.t(model.recipientQuery.isNarrowed ? "table.noFilterResults" : "insights.detailsEmpty"))
            }
        }
    }

    /// Only frozen print instances enter this path; live tables retain their
    /// existing controls, scrolling and loaded-row behavior.
    @MainActor func rowAwarePrintBlocks(presentation: NativeStatisticsPrintPresentation, width: CGFloat) -> [NSView]? {
        guard let printSection else { return nil }
        switch printSection {
        case .pivotTable(let page):
            guard model.isVisible("pivotTable") else { return [] }
            let periods = displayedPivotPeriods
            let groups = model.pivotGroups
            var rows: [NativeStatisticsPrintTable.Row] = []
            for group in groups {
                rows.append(
                    .init(
                        id: group.id,
                        values: [group.name] + periods.map { money(group.values[$0] ?? 0) } + [money(group.total)],
                        emphasized: true))
                if group.isExpandable, model.isGroupExpanded(group.id) {
                    rows += group.children.map { child in
                        .init(
                            id: group.id + "." + child.id,
                            values: [child.name] + periods.map { money(child.values[$0] ?? 0) } + [money(child.total)],
                            indentation: CGFloat(max(1, child.path.count - 1)) * 10)
                    }
                }
            }
            var headings = [strings.t("statsPage.pivotTitle")]
            if model.hasExclusions {
                headings.append(
                    strings.t(
                        model.graphExclusions["pivotTable"] != false
                            ? "exclusion.filtersActive" : "exclusion.filtersIgnored"))
            }
            headings += [
                strings.t("statsPage.pivot.metric.\(model.categoryMetric.rawValue)") + " · "
                    + (model.pivotYear.map(String.init) ?? strings.t("statsPage.allYears")),
                periods.first.map { periodShort($0) + " – " + periodShort(periods.last ?? $0) } ?? "—",
            ]
            let footer = NativeStatisticsPrintTable.Row(
                id: "total",
                values: [strings.t("statsPage.total")]
                    + periods.map { period in money(groups.reduce(0) { $0 + ($1.values[period] ?? 0) }) }
                    + [money(groups.reduce(0) { $0 + $1.total })], emphasized: true)
            return [
                NativeStatisticsPrintTable(
                    id: "statistics.pivotTable:\(page)", headings: headings,
                    columns: [strings.t("categories.title")] + periods.map(periodShort) + [strings.t("statsPage.total")],
                    rows: rows, footer: footer
                ).block(presentation: presentation, width: width)
            ]
        case .yearlySummary:
            guard model.isVisible("yearlySummary") else { return [] }
            let years = model.filtered?.years ?? []
            let table = NativeStatisticsPrintTable(
                id: "statistics.yearlySummary", headings: [strings.t("statsPage.yearly.title")],
                columns: ["year", "income", "spending", "net", "transactions"].map {
                    strings.t("statsPage.yearly.\($0)")
                },
                rows: years.map { year in
                    .init(
                        id: String(year.year),
                        values: [
                            String(year.year), money(year.income), money(year.spending), money(year.net),
                            String(year.count),
                        ])
                })
            return [table.block(presentation: presentation, width: width)]
        case .recipients:
            guard model.filtered?.recipients != nil else { return [] }
            let visible = Array(model.recipientRows.prefix(model.recipientVisibleCount))
            let totalCount = model.filtered?.recipients.topMerchants.count ?? 0
            var headings = [strings.t("insights.detailsTitle"), strings.t("insights.detailsSubtitle")]
            if !model.recipientQuery.search.isEmpty { headings.append(model.recipientQuery.search) }
            headings += model.recipientQuery.filters.map { $0.key + ": " + $0.value }
            var notes = [
                visible.count != totalCount
                    ? strings.t(
                        "table.shownOfFiltered",
                        ["shown": String(visible.count), "total": String(model.recipientRows.count)])
                    : strings.t(
                        "table.loadedOf", ["loaded": String(totalCount), "total": String(model.recipientRows.count)])
            ]
            if model.recipientRows.isEmpty {
                notes.append(
                    strings.t(model.recipientQuery.isNarrowed ? "table.noFilterResults" : "insights.detailsEmpty"))
            }
            let table = NativeStatisticsPrintTable(
                id: "statistics.recipients", headings: headings, columns: recipientColumns.map(\.title),
                rows: visible.map { row in
                    .init(
                        id: String(row.recipientId),
                        values: [
                            row.name, money(row.totalSpend), String(row.transactionCount), money(row.avgAmount),
                            VisionFormat.appDate(row.firstSeen, format: settings.dateFormat),
                            VisionFormat.appDate(row.lastSeen, format: settings.dateFormat),
                        ])
                }, notes: notes)
            return [
                printHost(recipientOverview, presentation: presentation, width: width),
                table.block(presentation: presentation, width: width),
                printHost(
                    VStack(alignment: .leading, spacing: 20) { recipientMonthChanges }, presentation: presentation,
                    width: width),
            ]
        default: return nil
        }
    }

    @MainActor private func printHost<Content: View>(
        _ content: Content, presentation: NativeStatisticsPrintPresentation, width: CGFloat
    ) -> NSView {
        NativePrintHostingView(
            rootView: content.frame(width: width, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .environment(\.locale, presentation.snapshot.settings.numberFormat.locale)
                .environment(\.visionTheme, VisionTheme(selection: presentation.snapshot.theme, isPrintReport: true))
                .environment(\.nativePrintPageWidth, width)
                .preferredColorScheme(.light))
    }

    @ViewBuilder private func printContent(_ section: NativeStatisticsPrintSection) -> some View {
        switch section {
        case .header:
            VisionPageHeader(
                title: strings.t("statsPage.title"), subtitle: strings.t("statsPage.subtitle"), symbol: "chart.bar"
            ) { EmptyView() }
            Text(
                strings.t(model.tab.labelKey) + " · "
                    + strings.t(model.window == .all ? "statsPage.window.allTime" : "statsPage.window.rolling24"))
        case .rhythm, .digest, .monthly, .netTrend: overview
        case .categoryPie, .categoryTrend, .pivotTable: categories
        case .recipients: recipients
        case .yearlyComparison, .yearlySummary: yearly
        case .flow: flow
        case .customHeader, .customStatus, .savedChart: EmptyView()
        }
    }
    private func card<Content: View>(
        _ title: String, graph: String? = nil, @ViewBuilder content: @escaping () -> Content
    )
        -> some View
    {
        AdminCard(padding: VisionPageLayout.padding) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(strings.t(title)).font(Font.visionTitle3).accessibilityAddTraits(.isHeader)
                    Spacer()
                    if let graph, model.hasExclusions, isPrinting {
                        Text(
                            strings.t(
                                model.graphExclusions[graph] != false
                                    ? "exclusion.filtersActive" : "exclusion.filtersIgnored")
                        ).font(.caption)
                    }
                    if let graph, model.hasExclusions, !isPrinting {
                        Toggle(
                            strings.t(
                                model.graphExclusions[graph] != false
                                    ? "exclusion.filtersActive" : "exclusion.filtersIgnored"),
                            isOn: Binding(
                                get: { model.graphExclusions[graph] != false },
                                set: { value in
                                    model.graphExclusions[graph] = value
                                    if graph == "sankey" { Task { await model.loadFlow() } }
                                })
                        ).toggleStyle(.button).controlSize(.small)
                    }
                }
                content()
            }
        }
    }
}

/// The web WidgetVisibilityDialog, shared with the portfolio and tax pages.
private struct StatisticsWidgetsSheet: View {
    let model: StatisticsModel
    let strings: any Localizing
    var body: some View {
        PortfolioWidgetsSheet(
            definitions: InsightWidget.statistics, visible: { model.isVisible($0) },
            setVisible: { id, value in await model.setWidget(id, visible: value) },
            setAll: { value in await model.allWidgets(visible: value) }, reset: { await model.resetWidgets() },
            reload: {}, isLoaded: model.widgetsLoaded, isSaving: model.widgetSavePending,
            error: model.widgetError, strings: strings)
    }
}

/// The web `StatCard` (components/shared/StatCard.tsx): label and tertiary icon on one row,
/// the title-1 figure, a secondary footnote.
private struct StatisticsStatCard<Value: View, Subtitle: View>: View {
    let title: String
    let symbol: String
    @ViewBuilder let value: () -> Value
    @ViewBuilder let subtitle: () -> Subtitle
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(theme.secondaryLabel)
                Spacer(minLength: 8)
                Image(systemName: symbol).font(.system(size: 13)).foregroundStyle(theme.tertiaryLabel)
                    .accessibilityHidden(true)
            }
            value()
                .font(.system(size: 26, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(theme.foreground)
                .padding(.top, 10)
            subtitle()
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
                .padding(.top, 8)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .visionCardBackground()
        .accessibilityElement(children: .combine)
    }
}
