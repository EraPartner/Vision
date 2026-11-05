import SwiftUI
import VisionNativeCore

struct ResearchCompareStatisticsView: View {
    let model: ResearchCompareModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    var body: some View {
        ResearchCard(title: shell.strings.t("research.compare.metrics")) {
            Text(shell.strings.t("research.compare.historyHint")).font(.callout).foregroundStyle(theme.secondaryLabel)
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 14) {
                    GridRow {
                        Text(shell.strings.t("research.compare.symbol"))
                        Text(shell.strings.t("research.compare.return")).gridColumnAlignment(.trailing)
                        Text(shell.strings.t("research.compare.volatility")).gridColumnAlignment(.trailing)
                        Text(shell.strings.t("research.compare.maxDrawdown")).gridColumnAlignment(.trailing)
                    }.font(.caption.weight(.medium)).foregroundStyle(theme.secondaryLabel)
                    ForEach(Array(model.state.symbols.enumerated()), id: \.element) { index, symbol in
                        let stats = model.presentation?.stats.first { $0.symbol == symbol }
                        GridRow {
                            VStack(alignment: .leading, spacing: 4) {
                                ResearchCompareSymbolLabel(symbol: symbol, index: index)
                                if let from = stats?.firstTime, let to = stats?.lastTime {
                                    Text(
                                        shell.strings.t(
                                            "research.compare.historyRange",
                                            [
                                                "from": ResearchCompareStyle.dateLabel(from, settings: shell.settings),
                                                "to": ResearchCompareStyle.dateLabel(to, settings: shell.settings),
                                            ])
                                    ).font(.caption).foregroundStyle(theme.secondaryLabel)
                                }
                            }
                            if let totalReturn = stats?.totalReturn {
                                DeltaPill(
                                    totalReturn,
                                    label: ResearchCompareStyle.percent(
                                        totalReturn, settings: shell.settings, signed: true))
                            } else {
                                Text(ResearchCompareStyle.percent(nil, settings: shell.settings, signed: true))
                                    .foregroundStyle(theme.secondaryLabel)
                            }
                            Text(
                                ResearchCompareStyle.percent(stats?.volatility, settings: shell.settings, signed: true))
                            Text(
                                ResearchCompareStyle.percent(stats?.maxDrawdown, settings: shell.settings, signed: true)
                            ).foregroundStyle(theme.loss)
                        }.monospacedDigit()
                    }
                }.textSelection(.enabled)
            }
        }
    }
}
struct ResearchCompareCorrelationView: View {
    let model: ResearchCompareModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    var body: some View {
        ResearchCard(title: shell.strings.t("research.compare.correlation")) {
            Text(shell.strings.t("research.compare.correlationHint")).font(.callout).foregroundStyle(
                theme.secondaryLabel)
            if model.isLoading || model.isPreparing && model.presentation == nil {
                ProgressView().frame(maxWidth: .infinity).frame(height: 160)
            } else if let data = model.presentation {
                ScrollView(.horizontal) {
                    Grid(horizontalSpacing: 6, verticalSpacing: 6) {
                        GridRow {
                            Color.clear.frame(width: 1, height: 1)
                            ForEach(Array(data.symbols.enumerated()), id: \.element) { index, symbol in
                                ResearchCompareSymbolLabel(symbol: symbol, index: index)
                            }
                        }
                        ForEach(Array(data.symbols.enumerated()), id: \.element) { index, symbol in
                            GridRow {
                                ResearchCompareSymbolLabel(symbol: symbol, index: index).gridColumnAlignment(.leading)
                                ForEach(data.symbols.indices, id: \.self) { column in
                                    let value = data.correlation[index][column]
                                    Text(ResearchCompareStyle.fixed(value)).monospacedDigit().font(.callout)
                                        .frame(minWidth: 64).padding(10)
                                        .background(heat(value), in: RoundedRectangle(cornerRadius: 7))
                                        .accessibilityLabel(
                                            symbol + " / " + data.symbols[column] + ": "
                                                + ResearchCompareStyle.fixed(value))
                                }
                            }
                        }
                    }.textSelection(.enabled)
                }
            } else {
                Text("—").foregroundStyle(theme.secondaryLabel)
            }
        }
    }
    private func heat(_ value: Decimal?) -> Color {
        guard let value else { return .clear }
        let intensity = min(abs(NSDecimalNumber(decimal: value).doubleValue), 1) * 0.32
        return (value >= 0 ? theme.gain : theme.loss).opacity(intensity)
    }
}
struct ResearchCompareFundamentalsView: View {
    let model: ResearchCompareModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    var body: some View {
        ResearchCard(title: shell.strings.t("research.compare.tabFundamentals")) {
            Text(shell.strings.t("research.compare.fundamentalsHint")).font(.callout).foregroundStyle(
                theme.secondaryLabel)
            if model.fundamentalsLoading {
                ProgressView().frame(maxWidth: .infinity).frame(height: 190)
            } else {
                ScrollView(.horizontal) {
                    Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 14) {
                        GridRow {
                            Text(shell.strings.t("research.compare.symbol"))
                            Text(shell.strings.t("research.scorecard.health"))
                            ForEach(ResearchCompareMetric.all) { metric in
                                Button {
                                    shell.replace(with: model.toggleSort(metric.id).string)
                                } label: {
                                    HStack(spacing: 5) {
                                        Text(shell.strings.t(metric.labelKey))
                                        if model.state.sort == metric.id {
                                            Image(systemName: metric.higherIsBetter ? "arrow.down" : "arrow.up")
                                        }
                                    }
                                }.buttonStyle(.plain).font(
                                    .caption.weight(model.state.sort == metric.id ? .semibold : .regular)
                                )
                                .accessibilityLabel(
                                    shell.strings.t(
                                        "research.compare.sortBy", ["metric": shell.strings.t(metric.labelKey)])
                                )
                                .accessibilityAddTraits(model.state.sort == metric.id ? .isSelected : [])
                                .gridColumnAlignment(.trailing)
                            }
                        }.font(.caption).foregroundStyle(theme.secondaryLabel)
                        ForEach(model.sortedFundamentalsSymbols, id: \.self) { symbol in
                            let index = model.state.symbols.firstIndex(of: symbol) ?? 0
                            let snapshot = model.fundamentals[symbol]
                            let unavailable = snapshot?.meta.source == "unavailable"
                            GridRow {
                                VStack(alignment: .leading, spacing: 5) {
                                    ResearchCompareSymbolLabel(symbol: symbol, index: index)
                                    if unavailable {
                                        Text(shell.strings.t("research.unavailable")).font(.caption).foregroundStyle(
                                            theme.warning)
                                    } else {
                                        ResearchProvenanceBadge(meta: snapshot?.meta, shell: shell)
                                    }
                                }
                                if let scorecard = snapshot?.data?.scorecard, scorecard.evaluated > 0 {
                                    grade(scorecard)
                                } else {
                                    Text("—").foregroundStyle(theme.secondaryLabel)
                                }
                                ForEach(ResearchCompareMetric.all) { metric in
                                    let flag =
                                        unavailable
                                        ? nil : snapshot?.data?.scorecard.flags.first { $0.metric == metric.id }
                                    let value =
                                        unavailable ? nil : snapshot?.data?.fundamentals[metric.id]?.decimalValue
                                    Text(display(value, metric: metric)).monospacedDigit()
                                        .foregroundStyle(tone(flag?.severity))
                                        .fontWeight(model.state.sort == metric.id ? .medium : .regular)
                                        .padding(.horizontal, 7).padding(.vertical, 6)
                                        .background(
                                            model.state.sort == metric.id ? theme.foreground.opacity(0.04) : .clear
                                        )
                                        .visionTooltip(flag?.reason ?? "")
                                }
                            }
                        }
                    }.textSelection(.enabled)
                }
            }
        }
    }
    private func grade(_ scorecard: ResearchScorecard) -> some View {
        HStack(spacing: 5) {
            if let score = scorecard.score { Text(VisionFormat.plain(score)).monospacedDigit() }
            Text(shell.strings.t("research.scorecard.grade." + scorecard.grade))
        }.font(.caption).foregroundStyle(gradeTone(scorecard.grade)).padding(.horizontal, 8).padding(.vertical, 5)
            .background(gradeTone(scorecard.grade).opacity(0.1), in: Capsule())
    }
    private func gradeTone(_ grade: String) -> Color {
        switch grade {
        case "strong", "healthy": theme.success
        case "mixed", "weak": theme.warning
        case "poor": theme.destructive
        default: theme.secondaryLabel
        }
    }
    private func tone(_ severity: String?) -> Color {
        switch severity {
        case "ok": theme.success
        case "caution", "warn": theme.warning
        case "risk": theme.destructive
        default: theme.foreground
        }
    }
    private func display(_ value: Decimal?, metric: ResearchCompareMetric) -> String {
        switch metric.format {
        case "pct": ResearchCompareStyle.percent(value, settings: shell.settings)
        case "largeNum": ResearchCompareStyle.compact(value)
        default: ResearchCompareStyle.fixed(value)
        }
    }
}
struct ResearchCompareSymbolLabel: View {
    let symbol: String
    let index: Int
    @Environment(\.visionTheme) private var theme
    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(ResearchCompareStyle.color(index, palette: theme.palette)).frame(width: 8, height: 8)
                .accessibilityHidden(true)
            Text(symbol).font(.callout.monospaced()).fixedSize()
        }
    }
}
