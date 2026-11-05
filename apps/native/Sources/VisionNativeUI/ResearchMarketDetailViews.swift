import SwiftUI
import VisionNativeCore

struct ResearchMarketFundamentalsView: View {
    let snapshot: ResearchSnapshot<ResearchScorecardData?>?
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private typealias Metric = (key: String, label: String, format: String)
    private var groups: [(key: String, metrics: [Metric])] {
        [
            (
                "groupValuation",
                [
                    ("pe", "market.pe", "ratio"), ("forwardPE", "market.forwardPE", "ratio"),
                    ("pegRatio", "research.metric.pegRatio", "ratio"), ("priceToBook", "market.priceBook", "ratio"),
                ]
            ),
            (
                "groupProfitability",
                [
                    ("profitMargin", "research.fundamentals.profitMargin", "pct"),
                    ("grossMargin", "research.metric.grossMargin", "pct"),
                    ("operatingMargin", "research.metric.operatingMargin", "pct"),
                    ("returnOnEquity", "research.fundamentals.roe", "pct"),
                ]
            ),
            (
                "groupLeverage",
                [
                    ("debtToEquity", "research.metric.debtToEquity", "ratio"),
                    ("currentRatio", "research.metric.currentRatio", "ratio"),
                    ("quickRatio", "research.metric.quickRatio", "ratio"),
                    ("interestCoverage", "research.metric.interestCoverage", "ratio"),
                ]
            ),
            (
                "groupCashGrowth",
                [
                    ("freeCashFlow", "research.metric.freeCashFlow", "compact"),
                    ("fcfYield", "research.metric.fcfYield", "pct"),
                    ("revenueGrowth", "research.metric.revenueGrowth", "pct"),
                    ("earningsGrowth", "research.metric.earningsGrowth", "pct"),
                ]
            ),
            (
                "groupDividendSize",
                [
                    ("dividendYield", "market.divYield", "pct"), ("payoutRatio", "research.metric.payoutRatio", "pct"),
                    ("marketCap", "market.marketCap", "compact"),
                    ("revenue", "research.fundamentals.revenue", "compact"), ("eps", "market.eps", "price"),
                    ("beta", "market.beta", "ratio"),
                ]
            ),
        ]
    }
    var body: some View {
        if snapshot?.meta.source == "unavailable" || snapshot?.data == nil {
            ResearchUnavailableView(provider: snapshot?.meta.provider, shell: shell)
        } else if snapshot?.data?.fundamentals == .null {
            Text(strings.t("research.fundamentals.none")).foregroundStyle(theme.secondaryLabel).padding(.vertical, 20)
        } else if let data = snapshot?.data {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    if let sector = data.fundamentals["sector"]?.stringValue {
                        Text(sector).font(.caption).foregroundStyle(theme.secondaryLabel)
                    }
                    Spacer()
                    ResearchProvenanceBadge(meta: snapshot?.meta, shell: shell)
                }
                Text(strings.t("research.scorecard.title")).font(.headline).accessibilityAddTraits(.isHeader)
                ResearchMarketScorecardView(
                    scorecard: data.scorecard, currency: data.fundamentals["currency"]?.stringValue, shell: shell)
                ForEach(groups, id: \.key) { group in
                    let metrics = group.metrics.filter { data.fundamentals[$0.key]?.decimalValue != nil }
                    if !metrics.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(strings.t("research.fundamentals." + group.key)).font(.headline)
                                .accessibilityAddTraits(.isHeader)
                            VStack(spacing: 0) {
                                ForEach(Array(metrics.enumerated()), id: \.element.key) { index, metric in
                                    if let value = data.fundamentals[metric.key]?.decimalValue {
                                        if index > 0 { Divider().opacity(0.5) }
                                        HStack {
                                            Text(strings.t(metric.label)).foregroundStyle(theme.secondaryLabel)
                                            Spacer()
                                            Text(
                                                format(
                                                    value, as: metric.format,
                                                    currency: data.fundamentals["currency"]?.stringValue ?? "USD")
                                            ).monospacedDigit()
                                        }.padding(.horizontal, 16).padding(.vertical, 10).frame(minHeight: 40)
                                    }
                                }
                            }
                            .background(
                                theme.card.opacity(0.7),
                                in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous).stroke(
                                    theme.border.opacity(0.6)))
                        }
                    }
                }
            }
        } else {
            Text(strings.t("research.fundamentals.none")).foregroundStyle(theme.secondaryLabel).padding(.vertical, 20)
        }
    }
    private func format(_ value: Decimal, as format: String, currency: String) -> String {
        switch format {
        case "pct": VisionFormat.percent(value * 100, digits: 2, locale: shell.settings.numberFormat.locale)
        case "price": ResearchMarketDisplay.money(value, currency: currency, shell: shell, digits: 2)
        case "compact": ResearchMarketDisplay.compact(value, shell: shell)
        default: ResearchMarketDisplay.number(value, shell: shell)
        }
    }
}

struct ResearchMarketScorecardView: View {
    let scorecard: ResearchScorecard
    let currency: String?
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if scorecard.evaluated == 0 {
                Text(strings.t("research.scorecard.noData")).foregroundStyle(theme.secondaryLabel)
            } else {
                HStack {
                    Text(strings.t("research.scorecard.grade." + scorecard.grade)).font(.headline)
                    if let score = scorecard.score {
                        Text(ResearchMarketDisplay.number(score, shell: shell, digits: 0)).monospacedDigit()
                    }
                    Text(strings.t("research.scorecard.evaluated", ["count": String(scorecard.evaluated)])).font(
                        .caption
                    )
                    .foregroundStyle(theme.secondaryLabel)
                    Spacer()
                    ForEach(["risk", "warn", "caution"], id: \.self) { severity in
                        if let count = scorecard.counts[severity], count > 0 {
                            Text(strings.t("research.scorecard.severity." + severity) + " " + String(count)).font(
                                .caption
                            ).foregroundStyle(tone(severity))
                        }
                    }
                }
                let concerns = scorecard.flags.filter { $0.severity != "ok" }
                if concerns.isEmpty {
                    Label(strings.t("research.scorecard.allClear"), systemImage: "checkmark.circle").foregroundStyle(
                        theme.success)
                }
                ForEach(concerns) { flag in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Image(
                                systemName: flag.severity == "risk"
                                    ? "exclamationmark.octagon" : "exclamationmark.triangle"
                            ).foregroundStyle(tone(flag.severity)).accessibilityLabel(
                                strings.t("research.scorecard.severity." + flag.severity))
                            Text(strings.t("research.metric." + flag.metric)).font(.callout.weight(.medium))
                            Spacer()
                            Text(flagValue(flag)).monospacedDigit()
                        }
                        let key = "research.scorecard.reason." + flag.reasonKey
                        Text(strings.t(key) == key ? flag.reason : strings.t(key)).font(.caption).foregroundStyle(
                            theme.secondaryLabel)
                        Text(strings.t("research.scorecard.benchmark", ["value": localizedBenchmark(flag.benchmark)]))
                            .font(.caption).foregroundStyle(theme.secondaryLabel)
                    }.padding(.vertical, 7)
                }
            }
        }
    }
    private func tone(_ severity: String) -> Color {
        severity == "risk" ? theme.destructive : severity == "ok" ? theme.success : theme.warning
    }
    private func flagValue(_ flag: ResearchScorecardFlag) -> String {
        if flag.benchmark.contains("%") {
            return VisionFormat.percent(
                flag.value * 100, digits: shell.settings.showDecimalPlaces, locale: shell.settings.numberFormat.locale)
        }
        if flag.metric == "freeCashFlow", let currency {
            return ResearchMarketDisplay.money(flag.value, currency: currency, shell: shell)
        }
        return ResearchMarketDisplay.number(flag.value, shell: shell)
    }
    private func localizedBenchmark(_ text: String) -> String {
        guard let expression = try? NSRegularExpression(pattern: "-?[0-9]+(?:\\.[0-9]+)?") else { return text }
        var result = text
        for match in expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            guard let range = Range(match.range, in: result),
                let value = Decimal(string: String(result[range]), locale: Locale(identifier: "en_US_POSIX"))
            else { continue }
            result.replaceSubrange(range, with: ResearchMarketDisplay.number(value, shell: shell, digits: 3))
        }
        return result
    }
}

struct ResearchMarketAnalystView: View {
    let model: ResearchMarketLookupModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private let ratings = ["strongBuy", "buy", "hold", "sell", "strongSell"]
    var body: some View {
        if model.analyst?.meta.source == "unavailable" {
            ResearchUnavailableView(provider: model.analyst?.meta.provider, shell: shell)
        } else if let data = model.analyst?.data, let presentation = model.analystPresentation {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text(strings.t(presentation["verdictKey"]?.stringValue ?? "research.analyst.none")).font(
                        .title3.weight(.semibold)
                    ).foregroundStyle(verdictTone(presentation["tone"]?.stringValue))
                    let total = presentation["total"]?.decimalValue ?? 0
                    Text(
                        strings.t(
                            total == 1 ? "market.analystCount" : "market.analystCountPlural",
                            ["n": ResearchMarketDisplay.number(total, shell: shell, digits: 0)])
                    ).font(.caption).foregroundStyle(theme.secondaryLabel)
                    Spacer()
                    ResearchProvenanceBadge(meta: model.analyst?.meta, shell: shell)
                }
                ForEach(Array(ratings.enumerated()), id: \.element) { index, rating in
                    HStack {
                        Text(strings.t("market." + rating)).frame(width: 110, alignment: .leading)
                        GeometryReader { geometry in
                            RoundedRectangle(cornerRadius: 3).fill(theme.foreground.opacity(0.04))
                            RoundedRectangle(cornerRadius: 3).fill(ratingTone(index)).frame(
                                width: geometry.size.width
                                    * CGFloat(
                                        NSDecimalNumber(decimal: presentation["fractions"]?[rating]?.decimalValue ?? 0)
                                            .doubleValue))
                        }.frame(height: 12)
                        Text(
                            ResearchMarketDisplay.number(
                                data.consensus?.raw[rating]?.decimalValue ?? 0, shell: shell, digits: 0)
                        ).monospacedDigit().frame(width: 40, alignment: .trailing)
                    }
                }
                HStack {
                    target("targetLow", data.targetLow)
                    target("targetMean", data.targetMean)
                    target("targetHigh", data.targetHigh)
                }
                if !data.recentActions.isEmpty {
                    Text(strings.t("market.recentActions")).font(.headline)
                    ForEach(Array(data.recentActions.enumerated()), id: \.offset) { _, action in
                        HStack {
                            Image(
                                systemName: ["up", "upgrade"].contains(action.action ?? "")
                                    ? "arrow.up.right"
                                    : ["down", "downgrade"].contains(action.action ?? "")
                                        ? "arrow.down.right" : "arrow.up.arrow.down"
                            ).foregroundStyle(
                                ["up", "upgrade"].contains(action.action ?? "")
                                    ? theme.success
                                    : ["down", "downgrade"].contains(action.action ?? "")
                                        ? theme.destructive : theme.secondaryLabel)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(action.firm ?? "—")
                                if let raw = action.date {
                                    Text(
                                        VisionFormat.appDate(
                                            raw.stringValue ?? raw.decimalValue.map(VisionFormat.plain) ?? "",
                                            format: shell.settings.dateFormat)
                                    ).font(.caption).foregroundStyle(theme.secondaryLabel)
                                }
                            }
                            Spacer()
                            Text(
                                (action.toGrade ?? "—")
                                    + (action.fromGrade != nil && action.fromGrade != action.toGrade
                                        ? " ← " + action.fromGrade! : "")
                            ).foregroundStyle(gradeTone(action.toGrade ?? ""))
                        }.padding(.vertical, 5)
                    }
                }
            }
        } else {
            Text(strings.t("research.analyst.none")).foregroundStyle(theme.secondaryLabel).padding(.vertical, 20)
        }
    }
    @ViewBuilder private func target(_ key: String, _ value: Decimal?) -> some View {
        if let value {
            VStack(alignment: .leading, spacing: 5) {
                Text(strings.t("research.analyst." + key)).font(.caption).foregroundStyle(theme.secondaryLabel)
                Text(
                    model.quote.map { ResearchMarketDisplay.money(value, currency: $0.currency, shell: shell) }
                        ?? ResearchMarketDisplay.number(value, shell: shell, digits: 3)
                ).monospacedDigit()
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func verdictTone(_ tone: String?) -> Color {
        tone == "success" ? theme.success : tone == "destructive" ? theme.destructive : theme.warning
    }
    private func ratingTone(_ index: Int) -> Color {
        index < 2
            ? theme.success.opacity(index == 0 ? 1 : 0.6)
            : index == 2 ? theme.warning : theme.destructive.opacity(index == 4 ? 1 : 0.6)
    }
    private func gradeTone(_ text: String) -> Color {
        let text = text.lowercased()
        if ["buy", "outperform", "overweight", "accumulate"].contains(where: text.contains) { return theme.success }
        if ["sell", "underperform", "underweight", "reduce"].contains(where: text.contains) {
            return theme.destructive
        }
        return theme.warning
    }
}

struct ResearchMarketNewsView: View {
    @Environment(\.openURL) private var openURL
    let snapshot: ResearchSnapshot<ResearchNewsData>?
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    var body: some View {
        if snapshot?.meta.source == "unavailable" {
            ResearchUnavailableView(provider: snapshot?.meta.provider, shell: shell)
        } else if let data = snapshot?.data, !data.articles.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Spacer()
                    ResearchProvenanceBadge(meta: snapshot?.meta, shell: shell)
                }
                ForEach(Array(data.articles.enumerated()), id: \.offset) { _, article in
                    let url = article.link.flatMap(ResearchURLs.article)
                    Button {
                        if let url { openURL(url) }
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            if let image = article.thumbnail.flatMap(ResearchURLs.image) {
                                ResearchMarketNewsThumbnail(url: image)
                            } else {
                                Image(systemName: "newspaper").frame(width: 27, height: 27).foregroundStyle(
                                    theme.secondaryLabel
                                ).accessibilityHidden(true)
                            }
                            VStack(alignment: .leading, spacing: 5) {
                                Text(article.title ?? "—").multilineTextAlignment(.leading).foregroundStyle(
                                    theme.foreground)
                                HStack {
                                    if let publisher = article.publisher { Text(publisher) }
                                    if let timestamp = article.publishedAt, timestamp != 0 {
                                        Text(
                                            VisionFormat.appDate(
                                                ResearchMarketDisplay.date(timestamp),
                                                format: shell.settings.dateFormat, timeZone: .current))
                                    }
                                }.font(.caption).foregroundStyle(theme.secondaryLabel)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            if url != nil {
                                Image(systemName: "arrow.up.right.square").foregroundStyle(theme.secondaryLabel)
                                    .accessibilityHidden(true)
                            }
                        }
                    }.buttonStyle(.plain).disabled(url == nil)
                }
            }
        } else {
            Text(shell.strings.t("market.noNews")).foregroundStyle(theme.secondaryLabel).padding(.vertical, 20)
        }
    }
}

private struct ResearchMarketNewsThumbnail: View {
    let url: URL
    @Environment(\.visionTheme) private var theme
    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFill().frame(width: 28, height: 28).clipped().clipShape(
                    RoundedRectangle(cornerRadius: 5))
            case .empty: RoundedRectangle(cornerRadius: 5).fill(theme.muted).frame(width: 28, height: 28)
            case .failure: EmptyView()
            @unknown default: EmptyView()
            }
        }.accessibilityHidden(true)
    }
}
