import SwiftUI
import VisionNativeCore

/// The five asset pages share actions but retain table, property and deposit layouts.
public struct PortfolioHoldingsView: View {
    let model: PortfolioModel
    let editing: PortfolioEditingModel
    let shell: NativeShellModel
    let assetClass: OpenAPI.AssetClass
    @State private var query = LocalTableQuery()
    @State private var optionalColumns = Set<String>()
    @Environment(\.visionTheme) private var theme

    /// `assetClass` is the route's segment: "stocks" and "real-estate" name the stock and real estate classes.
    public init(
        model: PortfolioModel, editing: PortfolioEditingModel, shell: NativeShellModel, assetClass route: String
    ) {
        self.model = model
        self.editing = editing
        self.shell = shell
        switch route {
        case "stocks": assetClass = .stock
        case "real-estate": assetClass = .realEstate
        default: assetClass = OpenAPI.AssetClass(rawValue: route)
        }
    }
    private var strings: any Localizing { shell.strings }
    private var prefix: String {
        switch assetClass {
        case .crypto: "crypto"
        case .metals: "metals"
        case .realEstate: "realestate"
        case .savings, .bond: "savings"
        default: "stocks"
        }
    }
    private var classes: [OpenAPI.AssetClass] {
        switch assetClass {
        case .stock, .etf: [.stock, .etf]
        case .savings, .bond: [.savings, .bond]
        default: [assetClass]
        }
    }
    private var symbol: String {
        switch assetClass {
        case .crypto: "bitcoinsign.circle"
        case .metals: "diamond"
        case .realEstate: "building.2"
        case .savings, .bond: "banknote"
        default: "chart.line.uptrend.xyaxis"
        }
    }
    private var holdings: [PortfolioHolding] { model.active.filter { classes.contains($0.assetClass) } }
    private var isUnitBased: Bool { ![.realEstate, .savings, .bond].contains(assetClass) }
    private var isRealEstate: Bool { assetClass == .realEstate }
    /// `findHoldingTotals`: the page figures are the server's totals of these classes (ADR-216).
    private var totals: PortfolioHoldingTotals { model.holdingTotals(assetClasses: classes) }
    /// RealEstatePage: a property's rent without a stored rate makes the monthly rent unavailable.
    private var missingRentRate: Bool { isRealEstate && totals.monthlyRentRateMissing }
    private var emptyKey: String {
        switch prefix {
        case "crypto": "noCrypto"
        case "metals": "noMetals"
        case "realestate": "noProperties"
        case "savings": "noAccounts"
        default: "noStocks"
        }
    }
    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VisionPageHeader(title: strings.t(prefix + ".title"), subtitle: "", symbol: symbol) {
                    if !model.isLoading {
                        Button(strings.t("addInv.title"), systemImage: "plus") {
                            editing.beginAddInvestment(allowedAssetClasses: classes)
                        }
                        .buttonStyle(.visionPrimary)
                        Menu {
                            if assetClass != .crypto {
                                Button(strings.t("portfolio.menu.exportPdf")) { shell.openPortfolioReport() }
                            }
                            Button(strings.t("nav.portfolioImport")) { shell.navigate(to: "/portfolio/import") }
                        } label: {
                            Image(systemName: "ellipsis")
                        }
                        .menuIndicator(.hidden).accessibilityLabel(strings.t("portfolio.menu"))
                    }
                }
                if model.isLoading {
                    ProgressView().frame(maxWidth: .infinity).padding(60)
                } else if let error = model.error ?? (missingRentRate ? strings.t("realestate.missingRentRate") : nil) {
                    Text(strings.t(prefix + ".pageErrorTitle")).font(.title2)
                    Text(error).foregroundStyle(theme.destructive)
                    Button(strings.t("common.retry")) { Task { await reload(force: true) } }
                } else if holdings.isEmpty {
                    AdminCard {
                        VisionEmptyState(
                            symbol: symbol, title: strings.t(prefix + "." + emptyKey),
                            description: strings.t(prefix + "." + emptyKey + "Desc")
                        ) {
                            Button(strings.t("addInv.title")) {
                                editing.beginAddInvestment(allowedAssetClasses: classes)
                            }
                            .buttonStyle(.visionPrimary)
                        }
                    }
                } else {
                    if isUnitBased { PortfolioStalePricesBanner(model: model, holdings: holdings, shell: shell) }
                    summary
                    if isUnitBased { holdingsTable } else { assetCards }
                    Text(strings.t(prefix == "metals" ? "stocks.howItWorks" : prefix + ".howItWorks"))
                        .font(.callout).foregroundStyle(theme.secondaryLabel)
                }
            }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: shell.settings.defaultCurrency + String(shell.settingsRevision)) { await reload() }
        .onChange(of: assetClass) { _, _ in
            query.clearAll()
            optionalColumns = []
        }
    }
    private func reload(force: Bool = false) async {
        await model.load(currency: shell.settings.portfolioCurrency, force: force)
    }
    private func money(_ amount: Decimal, currency: CurrencyCode? = nil, signed: Bool = false) -> String {
        MoneyText.text(
            amount, currency: currency ?? shell.settings.portfolioCurrency, settings: shell.settings, signed: signed)
    }
    private var summary: some View {
        let value = totals.totalPortfolioValue
        return AdminCard(padding: 24) {
            // The web summary: the value on the left, the figures in a grid on the right.
            HStack(alignment: .top, spacing: 32) {
            VStack(alignment: .leading, spacing: 12) {
                Text(
                    strings.t(
                        assetClass == .realEstate
                            ? "portfolio.totalValue"
                            : isUnitBased ? "portfolio.portfolioValue" : "portfolio.totalBalance")
                ).font(.caption2.weight(.medium)).tracking(1.3).textCase(.uppercase)
                    .foregroundStyle(Color(token: theme.palette.mutedForeground).opacity(0.8))
                MoneyText(
                    amount: value, currency: shell.settings.portfolioCurrency, settings: shell.settings, signed: false,
                    colored: false
                ).font(.visionLargeTitle)
                if isUnitBased { PortfolioPriceFreshnessCaption(holdings: holdings, shell: shell) }
            }
            .frame(minWidth: 220, alignment: .leading)
                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(minimum: 120), alignment: .leading), count: 3),
                    alignment: .leading, spacing: 14
                ) {
                    if isUnitBased {
                        figure("portfolio.realizedPnl", totals.totalRealizedGain, signed: true)
                        figure("portfolio.unrealizedPnl", totals.totalUnrealizedGain, signed: true)
                        if assetClass != .crypto { figure("portfolio.dividends", totals.totalDividends) }
                        figure("portfolio.feesAndTaxes", -totals.totalFeesAndTaxes)
                        // Custody fees and standalone deductions sit in the server's net return; the
                        // pages add only the income they show (crypto shows no dividends).
                        figure(
                            "portfolio.netReturn",
                            assetClass == .crypto ? totals.netReturnExcludingIncome : totals.netReturnWithDividends,
                            signed: true)
                    } else if assetClass == .realEstate {
                        figure("portfolio.appreciation", totals.totalAppreciation, signed: true)
                        figure("portfolio.rentalIncome", totals.totalIncome, signed: true)
                        Group {
                            let rent = totals.estimatedMonthlyRent
                            VStack(alignment: .leading, spacing: 5) {
                                Text(strings.t("portfolio.yield")).font(.caption).foregroundStyle(theme.tertiaryLabel)
                                Text(
                                    VisionFormat.percent(
                                        value > 0 ? rent * 12 / value * 100 : 0,
                                        digits: 1, locale: shell.settings.numberFormat.locale)
                                ).font(Font.visionTitle3).monospacedDigit()
                                Text("~" + money(rent) + strings.t("realestate.perMonth")).font(.footnote)
                                    .foregroundStyle(theme.secondaryLabel)
                            }
                        }
                        let returned = totals.totalPropertyReturn
                        figure("portfolio.totalReturn", returned, signed: true)
                        let cost = totals.totalInvested
                        let roi = cost > 0 ? returned / cost * 100 : 0
                        VStack(alignment: .leading, spacing: 5) {
                            Text(strings.t("portfolio.totalROI")).font(.caption).foregroundStyle(theme.tertiaryLabel)
                            DeltaPill(
                                roi,
                                label: VisionFormat.percent(roi, digits: 1, locale: shell.settings.numberFormat.locale))
                        }
                    } else {
                        let weightedRate = totals.valueWeightedInterestRate
                        VStack(alignment: .leading, spacing: 5) {
                            Text(strings.t("portfolio.avgInterestRate")).font(.caption).foregroundStyle(
                                theme.tertiaryLabel)
                            Text(
                                VisionFormat.percent(
                                    weightedRate, digits: 2, locale: shell.settings.numberFormat.locale)
                            ).font(Font.visionTitle3).monospacedDigit()
                        }
                        figure("portfolio.interestEarned", totals.totalIncome)
                        figure("portfolio.projectedAnnual", totals.totalProjectedAnnualInterest)
                        if totals.totalAccruedInterest > 0 {
                            figure("portfolio.accrued", totals.totalAccruedInterest)
                        }
                    }
                }
            }
        }
    }
    private func figure(_ key: String, _ amount: Decimal, signed: Bool = false) -> some View {
        let color = signed ? (amount >= 0 ? theme.gain : theme.loss) : theme.foreground
        return VStack(alignment: .leading, spacing: 3) {
            Text(strings.t(key)).font(.caption).foregroundStyle(theme.tertiaryLabel)
            MoneyText.styled(
                money(amount, signed: signed),
                decimalSeparator: shell.settings.numberFormat.locale.decimalSeparator?.first, color: color
            )
            .font(.visionDisplayHeadline).monospacedDigit()
        }
        .accessibilityElement(children: .combine)
    }
    private var holdingsTable: some View {
        let columns = tableColumns
        let keys = columns.map(\.key)
        let rows = query.apply(holdings, keys: keys, value: rawValue)
        return AdminCard(padding: 24) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(strings.t("portfolio.holdings")).font(Font.visionTitle3)
                        .accessibilityAddTraits(.isHeader)
                    Spacer()
                    Menu(strings.t("portfolio.columns")) {
                        ForEach(
                            ["avgCost", "realized", "fx", "dividends"].filter {
                                ($0 != "dividends" || assetClass != .crypto)
                                    && ($0 != "fx" || holdings.contains { $0.originalCurrency != $0.currency })
                            }, id: \.self
                        ) { key in
                            Toggle(
                                strings.t("portfolio." + (key == "fx" ? "fxPnl" : key)),
                                isOn: Binding(
                                    get: { optionalColumns.contains(key) },
                                    set: { enabled in
                                        if enabled { optionalColumns.insert(key) } else { optionalColumns.remove(key) }
                                    }))
                        }
                    }
                }
                HStack(spacing: 16) {
                    if let freshness = PortfolioPricePresentation.freshness(holdings, shell: shell) {
                        PortfolioPriceDisclosure(label: strings.t("portfolio.price"), explanation: freshness)
                            .accessibilityLabel(
                                strings.t(
                                    "portfolio.priceFreshnessLabel",
                                    [
                                        "price": strings.t("portfolio.price"), "freshness": freshness,
                                    ]))
                    }
                    if optionalColumns.contains("fx") {
                        PortfolioPriceDisclosure(
                            label: strings.t("portfolio.fxPnl"), explanation: strings.t("portfolio.fxEffect"))
                    }
                }.font(.caption).foregroundStyle(theme.secondaryLabel)
                LocalDataTable(
                    title: "", subtitle: "", columns: columns, rows: rows, totalCount: holdings.count,
                    query: $query,
                    filterValues: { key in LocalTableQuery.uniqueValues(holdings, key: key, value: rawValue) },
                    strings: strings
                ) {
                    Text(strings.t("table.noFilterResults"))
                }.rowDoubleClicked { holding in Task { await model.openDetail(id: holding.id) } }
            }
        }
    }
    private var tableColumns: [LocalDataColumn<PortfolioHolding>] {
        var result: [LocalDataColumn<PortfolioHolding>] = [
            LocalDataColumn(
                key: "name", title: strings.t("portfolio.asset"), width: 250, minWidth: 200, flexible: true,
                cell: { holding in
                    AnyView(
                        HStack(spacing: 10) {
                        Image(systemName: "chart.line.uptrend.xyaxis")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(theme.secondaryLabel)
                            .frame(width: 28, height: 28)
                            .background(
                                RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                                    .fill(theme.foreground.opacity(0.06)))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            if let symbol = holding.symbol {
                                Button(symbol) {
                                    shell.navigate(
                                        to: NativeRoute(
                                            path: "/research/market",
                                            query: [
                                                URLQueryItem(name: "symbol", value: symbol),
                                                URLQueryItem(name: "investmentId", value: String(holding.id.rawValue)),
                                            ]
                                        ).string)
                                }
                                .buttonStyle(.plain)
                                .font(.callout.weight(.semibold))
                            }
                            Button(holding.name) { Task { await model.openDetail(id: holding.id) } }.buttonStyle(.plain)
                                .font(holding.symbol == nil ? .callout.weight(.semibold) : .caption)
                                .foregroundStyle(holding.symbol == nil ? theme.foreground : theme.secondaryLabel)
                            if holding.oversold {
                                VisionBadge(text: strings.t("portfolio.oversold.label"), tone: .warning, small: true)
                            }
                        }
                        })
                }),
            LocalDataColumn(
                key: "units", title: strings.t("portfolio.units"), width: 130, minWidth: 90, alignment: .trailing,
                cell: { h in
                    AnyView(
                        Text(
                            VisionFormat.decimal(
                                h.totalUnits, fractionDigits: assetClass == .crypto ? 8 : 4,
                                locale: shell.settings.numberFormat.locale)
                        ).monospacedDigit())
                }),
        ]
        if optionalColumns.contains("avgCost") {
            result.append(
                LocalDataColumn(
                    key: "avgCost", title: strings.t("portfolio.avgCost"), width: 155, minWidth: 110,
                    alignment: .trailing,
                    cell: { h in
                        return AnyView(
                            Text(money(h.avgCostBasis, currency: h.currency)).monospacedDigit())
                    }))
        }
        result.append(
            LocalDataColumn(
                key: "price", title: strings.t("portfolio.price"), width: 150, minWidth: 120, alignment: .trailing,
                cell: { h in
                    AnyView(
                        HStack {
                            Text(money(h.currentPrice, currency: h.currency)).monospacedDigit()
                            PortfolioStalePriceIndicator(holding: h, shell: shell)
                        })
                }))
        result.append(
            LocalDataColumn(
                key: "value", title: strings.t("portfolio.value"), width: 155, minWidth: 110, alignment: .trailing,
                cell: { h in
                    AnyView(
                        Text(money(h.currentValue, currency: h.currency)).monospacedDigit())
                }))
        result.append(
            LocalDataColumn(
                key: "unrealized", title: strings.t("portfolio.unrealized"), width: 190, minWidth: 130,
                alignment: .trailing,
                cell: { h in
                    AnyView(
                        HStack(spacing: 8) {
                            Text(money(h.unrealizedGain, signed: true)).foregroundStyle(
                                h.unrealizedGain >= 0 ? theme.gain : theme.loss
                            ).monospacedDigit()
                            // `unrealizedPercentOf`: crypto keeps its total-return pill; the others show
                            // the server's unrealized percent (0 when absent).
                            let percent = assetClass == .crypto ? h.gainLossPercent : (h.unrealizedGainPercent ?? 0)
                            DeltaPill(
                                percent,
                                label: VisionFormat.percent(
                                    percent, digits: 2, locale: shell.settings.numberFormat.locale))
                        })
                }))
        if optionalColumns.contains("realized") {
            result.append(amountColumn("realized", key: "portfolio.realized", pick: { $0.realizedGain }, signed: true))
        }
        if optionalColumns.contains("fx") {
            result.append(
                LocalDataColumn(
                    key: "fx", title: strings.t("portfolio.fxPnl"), width: 160, minWidth: 120, alignment: .trailing,
                    cell: { h in
                        AnyView(
                            VStack(alignment: .trailing) {
                                Text(
                                    h.originalCurrency == h.currency
                                        ? "—" : h.fxGain.map { money($0, signed: true) } ?? "—"
                                )
                                .monospacedDigit()
                                if h.usedFallbackRate == true {
                                    PortfolioPriceDisclosure(
                                        label: "", explanation: strings.t("portfolio.fxFallbackNote"),
                                        symbol: "exclamationmark.triangle"
                                    )
                                    .foregroundStyle(theme.warning)
                                }
                            })
                    }))
        }
        if optionalColumns.contains("dividends") {
            result.append(amountColumn("dividends", key: "portfolio.dividends", pick: { $0.totalDividends }))
        }
        result.append(
            LocalDataColumn(
                key: "actions", title: "", width: 40, minWidth: 40,
                cell: { h in
                    AnyView(
                        PortfolioHoldingActionsMenu(
                            holding: h, model: model, editing: editing, shell: shell, deletePrefix: prefix))
                }))
        return result
    }
    private func amountColumn(
        _ key: String, key label: String, pick: @escaping (PortfolioHolding) -> Decimal, signed: Bool = false
    ) -> LocalDataColumn<PortfolioHolding> {
        LocalDataColumn(
            key: key, title: strings.t(label), width: 155, minWidth: 110, alignment: .trailing,
            cell: { h in
                AnyView(
                    Text(money(pick(h), signed: signed)).monospacedDigit().foregroundStyle(
                        signed ? (pick(h) >= 0 ? theme.gain : theme.loss) : theme.foreground))
            })
    }
    private func rawValue(_ h: PortfolioHolding, _ key: String) -> TableRawValue {
        switch key {
        case "name": .text(h.name + " " + (h.symbol ?? ""))
        case "units": .number(h.totalUnits)
        case "price": .number(h.currentPrice)
        case "avgCost": .number(h.avgCostBasis)
        case "value": .number(h.currentValue)
        case "unrealized": .number(h.unrealizedGain)
        case "realized": .number(h.realizedGain)
        case "fx": h.fxGain.map(TableRawValue.number) ?? .none
        case "dividends": .number(h.totalDividends)
        default: .none
        }
    }
    private var assetCards: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 390), alignment: .top)], alignment: .leading, spacing: 20) {
            ForEach(holdings) { holding in
                PortfolioAssetCard(holding: holding, model: model, editing: editing, shell: shell)
            }
        }
    }
}
