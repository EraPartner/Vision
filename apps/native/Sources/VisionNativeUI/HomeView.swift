import Charts
import SwiftUI
import VisionNativeCore

public struct HomeView: View {
    let model: HomeModel
    let shell: NativeShellModel
    @State private var customize = false
    @State private var diagnostics = false
    @State private var heroSelection: String?
    @State private var heroRange: String?
    @State private var monthSelection: String?
    @State private var monthRange: String?
    @State private var netSelection: String?
    @State private var netRange: String?
    @Environment(\.visionTheme) private var theme

    public init(model: HomeModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }
    private var currency: CurrencyCode { LedgerCurrency.display(settings) }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VisionPageHeader(title: greeting, subtitle: todayLong, symbol: "house") {
                    Menu {
                        Button(strings.t("home.customize")) { customize = true }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .menuIndicator(.hidden)
                    .accessibilityLabel(strings.t("home.menu"))
                    Button {
                        shell.transactions.requestAdd()
                    } label: {
                        Label(strings.t("form.addTransaction.title"), systemImage: "plus")
                    }
                    .buttonStyle(.visionPrimary)
                }
                if model.isLoading {
                    ProgressView().frame(maxWidth: .infinity).padding(40)
                } else if model.isFullPageError {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(model.errors["settings"] ?? model.errors["monthly"] ?? "").foregroundStyle(
                            theme.destructive)
                        Button(strings.t("common.retry")) { Task { await reload(force: true) } }
                            .buttonStyle(.visionOutline)
                    }
                } else {
                    if model.isVisible("hero") { hero }
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 320), alignment: .top)], alignment: .leading,
                        spacing: 16
                    ) {
                        if model.isVisible("attention") { attention }
                        if model.isVisible("netWorth") { netWorth }
                        if model.isVisible("upcoming") { upcoming }
                        if model.isVisible("accounts") { accounts }
                        if model.isVisible("statCards") { summary }
                    }
                    if model.isVisible("bankBalances") { bankBalances }
                    if model.isVisible("monthlyTrends") { monthlyTrends }
                    if model.isVisible("categoryPie") {
                        card("dashboard.categoryDistribution", exclusion: "categoryPie") {
                            HomeCategoryChart(
                                slices: model.categorySlices(strings: strings), strings: strings, navigate: navigate
                            )
                        }
                    }
                    if model.isVisible("cashflowComparison") { forecast }
                    if model.isVisible("recentTransactions") { recent }
                }
            }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: shell.route.string + currency.rawValue + String(shell.settingsRevision)) { await reload() }
        .onAppear {
            shell.setLeaveGuard(
                NativeLeaveGuard(
                    id: InsightsRoutes.home,
                    hasUnsavedChanges: { shell.transactions.hasUnsavedChanges },
                    discard: { shell.transactions.leaveGuard.discard() }))
        }
        .onDisappear { shell.removeLeaveGuard(id: InsightsRoutes.home) }
        .visionDialog(
            isPresented: $customize, metrics: VisionDialogMetrics(maxWidth: nil, padding: 0, spacing: 0),
            accessibilityTitle: strings.t("widgets.title")
        ) {
            HomeWidgetsSheet(model: model, strings: strings)
        }
        // `SheetContent side="right" w-full sm:max-w-2xl`: the sheet pads its own scroll area.
        .visionSideSheet(
            isPresented: $diagnostics, metrics: .sideSheet(maxWidth: 672),
            accessibilityTitle: strings.t("cashflow.diagnostics.title")
        ) {
            HomeForecastDiagnostics(model: model, settings: settings, strings: strings)
        }
        // `SheetContent sm:max-w-[470px]`, `p-0`.
        .visionSideSheet(
            isPresented: Binding(
                get: { shell.transactions.isAddPresented },
                set: { if !$0 { shell.transactions.dismissAdd() } }),
            metrics: .sideSheet(maxWidth: 470)
        ) {
            if let form = shell.transactions.addForm {
                TransactionAddSheet(model: shell.transactions, form: form, shell: shell)
            }
        }
    }

    private func reload(force: Bool = false) async {
        async let home: Void = model.appear(settings: settings, route: shell.route, force: force)
        async let pickers: Void = shell.transactions.pickers.load()
        _ = await (home, pickers)
    }
    private func navigate(_ route: String) { shell.navigate(to: route) }
    private func money(_ value: Decimal, currency code: CurrencyCode? = nil) -> String {
        MoneyText.text(value, currency: code ?? currency, settings: settings, signed: false)
    }

    private var hero: some View {
        // MonthToDateHero is a headerless card: the eyebrow is its only heading.
        card(nil) {
            if let pace = model.pace {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 24) {
                        heroReadout(pace).frame(minWidth: 240, maxWidth: 360)
                        heroPlot(pace).frame(minWidth: 320)
                    }
                    VStack(alignment: .leading, spacing: 18) {
                        heroReadout(pace)
                        heroPlot(pace)
                    }
                }
            } else {
                widgetFailure("hero")
            }
        }
    }
    private func heroReadout(_ pace: HomeSpendingPace) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(strings.t("home.spentSoFar", ["month": monthName]).uppercased())
                .font(.caption2.weight(.medium)).tracking(1.3)
                .foregroundStyle(Color(token: theme.palette.mutedForeground).opacity(0.8))
            MoneyText(
                amount: pace.current_month.total_spending, currency: currency, settings: settings,
                signed: false, colored: false
            ).font(.visionLargeTitle)
            Text(paceDescription(pace)).font(.callout).foregroundStyle(theme.secondaryLabel)
            if pace.unconvertedCount > 0 {
                Text(strings.tc("common.fxUnavailableTransactions", pace.unconvertedCount))
                    .font(.footnote).foregroundStyle(theme.warning)
            }
            HStack(alignment: .top, spacing: 12) {
                heroFigure(strings.t("home.incomeSoFar"), amount: pace.income, colored: true)
                heroFigure(strings.t("home.plannedIn"), amount: model.plannedIncoming, colored: true)
                heroFigure(strings.t("home.plannedOut"), amount: model.plannedOutgoing, colored: false)
            }.padding(.top, 8)
        }
    }
    private func heroFigure(_ label: String, amount: Decimal, colored: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption.weight(.medium)).foregroundStyle(theme.tertiaryLabel).lineLimit(1)
            MoneyText(
                amount: amount, currency: currency, settings: settings, signed: amount > 0, colored: colored
            ).font(.headline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
    private func heroPlot(_ pace: HomeSpendingPace) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HomePaceChart(pace: pace)
                .frame(height: 144)
                .accessibilityElement()
                .accessibilityLabel(strings.t("home.chart.aria"))
            HStack(spacing: 16) {
                HStack(spacing: 6) {
                    Capsule().fill(theme.primary).frame(width: 16, height: 2)
                    Text(strings.t("home.chart.thisMonth"))
                }
                HStack(spacing: 6) {
                    Path { path in
                        path.move(to: .zero)
                        path.addLine(to: CGPoint(x: 16, y: 0))
                    }
                    .stroke(Color(token: theme.palette.mutedForeground), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                    .frame(width: 16, height: 1)
                    Text(strings.t("home.chart.typical"))
                }
            }
            .font(.caption)
            .foregroundStyle(theme.secondaryLabel)
            .accessibilityHidden(true)
        }
    }
    private var monthName: String {
        let format = DateFormatter()
        format.locale =
            strings.language == .nl ? Locale(identifier: "nl_NL") : Locale(identifier: "en_US")
        format.dateFormat = "LLLL"
        return format.string(from: Date())
    }
    private func paceDescription(_ pace: HomeSpendingPace) -> String {
        if pace.current_month.total_spending <= 0 { return strings.t("home.pace.nothingYet") }
        let projected = pace.comparison.projected_monthly_total
        let typical = pace.comparison.avg_monthly_spending
        let variables = ["projected": money(projected), "diff": money(abs(projected - typical))]
        if pace.past_6_months.months_counted == 0 || typical <= 0 {
            return strings.t("home.pace.noHistory", variables)
        }
        let difference = projected - typical
        let key =
            abs(difference) < max(typical * Decimal(string: "0.03")!, 1)
            ? "even" : difference > 0 ? "over" : "under"
        return strings.t("home.pace.\(key)", variables)
    }
    private func heroSeries(_ pace: HomeSpendingPace) -> [InsightChartSeries] {
        let points = pace.cumulativeSpending
        let elapsed = max(1, pace.current_month.days_elapsed)
        let days = max(1, pace.current_month.days_in_month)
        let key: (Int) -> String = { String(format: "%02d", $0) }
        var series = [
            InsightChartSeries(
                id: "spending", label: strings.t("home.chart.thisMonth"),
                points: points.map { InsightChartPoint(key: key(Int($0.key) ?? 0), value: $0.value) }),
            InsightChartSeries(
                id: "typical", label: strings.t("home.chart.typical"),
                points: (0...days).map {
                    InsightChartPoint(
                        key: key($0),
                        value: pace.past_6_months.avg_monthly_spending * Decimal($0) / Decimal(days))
                }, dashed: true),
        ]
        if elapsed < days, let last = points.last, pace.comparison.projected_monthly_total > 0 {
            series.append(
                InsightChartSeries(
                    id: "projected", label: strings.t("dashboard.cashFlowComparison"),
                    points: [
                        InsightChartPoint(key: key(elapsed), value: last.value),
                        InsightChartPoint(key: key(days), value: pace.comparison.projected_monthly_total),
                    ], dashed: true))
        }
        return series
    }

    private var attention: some View {
        card("home.attention.title") {
            if model.needsCategory > 0 || model.matchCount > 0 || !model.staleAccounts.isEmpty {
                // The web list: one inset surface with hairline dividers and leading glyphs.
                VStack(spacing: 0) {
                    if model.needsCategory > 0 {
                        routeRow(
                            strings.tc("home.attention.needsCategory", model.needsCategory),
                            route: "/transactions?uncategorised=true", trailing: strings.t("home.attention.review"),
                            symbol: "tag")
                    }
                    if model.matchCount > 0 {
                        if model.needsCategory > 0 { Divider() }
                        routeRow(
                            strings.tc("home.attention.looksPaid", model.matchCount),
                            route: "/planned", subtitle: model.matchPayees.isEmpty ? nil : model.matchPayees.joined(separator: ", "),
                            trailing: strings.t("home.attention.confirm"), symbol: "doc.text")
                    }
                    ForEach(model.staleAccounts) { account in
                        if model.needsCategory > 0 || model.matchCount > 0 || account.id != model.staleAccounts.first?.id {
                            Divider()
                        }
                        HStack(spacing: 4) {
                            routeRow(
                                strings.t(
                                    "home.attention.stale",
                                    [
                                        "name": account.name,
                                        "date": VisionFormat.appDate(
                                            account.last_transaction, format: settings.dateFormat),
                                    ]),
                                route: "/import", trailing: strings.t("home.attention.import"),
                                symbol: "square.and.arrow.down")
                            Button {
                                Task { await model.dismissInactivity(account) }
                            } label: {
                                Image(systemName: "xmark").foregroundStyle(theme.secondaryLabel)
                            }
                            .buttonStyle(.vision(.ghost, size: .iconXs))
                            .padding(.trailing, 12)
                            .accessibilityLabel(strings.t("home.attention.dismissInactivity", ["name": account.name]))
                        }
                    }
                }
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                        .fill(theme.foreground.opacity(0.02)))
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                        .strokeBorder(theme.border.opacity(0.6)))
            }
            if model.needsCategory == 0 && model.matchCount == 0 && model.staleAccounts.isEmpty {
                Label(strings.t("home.attention.none"), systemImage: "checkmark.circle").foregroundStyle(
                    theme.secondaryLabel)
            }
            if !model.dismissedAccounts.isEmpty {
                Button(strings.t("home.attention.restoreDismissed")) {
                    Task { await model.restoreInactivity() }
                }.buttonStyle(.visionLink)
            }
        }
    }
    private var netWorth: some View {
        card("home.netWorth.title", action: ("home.netWorth.details", "/portfolio/net-worth")) {
            if let worth = model.netWorth, worth.hasData {
                MoneyText(
                    amount: worth.current.netWorth, currency: currency, settings: settings, signed: false,
                    colored: false, rolling: true
                ).font(Font.visionTitle1)
                HStack(spacing: 4) {
                    MoneyText(amount: worth.monthlyChange, currency: currency, settings: settings)
                    Text(strings.t("home.netWorth.change")).foregroundStyle(theme.secondaryLabel)
                    if worth.monthlyChangePercent != 0 {
                        Text(
                            "("
                                + VisionFormat.decimal(
                                    worth.monthlyChangePercent, fractionDigits: 1,
                                    locale: settings.numberFormat.locale) + "%)"
                        )
                        .foregroundStyle(theme.secondaryLabel)
                    }
                }.font(.footnote)
                if !(worth.unconvertedCurrencies ?? []).isEmpty {
                    Text(strings.t("accounts.totalIncomplete")).font(.footnote).foregroundStyle(theme.warning)
                }
                VStack(spacing: 10) {
                    netWorthBar(
                        "home.netWorth.assets", worth.assets, scale: max(worth.assets, worth.debt, 1),
                        color: theme.gain)
                    netWorthBar(
                        "home.netWorth.debt", worth.debt, scale: max(worth.assets, worth.debt, 1),
                        color: theme.loss)
                }.padding(.top, 4)
            } else if model.errors["netWorth"] != nil {
                widgetFailure("netWorth")
            } else {
                Text(strings.t("home.netWorth.empty")).font(.callout).foregroundStyle(theme.secondaryLabel)
                Button(strings.t("home.accounts.title")) { navigate("/accounts") }.buttonStyle(.visionLink)
            }
        }
    }
    /// NetWorthWidget's bar: the label and amount on one line over a thin rounded track.
    private func netWorthBar(_ key: String, _ amount: Decimal, scale: Decimal, color: Color) -> some View {
        VStack(spacing: 5) {
            HStack {
                Text(strings.t(key)).foregroundStyle(theme.secondaryLabel)
                Spacer()
                MoneyText(amount: amount, currency: currency, settings: settings, signed: false, colored: false)
            }.font(.footnote)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(theme.foreground.opacity(0.08))
                    Capsule().fill(color).frame(width: proxy.size.width * ratio(amount, scale: scale))
                }
            }
            .frame(height: 6)
            .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
    }
    private func ratio(_ value: Decimal, scale: Decimal) -> Double {
        NSDecimalNumber(decimal: min(1, max(0, value / scale))).doubleValue
    }
    private var upcoming: some View {
        card("home.upcoming.title", action: ("home.upcoming.all", "/planned")) {
            if model.upcomingRows.isEmpty {
                Text(strings.t("home.upcoming.none")).foregroundStyle(theme.secondaryLabel)
            }
            ForEach(model.upcomingRows, id: \.id) { payment in
                routeRow(
                    payment.recipientName ?? payment.bankAccount ?? "", route: "/planned",
                    subtitle: upcomingDay(payment.plannedDate),
                    amount: (payment.amount, payment.currency ?? currency))
            }
        }
    }
    private var accounts: some View {
        card("home.accounts.title", action: ("home.accounts.showAll", "/accounts")) {
            if model.accounts.isEmpty {
                Text(strings.t("home.accounts.none")).foregroundStyle(theme.secondaryLabel)
            }
            ForEach(model.sortedAccounts.prefix(6), id: \.id) { account in
                routeRow(
                    account.displayName ?? account.name, route: "/accounts/\(account.id.rawValue)",
                    subtitle: [
                        strings.t(HomeModel.accountTypeKey(account)),
                        AccountProvenance.text(account, settings: settings, strings: strings),
                    ]
                    .compactMap { $0 }.joined(separator: " · "),
                    trailing: "—", amount: account.computedBalance.map { ($0, account.currency) }, signed: false,
                    colored: false)
            }
        }
    }
    private var summary: some View {
        let months = Array((model.monthly?.orderedMonths ?? []).filter { $0.transaction_count > 0 }.suffix(12))
        let selected = months.first { $0.id == netSelection } ?? months.last
        let net = selected.map { $0.total_income - abs($0.total_spending) } ?? 0
        return card("dashboard.statCards", hero: net >= 0 ? .gain : .loss) {
            Text(strings.t("dashboard.stat.lastMonthNet")).font(.body.weight(.medium)).foregroundStyle(
                theme.secondaryLabel)
            MoneyText(amount: net, currency: currency, settings: settings, rolling: true).font(.visionLargeTitle)
            Text(selected?.id ?? strings.t("dashboard.stat.mostRecentMonth")).foregroundStyle(
                theme.secondaryLabel)
            if let latest = months.last, latest.total_income > 0 {
                LabeledContent(
                    strings.t("dashboard.stat.savingsRate"),
                    value:
                        VisionFormat.decimal(
                            100 * (latest.total_income - abs(latest.total_spending)) / latest.total_income,
                            fractionDigits: 1, locale: settings.numberFormat.locale) + "%")
            }
            InsightTimelineChart(
                series: [
                    InsightChartSeries(
                        id: "net", label: strings.t("dashboard.stat.lastMonthNet"),
                        points: months.map {
                            InsightChartPoint(key: $0.id, value: $0.total_income - abs($0.total_spending))
                        })
                ],
                currency: currency, settings: settings,
                title: strings.t("dashboard.stat.netTrend", ["n": String(months.count)]),
                rangeComparison: false, height: 80, selection: $netSelection, rangeStart: $netRange)
            routeRow(
                strings.t("dashboard.stat.lastMonthIncome"),
                route: InsightsRoutes.drill(
                    month: months.last, type: "income", label: strings.t("dashboard.stat.lastMonthIncome")
                ).string,
                trailing: money(months.last?.total_income ?? 0))
            routeRow(
                strings.t("dashboard.stat.lastMonthSpending"),
                route: InsightsRoutes.drill(
                    month: months.last, type: "expense", label: strings.t("dashboard.stat.lastMonthSpending")
                ).string,
                trailing: money(abs(months.last?.total_spending ?? 0)))
            routeRow(
                strings.t("dashboard.stat.totalTransactions"), route: "/transactions",
                trailing: String(model.transactionCount))
        }
    }
    private var bankBalances: some View {
        card("bankWidget.title", titleFont: .visionCardTitle) {
            if let balances = model.balances {
                LabeledContent(
                    strings.t("bankWidget.netPosition"), value: money(balances.total_net_position))
                if balances.unconvertedCount > 0 {
                    Text(strings.t("accounts.totalIncomplete")).font(.footnote).foregroundStyle(theme.warning)
                }
                ForEach(
                    model.accounts.filter {
                        $0.isActive && !AccountKinds.isHoldingsOnly($0)
                            && $0.computedBalance.map { abs($0) > Decimal(string: "0.000001")! } == true
                    }, id: \.id
                ) { account in
                    routeRow(
                        AccountKinds.label(account), route: "/accounts/\(account.id.rawValue)",
                        subtitle: AccountProvenance.text(account, settings: settings, strings: strings),
                        trailing: money(account.computedBalance ?? 0, currency: account.currency))
                    if let drift = AccountDrift.of(
                        account, today: VisionFormat.appDate(Date(), format: .isoDate), settings: settings,
                        strings: strings)
                    {
                        Text(drift.label).font(.caption).visionTooltip(strings.t(drift.tooltipKey))
                    }
                }
                InsightTimelineChart(
                    series: balances.history.keys.sorted().filter { key in
                        balances.history[key]?.contains { abs($0.balance) > Decimal(string: "0.000001")! }
                            == true
                    }.map { key in
                        let values = Dictionary(
                            (balances.history[key] ?? []).map { ($0.date, $0.balance) },
                            uniquingKeysWith: { _, last in last })
                        let label = model.accounts.first { $0.name == key }.map(AccountKinds.label) ?? key
                        return InsightChartSeries(
                            id: key, label: label,
                            points: balances.total_history.map {
                                InsightChartPoint(key: $0.date, value: values[$0.date] ?? 0)
                            })
                    }, currency: currency, settings: settings, title: strings.t("bankWidget.balanceHistory"),
                    areas: true,
                    selection: Binding(get: { model.chartSelection }, set: { model.chartSelection = $0 }),
                    rangeStart: Binding(get: { model.chartRangeStart }, set: { model.chartRangeStart = $0 }))
            } else {
                widgetFailure("bankBalances")
            }
        }
    }
    private var monthlyTrends: some View {
        card("dashboard.monthlyTrends", exclusion: "monthlyTrends") {
            let months = Array((model.monthlyData(for: "monthlyTrends")?.orderedMonths ?? []).suffix(6))
            InsightTimelineChart(
                series: [
                    InsightChartSeries(
                        id: "income", label: strings.t("monthlyTrends.income"),
                        points: months.map { InsightChartPoint(key: $0.id, value: $0.total_income) }),
                    InsightChartSeries(
                        id: "spending", label: strings.t("monthlyTrends.spending"),
                        points: months.map { InsightChartPoint(key: $0.id, value: abs($0.total_spending)) }),
                ], currency: currency, settings: settings, title: strings.t("monthlyTrends.title"),
                bars: true,
                selection: $monthSelection, rangeStart: $monthRange)
            HStack {
                LabeledContent(
                    strings.t("monthlyTrends.totalIncome"),
                    value: money(months.reduce(0) { $0 + $1.total_income }))
                LabeledContent(
                    strings.t("monthlyTrends.totalSpending"),
                    value: money(months.reduce(0) { $0 + abs($1.total_spending) }))
            }
        }
    }
    private var recent: some View {
        card(
            "dashboard.recentTransactions", action: ("home.recent.seeAll", "/transactions"),
            exclusion: "recentTransactions"
        ) {
            if model.recentRows().isEmpty {
                Text(strings.t("dashboard.recentTransactions.empty")).foregroundStyle(theme.secondaryLabel)
            }
            ForEach(model.recentRows(), id: \.id) { row in
                routeRow(
                    row.recipientName ?? row.memo ?? "", route: "/transactions?id=\(row.id.rawValue)",
                    subtitle: VisionFormat.appDate(row.transactionDate, format: settings.dateFormat),
                    amount: (row.amount, row.currency ?? currency))
            }
        }
    }
    private var forecast: some View {
        card("dashboard.cashFlowComparison") {
            HStack {
                VisionSegmentedControl(
                    selection: forecastMode,
                    options: [
                        VisionSegmentOption(value: InsightForecastOptions.Mode.month, title: strings.t("cashflow.modeMonth")),
                        VisionSegmentOption(
                            value: InsightForecastOptions.Mode.rolling, title: strings.t("cashflow.modeRolling")),
                    ]
                ).accessibilityLabel(strings.t("cashflow.modeMonth")).frame(maxWidth: 360)
                if model.forecastOptions.mode == .rolling {
                    VisionSelect(
                        selection: rollingDays,
                        options: [30, 60, 90, 180].map {
                            VisionSelectOption(
                                value: $0, title: strings.t("cashflow.windowDays", ["days": String($0)]))
                        }, accessibilityLabel: strings.t("cashflow.rollingWindow")
                    ).frame(maxWidth: 150)
                }
            }
            HStack {
                VisionSegmentedControl(
                    selection: Binding(
                        get: { model.cumulativeForecast }, set: { model.cumulativeForecast = $0 }),
                    options: [
                        VisionSegmentOption(value: true, title: strings.t("cashflow.cumulative")),
                        VisionSegmentOption(value: false, title: strings.t("cashflow.dailyNet")),
                    ]
                ).accessibilityLabel(strings.t("cashflow.cumulative")).frame(maxWidth: 260)
                Toggle(
                    strings.t("cashflow.withPlanned"),
                    isOn: Binding(
                        get: { model.forecastOptions.includePlanned },
                        set: {
                            model.forecastOptions.includePlanned = $0
                            Task { await model.loadForecast() }
                        })
                ).toggleStyle(.visionSwitch)
                Spacer()
                Button(strings.t("cashflow.diagnostics")) { diagnostics = true }
                    .buttonStyle(.vision(.outline, size: .sm))
            }
            if model.isForecastLoading {
                ProgressView().frame(height: 240)
            } else if let forecast = model.forecast {
                if forecast.unconvertedCount > 0 {
                    Text(strings.tc("common.fxUnavailableTransactions", forecast.unconvertedCount))
                        .font(.footnote).foregroundStyle(theme.warning)
                }
                InsightTimelineChart(
                    series: forecast.series(
                        cumulative: model.cumulativeForecast, visible: model.visibleMethods,
                        actualLabel: strings.t("cashflow.actualThisMonth")),
                    currency: forecast.currency, settings: settings,
                    title: strings.t("dashboard.cashFlowComparison"),
                    selection: Binding(get: { model.chartSelection }, set: { model.chartSelection = $0 }),
                    rangeStart: Binding(get: { model.chartRangeStart }, set: { model.chartRangeStart = $0 }))
                DisclosureGroup(strings.t("cashflow.compareMethods")) {
                    Text(strings.t("cashflow.compareMethodsHelp")).foregroundStyle(theme.secondaryLabel)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 190))]) {
                        // The web's fixed "This month" chip marks the actual line; it never toggles.
                        HStack(spacing: 6) {
                            Circle().fill(theme.foreground).frame(width: 8, height: 8)
                            Text(strings.t("cashflow.thisMonth"))
                        }
                        .font(.footnote)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .overlay(Capsule().strokeBorder(theme.foreground.opacity(0.4)))
                        .accessibilityElement(children: .combine)
                        // Every method stays toggleable; a failed one carries the web's Error badge.
                        ForEach(forecast.methods) { method in
                            InsightToggleButton(
                                isOn: Binding(
                                    get: { model.visibleMethods.contains(method.id) },
                                    set: { _ in model.toggleMethod(method.id) })
                            ) {
                                HStack(spacing: 6) {
                                    Text(method.label)
                                    if method.error != nil {
                                        Text(strings.t("cashflow.methodError"))
                                            .font(.caption2.weight(.semibold))
                                            .foregroundStyle(theme.destructive)
                                            .padding(.horizontal, 5).padding(.vertical, 1)
                                            .background(theme.destructive.opacity(0.15), in: Capsule())
                                    }
                                }
                            }
                        }
                    }
                }
            } else if let error = model.forecastError {
                Text(error).foregroundStyle(theme.destructive)
                Button(strings.t("common.retry")) { Task { await model.loadForecast() } }
                    .buttonStyle(.visionOutline)
            }
        }
    }
    private var forecastMode: Binding<InsightForecastOptions.Mode> {
        Binding(
            get: { model.forecastOptions.mode },
            set: { value in
                model.forecastOptions.mode = value
                model.selectedMethods = nil
                shell.replace(with: model.forecastOptions.applying(to: shell.route).string)
                Task { await model.loadForecast() }
            })
    }
    private var rollingDays: Binding<Int> {
        Binding(
            get: { model.forecastOptions.rollingDays },
            set: { value in
                model.forecastOptions.rollingDays = value
                shell.replace(with: model.forecastOptions.applying(to: shell.route).string)
                Task { await model.loadForecast() }
            })
    }

    private func widgetFailure(_ key: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error = model.errors[key] { Text(error).foregroundStyle(theme.destructive) }
            Button(strings.t("common.retry")) { Task { await reload(force: true) } }
        }
    }
    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        return strings.t(
            hour < 12
                ? "dashboard.greetingMorning"
                : hour < 18 ? "dashboard.greetingAfternoon" : "dashboard.greetingEvening")
    }
    private func upcomingDay(_ date: CalendarDay) -> String {
        let day = date.description
        let today = Date()
        if day == VisionFormat.appDate(today, format: .isoDate) {
            return strings.t("home.upcoming.today")
        }
        if let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: today),
            day == VisionFormat.appDate(tomorrow, format: .isoDate)
        {
            return strings.t("home.upcoming.tomorrow")
        }
        return VisionFormat.appDate(day, format: settings.dateFormat)
    }
    private var todayLong: String {
        let format = DateFormatter()
        format.locale =
            strings.language == .nl ? Locale(identifier: "nl_NL") : Locale(identifier: "en_US")
        format.dateStyle = .full
        return format.string(from: Date())
    }
    private func routeRow(
        _ title: String, route: String, subtitle: String? = nil, trailing: String? = nil,
        amount: (Decimal, CurrencyCode)? = nil, signed: Bool = true, colored: Bool = true, symbol: String? = nil
    ) -> some View {
        Button {
            navigate(route)
        } label: {
            HStack(alignment: .center, spacing: 10) {
                if let symbol {
                    Image(systemName: symbol).font(.system(size: 15)).foregroundStyle(theme.secondaryLabel)
                        .frame(width: 22).accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).foregroundStyle(theme.foreground)
                    if let subtitle { Text(subtitle).font(.footnote).foregroundStyle(theme.secondaryLabel) }
                }
                Spacer()
                if let amount {
                    MoneyText(
                        amount: amount.0, currency: amount.1, settings: settings, signed: signed, colored: colored
                    ).fontWeight(.medium)
                } else if let trailing {
                    Text(trailing).monospacedDigit().foregroundStyle(theme.secondaryLabel)
                }
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(theme.tertiaryLabel)
            }
            .padding(.vertical, symbol == nil ? 6 : 10)
            .padding(.horizontal, symbol == nil ? 0 : 12)
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
    private func card<Content: View>(
        _ titleKey: String?, action: (String, String)? = nil, exclusion: String? = nil, hero: TrendHue.Tone? = nil,
        titleFont: Font = Font.visionTitle3,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if titleKey != nil || action != nil || exclusion != nil {
                cardHeader(titleKey, action: action, exclusion: exclusion, titleFont: titleFont)
            }
            content()
        }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
            // NetSummaryCard: TrendHue then the hero CardSheen (ADR-172), above the card fill.
            .background {
                if let hero {
                    ZStack {
                        TrendHue(tone: hero)
                        CardSheen(tier: .hero)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
                }
            }
            .visionCardBackground()
    }
    private func cardHeader(
        _ titleKey: String?, action: (String, String)?, exclusion: String?, titleFont: Font
    ) -> some View {
            HStack {
                if let titleKey {
                    Text(strings.t(titleKey)).font(titleFont).accessibilityAddTraits(.isHeader)
                }
                Spacer()
                if let exclusion, model.hasExclusions {
                    InsightToggleButton(
                        strings.t(
                            model.graphExclusions[exclusion] != false
                                ? "exclusion.filtersActive" : "exclusion.filtersIgnored"),
                        isOn: Binding(
                            get: { model.graphExclusions[exclusion] != false },
                            set: { model.graphExclusions[exclusion] = $0 }))
                }
                if let action { Button(strings.t(action.0)) { navigate(action.1) }.buttonStyle(.visionLink) }
            }
    }
}

/// MonthToDateHero's chart: no axes or grid; the typical month as a dashed muted diagonal, the
/// projection as a faint dotted primary line, this month's running spend as a 2.5 pt primary
/// line ending in a dot. Heights follow the web's 600 × 140 view box, padded 4 × 8.
private struct HomePaceChart: View {
    let pace: HomeSpendingPace
    @Environment(\.visionTheme) private var theme

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            let points = pace.cumulativeSpending.map { (Double($0.key) ?? 0, double($0.value)) }
            let days = Double(max(pace.current_month.days_in_month, 1))
            let elapsed = Double(pace.current_month.days_elapsed)
            let typical = double(pace.past_6_months.avg_monthly_spending)
            let projected = double(pace.comparison.projected_monthly_total)
            let total = double(pace.current_month.total_spending)
            let yMax = max(total, typical, projected, 1) * 1.08
            let x = { (day: Double) in 4 + day / days * (size.width - 8) }
            let y = { (value: Double) in size.height - 8 - value / yMax * (size.height - 16) }
            let last = points.last ?? (0, 0)
            ZStack {
                if typical > 0 {
                    Path { path in
                        path.move(to: CGPoint(x: x(0), y: y(0)))
                        path.addLine(to: CGPoint(x: x(days), y: y(typical)))
                    }
                    .stroke(
                        Color(token: theme.palette.mutedForeground).opacity(0.5),
                        style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                }
                if projected > 0 && elapsed < days {
                    Path { path in
                        path.move(to: CGPoint(x: x(last.0), y: y(last.1)))
                        path.addLine(to: CGPoint(x: x(days), y: y(projected)))
                    }
                    .stroke(theme.primary.opacity(0.45), style: StrokeStyle(lineWidth: 2, dash: [2, 4]))
                }
                Path { path in
                    for (index, point) in points.enumerated() {
                        let location = CGPoint(x: x(point.0), y: y(point.1))
                        if index == 0 { path.move(to: location) } else { path.addLine(to: location) }
                    }
                }
                .stroke(theme.primary, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                Circle().fill(theme.primary).frame(width: 8, height: 8)
                    .position(x: x(last.0), y: y(last.1))
            }
        }
    }

    private func double(_ value: Decimal) -> Double { NSDecimalNumber(decimal: value).doubleValue }
}

/// `WidgetVisibilityDialog`: a switch per widget with its description, Show all / Hide all
/// on the left of the footer and Reset on the right.
private struct HomeWidgetsSheet: View {
    let model: HomeModel
    let strings: any Localizing
    @Environment(\.visionDismissDialog) private var dismiss
    @Environment(\.visionTheme) private var theme
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VisionDialogHeader(
                title: strings.t("widgets.title"), description: strings.t("widgets.description"),
                closeLabel: strings.t("common.close"), onClose: { dismiss() })
            .keyboardShortcut(.cancelAction)
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(InsightWidget.home.enumerated()), id: \.element.id) { index, widget in
                        if index > 0 { Divider() }
                        HStack(alignment: .center, spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(strings.t(widget.labelKey))
                                    .foregroundStyle(theme.foreground)
                                Text(strings.t("dashboard.widgetDescriptions.\(widget.id)"))
                                    .font(.footnote)
                                    .foregroundStyle(theme.secondaryLabel)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 8)
                            Toggle(
                                isOn: Binding(
                                    get: { model.isVisible(widget.id) },
                                    set: { value in
                                        Task { await model.setWidget(widget.id, visible: value) }
                                    })
                            ) {
                                EmptyView()
                            }
                            .toggleStyle(.visionSwitch)
                            .accessibilityLabel(strings.t(widget.labelKey))
                            .disabled(!model.widgetsLoaded || model.widgetSavePending)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                    }
                }
                .visionCardBackground()
            }
            .frame(height: 420)
            if let error = model.widgetError {
                VStack(alignment: .leading, spacing: 2) {
                    Text(strings.t("settings.saveFailed")).foregroundStyle(theme.destructive)
                    Text(error).font(.caption).foregroundStyle(theme.secondaryLabel)
                }
            }
            HStack(spacing: 8) {
                Button(strings.t("widgets.showAll")) { Task { await model.allWidgets(visible: true) } }
                    .buttonStyle(.visionOutline)
                Button(strings.t("widgets.hideAll")) { Task { await model.allWidgets(visible: false) } }
                    .buttonStyle(.visionOutline)
                Spacer(minLength: 8)
                Button {
                    Task { await model.resetWidgets() }
                } label: {
                    Label(strings.t("widgets.reset"), systemImage: "arrow.counterclockwise")
                }
                .buttonStyle(.vision(.ghost, size: .sm))
            }
            .controlSize(.small)
            .disabled(model.widgetSavePending || !model.widgetsLoaded)
        }
        .visionDialogPadding()
        .frame(width: 448)
        .foregroundStyle(theme.foreground)
    }
}
