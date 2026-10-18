import SwiftUI
import VisionNativeCore

public struct NetWorthView: View {
    let model: NetWorthModel
    let shell: NativeShellModel
    @State private var connectivity = PortfolioConnectivity()
    @Environment(\.visionTheme) private var theme
    public init(model: NetWorthModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }
    private var currency: String { settings.defaultCurrency }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VisionPageHeader(title: strings.t("networth.title"), subtitle: "", symbol: "chart.line.uptrend.xyaxis")
                {}
                if model.isLoading || model.currency != currency {
                    ProgressView().frame(maxWidth: .infinity).padding(60)
                } else if let error = model.error {
                    AdminCard {
                        Text(strings.t("networth.unableToLoad")).font(.headline)
                        Text(error).foregroundStyle(theme.destructive)
                        Button(strings.t("common.retry")) { Task { await reload(force: true) } }
                    }
                } else if let data = model.data, data.current.currency == currency {
                    if model.snapshots.isEmpty {
                        AdminCard {
                            VisionEmptyState(
                                symbol: "chart.xyaxis.line", title: strings.t("networth.emptyTitle"),
                                description: strings.t("networth.emptyDescription")
                            ) { refreshButton }
                            if !model.isOnline {
                                Text(strings.t("portfolio.refreshPricesOffline")).foregroundStyle(theme.secondaryLabel)
                            }
                        }
                    } else {
                        stalePrices
                        hero(data)
                        accounts(data)
                        chart
                        HStack(spacing: 16) {
                            stat("networth.peak", value: model.peak.map(money) ?? "—", symbol: "arrow.up.right")
                            stat("networth.lowest", value: model.trough.map(money) ?? "—", symbol: "arrow.down.right")
                            stat(
                                "networth.daysTracked", value: String(model.displaySnapshots.count), symbol: "calendar")
                        }
                        table
                    }
                }
                if let error = model.pricesError { Text(error).font(.callout).foregroundStyle(theme.destructive) }
            }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: currency + String(settings.defaultPageSize) + shell.route.string + String(shell.settingsRevision)) {
            await reload()
        }
        .onAppear { connectivity.start { model.isOnline = $0 } }
        .onDisappear { connectivity.stop() }
        .overlay(alignment: .bottom) { NoticeToast(notice: refreshNotice, strings: strings, clear: model.clearNotice) }
    }
    private var refreshNotice: ScreenNotice? {
        guard let notice = model.notice, notice.key == "portfolio.refreshedPrices",
            let result = model.priceRefreshResult, result.staleCount > 0
        else { return model.notice }
        return ScreenNotice(
            id: notice.id, kind: notice.kind, key: notice.key, variables: notice.variables,
            detail: strings.t(
                "portfolio.refreshedPricesStale", ["n": String(result.staleCount), "total": String(result.total ?? 0)]))
    }
    private var refreshButton: some View {
        Button {
            Task { await model.refreshPrices(route: shell.route) }
        } label: {
            if model.isRefreshingPrices { ProgressView().controlSize(.small) }
            Label(strings.t("portfolio.refreshPrices"), systemImage: "arrow.clockwise")
        }.disabled(!model.isOnline || model.isRefreshingPrices)
            .help(model.isOnline ? strings.t("portfolio.refreshPrices") : strings.t("portfolio.refreshPricesOffline"))
    }
    @ViewBuilder private var stalePrices: some View {
        if model.stalePriceCount > 0 {
            AdminCard {
                HStack {
                    Label(
                        strings.t("portfolio.stalePricesBanner", ["n": String(model.stalePriceCount)]),
                        systemImage: "exclamationmark.triangle"
                    )
                    .foregroundStyle(theme.warning)
                    Spacer()
                    refreshButton
                }
                if !model.isOnline {
                    Text(strings.t("portfolio.refreshPricesOffline")).foregroundStyle(theme.secondaryLabel)
                }
            }
        }
    }
    private func hero(_ data: OpenAPI.NetWorthResponse) -> some View {
        AdminCard {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 40) {
                    identity(data)
                    Spacer()
                    assetBars(data).frame(minWidth: 240)
                }
                VStack(alignment: .leading, spacing: 24) {
                    identity(data)
                    assetBars(data)
                }
            }
        }
    }
    private func identity(_ data: OpenAPI.NetWorthResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(strings.t("networth.title")).font(.caption).foregroundStyle(theme.secondaryLabel)
            RollingNumber(
                value: MoneyText.text(data.current.netWorth, currency: currency, settings: settings, signed: false),
                decimalSeparator: settings.numberFormat.locale.decimalSeparator?.first
            )
            .font(.system(size: 40, weight: .semibold))
            HStack {
                Text(MoneyText.text(data.monthlyChange, currency: currency, settings: settings)).monospacedDigit()
                    .foregroundStyle(tone(data.monthlyChange))
                Text("(" + signedPercent(data.monthlyChangePercent) + ")")
                    .foregroundStyle(tone(data.monthlyChange))
                Text(strings.t("networth.thisMonth")).foregroundStyle(theme.secondaryLabel)
            }.font(.callout)
            if let stamp = model.priceFreshness {
                Text(
                    stamp.isEmpty
                        ? strings.t("networth.investmentPricesNotFetched")
                        : strings.t(
                            "networth.investmentPricesAsOf",
                            [
                                "date": VisionFormat.appDateTime(
                                    stamp, format: settings.dateFormat, locale: settings.numberFormat.locale)
                            ])
                )
                .font(.caption).foregroundStyle(theme.tertiaryLabel)
            }
            Text(strings.t("networth.sinceStart")).font(.caption).foregroundStyle(theme.tertiaryLabel)
            if let change = model.allTimeChange {
                HStack {
                    Image(systemName: change >= 0 ? "arrow.up.right" : "arrow.down.right")
                    Text(MoneyText.text(change, currency: currency, settings: settings)).monospacedDigit()
                        .foregroundStyle(tone(change))
                    if let percent = model.allTimePercent {
                        Text("(" + signedPercent(percent) + ")")
                    }
                }.font(.headline).foregroundStyle(tone(change))
            }
        }
    }
    private func assetBars(_ data: OpenAPI.NetWorthResponse) -> some View {
        let assets = model.assets ?? 0
        let debt = model.debt ?? 0
        let scale = max(assets, debt, 1)
        return VStack(alignment: .leading, spacing: 20) {
            valueBar("networth.assets", value: assets, scale: scale, color: theme.gain)
            if assets > Decimal(string: "0.005")! {
                Text(
                    strings.t("networth.liquid") + " " + money(data.current.liquid) + " · "
                        + strings.t("networth.investments") + " " + money(data.current.investments)
                )
                .font(.caption).foregroundStyle(theme.tertiaryLabel)
            }
            valueBar("networth.debt", value: debt, scale: scale, color: theme.loss)
        }
    }
    private func valueBar(_ key: String, value: Decimal, scale: Decimal, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(strings.t(key))
                Spacer()
                Text(value <= Decimal(string: "0.005")! ? "—" : money(value)).monospacedDigit()
            }
            .font(.callout)
            if value > Decimal(string: "0.005")! {
                GeometryReader { geometry in
                    Capsule().fill(theme.foreground.opacity(0.06))
                    Capsule().fill(color).frame(
                        width: geometry.size.width
                            * CGFloat(NSDecimalNumber(decimal: min(1, value / scale)).doubleValue))
                }.frame(height: 6).accessibilityHidden(true)
            }
        }
    }
    @ViewBuilder private func accounts(_ data: OpenAPI.NetWorthResponse) -> some View {
        AdminCard {
            Text(strings.t("networth.byAccount.title")).font(.headline)
            Text(strings.t("networth.byAccount.description")).font(.callout).foregroundStyle(theme.secondaryLabel)
            if let rows = model.accountRows {
                if rows.isEmpty { Text(strings.t("networth.byAccount.none")) }
                ForEach(rows) { row in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.label ?? strings.t("networth.byAccount.unassigned")).font(.headline)
                            if row.accountId == nil {
                                Text(strings.t("networth.byAccount.unassignedHint")).font(.caption).foregroundStyle(
                                    theme.secondaryLabel)
                            } else if let type = row.type {
                                Text(strings.t("accounts.type." + type)).font(.caption).foregroundStyle(
                                    theme.secondaryLabel)
                            }
                            if abs(row.cash) > Decimal(string: "0.005")!, abs(row.holdings) > Decimal(string: "0.005")!
                            {
                                Text(
                                    strings.t("networth.byAccount.cash") + " " + money(row.cash) + " · "
                                        + strings.t("networth.byAccount.holdings") + " " + money(row.holdings)
                                )
                                .font(.caption).foregroundStyle(theme.secondaryLabel)
                            }
                        }
                        Spacer()
                        if row.accountId == nil {
                            Button(strings.t("networth.byAccount.assign")) { shell.navigate(to: "/portfolio") }
                        }
                        MoneyText(
                            amount: row.total, currency: currency, settings: settings, signed: false, colored: false)
                    }.padding(.vertical, 5)
                    Divider()
                }
                let total = rows.reduce(Decimal.zero) { $0 + $1.total }
                let difference = NetWorthAccountRow.cents(total - data.current.netWorth)
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(strings.t("networth.byAccount.displayedTotal")).font(.headline)
                        Text(
                            abs(difference) < Decimal(string: "0.005")!
                                ? strings.t("networth.byAccount.matches")
                                : strings.t(difference > 0 ? "networth.byAccount.above" : "networth.byAccount.below")
                                    + " " + money(abs(difference))
                        )
                        .font(.caption).foregroundStyle(
                            abs(difference) < Decimal(string: "0.005")! ? theme.secondaryLabel : theme.warning)
                    }
                    Spacer()
                    MoneyText(amount: total, currency: currency, settings: settings, signed: false, colored: false)
                }
                if abs(difference) >= Decimal(string: "0.005")! {
                    Text(strings.t("networth.byAccount.differenceHint")).font(.caption).foregroundStyle(
                        theme.secondaryLabel)
                }
            } else if model.accountsError != nil {
                Text(strings.t("networth.byAccount.unavailable")).foregroundStyle(theme.warning)
            } else {
                ProgressView()
            }
        }
    }
    private var chart: some View {
        AdminCard {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(strings.t("networth.overTime")).font(.headline)
                    Text(strings.t("networth.chartDesc")).font(.callout).foregroundStyle(theme.secondaryLabel)
                }
                Spacer()
                Picker(
                    strings.t("networth.overTime"),
                    selection: Binding(
                        get: { model.period },
                        set: { value in
                            model.period = value
                            model.selection = nil
                            model.rangeStart = nil
                            shell.replaceQuery("period", with: value == .year ? nil : value.rawValue)
                        })
                ) {
                    ForEach(NetWorthPeriod.allCases, id: \.self) { period in
                        Text(strings.t("performance.period." + period.rawValue)).tag(period)
                    }
                }
                .pickerStyle(.segmented).frame(maxWidth: 420)
            }
            InsightTimelineChart(
                series: series, currency: currency, settings: settings, title: strings.t("networth.overTime"),
                areas: true, stackedAreas: false, height: 380,
                customColors: [
                    "netWorth": theme.primary, "liquid": Color(token: theme.palette.chart2),
                    "investments": Color(token: theme.palette.chart4), "liabilities": theme.loss,
                ],
                areaSeries: ["netWorth"], rangePercent: true,
                formatPeriod: { VisionFormat.appDate($0, format: settings.dateFormat) }, formatTick: tick,
                selection: Binding(get: { model.selection }, set: { model.selection = $0 }),
                rangeStart: Binding(get: { model.rangeStart }, set: { model.rangeStart = $0 }))
        }
    }
    private var series: [InsightChartSeries] {
        let keys =
            ["liquid", "investments"]
            + (model.displaySnapshots.contains { abs($0.liabilities) > Decimal(string: "0.005")! }
                ? ["liabilities"] : []) + ["netWorth"]
        return keys.map { key in
            InsightChartSeries(
                id: key, label: strings.t(key == "netWorth" ? "networth.seriesTotal" : "networth." + key),
                points: model.displaySnapshots.map { snapshot in
                    let value: Decimal
                    switch key {
                    case "liquid": value = snapshot.liquid
                    case "investments": value = snapshot.investments
                    case "liabilities": value = snapshot.liabilities
                    default: value = snapshot.netWorth
                    }
                    return InsightChartPoint(key: snapshot.date, value: value)
                })
        }
    }
    private var table: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView {
                LocalDataTable(
                    title: strings.t("networth.dailyBreakdown"), subtitle: "", columns: columns, rows: model.tableRows,
                    totalCount: model.tableSnapshots.count,
                    query: Binding(get: { model.tableQuery }, set: { model.tableQuery = $0 }),
                    filterValues: model.tableFilterValues, strings: strings, serverTotal: model.tableTotal,
                    isFetchingMore: model.isFetchingMore, hasMore: model.hasMore
                ) {
                    Text(strings.t(model.tableQuery.isNarrowed ? "table.noFilterResults" : "table.noData"))
                }.rowAppeared { id in
                    if model.tableRows.suffix(5).contains(where: { $0.id == id }) { Task { await model.loadMore() } }
                }
            }.frame(maxHeight: 520)
            if let error = model.tableError {
                Text(error).foregroundStyle(theme.destructive)
                Button(strings.t("common.retry")) {
                    Task {
                        if model.tableSnapshots.isEmpty { await reload(force: true) } else { await model.loadMore() }
                    }
                }
            }
        }
    }
    private var columns: [LocalDataColumn<NetWorthTableRow>] {
        model.tableKeys.map { key in
            LocalDataColumn(
                key: key, title: strings.t(key == "netWorth" ? "networth.title" : "networth." + key), width: 170,
                minWidth: 100, flexible: key == "date", alignment: key == "date" ? .leading : .trailing
            ) { row in
                if key == "date" {
                    return AnyView(Text(VisionFormat.appDate(row.snapshot.date, format: settings.dateFormat)))
                }
                if case .number(let value) = row.rawValue(key) {
                    if key == "change" {
                        return AnyView(
                            Text(MoneyText.text(value, currency: currency, settings: settings)).monospacedDigit()
                                .foregroundStyle(value < 0 ? theme.loss : theme.gain))
                    }
                    return AnyView(
                        MoneyText(
                            amount: value, currency: currency, settings: settings, signed: key == "change",
                            colored: key == "change"
                        ).fontWeight(key == "netWorth" ? .bold : .regular))
                }
                return AnyView(Text("—"))
            }
        }
    }
    private func stat(_ key: String, value: String, symbol: String) -> some View {
        AdminCard {
            Label(strings.t(key), systemImage: symbol).font(.caption).foregroundStyle(theme.secondaryLabel)
            RollingNumber(value: value, decimalSeparator: settings.numberFormat.locale.decimalSeparator?.first)
                .font(.title2)
        }
    }
    private func signedPercent(_ value: Decimal) -> String {
        (value > 0 ? "+" : "") + VisionFormat.percent(value, locale: settings.numberFormat.locale)
    }
    private func tick(_ day: String) -> String {
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.calendar = Calendar(identifier: .gregorian)
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: day) else { return day }
        let formatter = DateFormatter()
        formatter.locale = LanguageLocale.locale(shell.strings.language)
        formatter.dateFormat = [.month, .quarter, .halfYear].contains(model.period) ? "d MMM" : "MMM yy"
        return formatter.string(from: date)
    }
    private func money(_ amount: Decimal) -> String {
        MoneyText.text(amount, currency: currency, settings: settings, signed: false)
    }
    private func tone(_ value: Decimal) -> Color {
        abs(value) <= Decimal(string: "0.005")! ? theme.secondaryLabel : value > 0 ? theme.gain : theme.loss
    }
    private func reload(force: Bool = false) async {
        await model.load(currency: currency, pageSize: settings.defaultPageSize, route: shell.route, force: force)
    }
}
