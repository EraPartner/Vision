import SwiftUI
import VisionNativeCore

/// The five asset pages share actions but retain table, property and deposit layouts.
public struct PortfolioHoldingsView: View {
    let model: PortfolioModel
    let editing: PortfolioEditingModel
    let shell: NativeShellModel
    let assetClass: String
    @State private var query = LocalTableQuery()
    @State private var optionalColumns = Set<String>()
    @Environment(\.visionTheme) private var theme

    public init(model: PortfolioModel, editing: PortfolioEditingModel, shell: NativeShellModel, assetClass: String) {
        self.model = model
        self.editing = editing
        self.shell = shell
        self.assetClass = assetClass == "stocks" ? "stock" : assetClass == "real-estate" ? "real_estate" : assetClass
    }
    private var strings: any Localizing { shell.strings }
    private var prefix: String {
        switch assetClass {
        case "crypto": "crypto"
        case "metals": "metals"
        case "real_estate": "realestate"
        case "savings", "bond": "savings"
        default: "stocks"
        }
    }
    private var classes: [String] {
        switch assetClass {
        case "stock", "etf": ["stock", "etf"]
        case "savings", "bond": ["savings", "bond"]
        default: [assetClass]
        }
    }
    private var symbol: String {
        switch assetClass {
        case "crypto": "bitcoinsign.circle"
        case "metals": "diamond"
        case "real_estate": "building.2"
        case "savings", "bond": "banknote"
        default: "chart.line.uptrend.xyaxis"
        }
    }
    private var holdings: [PortfolioHolding] { model.active.filter { classes.contains($0.assetClass) } }
    private var isUnitBased: Bool { !["real_estate", "savings", "bond"].contains(assetClass) }
    private var isRealEstate: Bool { assetClass == "real_estate" }
    /// RealEstatePage: each property's latest rent, converted from its booking currency.
    private var rentById: [Int: Decimal?] {
        let converter = PlannedCurrencyConverter(
            rates: shell.exchangeRates.data, target: shell.settings.defaultCurrency)
        return Dictionary(
            uniqueKeysWithValues: holdings.map { holding in
                (
                    holding.id,
                    PortfolioMonthlyRent.inTarget(
                        model.rentHistory[holding.id] ?? [], originalCurrency: holding.originalCurrency,
                        convert: { converter.convert($0, from: $1) })
                )
            })
    }
    private var missingRentRate: Bool { isRealEstate && rentById.values.contains { $0 == nil } }
    private var rentKey: String { holdings.map { String($0.id) }.joined(separator: ",") }
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
                        .buttonStyle(.borderedProminent)
                        Menu {
                            if assetClass != "crypto" {
                                Button(strings.t("portfolio.menu.exportPdf")) { shell.openPortfolioReport() }
                            }
                            Button(strings.t("nav.portfolioImport")) { shell.navigate(to: "/portfolio/import") }
                        } label: {
                            Image(systemName: "ellipsis")
                        }.accessibilityLabel(strings.t("portfolio.menu"))
                    }
                }
                if model.isLoading || (isRealEstate && (model.rentLoading || (missingRentRate && shell.exchangeRates.isLoading))) {
                    ProgressView().frame(maxWidth: .infinity).padding(60)
                } else if let error = model.error ?? (isRealEstate ? model.rentError : nil) ?? (missingRentRate
                    ? strings.t("realestate.missingRentRate") : nil)
                {
                    Text(strings.t(prefix + ".pageErrorTitle")).font(.title2)
                    Text(error).foregroundStyle(theme.destructive)
                    Button(strings.t("common.retry")) {
                        Task {
                            await reload(force: true)
                            if isRealEstate {
                                await model.loadRentHistory(ids: holdings.map(\.id), force: true)
                                if missingRentRate { await shell.exchangeRates.retry() }
                            }
                        }
                    }
                } else if holdings.isEmpty {
                    AdminCard {
                        VisionEmptyState(
                            symbol: symbol, title: strings.t(prefix + "." + emptyKey),
                            description: strings.t(prefix + "." + emptyKey + "Desc")
                        ) {
                            Button(strings.t("addInv.title")) {
                                editing.beginAddInvestment(allowedAssetClasses: classes)
                            }
                            .buttonStyle(.borderedProminent)
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
        .task(id: isRealEstate ? rentKey : "") {
            guard isRealEstate, !holdings.isEmpty else { return }
            await shell.exchangeRates.appear()
            await model.loadRentHistory(ids: holdings.map(\.id))
        }
        .onChange(of: assetClass) { _, _ in
            query.clearAll()
            optionalColumns = []
        }
    }
    private func reload(force: Bool = false) async {
        await model.load(currency: shell.settings.defaultCurrency, force: force)
    }
    private func total(_ pick: (PortfolioHolding) -> Decimal) -> Decimal { holdings.reduce(0) { $0 + pick($1) } }
    private func money(_ amount: Decimal, currency: String? = nil, signed: Bool = false) -> String {
        MoneyText.text(
            amount, currency: currency ?? shell.settings.defaultCurrency, settings: shell.settings, signed: signed)
    }
    private var summary: some View {
        let value = total { $0.currentValue }
        return AdminCard(padding: 24) {
            VStack(alignment: .leading, spacing: 12) {
                Text(
                    strings.t(
                        assetClass == "real_estate"
                            ? "portfolio.totalValue"
                            : isUnitBased ? "portfolio.portfolioValue" : "portfolio.totalBalance")
                ).font(.caption2.weight(.medium)).tracking(1.3).textCase(.uppercase)
                    .foregroundStyle(Color(token: theme.palette.mutedForeground).opacity(0.8))
                MoneyText(
                    amount: value, currency: shell.settings.defaultCurrency, settings: shell.settings, signed: false,
                    colored: false
                ).font(.visionLargeTitle)
                if isUnitBased { PortfolioPriceFreshnessCaption(holdings: holdings, shell: shell) }
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 190), alignment: .leading)], alignment: .leading, spacing: 16
                ) {
                    if isUnitBased {
                        figure("portfolio.realizedPnl", total { $0.realizedGain }, signed: true)
                        figure("portfolio.unrealizedPnl", total { $0.unrealizedGain }, signed: true)
                        if assetClass != "crypto" { figure("portfolio.dividends", total { $0.totalDividends }) }
                        figure("portfolio.feesAndTaxes", -total { $0.totalFees + $0.totalTaxes })
                        figure("portfolio.netReturn", total { $0.gainLoss }, signed: true)
                    } else if assetClass == "real_estate" {
                        figure("portfolio.appreciation", total { $0.totalAppreciation }, signed: true)
                        figure("portfolio.rentalIncome", total { $0.totalIncome }, signed: true)
                        Group {
                            let rent = rentById.values.reduce(Decimal(0)) { $0 + ($1 ?? 0) }
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
                        let returned = total { $0.totalAppreciation + $0.totalIncome - $0.totalFees - $0.totalTaxes }
                        figure("portfolio.totalReturn", returned, signed: true)
                        let cost = total { $0.totalBuyCost }
                        let roi = cost > 0 ? returned / cost * 100 : 0
                        VStack(alignment: .leading, spacing: 5) {
                            Text(strings.t("portfolio.totalROI")).font(.caption).foregroundStyle(theme.tertiaryLabel)
                            DeltaPill(
                                roi,
                                label: VisionFormat.percent(roi, digits: 1, locale: shell.settings.numberFormat.locale))
                        }
                    } else {
                        let weightedRate = value > 0 ? total { $0.currentValue * $0.interestRate } / value : 0
                        VStack(alignment: .leading, spacing: 5) {
                            Text(strings.t("portfolio.avgInterestRate")).font(.caption).foregroundStyle(
                                theme.tertiaryLabel)
                            Text(
                                VisionFormat.percent(
                                    weightedRate, digits: 2, locale: shell.settings.numberFormat.locale)
                            ).font(Font.visionTitle3).monospacedDigit()
                        }
                        figure("portfolio.interestEarned", total { $0.totalIncome })
                        figure("portfolio.projectedAnnual", total { $0.projectedAnnualInterest })
                        if total({ $0.accruedInterest }) > 0 {
                            figure("portfolio.accrued", total { $0.accruedInterest })
                        }
                    }
                }
            }
        }
    }
    private func figure(_ key: String, _ amount: Decimal, signed: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t(key)).font(.caption).foregroundStyle(theme.tertiaryLabel)
            Text(money(amount, signed: signed)).font(Font.visionTitle3).monospacedDigit()
                .foregroundStyle(signed ? (amount >= 0 ? theme.gain : theme.loss) : theme.foreground)
        }
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
                                ($0 != "dividends" || assetClass != "crypto")
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
                        VStack(alignment: .leading, spacing: 3) {
                            if let symbol = holding.symbol {
                                Button(symbol) {
                                    shell.navigate(
                                        to: NativeRoute(
                                            path: "/research/market",
                                            query: [
                                                URLQueryItem(name: "symbol", value: symbol),
                                                URLQueryItem(name: "investmentId", value: String(holding.id)),
                                            ]
                                        ).string)
                                }
                                .buttonStyle(.visionLink)
                            }
                            Button(holding.name) { Task { await model.openDetail(id: holding.id) } }.buttonStyle(.plain)
                            if holding.oversold {
                                VisionBadge(text: strings.t("portfolio.oversold.label"), tone: .warning, small: true)
                            }
                        })
                }),
            LocalDataColumn(
                key: "units", title: strings.t("portfolio.units"), width: 130, minWidth: 90, alignment: .trailing,
                cell: { h in
                    AnyView(
                        Text(
                            VisionFormat.decimal(
                                h.totalUnits, fractionDigits: assetClass == "crypto" ? 8 : 4,
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
                        VStack(alignment: .trailing, spacing: 3) {
                            Text(money(h.unrealizedGain, signed: true)).foregroundStyle(
                                h.unrealizedGain >= 0 ? theme.gain : theme.loss
                            ).monospacedDigit()
                            if let percent = (assetClass == "crypto" ? h.gainLossPercent : h.unrealizedGainPercent) {
                                DeltaPill(
                                    percent,
                                    label: VisionFormat.percent(
                                        percent, digits: 2, locale: shell.settings.numberFormat.locale))
                            } else {
                                Text("—").font(.caption).monospacedDigit()
                            }
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
                PortfolioAssetCard(
                    holding: holding, model: model, editing: editing, shell: shell,
                    monthlyRent: isRealEstate ? (rentById[holding.id] ?? nil) : nil)
            }
        }
    }
}
