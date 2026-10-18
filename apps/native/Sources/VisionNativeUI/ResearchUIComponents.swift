import SwiftUI
import VisionNativeCore

extension Font {
    /// `type-title-3`: `CardTitle variant="sm"`, the research cards' section titles.
    static var researchCardTitle: Font { .visionTitle3 }
}

struct ResearchCard<Content: View>: View {
    var title: String? = nil
    var titleFont: Font = .researchCardTitle
    var padding: CGFloat = 24
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) private var theme
    init(
        title: String? = nil, titleFont: Font = .researchCardTitle, padding: CGFloat = 24,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.titleFont = titleFont
        self.padding = padding
        self.content = content
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let title { Text(title).font(titleFont).accessibilityAddTraits(.isHeader) }
            content()
        }.padding(padding).frame(maxWidth: .infinity, alignment: .leading)
            .visionCardBackground()
    }
}

struct ResearchUnavailableView: View {
    let provider: String?
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    init(provider: String?, shell: NativeShellModel) {
        self.provider = provider
        self.shell = shell
    }
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "icloud.slash").accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(shell.strings.t("research.unavailable")).font(.callout.weight(.medium))
                if let provider {
                    Text(shell.strings.t("research.unavailableProvider", ["provider": provider])).font(.caption)
                }
            }
        }.foregroundStyle(theme.warning).padding(12).frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ResearchSymbolSearchView: View {
    @Binding var text: String
    let items: [ResearchSearchItem]
    let isOpen: Bool
    var isFetching = false
    var showsLoading = true
    var isUnavailable = false
    var isError = false
    var provider: String? = nil
    let placeholder: String
    var autoFocus = false
    let onEscape: (() -> Void)?
    let shell: NativeShellModel
    let onSelect: (ResearchSearchItem) -> Void
    @State private var selected: Int? = nil
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    init(
        text: Binding<String>, items: [ResearchSearchItem], isOpen: Bool, isFetching: Bool = false,
        showsLoading: Bool = true, isUnavailable: Bool = false, isError: Bool = false, provider: String? = nil,
        placeholder: String, autoFocus: Bool = false, onEscape: (() -> Void)? = nil, shell: NativeShellModel,
        onSelect: @escaping (ResearchSearchItem) -> Void
    ) {
        self._text = text
        self.items = items
        self.isOpen = isOpen
        self.isFetching = isFetching
        self.showsLoading = showsLoading
        self.isUnavailable = isUnavailable
        self.isError = isError
        self.provider = provider
        self.placeholder = placeholder
        self.autoFocus = autoFocus
        self.onEscape = onEscape
        self.shell = shell
        self.onSelect = onSelect
    }
    private var navigable: [Int] {
        items.indices.filter { !(items[$0].symbol?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) }
    }
    private var popupHeight: CGFloat {
        if isUnavailable { return provider == nil ? 70 : 110 }
        if items.isEmpty { return isFetching ? 12 : 60 }
        return min(360, CGFloat(items.count) * 54 + 12)
    }
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(theme.tertiaryLabel).accessibilityHidden(true)
            TextField(placeholder, text: $text).textFieldStyle(.plain).focused($focused)
                .accessibilityLabel(placeholder)
                .onKeyPress(.downArrow) { move(1) }
                .onKeyPress(.upArrow) { move(-1) }
                .onKeyPress(.return) {
                    guard isOpen, let selected, navigable.contains(selected) else { return .ignored }
                    onSelect(items[selected])
                    return .handled
                }
                .onKeyPress(.escape) {
                    if let onEscape {
                        onEscape()
                        return .handled
                    }
                    guard isOpen else { return .ignored }
                    selected = nil
                    text = ""
                    return .handled
                }
            if isFetching && showsLoading { ProgressView().controlSize(.small) }
        }.padding(.horizontal, 16).frame(height: 48)
            .background(theme.card, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control))
            .overlay(RoundedRectangle(cornerRadius: DesignTokens.Radius.control).stroke(theme.border))
            .overlay(alignment: .topLeading) {
                if isOpen { popup.offset(y: 54) }
            }
            .zIndex(isOpen ? 10 : 0)
            .onChange(of: text) { _, _ in selected = nil }
            .onChange(of: isOpen) { _, open in if !open { selected = nil } }
            .onChange(of: items) { _, _ in selected = nil }
            .task { if autoFocus { focused = true } }
    }
    private var popup: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if isUnavailable {
                        ResearchUnavailableView(provider: provider, shell: shell)
                    } else if items.isEmpty {
                        if !isFetching {
                            Text(shell.strings.t(isError ? "research.searchFailed" : "research.noResults")).font(
                                .callout
                            ).foregroundStyle(
                                theme.secondaryLabel
                            ).padding(12)
                        }
                    } else {
                        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                            if navigable.contains(index) {
                                Button {
                                    onSelect(item)
                                } label: {
                                    row(item, selected: selected == index)
                                }
                                .buttonStyle(.plain).id(index).onHover { hover in if hover { selected = index } }
                                .accessibilityLabel(
                                    [item.symbol, item.name, item.type, item.exchange].compactMap { $0 }.joined(
                                        separator: ", "))
                            } else {
                                row(item, selected: false)
                            }
                        }
                    }
                }.padding(6)
            }.frame(height: popupHeight)
                .background(theme.card, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card))
                .overlay(RoundedRectangle(cornerRadius: DesignTokens.Radius.card).stroke(theme.border))
                .shadow(color: .black.opacity(0.15), radius: 12, y: 6)
                .onChange(of: selected) { _, index in if let index { proxy.scrollTo(index, anchor: .center) } }
        }
    }
    private func row(_ item: ResearchSearchItem, selected: Bool) -> some View {
        HStack(spacing: 12) {
            Text(item.symbol ?? "—").font(.callout.monospaced().weight(.medium)).frame(
                minWidth: 64, alignment: .leading)
            Text(item.name ?? "").font(.callout).foregroundStyle(theme.secondaryLabel).lineLimit(1)
            Spacer(minLength: 0)
            if let type = item.type, !type.isEmpty {
                Text(type).font(.caption).padding(.horizontal, 6).padding(.vertical, 3)
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(theme.border))
            }
            if let exchange = item.exchange, !exchange.isEmpty {
                Text(exchange).font(.caption).foregroundStyle(theme.secondaryLabel)
            }
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? theme.foreground.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 8))
    }
    private func move(_ direction: Int) -> KeyPress.Result {
        guard isOpen, !isUnavailable, !navigable.isEmpty else { return .ignored }
        let current = selected.flatMap { navigable.firstIndex(of: $0) }
        let next =
            current.map { ($0 + direction + navigable.count) % navigable.count }
            ?? (direction > 0 ? 0 : navigable.count - 1)
        selected = navigable[next]
        return .handled
    }
}

struct ResearchNewsCard: View {
    let articles: [ResearchNewsArticle]
    let isLoading: Bool
    let error: String?
    let isOnline: Bool
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    init(articles: [ResearchNewsArticle], isLoading: Bool, error: String?, isOnline: Bool, shell: NativeShellModel) {
        self.articles = articles
        self.isLoading = isLoading
        self.error = error
        self.isOnline = isOnline
        self.shell = shell
    }
    var body: some View {
        ResearchCard {
            HStack {
                Text(shell.strings.t("newsFeed.title")).font(.researchCardTitle).accessibilityAddTraits(.isHeader)
                Spacer()
                if !articles.isEmpty {
                    Text(shell.strings.t("newsFeed.articles", ["n": String(min(6, articles.count))])).font(.caption)
                        .foregroundStyle(theme.secondaryLabel)
                }
            }
            if articles.isEmpty {
                if !isOnline {
                    state("newsFeed.offline", symbol: "wifi.slash")
                } else if isLoading {
                    VStack(spacing: 16) {
                        ForEach(0..<6, id: \.self) { _ in
                            HStack(spacing: 12) {
                                RoundedRectangle(cornerRadius: 6).fill(theme.muted).frame(width: 96, height: 64)
                                VStack(alignment: .leading, spacing: 8) {
                                    RoundedRectangle(cornerRadius: 3).fill(theme.muted).frame(height: 12)
                                    RoundedRectangle(cornerRadius: 3).fill(theme.muted).frame(width: 160, height: 10)
                                    RoundedRectangle(cornerRadius: 3).fill(theme.muted).frame(width: 90, height: 10)
                                }
                            }
                        }
                    }.accessibilityElement(children: .ignore).accessibilityLabel(shell.strings.t("common.loading"))
                } else {
                    state(error == nil ? "newsFeed.noNews" : "newsFeed.unableToLoad", symbol: "newspaper")
                }
            }
            if !articles.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(articles.prefix(6).enumerated()), id: \.offset) { _, article in
                            ResearchNewsRow(article: article, shell: shell)
                            Divider()
                        }
                    }
                }.frame(height: min(440, CGFloat(min(6, articles.count)) * 108))
            }
        }
    }
    private func state(_ key: String, symbol: String) -> some View {
        VisionEmptyState(symbol: symbol, title: shell.strings.t(key)) {}.padding(.vertical, 22)
    }
}

private struct ResearchNewsRow: View {
    let article: ResearchNewsArticle
    let shell: NativeShellModel
    @State private var hovered = false
    @Environment(\.visionTheme) private var theme
    init(article: ResearchNewsArticle, shell: NativeShellModel) {
        self.article = article
        self.shell = shell
    }
    var body: some View {
        Group {
            if let url = article.link.flatMap(ResearchURLs.article) {
                Link(destination: url) { content(interactive: true) }.buttonStyle(.plain)
            } else {
                content(interactive: false)
            }
        }.padding(.vertical, 10)
            .onHover { hovered = $0 }
    }
    private func content(interactive: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            if let url = article.thumbnail.flatMap(ResearchURLs.image) {
                ResearchRemoteThumbnail(url: url)
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 4) {
                    Text(article.title ?? "—").font(.callout.weight(.medium)).lineLimit(2)
                    if interactive {
                        Image(systemName: "arrow.up.right.square").font(.caption).opacity(hovered ? 0.6 : 0)
                            .accessibilityHidden(true)
                    }
                }
                HStack(spacing: 6) {
                    if let publisher = article.publisher { Text(publisher) }
                    if let milliseconds = article.publishedAt, milliseconds != 0 {
                        Image(systemName: "clock").accessibilityHidden(true)
                        Text(relative(milliseconds))
                    }
                }.font(.caption).foregroundStyle(theme.secondaryLabel)
                if !article.relatedSymbols.isEmpty {
                    Text(article.relatedSymbols.joined(separator: " · ")).font(.caption.monospaced())
                        .foregroundStyle(theme.secondaryLabel)
                }
            }
            Spacer(minLength: 0)
        }.frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6)
            .background(
                interactive && hovered ? theme.foreground.opacity(0.04) : .clear, in: RoundedRectangle(cornerRadius: 6))
    }
    private func relative(_ milliseconds: Decimal) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = LanguageLocale.locale(shell.strings.language)
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(
            for: Date(timeIntervalSince1970: NSDecimalNumber(decimal: milliseconds / 1000).doubleValue),
            relativeTo: Date())
    }
}

struct ResearchRemoteThumbnail: View {
    let url: URL
    @Environment(\.visionTheme) private var theme
    init(url: URL) { self.url = url }
    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFill().frame(width: 96, height: 64).clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            case .empty:
                RoundedRectangle(cornerRadius: 6).fill(theme.muted).frame(width: 96, height: 64)
            case .failure: EmptyView()
            @unknown default: EmptyView()
            }
        }.accessibilityHidden(true)
    }
}

struct ResearchProvenanceBadge: View {
    let meta: ResearchMeta?
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    init(meta: ResearchMeta?, shell: NativeShellModel) {
        self.meta = meta
        self.shell = shell
    }
    var body: some View {
        if let meta, meta.source != "unavailable" {
            HStack(spacing: 5) {
                Image(systemName: meta.source == "cache" ? "externaldrive" : "dot.radiowaves.left.and.right")
                    .accessibilityHidden(true)
                Text(shell.strings.t(meta.source == "cache" ? "research.source.cache" : "research.source.live"))
                if let provider = meta.provider { Text("· " + provider) }
            }.font(.caption).foregroundStyle(theme.secondaryLabel).padding(.horizontal, 7).padding(.vertical, 4)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(theme.border))
        }
    }
}

enum ResearchURLs {
    static func article(_ text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = trimmed.hasPrefix("//") ? "https:" + trimmed : trimmed
        guard let url = URL(string: candidate), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
            url.host != nil
        else { return nil }
        return url
    }
    static func image(_ text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("//") || trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") else {
            return nil
        }
        let candidate = trimmed.hasPrefix("http://") ? "https://" + trimmed.dropFirst(7) : trimmed
        return article(candidate)
    }
    static func market(_ symbol: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return "/research/market?symbol=" + (symbol.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
    }
}
