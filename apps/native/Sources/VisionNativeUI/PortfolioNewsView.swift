import SwiftUI
import VisionNativeCore

struct PortfolioNewsView: View {
    let model: PortfolioModel
    let shell: NativeShellModel
    @State private var visible = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.visionTheme) private var theme
    private var polling: Bool { visible && scenePhase == .active && model.isOnline }

    var body: some View {
        PortfolioCard(title: shell.strings.t("newsFeed.title")) {
            if !model.news.isEmpty {
                Text(shell.strings.t("newsFeed.articles", ["n": String(min(6, model.news.count))]))
                    .font(.caption).foregroundStyle(theme.secondaryLabel)
            }
            if model.news.isEmpty {
                if !model.isOnline {
                    Text(shell.strings.t("newsFeed.offline")).foregroundStyle(theme.secondaryLabel)
                } else if model.errors["news|" + model.newsSymbols.joined(separator: ",")] != nil {
                    Text(shell.strings.t("newsFeed.unableToLoad")).foregroundStyle(theme.secondaryLabel)
                } else if model.isNewsLoading {
                    ProgressView().frame(maxWidth: .infinity).padding(20)
                } else {
                    Text(shell.strings.t("newsFeed.noNews")).foregroundStyle(theme.secondaryLabel)
                }
            }
            if !model.news.isEmpty {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(model.news.prefix(6).enumerated()), id: \.offset) { _, article in
                            HStack(alignment: .top, spacing: 12) {
                                if let thumbnail = article.thumbnail.flatMap(PortfolioOverviewURL.safe) {
                                    AsyncImage(url: thumbnail) { image in
                                        image.resizable().scaledToFill()
                                    } placeholder: {
                                        Rectangle().fill(theme.muted)
                                    }
                                    .frame(width: 88, height: 60).clipped().clipShape(RoundedRectangle(cornerRadius: 6))
                                    .accessibilityHidden(true)
                                }
                                VStack(alignment: .leading, spacing: 6) {
                                    if let link = article.link.flatMap(PortfolioOverviewURL.safe) {
                                        Link(article.title ?? "—", destination: link).font(.callout.weight(.medium))
                                    } else {
                                        Text(article.title ?? "—").font(.callout.weight(.medium))
                                    }
                                    HStack {
                                        if let publisher = article.publisher { Text(publisher) }
                                        if let published = article.publishedAt { Text(relative(published)) }
                                    }.font(.caption).foregroundStyle(theme.secondaryLabel)
                                    if !article.relatedSymbols.isEmpty {
                                        Text(article.relatedSymbols.joined(separator: " · ")).font(
                                            .caption.monospaced()
                                        )
                                        .foregroundStyle(theme.secondaryLabel)
                                    }
                                }
                                Spacer(minLength: 0)
                            }.padding(.vertical, 8)
                        }
                    }
                }.frame(height: min(420, CGFloat(min(6, model.news.count)) * 100))
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
    private func relative(_ milliseconds: Decimal) -> String {
        let locale = LanguageLocale.locale(shell.strings.language)
        let formatter = FormatterCache.shared("relative.abbreviated|\(locale.identifier)") {
            () -> RelativeDateTimeFormatter in
            let made = RelativeDateTimeFormatter()
            made.locale = locale
            made.unitsStyle = .abbreviated
            return made
        }
        let seconds = NSDecimalNumber(decimal: milliseconds / 1000).doubleValue
        return formatter.localizedString(for: Date(timeIntervalSince1970: seconds), relativeTo: Date())
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
