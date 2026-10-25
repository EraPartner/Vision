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
                // The web PageHeader: the sidebar icon tile and the title, without a subtitle.
                VisionPageHeader(title: strings.t("marketLookup.title"), subtitle: "", symbol: "chart.xyaxis.line") {
                    if let quote = model.quote, !model.isProviderAsset {
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
                        }
                        .visionMoreActionsMenu().accessibilityLabel(strings.t("marketLookup.menu"))
                        addPortfolioButton
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
                            Text(strings.t("market.priceChart")).font(.researchCardTitle)
                            Spacer()
                            VisionSegmentedControl(
                                selection: Binding(
                                    get: { model.state.range.range },
                                    set: { shell.replace(with: model.selectRange($0).string) }),
                                values: ResearchRangeOption.lookup.map(\.range),
                                title: { strings.t("research.range." + $0) }
                            ).accessibilityLabel(strings.t("market.priceChart")).frame(maxWidth: 510)
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
                            Text(strings.t("research.details")).font(.researchCardTitle)
                            VisionSegmentedControl(
                                selection: Binding(
                                    get: { model.state.tab }, set: { shell.replace(with: model.selectTab($0).string) }),
                                options: [
                                    VisionSegmentOption(value: "fundamentals", title: strings.t("market.fundamentals")),
                                    VisionSegmentOption(value: "analyst", title: strings.t("market.analystRatings")),
                                    VisionSegmentOption(value: "news", title: strings.t("market.latestNews")),
                                ]
                            ).accessibilityLabel(strings.t("research.details")).frame(maxWidth: 500)
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
                        VisionEmptyState(
                            symbol: "magnifyingglass", title: strings.t("market.searchTicker"),
                            description: strings.t("market.searchHint")
                        ) {}.padding(.vertical, 50)
                    }
                }
            }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
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
        .visionDialog(
            isPresented: Binding(get: { model.mapping.isPresented }, set: { if !$0 { model.mapping.close() } }),
            metrics: VisionDialogMetrics(maxWidth: nil, padding: 0, spacing: 0),
            accessibilityTitle: strings.t("research.mapping.title")
        ) {
            ResearchMarketMappingSheet(model: model.mapping, shell: shell)
        }
        // Presented from the screen, above the mapping dialog, as the web `AlertDialog` is. The
        // buttons decide: `remove()` reads `pendingRemoval`, so a dismissal must not clear it first.
        .visionConfirmationDialog(
            title: strings.t("research.mapping.remove"),
            message: { mapping in
                strings.t(
                    "research.mapping.removeDesc",
                    ["provider": mapping.provider, "symbol": mapping.providerSymbol ?? "—"])
            },
            item: Binding(get: { model.mapping.pendingRemoval }, set: { _ in })
        ) { _ in
            VisionDialogAction(strings.t("common.cancel"), role: .cancel) { model.mapping.pendingRemoval = nil }
            VisionDialogAction(strings.t("common.delete"), role: .destructive) {
                Task { await model.mapping.remove() }
            }
        }
        .visionDialog(
            isPresented: Binding(get: { model.action.isPresented }, set: { if !$0 { model.action.close() } }),
            metrics: VisionDialogMetrics(maxWidth: nil, padding: 0, spacing: 0)
        ) {
            ResearchMarketActionSheet(model: model.action, shell: shell)
        }
        .visionDialog(
            isPresented: Binding(get: { watchlistAdd.isPresented }, set: { if !$0 { watchlistAdd.close() } }),
            metrics: VisionDialogMetrics(maxWidth: nil, padding: 0, spacing: 0)
        ) {
            ResearchWatchlistAddSheet(model: watchlistAdd, shell: shell)
        }
    }
    private var actionNotice: ScreenNotice? {
        guard !model.action.globalNoticesAttached else { return nil }
        guard let notice = model.action.notice else { return nil }
        var variables = notice.variables
        if let type = variables["type"] { variables["type"] = strings.t("portfolio.txnType." + type) }
        return .init(id: notice.id, kind: notice.kind, key: notice.key, variables: variables, detail: notice.detail)
    }
    private var addPortfolioButton: some View {
        Button(
            strings.t(model.existingHolding == nil ? "portfolio.addInvestment" : "form.addTransaction.title"),
            systemImage: "plus"
        ) {
            let date = VisionFormat.appDate(Date(), format: shell.settings.dateFormat, timeZone: .current)
            Task { await model.action.begin(notes: strings.t("addInvFromMarket.notesDefault", ["date": date])) }
        }.buttonStyle(.visionPrimary)
    }
    private func quoteHero(_ quote: ResearchQuote) -> some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(quote.symbol).font(Font.visionTitle1).accessibilityAddTraits(
                        .isHeader)
                    if let type = quote.type, !type.isEmpty { VisionBadge(text: type, tone: .secondary, small: true) }
                    if let exchange = quote.exchange {
                        Text(exchange).font(.footnote).foregroundStyle(theme.secondaryLabel)
                    }
                }
                if let name = quote.name { Text(name).foregroundStyle(theme.secondaryLabel) }
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    if let price = quote.price {
                        Text(ResearchMarketDisplay.money(price, currency: quote.currency, shell: shell, digits: 2))
                            .font(.visionLargeTitle.monospacedDigit())
                    }
                    let changeLabel = quoteChangeLabel(quote)
                    if !changeLabel.isEmpty {
                        DeltaPill(quote.changePercent ?? quote.change ?? 0, label: changeLabel)
                    }
                }.padding(.top, 14)
            }
            Spacer(minLength: 0)
            if !model.isProviderAsset {
                Label(strings.t("market.autoRefresh"), systemImage: "clock").font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
            }
        }
    }
    private func quoteChangeLabel(_ quote: ResearchQuote) -> String {
        var parts: [String] = []
        if let amount = quote.change {
            parts.append(
                (amount >= 0 ? "+" : "")
                    + ResearchMarketDisplay.money(amount, currency: quote.currency, shell: shell, digits: 2))
        }
        if let percentage = quote.changePercent {
            parts.append(
                "(" + (percentage >= 0 ? "+" : "")
                    + VisionFormat.percent(percentage, digits: 2, locale: shell.settings.numberFormat.locale)
                    + ")")
        }
        return parts.joined(separator: " ")
    }
    private func tradingInfo(_ quote: ResearchQuote) -> some View {
        ResearchCard(title: strings.t("market.tradingInfo")) {
            // `grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-3`: two bordered lists.
            VisionResponsiveColumns(weights: [1, 1], minimumPageWidth: 700, spacing: 12) {
                VStack(spacing: 0) {
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
                        }, last: true)
                }.visionListSurface()
                VStack(spacing: 0) {
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
                        }, last: true)
                }.visionListSurface()
            }
        }
    }
    /// A `ListRow` (`min-h-10`): the label on the left, the value on the right, a hairline below
    /// every row but the last of its list.
    private func metric(_ key: String, _ value: String?, last: Bool = false) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(strings.t(key)).foregroundStyle(theme.secondaryLabel)
                Spacer()
                Text(value ?? "—").monospacedDigit().foregroundStyle(theme.foreground)
            }
            .padding(.horizontal, 16).padding(.vertical, 10).frame(minHeight: 40)
            if !last { VisionListDivider() }
        }
    }
}

enum ResearchMarketDisplay {
    @MainActor static func money(_ value: Decimal, currency: String, shell: NativeShellModel, digits: Int? = nil)
        -> String
    {
        ResearchMoney.text(
            value, currency: currency, locale: shell.settings.numberFormat.locale,
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
