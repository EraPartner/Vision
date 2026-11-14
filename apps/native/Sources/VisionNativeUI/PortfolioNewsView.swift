import SwiftUI
import VisionNativeCore

struct PortfolioNewsView: View {
    let model: PortfolioModel
    let shell: NativeShellModel
    @State private var visible = false
    @Environment(\.scenePhase) private var scenePhase
    private var polling: Bool { visible && scenePhase == .active && model.isOnline && !UserPresence.shared.isAway }

    private var articles: [PortfolioNewsArticle] { Array(model.news.prefix(6)) }

    var body: some View {
        PortfolioCard(title: shell.strings.t("newsFeed.title")) {
            if !articles.isEmpty {
                VisionBadge(text: shell.strings.t("newsFeed.articles", ["n": String(articles.count)]), small: true)
            }
        } content: {
            if model.news.isEmpty {
                if !model.isOnline {
                    VisionEmptyState(
                        symbol: "wifi.slash", title: shell.strings.t("newsFeed.offline"), compact: true) {}
                } else if model.errors["news|" + model.newsSymbols.joined(separator: ",")] != nil {
                    VisionEmptyState(
                        symbol: "newspaper", title: shell.strings.t("newsFeed.unableToLoad"), compact: true) {}
                } else if model.isNewsLoading {
                    ProgressView().frame(maxWidth: .infinity).padding(20)
                } else {
                    VisionEmptyState(symbol: "newspaper", title: shell.strings.t("newsFeed.noNews"), compact: true) {}
                }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(articles.enumerated()), id: \.offset) { index, article in
                            PortfolioNewsRow(
                                article: article, last: index == articles.count - 1,
                                timeAgo: article.publishedAt.flatMap { $0 == 0 ? nil : relative($0) })
                        }
                    }
                }.frame(height: min(420, CGFloat(articles.count) * 100))
            }
        }
        .onScrollVisibilityChange(threshold: 0.1) { visible = $0 }
        .task(id: polling) {
            guard polling else { return }
            while !Task.isCancelled {
                await model.loadNews()
                do { try await Task.sleep(for: .seconds(600)) } catch { return }
            }
        }
    }
    /// `formatDistanceToNow`: `Intl.RelativeTimeFormat(numeric: "auto")` in the largest unit under
    /// its threshold, the count rounded ("3 hours ago", "yesterday").
    private func relative(_ milliseconds: Decimal) -> String {
        let locale = LanguageLocale.locale(shell.strings.language)
        let formatter = FormatterCache.shared("relative.named|\(locale.identifier)") {
            () -> RelativeDateTimeFormatter in
            let made = RelativeDateTimeFormatter()
            made.locale = locale
            made.unitsStyle = .full
            made.dateTimeStyle = .named
            return made
        }
        let diff = NSDecimalNumber(decimal: milliseconds).doubleValue - Date().timeIntervalSince1970 * 1000
        let day = 86_400_000.0
        var parts = DateComponents()
        switch abs(diff) {
        case ..<60_000: parts.second = Int((diff / 1000).rounded())
        case ..<3_600_000: parts.minute = Int((diff / 60_000).rounded())
        case ..<day: parts.hour = Int((diff / 3_600_000).rounded())
        case ..<(day * 30): parts.day = Int((diff / day).rounded())
        case ..<(day * 365): parts.month = Int((diff / (day * 30.44)).rounded())
        default: parts.year = Int((diff / (day * 365.25)).rounded())
        }
        return formatter.localizedString(from: parts)
    }
}

/// `NewsItem`: the whole row is the link, with a faint fill and the title in primary on hover and
/// an external-link glyph fading in after the title; publisher, a clock and the relative time,
/// then the related symbols as outline badges.
private struct PortfolioNewsRow: View {
    let article: PortfolioNewsArticle
    let last: Bool
    let timeAgo: String?
    @Environment(\.openURL) private var openURL
    @Environment(\.visionTheme) private var theme
    @State private var hovering = false
    private var link: URL? { article.link.flatMap(PortfolioOverviewURL.safe) }

    var body: some View {
        let hot = hovering && link != nil
        Button {
            if let link { openURL(link) }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                if let thumbnail = article.thumbnail.flatMap(PortfolioOverviewURL.safe) {
                    AsyncImage(url: thumbnail) { phase in
                        if case .success(let image) = phase {
                            image.resizable().scaledToFill().frame(width: 96, height: 64).clipped()
                                .clipShape(
                                    RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous))
                        }
                    }
                    .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 6) {
                    (Text(article.title ?? "—")
                        + (link == nil
                            ? Text(verbatim: "")
                            : Text(verbatim: " ") + Text(Image(systemName: "arrow.up.forward.square")).font(.caption)
                                .foregroundStyle(theme.foreground.opacity(hot ? 0.6 : 0))))
                        .font(.body.weight(.medium)).lineLimit(2).multilineTextAlignment(.leading)
                        .foregroundStyle(hot ? theme.primary : theme.foreground)
                    HStack(spacing: 8) {
                        if let publisher = article.publisher { Text(publisher) }
                        if let timeAgo {
                            Text(verbatim: "·").foregroundStyle(theme.tertiaryLabel).accessibilityHidden(true)
                            Label(timeAgo, systemImage: "clock").labelStyle(.titleAndIcon)
                                .imageScale(.small)
                        }
                        ForEach(article.relatedSymbols, id: \.self) { symbol in
                            VisionBadge(text: symbol, tone: .outline, small: true)
                        }
                    }.font(.caption).foregroundStyle(theme.secondaryLabel).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 12).padding(.horizontal, 8)
            .background(
                theme.foreground.opacity(hot ? 0.04 : 0),
                in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
            )
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(theme.border.opacity(0.5)).frame(height: 1) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).padding(.horizontal, -8).disabled(link == nil)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.15), value: hovering)
    }
}

enum PortfolioOverviewURL {
    static func safe(_ text: String) -> URL? {
        guard let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
            url.host != nil
        else { return nil }
        return url
    }
}
