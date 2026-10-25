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
    private var currency: CurrencyCode { LedgerCurrency.display(settings) }

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
                            .buttonStyle(.visionOutline)
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
                        // `grid grid-cols-1 gap-4 sm:grid-cols-3`.
                        VisionResponsiveColumns(
                            weights: [1, 1, 1], minimumPageWidth: VisionBreakpoint.sm, spacing: 16
                        ) {
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
        .task(id: currency.rawValue + String(settings.defaultPageSize) + shell.route.string + String(shell.settingsRevision)) {
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
        }.buttonStyle(.visionOutline).disabled(!model.isOnline || model.isRefreshingPrices)
            .visionTooltip(model.isOnline ? strings.t("portfolio.refreshPrices") : strings.t("portfolio.refreshPricesOffline"))
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
        AdminCard(padding: VisionPageLayout.padding) {
            // `grid gap-6 lg:grid-cols-5`: the value on three fifths, the asset bars on two.
            VisionResponsiveColumns(weights: [3, 2]) {
                identity(data)
                assetBars(data)
            }
        }
    }
    private func identity(_ data: OpenAPI.NetWorthResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(strings.t("networth.title").uppercased())
                .font(.caption2.weight(.medium)).tracking(1.3)
                .foregroundStyle(Color(token: theme.palette.mutedForeground).opacity(0.8))
            // The same hero figure as Home: `<RollingNumber parts={fmtParts(...)}>` with the small
            // currency symbol and decimals.
            MoneyText(
                amount: data.current.netWorth, currency: currency, settings: settings, signed: false,
                colored: false, rolling: true
            ).font(.visionLargeTitle)
            HStack {
                MoneyText.styled(
                    MoneyText.text(data.monthlyChange, currency: currency, settings: settings),
                    decimalSeparator: settings.numberFormat.locale.decimalSeparator?.first, color: tone(data.monthlyChange)
                ).monospacedDigit()
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
                .font(.footnote).foregroundStyle(theme.tertiaryLabel)
            }
            if !data.unconvertedCurrencies.isEmpty {
                // Balances in a currency without a stored rate are left out (ADR-216).
                Text(strings.t("accounts.totalIncomplete")).font(.footnote).foregroundStyle(theme.warning)
            }
            Text(strings.t("networth.sinceStart")).font(.caption.weight(.medium)).foregroundStyle(theme.tertiaryLabel)
                .padding(.top, 8)
            if let change = model.allTimeChange {
                HStack {
                    Image(systemName: change >= 0 ? "arrow.up.right" : "arrow.down.right")
                    MoneyText.styled(
                        MoneyText.text(change, currency: currency, settings: settings),
                        decimalSeparator: settings.numberFormat.locale.decimalSeparator?.first, color: tone(change)
                    ).monospacedDigit()
                        .foregroundStyle(tone(change))
                    if let percent = model.allTimePercent {
                        Text("(" + signedPercent(percent) + ")").font(.footnote)
                    }
                }.font(.headline).foregroundStyle(tone(change))
            }
        }
    }
    private func assetBars(_ data: OpenAPI.NetWorthResponse) -> some View {
        let assets = model.assets ?? 0
        let debt = model.debt ?? 0
        let scale = max(assets, debt, 1)
        return VStack(alignment: .leading, spacing: 16) {
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
                Text(strings.t(key)).foregroundStyle(theme.secondaryLabel)
                Spacer()
                if value <= Decimal(string: "0.005")! {
                    Text("—")
                } else {
                    MoneyText(amount: value, currency: currency, settings: settings, signed: false, colored: false)
                }
            }
            .font(.footnote)
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
    private func accountRow(_ row: NetWorthAccountRow) -> some View {
        let threshold = Decimal(string: "0.005")!
        var details: [String] = []
        if row.accountId == nil {
            details.append(strings.t("networth.byAccount.unassignedHint"))
        } else if let type = row.type {
            // An account type the catalog lacks shows the raw type, not the key.
            let key = "accounts.type." + type
            let label = strings.t(key)
            details.append(label == key ? type : label)
        }
        if abs(row.cash) > threshold, abs(row.holdings) > threshold {
            details.append(strings.t("networth.byAccount.cash") + " " + money(row.cash))
            details.append(strings.t("networth.byAccount.holdings") + " " + money(row.holdings))
        }
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.label ?? strings.t("networth.byAccount.unassigned"))
                    .font(.callout.weight(.medium))
                if !details.isEmpty {
                    Text(details.joined(separator: " · "))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                }
            }
            Spacer()
            if row.accountId == nil {
                Button(strings.t("networth.byAccount.assign")) { shell.navigate(to: "/portfolio") }
                    .buttonStyle(.visionLink)
                    .font(.footnote.weight(.medium))
            }
            MoneyText(amount: row.total, currency: currency, settings: settings, signed: false, colored: false)
                .font(.callout.weight(.medium))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
    @ViewBuilder private func accounts(_ data: OpenAPI.NetWorthResponse) -> some View {
        AdminCard(padding: VisionPageLayout.padding) {
            Text(strings.t("networth.byAccount.title")).font(Font.visionTitle3)
            Text(strings.t("networth.byAccount.description")).foregroundStyle(theme.secondaryLabel)
            if let rows = model.accountRows, let total = model.accountsTotal {
                if rows.isEmpty { Text(strings.t("networth.byAccount.none")) }
                // The web's inset list: one bordered surface, hairlines between compact rows.
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        if index > 0 { Divider() }
                        accountRow(row)
                    }
                }
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                        .fill(theme.foreground.opacity(0.02)))
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                        .strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
                let difference = NetWorthAccountRow.cents(total - data.current.netWorth)
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(strings.t("networth.byAccount.displayedTotal")).fontWeight(.medium)
                        Text(
                            abs(difference) < Decimal(string: "0.005")!
                                ? strings.t("networth.byAccount.matches")
                                : strings.t(difference > 0 ? "networth.byAccount.above" : "networth.byAccount.below")
                                    + " " + money(abs(difference))
                        )
                        .font(.footnote).foregroundStyle(
                            abs(difference) < Decimal(string: "0.005")! ? theme.secondaryLabel : theme.warning)
                    }
                    Spacer()
                    MoneyText(amount: total, currency: currency, settings: settings, signed: false, colored: false)
                        .fontWeight(.medium)
                }
                .padding(.vertical, 6).padding(.horizontal, 8)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.control).fill(theme.foreground.opacity(0.02)))
                if abs(difference) >= Decimal(string: "0.005")! {
                    Text(strings.t("networth.byAccount.differenceHint")).font(.footnote).foregroundStyle(
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
        AdminCard(padding: VisionPageLayout.padding) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(strings.t("networth.overTime")).font(Font.visionTitle3)
                    Text(strings.t("networth.chartDesc")).font(.callout).foregroundStyle(theme.secondaryLabel)
                }
                Spacer()
                VisionSegmentedControl(
                    selection: Binding(
                        get: { model.period },
                        set: { value in
                            model.period = value
                            model.selection = nil
                            model.rangeStart = nil
                            shell.replaceQuery("period", with: value == .year ? nil : value.rawValue)
                        }),
                    values: NetWorthPeriod.allCases, title: { strings.t("performance.period." + $0.rawValue) },
                    size: .sm, compact: true
                )
                .fixedSize()
                .accessibilityLabel(strings.t("networth.overTime"))
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
                    return InsightChartPoint(key: snapshot.date.description, value: value)
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
                .buttonStyle(.visionOutline)
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
        AdminCard(padding: 20) {
            HStack {
                Text(strings.t(key)).fontWeight(.medium).foregroundStyle(theme.secondaryLabel)
                Spacer()
                Image(systemName: symbol).foregroundStyle(theme.tertiaryLabel).accessibilityHidden(true)
            }
            RollingNumber(value: value, decimalSeparator: settings.numberFormat.locale.decimalSeparator?.first)
                .font(Font.visionTitle1)
        }
    }
    private func signedPercent(_ value: Decimal) -> String {
        (value > 0 ? "+" : "") + VisionFormat.percent(value, locale: settings.numberFormat.locale)
    }
    private func tick(_ day: String) -> String {
        let parser = FormatterCache.shared("netWorth.day") {
            () -> DateFormatter in
            let made = DateFormatter()
            made.locale = Locale(identifier: "en_US_POSIX")
            made.calendar = Calendar(identifier: .gregorian)
            made.dateFormat = "yyyy-MM-dd"
            return made
        }
        guard let date = parser.date(from: day) else { return day }
        let locale = LanguageLocale.locale(shell.strings.language)
        let format = [.month, .quarter, .halfYear].contains(model.period) ? "d MMM" : "MMM yy"
        let formatter = FormatterCache.shared("netWorth.tick|\(locale.identifier)|\(format)") {
            () -> DateFormatter in
            let made = DateFormatter()
            made.locale = locale
            made.dateFormat = format
            return made
        }
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
