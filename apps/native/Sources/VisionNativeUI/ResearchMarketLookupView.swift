import SwiftUI
import VisionNativeCore

public struct ResearchMarketLookupView: View {
    @Bindable var model: ResearchMarketLookupModel
    let watchlistAdd: ResearchWatchlistAddModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    @Environment(\.scenePhase) private var scenePhase
    public init(model: ResearchMarketLookupModel, watchlistAdd: ResearchWatchlistAddModel, shell: NativeShellModel) {
        self.model = model
        self.watchlistAdd = watchlistAdd
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    Label(strings.t("marketLookup.title"), systemImage: "magnifyingglass.chart.bar").font(
                        .largeTitle.weight(.semibold)
                    ).accessibilityAddTraits(.isHeader)
                    Spacer()
                    if let quote = model.quote, !model.isProviderAsset {
                        addPortfolioButton
                        Menu {
                            Button(strings.t("addWatchlist.title")) {
                                watchlistAdd.begin(
                                    prefill: .init(
                                        symbol: quote.symbol, name: quote.name ?? quote.symbol, type: quote.type,
                                        currency: quote.currency, price: quote.price),
                                    numberFormat: shell.settings.numberFormat)
                            }
                            Button(strings.t("research.mapping.button")) { Task { await model.mapping.begin() } }
                        } label: {
                            Image(systemName: "ellipsis")
                        }.accessibilityLabel(strings.t("marketLookup.menu"))
                    }
                }
                ResearchSymbolSearchView(
                    text: Binding(get: { model.search.searchText }, set: { model.search.searchText = $0 }),
                    items: model.search.items, isOpen: model.search.isOpen, isFetching: model.search.isSearching,
                    isError: model.search.error != nil, placeholder: strings.t("market.searchPlaceholder"),
                    autoFocus: true, shell: shell
                ) { item in
                    if let symbol = item.symbol { shell.navigate(to: model.selectSymbol(symbol).string) }
                }
                if let symbol = model.state.symbol {
                    ResearchCard {
                        if model.isQuoteFetching || model.isResolvingProvider {
                            ProgressView().frame(maxWidth: .infinity).frame(height: 130)
                        } else if let quote = model.quote {
                            quoteHero(quote)
                        } else {
                            Text(strings.t("market.noQuote", ["symbol": symbol])).foregroundStyle(theme.secondaryLabel)
                                .padding(.vertical, 30).frame(maxWidth: .infinity)
                        }
                    }
                    ResearchCard {
                        HStack {
                            Text(strings.t("market.priceChart")).font(.headline)
                            Spacer()
                            Picker(
                                strings.t("market.priceChart"),
                                selection: Binding(
                                    get: { model.state.range.range },
                                    set: { shell.replace(with: model.selectRange($0).string) })
                            ) {
                                ForEach(ResearchRangeOption.lookup) {
                                    Text(strings.t("research.range." + $0.range)).tag($0.range)
                                }
                            }.pickerStyle(.segmented).frame(maxWidth: 510)
                        }
                        if model.isChartFetching || model.isResolvingProvider {
                            ProgressView().frame(maxWidth: .infinity).frame(height: 320)
                        } else if let chart = model.chart, !chart.points.isEmpty {
                            ResearchMarketChartView(
                                data: chart, range: model.state.range.range, positive: (model.quote?.change ?? 0) >= 0,
                                showsVolume: !model.isProviderAsset, shell: shell)
                        } else {
                            Text(strings.t("market.noChartData")).foregroundStyle(theme.secondaryLabel).frame(
                                maxWidth: .infinity
                            ).frame(height: 320)
                        }
                    }
                    if !model.isProviderAsset {
                        if let quote = model.quote { tradingInfo(quote) }
                        ResearchCard {
                            Text(strings.t("research.details")).font(.headline)
                            Picker(
                                strings.t("research.details"),
                                selection: Binding(
                                    get: { model.state.tab }, set: { shell.replace(with: model.selectTab($0).string) })
                            ) {
                                Text(strings.t("market.fundamentals")).tag("fundamentals")
                                Text(strings.t("market.analystRatings")).tag("analyst")
                                Text(strings.t("market.latestNews")).tag("news")
                            }.pickerStyle(.segmented).frame(maxWidth: 500)
                            if model.isDetailFetching
                                && (model.state.tab == "analyst"
                                    ? model.analyst == nil
                                    : model.state.tab == "news" ? model.news == nil : model.fundamentals == nil)
                            {
                                ProgressView().frame(maxWidth: .infinity).frame(height: 180)
                            } else if model.state.tab == "analyst" {
                                ResearchMarketAnalystView(model: model, shell: shell)
                            } else if model.state.tab == "news" {
                                ResearchMarketNewsView(snapshot: model.news, shell: shell)
                            } else {
                                ResearchMarketFundamentalsView(snapshot: model.fundamentals, shell: shell)
                            }
                        }
                    }
                } else {
                    ResearchCard {
                        VStack(spacing: 8) {
                            Image(systemName: "magnifyingglass").font(.largeTitle).accessibilityHidden(true)
                            Text(strings.t("market.searchTicker")).font(.headline)
                            Text(strings.t("market.searchHint")).foregroundStyle(theme.secondaryLabel)
                        }.padding(.vertical, 50).frame(maxWidth: .infinity)
                    }
                }
            }.padding(24).frame(maxWidth: 1500, alignment: .leading).frame(maxWidth: .infinity)
        }
        .overlay(alignment: .bottom) {
            NoticeToast(notice: watchlistAdd.notice ?? actionNotice, strings: strings) {
                watchlistAdd.clearNotice($0)
                model.action.clearNotice($0)
            }
        }
        .task(id: scenePhase == .active && model.isOnline) {
            guard scenePhase == .active, model.isOnline else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
                guard !Task.isCancelled else { return }
                await model.refreshQuotes()
            }
        }
        .sheet(isPresented: Binding(get: { model.mapping.isPresented }, set: { if !$0 { model.mapping.close() } })) {
            ResearchMarketMappingSheet(model: model.mapping, shell: shell)
        }
        .sheet(isPresented: Binding(get: { model.action.isPresented }, set: { if !$0 { model.action.close() } })) {
            ResearchMarketActionSheet(model: model.action, shell: shell)
        }
        .sheet(isPresented: Binding(get: { watchlistAdd.isPresented }, set: { if !$0 { watchlistAdd.close() } })) {
            ResearchWatchlistAddSheet(model: watchlistAdd, shell: shell)
        }
    }
    private var actionNotice: ScreenNotice? {
        guard let notice = model.action.notice else { return nil }
        var variables = notice.variables
        if let type = variables["type"] { variables["type"] = strings.t("portfolio.txnType." + type) }
        return .init(id: notice.id, kind: notice.kind, key: notice.key, variables: variables, detail: notice.detail)
    }
    private var addPortfolioButton: some View {
        Button(strings.t(model.existingHolding == nil ? "portfolio.addInvestment" : "form.addTransaction.title")) {
            let date = VisionFormat.appDate(Date(), format: shell.settings.dateFormat, timeZone: .current)
            Task { await model.action.begin(notes: strings.t("addInvFromMarket.notesDefault", ["date": date])) }
        }.buttonStyle(.borderedProminent)
    }
    private func quoteHero(_ quote: ResearchQuote) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(quote.symbol).font(.title2.weight(.semibold)).monospaced()
                if let type = quote.type { Text(type).font(.caption).foregroundStyle(theme.secondaryLabel) }
                if let exchange = quote.exchange { Text(exchange).font(.caption).foregroundStyle(theme.secondaryLabel) }
                Spacer()

            }
            if let name = quote.name { Text(name).foregroundStyle(theme.secondaryLabel) }
            if let price = quote.price {
                Text(ResearchMarketDisplay.money(price, currency: quote.currency, shell: shell, digits: 2)).font(
                    .largeTitle.weight(.semibold)
                ).monospacedDigit()
            }
            HStack(spacing: 6) {
                let change = quote.change ?? 0
                Image(systemName: change >= 0 ? "arrow.up.right" : "arrow.down.right").accessibilityHidden(true)
                if let amount = quote.change {
                    Text(
                        (amount >= 0 ? "+" : "")
                            + ResearchMarketDisplay.money(amount, currency: quote.currency, shell: shell, digits: 2))
                }
                if let percentage = quote.changePercent {
                    Text(
                        "(" + (percentage >= 0 ? "+" : "")
                            + VisionFormat.percent(percentage, digits: 2, locale: shell.settings.numberFormat.locale)
                            + ")")
                }
            }.foregroundStyle((quote.change ?? 0) >= 0 ? theme.primary : theme.destructive).monospacedDigit()
            if !model.isProviderAsset {
                Text(strings.t("market.autoRefresh")).font(.caption).foregroundStyle(theme.secondaryLabel)
            }
        }
    }
    private func tradingInfo(_ quote: ResearchQuote) -> some View {
        ResearchCard(title: strings.t("market.tradingInfo")) {
            HStack(alignment: .top, spacing: 32) {
                VStack(spacing: 10) {
                    metric(
                        "market.open",
                        quote.open.map {
                            ResearchMarketDisplay.money($0, currency: quote.currency, shell: shell, digits: 2)
                        })
                    metric(
                        "market.dayHigh",
                        quote.dayHigh.map {
                            ResearchMarketDisplay.money($0, currency: quote.currency, shell: shell, digits: 2)
                        })
                    metric(
                        "market.dayLow",
                        quote.dayLow.map {
                            ResearchMarketDisplay.money($0, currency: quote.currency, shell: shell, digits: 2)
                        })
                    metric(
                        "market.prevClose",
                        quote.prevClose.map {
                            ResearchMarketDisplay.money($0, currency: quote.currency, shell: shell, digits: 2)
                        })
                }.frame(maxWidth: .infinity)
                VStack(spacing: 10) {
                    metric("market.volume", quote.volume.map { ResearchMarketDisplay.compact($0, shell: shell) })
                    metric("market.avgVolume", quote.avgVolume.map { ResearchMarketDisplay.compact($0, shell: shell) })
                    metric(
                        "market.52wRange",
                        quote.low52w.flatMap { low in
                            quote.high52w.map {
                                ResearchMarketDisplay.money(low, currency: quote.currency, shell: shell, digits: 2)
                                    + " – "
                                    + ResearchMarketDisplay.money($0, currency: quote.currency, shell: shell, digits: 2)
                            }
                        })
                }.frame(maxWidth: .infinity)
            }
        }
    }
    private func metric(_ key: String, _ value: String?) -> some View {
        HStack {
            Text(strings.t(key)).foregroundStyle(theme.secondaryLabel)
            Spacer()
            Text(value ?? "—").monospacedDigit()
        }
    }
}

enum ResearchMarketDisplay {
    @MainActor static func money(_ value: Decimal, currency: String, shell: NativeShellModel, digits: Int? = nil)
        -> String
    {
        VisionFormat.currency(
            value, code: currency, locale: shell.settings.numberFormat.locale,
            fractionDigits: digits ?? shell.settings.showDecimalPlaces)
    }
    @MainActor static func number(_ value: Decimal, shell: NativeShellModel, digits: Int? = nil) -> String {
        value.formatted(
            Decimal.FormatStyle(locale: shell.settings.numberFormat.locale).precision(
                .fractionLength(0...(digits ?? shell.settings.showDecimalPlaces))))
    }
    @MainActor static func compact(_ value: Decimal, shell: NativeShellModel) -> String {
        value.formatted(
            Decimal.FormatStyle(locale: shell.settings.numberFormat.locale).notation(.compactName).precision(
                .fractionLength(0...shell.settings.showDecimalPlaces)))
    }
    static func date(_ value: Decimal) -> Date {
        Date(timeIntervalSince1970: NSDecimalNumber(decimal: value).doubleValue / 1000)
    }
}
