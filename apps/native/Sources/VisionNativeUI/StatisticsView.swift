import SwiftUI
import VisionNativeCore

public struct StatisticsView: View {
    let screens: StatisticsScreens
    let shell: NativeShellModel
    @State private var customize = false
    private let printSection: NativeStatisticsPrintSection?
    @Environment(\.visionTheme) private var theme

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

    private var includesPivot: Bool {
        guard let printSection else { return true }
        if case .pivotTable = printSection { return true }
        return false
    }
    private var displayedPivotPeriods: [String] {
        guard case .pivotTable(let page) = printSection else { return model.pivotPeriods }
        return Array(model.pivotPeriods.dropFirst(page * 4).prefix(4))
    }
    private var pivotColumnWidth: CGFloat { isPrinting ? 78 : 110 }
    private var isPrinting: Bool { printSection != nil }
    private func includes(_ section: NativeStatisticsPrintSection) -> Bool { printSection == nil || printSection == section }
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
                    }.pickerStyle(.segmented).frame(maxWidth: 280)
                    Menu {
                        if model.hasData {
                            Button(strings.t("statsPage.menu.exportPdf")) { shell.openStatisticsReport() }
                        }
                        Button(strings.t("statsPage.menu.customize")) { customize = true }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
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
                    Button(strings.t("statsPage.importBtn")) { shell.navigate(to: "/import") }.buttonStyle(
                        .borderedProminent)
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
                    }.pickerStyle(.segmented)
                    content
                }
            }.padding(24).frame(maxWidth: 1280, alignment: .leading).frame(maxWidth: .infinity)
        }
        .task(id: shell.route.string + currency + String(shell.settingsRevision)) { await reload() }
        .sheet(isPresented: $customize) { StatisticsWidgetsSheet(model: model, strings: strings) }
        .onChange(of: model.recipientQuery) { _, _ in model.recipientVisibleCount = settings.defaultPageSize }
        .onChange(of: model.pivotYear) { _, _ in model.pivotPage = 0 }
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
            selection: isPrinting ? .constant(model.printLocalState.selection[key]) : Binding(get: { model.printLocalState.selection[key] }, set: { model.printLocalState.selection[key] = $0 }),
            rangeStart: isPrinting ? .constant(model.printLocalState.rangeStart[key]) : Binding(get: { model.printLocalState.rangeStart[key] }, set: { model.printLocalState.rangeStart[key] = $0 }))
    }
    private var overview: some View {
        VStack(alignment: .leading, spacing: 20) {
            if includes(.rhythm), model.isVisible("summaryCards"), let snapshot = model.filtered { rhythm(snapshot) }
            if includes(.digest) { StatisticsDigestView(model: screens.digest, settings: settings, strings: strings, isPrinting: isPrinting) }
            if includes(.monthly), model.isVisible("monthly") {
                card("statsPage.widget.monthly", graph: "monthly") {
                    if !isPrinting { Toggle(strings.t("statsPage.toggleRollingAvg", ["n": "3"]), isOn: Binding(get: { model.printLocalState.rollingAverage }, set: { model.printLocalState.rollingAverage = $0 })).toggleStyle(
                        .button) }
                    chart(
                        monthlySeries(model.data(for: "monthly"), average: model.printLocalState.rollingAverage), key: "monthly", bars: true)
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
        card("statsPage.rhythm.title") {
            let months = snapshot.monthly.orderedMonths
            let chosen = months.first { $0.id == model.printLocalState.selection["rhythm"] } ?? months.last
            if let chosen {
                let net = chosen.total_income - abs(chosen.total_spending)
                Text(
                    strings.t(
                        "statsPage.rhythm.netIn",
                        [
                            "month": chosen.id
                                + (chosen.id == model.currentPeriod ? " " + strings.t("statsPage.rhythm.soFar") : "")
                        ])
                )
                .foregroundStyle(theme.secondaryLabel)
                MoneyText(amount: net, currency: currency, settings: settings).font(.largeTitle)
                if let index = months.firstIndex(where: { $0.id == chosen.id }), index > 0 {
                    let before = months[index - 1].total_income - abs(months[index - 1].total_spending)
                    HStack {
                        MoneyText(amount: net - before, currency: currency, settings: settings)
                        Text(strings.t("statsPage.rhythm.vsPrevious"))
                    }
                }
            }
            chart(
                [
                    InsightChartSeries(
                        id: "net", label: strings.t("statsPage.net"),
                        points: months.map {
                            InsightChartPoint(key: $0.id, value: $0.total_income - abs($0.total_spending))
                        })
                ], key: "rhythm", bars: true, rangeComparison: false)
            if let extremes = snapshot.extremes(currentPeriod: model.currentPeriod) {
                HStack {
                    LabeledContent(
                        strings.t("statsPage.rhythm.strongest"),
                        value: extremes.best.id + " · "
                            + money(extremes.best.total_income - abs(extremes.best.total_spending)))
                    LabeledContent(
                        strings.t("statsPage.rhythm.toughest"),
                        value: extremes.worst.id + " · "
                            + money(extremes.worst.total_income - abs(extremes.worst.total_spending)))
                    LabeledContent(
                        strings.t("statsPage.rhythm.inTheBlack"), value: "\(extremes.positive)/\(extremes.count)")
                }
            }
            HStack {
                LabeledContent(
                    strings.t("statsPage.rhythm.typicalIn"),
                    value: money(snapshot.totalIncome / Decimal(max(1, months.count))))
                LabeledContent(strings.t("statsPage.rhythm.typicalOut"), value: money(snapshot.averageSpending))
            }
            if !isPrinting { Text(strings.t("statsPage.rhythm.scrubHint")).font(.caption).foregroundStyle(theme.secondaryLabel) }
        }
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
                    yearPicker(Binding(get: { model.categoryYear }, set: { model.categoryYear = $0 }))
                    let snapshot = model.data(for: "categoryPie")
                    let periods = snapshot?.periods.filter { period in
                        model.categoryYear.map { year in period.hasPrefix(String(year) + "-") } ?? true
                    }
                    StatisticsCategoryDonut(
                        rows: Array(
                            (snapshot?.categories(metric: .expense, periods: periods.map(Set.init)) ?? []).filter {
                                $0.total > 0
                            }.prefix(10)),
                        settings: settings, currency: currency, strings: strings)
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
            if !isPrinting { HStack {
                Picker(
                    strings.t("statsPage.pivot.metric"),
                    selection: Binding(get: { model.categoryMetric }, set: { model.categoryMetric = $0 })
                ) {
                    ForEach(StatisticsMetric.allCases, id: \.self) { metric in
                        Text(strings.t("statsPage.pivot.metric.\(metric.rawValue)")).tag(metric)
                    }
                }.frame(maxWidth: 220)
                yearPicker(Binding(get: { model.pivotYear }, set: { model.pivotYear = $0 }))
                Button(strings.t("statsPage.pivot.expandAll")) { model.expandAllGroups() }
                Button(strings.t("statsPage.pivot.collapseAll")) { model.collapseAllGroups() }
            } } else {
                Text(strings.t("statsPage.pivot.metric.\(model.categoryMetric.rawValue)") + " · " + (model.pivotYear.map(String.init) ?? strings.t("statsPage.allYears")))
            }
            HStack {
                if !isPrinting { Button(strings.t("common.previous")) { model.pivotPage += 1 }
                    .disabled(!model.pivotHasPrevious) }
                Text((displayedPivotPeriods.first ?? "") + " – " + (displayedPivotPeriods.last ?? "")).font(.caption)
                if !isPrinting { Button(strings.t("common.next")) { model.pivotPage = max(0, model.pivotPage - 1) }.disabled(
                    model.pivotPage == 0) }
            }
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
                                        systemName: model.expandedGroups.contains(group.id)
                                            ? "chevron.down" : "chevron.right")
                                }.buttonStyle(.plain)
                                    .accessibilityLabel(
                                        strings.t(
                                            model.expandedGroups.contains(group.id)
                                                ? "statsPage.pivot.collapseGroup" : "statsPage.pivot.expandGroup",
                                            ["name": group.name]))
                            }
                            Text(group.name).fontWeight(.semibold)
                        }.frame(height: 32)
                        if model.expandedGroups.contains(group.id) {
                            ForEach(group.children) { child in
                                Text(child.name).padding(.leading, CGFloat(max(1, child.path.count - 1)) * 10).frame(
                                    height: 32)
                            }
                        }
                    }
                    Text(strings.t("statsPage.total")).fontWeight(.semibold).frame(height: 32)
                }.frame(width: isPrinting ? 140 : 200, alignment: .leading)
                horizontalContent {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: 0) {
                            ForEach(displayedPivotPeriods, id: \.self) { period in
                                Text(period).frame(width: pivotColumnWidth, height: 32)
                            }
                            Text(strings.t("statsPage.total")).frame(width: pivotColumnWidth, height: 32)
                        }.font(.caption.weight(.semibold))
                        ForEach(model.pivotGroups) { group in
                            pivotRow(
                                values: group.values, ids: group.categoryIds, name: group.name,
                                uncategorised: group.categoryIds.isEmpty)
                            if model.expandedGroups.contains(group.id) {
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
                            if isPrinting { Text(money(model.pivotGroups.reduce(0) { $0 + $1.total })).frame(width: pivotColumnWidth, height: 32) } else { Button(money(model.pivotGroups.reduce(0) { $0 + $1.total })) {
                                shell.navigate(to: "/transactions")
                            }
                            .buttonStyle(.link).frame(width: pivotColumnWidth, height: 32) }
                        }.fontWeight(.semibold)
                    }
                }
            }
        }
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
        Group { if isPrinting { Text(money(value)).frame(width: pivotColumnWidth, height: 32).monospacedDigit() } else { Button(money(value)) {
            shell.navigate(
                to: model.pivotDrill(categoryIds: ids, period: period, label: name, uncategorised: uncategorised).string
            )
        }.buttonStyle(.link).disabled(value == 0).frame(width: pivotColumnWidth, height: 32).monospacedDigit()
            .help(money(value)).accessibilityLabel(strings.t("statsPage.pivot.drillAria", ["label": name])) } }
    }

    private var recipients: some View {
        VStack(alignment: .leading, spacing: 20) {
            if model.isVisible("topRecipients") {
                card("statsPage.widget.topRecipients", graph: "topRecipients") {
                    yearPicker(Binding(get: { model.recipientYear }, set: { model.recipientYear = $0 }))
                    let snapshot = model.data(for: "topRecipients")
                    let rows = recipientBars(snapshot)
                    InsightRankedChart(rows: rows, settings: settings, currency: currency, strings: strings)
                }
            }
            if let data = model.filtered?.recipients {
                HStack {
                    LabeledContent(
                        strings.t("insights.topRecipient"),
                        value: data.topMerchants.first?.name ?? strings.t("insights.noDataFallback"))
                    LabeledContent(
                        strings.t("insights.top10Total"),
                        value: money(data.topMerchants.prefix(10).reduce(0) { $0 + $1.totalSpend }))
                    let transactions = data.topMerchants.prefix(10).reduce(0) { $0 + $1.transactionCount }
                    LabeledContent(
                        strings.t("insights.avgTransaction"),
                        value: money(
                            transactions > 0
                                ? data.topMerchants.prefix(10).reduce(0) { $0 + $1.totalSpend } / Decimal(transactions)
                                : 0))
                }
                if isPrinting { recipientPrintTable } else { LocalDataTable(
                    title: strings.t("insights.detailsTitle"), subtitle: strings.t("insights.detailsSubtitle"),
                    columns: recipientColumns,
                    rows: Array(model.recipientRows.prefix(model.recipientVisibleCount)),
                    totalCount: data.topMerchants.count,
                    query: Binding(get: { model.recipientQuery }, set: { model.recipientQuery = $0 }),
                    filterValues: model.recipientFilterValues, strings: strings,
                    serverTotal: model.recipientRows.count,
                    hasMore: model.recipientVisibleCount < model.recipientRows.count
                ) {
                    Text(strings.t(model.recipientQuery.isNarrowed ? "table.noFilterResults" : "insights.detailsEmpty"))
                }.rowAppeared { id in
                    if model.recipientRows.prefix(model.recipientVisibleCount).suffix(5).contains(where: { $0.id == id }
                    ) {
                        model.loadMoreRecipients(pageSize: settings.defaultPageSize)
                    }
                }
                }
                ForEach(data.monthOverMonth) { change in
                    LabeledContent(
                        change.name,
                        value: money(change.currentSpend) + " · "
                            + VisionFormat.decimal(
                                change.changePercent, fractionDigits: 1, locale: settings.numberFormat.locale) + "%")
                }
            }
        }
    }
    private func recipientBars(_ snapshot: StatisticsSnapshot?) -> [CustomChartEntity] {
        if let year = model.recipientYear {
            return (snapshot?.recipientYears.recipientsByYear[String(year)] ?? []).map {
                CustomChartEntity(id: String($0.id), name: $0.name, values: ["total": $0.totalSpend])
            }
        }
        return (snapshot?.recipients.topMerchants.prefix(20) ?? []).map {
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
            if !isPrinting { Picker(
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
            }.frame(maxWidth: 200) } else { Text(String(model.flowYear)) }
            if model.isFlowLoading {
                ProgressView().frame(height: 380)
            } else if let flow = model.flow {
                if flow.nodes.isEmpty {
                    Text(strings.t("statsPage.sankey.noData")).foregroundStyle(theme.secondaryLabel)
                } else {
                    horizontalContent {
                        StatisticsFlowView(flow: flow, settings: settings, currency: currency, strings: strings).frame(
                            minWidth: 720)
                    }.frame(height: 380)
                }
            } else if let error = model.flowError {
                Text(error).foregroundStyle(theme.destructive)
                if !isPrinting { Button(strings.t("common.retry")) { Task { await model.loadFlow() } } }
            }
        }
    }
    @ViewBuilder private func yearPicker(_ binding: Binding<Int?>) -> some View {
        if isPrinting { Text(binding.wrappedValue.map(String.init) ?? strings.t("statsPage.allYears")) } else { Picker(strings.t("statistics.selectYear"), selection: binding) {
            Text(strings.t("statsPage.allYears")).tag(nil as Int?)
            ForEach((model.unfiltered?.years.map(\.year) ?? []).sorted(by: >), id: \.self) {
                Text(String($0)).tag(Optional($0))
            }
        }.frame(maxWidth: 180) }
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
                    GridRow { ForEach(recipientColumns) { column in column.cell(row).font(.caption) } }
                }
            }
            if model.recipientRows.isEmpty {
                Text(strings.t(model.recipientQuery.isNarrowed ? "table.noFilterResults" : "insights.detailsEmpty"))
            }
        }
    }
    @ViewBuilder private func printContent(_ section: NativeStatisticsPrintSection) -> some View {
        switch section {
        case .header:
            VisionPageHeader(title: strings.t("statsPage.title"), subtitle: strings.t("statsPage.subtitle"), symbol: "chart.bar") { EmptyView() }
            Text(strings.t(model.tab.labelKey) + " · " + strings.t(model.window == .all ? "statsPage.window.allTime" : "statsPage.window.rolling24"))
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
        AdminCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(strings.t(title)).font(.headline)
                    Spacer()
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

private struct StatisticsWidgetsSheet: View {
    let model: StatisticsModel
    let strings: any Localizing
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(strings.t("widgets.title")).font(.title2)
            Text(strings.t("widgets.description"))
            ForEach(InsightWidget.statistics) { widget in
                Toggle(
                    strings.t(widget.labelKey),
                    isOn: Binding(
                        get: { model.isVisible(widget.id) },
                        set: { value in
                            Task { await model.setWidget(widget.id, visible: value) }
                        })
                ).disabled(!model.widgetsLoaded || model.widgetSavePending)
            }
            if let error = model.widgetError { Text(error).foregroundStyle(.red) }
            HStack {
                HStack {
                    Button(strings.t("widgets.showAll")) { Task { await model.allWidgets(visible: true) } }
                    Button(strings.t("widgets.hideAll")) { Task { await model.allWidgets(visible: false) } }
                    Button(strings.t("widgets.reset")) { Task { await model.resetWidgets() } }
                }.disabled(!model.widgetsLoaded || model.widgetSavePending)
                Spacer()
                Button(strings.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
        }.padding(24).frame(width: 520)
    }
}
