import SwiftUI
import VisionNativeCore

public struct ResearchHomeView: View {
    let model: ResearchHomeModel
    let shell: NativeShellModel
    @State private var visible = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.visionTheme) private var theme
    public init(model: ResearchHomeModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var polling: Bool { visible && scenePhase == .active && model.isOnline }
    private var locale: Locale { shell.settings.numberFormat.locale }
    public var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VisionPageHeader(
                        title: shell.strings.t("research.title"), subtitle: shell.strings.t("research.subtitle"),
                        symbol: "magnifyingglass")
                    ResearchSymbolSearchView(
                        text: Binding(get: { model.search.searchText }, set: { model.search.searchText = $0 }),
                        items: model.search.items, isOpen: model.search.isOpen,
                        isFetching: model.search.isSearching, showsLoading: false,
                        isUnavailable: model.search.meta?.source == "unavailable",
                        provider: model.search.meta?.provider,
                        placeholder: shell.strings.t("research.searchPlaceholder"), autoFocus: true, shell: shell,
                        onSelect: { item in
                            if let symbol = item.symbol { shell.navigate(to: ResearchURLs.market(symbol)) }
                        }
                    ).frame(maxWidth: 760).zIndex(10)
                    snapshot(width: geometry.size.width)
                    let wide = geometry.size.width >= 1040
                    let layout =
                        wide
                        ? AnyLayout(HStackLayout(alignment: .top, spacing: 24))
                        : AnyLayout(VStackLayout(alignment: .leading, spacing: 24))
                    layout {
                        watchlist.frame(maxWidth: .infinity)
                        ResearchNewsCard(
                            articles: model.news, isLoading: model.isNewsLoading, error: model.errors["news"],
                            isOnline: model.isOnline, shell: shell
                        ).frame(width: wide ? 380 : nil)
                    }
                }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .task(id: polling) {
            guard polling else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
                await model.refreshQuotes()
            }
        }
        .task(id: polling ? "news-active" : "news-paused") {
            guard polling else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(600)) } catch { return }
                await model.loadNews(force: true)
            }
        }
    }
    private func snapshot(width: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(shell.strings.t("research.marketSnapshot")).font(.headline).foregroundStyle(theme.secondaryLabel)
                .accessibilityAddTraits(.isHeader)
            LazyVGrid(
                columns: Array(
                    repeating: GridItem(.flexible(), spacing: 12), count: width >= 1024 ? 5 : width >= 640 ? 3 : 2),
                spacing: 12
            ) {
                ForEach(ResearchHomeModel.benchmarks, id: \.symbol) { benchmark in
                    let quote = model.benchmarkQuotes.first { $0.symbol == benchmark.symbol }
                    Button {
                        shell.navigate(to: ResearchURLs.market(benchmark.symbol))
                    } label: {
                        ResearchCard {
                            HStack(alignment: .top, spacing: 6) {
                                Text(benchmark.label).font(.caption).foregroundStyle(theme.secondaryLabel).lineLimit(1)
                                Spacer(minLength: 0)
                                if let percent = quote?.changePercent { delta(percent) }
                            }
                            Text(
                                quote?.price.map { VisionFormat.decimal($0, fractionDigits: 2, locale: locale) } ?? "—"
                            )
                            .font(.title2.weight(.semibold)).monospacedDigit()
                            if let change = quote?.change {
                                Text(
                                    (change > 0 ? "+" : "")
                                        + VisionFormat.decimal(change, fractionDigits: 2, locale: locale)
                                )
                                .font(.caption).monospacedDigit().foregroundStyle(theme.secondaryLabel)
                            }
                        }
                    }.buttonStyle(.plain).accessibilityLabel(benchmark.label)
                        .accessibilityValue(
                            [quote?.price, quote?.change, quote?.changePercent].compactMap { $0 }.map {
                                VisionFormat.decimal($0, fractionDigits: 2, locale: locale)
                            }.joined(separator: ", "))
                }
            }
        }
    }
    private var watchlist: some View {
        ResearchCard {
            HStack {
                Text(shell.strings.t("research.watchlistPreview")).font(.headline).accessibilityAddTraits(.isHeader)
                Spacer()
                if !model.watchlist.isEmpty {
                    Button {
                        shell.navigate(to: "/research/watchlist")
                    } label: {
                        Label(shell.strings.t("research.viewAll"), systemImage: "arrow.right")
                    }.buttonStyle(.borderless)
                }
            }
            if model.watchlist.isEmpty {
                VisionEmptyState(symbol: "star", title: shell.strings.t("research.watchlistEmpty")) {
                    Button(shell.strings.t("research.watchlistEmptyCta"), systemImage: "plus") {
                        shell.navigate(to: "/research/watchlist")
                    }.buttonStyle(.bordered)
                }.padding(.vertical, 28)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(model.watchlist.prefix(9).enumerated()), id: \.element.id) { _, item in
                        if let symbol = item.symbol, !symbol.isEmpty {
                            Button {
                                shell.navigate(to: ResearchURLs.market(symbol))
                            } label: {
                                watchlistRow(item)
                            }
                            .buttonStyle(.plain)
                        } else {
                            watchlistRow(item).opacity(0.6)
                        }
                        Divider()
                    }
                }
            }
        }
    }
    private func watchlistRow(_ item: ResearchWatchlistItem) -> some View {
        let quote = item.symbol.flatMap { symbol in model.watchlistQuotes.first { $0.symbol == symbol } }
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(item.symbol ?? item.name).font(.callout.monospaced().weight(.medium))
                if item.symbol != nil { Text(item.name).font(.caption).foregroundStyle(theme.secondaryLabel) }
            }
            Spacer()
            if let price = quote?.price {
                MoneyText(
                    amount: price, currency: item.currency, settings: shell.settings, signed: false, colored: false
                )
                .font(.callout)
            } else {
                Text("—").foregroundStyle(theme.tertiaryLabel)
            }
            if let percent = quote?.changePercent { delta(percent) }
            if item.symbol != nil {
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(theme.tertiaryLabel)
                    .accessibilityHidden(true)
            }
        }.padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }
    private func delta(_ value: Decimal) -> some View {
        DeltaPill(value, label: (value > 0 ? "+" : "") + VisionFormat.percent(value, digits: 2, locale: locale))
    }
}
