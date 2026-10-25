import SwiftUI
import VisionNativeCore

struct PortfolioPerformanceWidgets: View {
    let model: PortfolioModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var data: PortfolioPerformanceData? {
        guard model.performance?.currency == shell.settings.portfolioCurrency else { return nil }
        return model.performance
    }
    var body: some View {
        if let data {
            if model.widgets.isVisible("valueChart"), data.snapshots.count > 1 {
                PortfolioCard(
                    title: shell.strings.t("performance.valueOverTime"),
                    description: shell.strings.t("performance.chartDesc", ["period": period])
                ) {
                    PortfolioSeriesChart(
                        series: valueSeries(data), title: shell.strings.t("performance.valueOverTime"),
                        currency: data.currency, shell: shell, area: true, colors: colors)
                    if hasFxNeutral(data) {
                        HStack {
                            Toggle(
                                shell.strings.t("performance.fxNeutral"),
                                isOn: Binding(
                                    get: { model.showFxNeutral },
                                    set: { shell.replaceQuery("fx_neutral", with: $0 ? "true" : nil) })
                            )
                            PortfolioInlineDisclosure(
                                label: "ⓘ", explanation: shell.strings.t("performance.fxNeutralDesc"))
                        }
                    }
                }
            }
            if model.widgets.isVisible("brokerChart"), let broker = model.brokerPerformance,
                broker.currency == data.currency, !broker.series.isEmpty, broker.dates.count > 1
            {
                PortfolioCard(
                    title: shell.strings.t("performance.byBrokerTitle"),
                    description: shell.strings.t("performance.byBrokerDescription")
                ) {
                    PortfolioSeriesChart(
                        series: brokerSeries(broker, data: data),
                        title: shell.strings.t("performance.byBrokerTitle"), currency: data.currency, shell: shell,
                        area: true)
                }
            }
            if model.widgets.isVisible("relativeChart"), data.snapshots.count > 1 {
                PortfolioCard(
                    title: shell.strings.t("performance.relativeTitle"),
                    description: shell.strings.t("performance.relativeDesc", ["period": period])
                ) {
                    PortfolioSeriesChart(
                        series: relativeSeries(data), title: shell.strings.t("performance.relativeTitle"),
                        currency: data.currency, shell: shell, percent: true, area: true, colors: colors)
                }
            }
            if model.widgets.isVisible("breakdown"), !data.snapshots.isEmpty, !data.breakdownSummary.isEmpty {
                PortfolioBreakdownView(data: data, shell: shell)
            }
        }
    }
    private var period: String { shell.strings.t("performance.period." + model.period.rawValue) }
    private var colors: [String: Color] {
        [
            "stocksEtfs": Color(token: theme.palette.chart1),
            "crypto": Color(token: theme.palette.chart2), "metals": Color(token: theme.palette.chart3),
            "inflation": Color(token: theme.palette.chart6), "fxNeutral": Color(token: theme.palette.chart7),
            "value": theme.primary,
        ]
    }
    private func hasFxNeutral(_ data: PortfolioPerformanceData) -> Bool {
        data.snapshots.contains { snapshot in
            snapshot.valueFxNeutral.map { abs($0 - snapshot.value) > Decimal(1) / 100 } ?? false
        }
    }
    private func line(
        _ id: String, _ key: String, _ data: PortfolioPerformanceData,
        dashed: Bool = false, amount: (PortfolioPerformanceSnapshot) -> Decimal?
    ) -> InsightChartSeries {
        InsightChartSeries(
            id: id, label: shell.strings.t(key),
            points: data.snapshots.compactMap { row in
                amount(row).map { InsightChartPoint(key: row.date, value: $0) }
            }, dashed: dashed)
    }
    private func valueSeries(_ data: PortfolioPerformanceData) -> [InsightChartSeries] {
        var lines = [
            line("stocksEtfs", "performance.relativeStocksEtfs", data) { $0.stocksEtfsValue },
            line("crypto", "performance.crypto", data) { $0.cryptoValue },
            line("metals", "performance.metals", data) { $0.metalsValue },
            line("inflation", "performance.inflationAdjusted", data) { $0.inflationAdjustedValue },
            line("value", "portfolio.portfolioValue", data) { $0.value },
        ]
        if model.showFxNeutral && hasFxNeutral(data) {
            lines.append(line("fxNeutral", "performance.fxNeutral", data, dashed: true) { $0.valueFxNeutral })
        }
        return lines
    }
    private func relativeSeries(_ data: PortfolioPerformanceData) -> [InsightChartSeries] {
        func rate(_ value: Decimal, _ invested: Decimal) -> Decimal { invested > 0 ? (value / invested - 1) * 100 : 0 }
        return [
            line("value", "performance.relativePortfolio", data) { rate($0.value, $0.invested) },
            line("stocksEtfs", "performance.relativeStocksEtfs", data) {
                rate($0.stocksEtfsValue, $0.stocksEtfsInvested)
            },
            line("crypto", "performance.crypto", data) { rate($0.cryptoValue, $0.cryptoInvested) },
            line("metals", "performance.metals", data) { rate($0.metalsValue, $0.metalsInvested) },
            line("inflation", "performance.inflationAdjusted", data, dashed: true) {
                rate($0.inflationAdjustedValue, $0.invested)
            },
        ]
    }
    private func brokerSeries(_ broker: PortfolioBrokerPerformance, data: PortfolioPerformanceData)
        -> [InsightChartSeries]
    {
        broker.series.map { entry in
            InsightChartSeries(
                id: entry.accountKey,
                label: entry.assignment == .unassigned
                    ? shell.strings.t("portfolio.brokerFilter.unassigned") : entry.accountName,
                points: broker.rows.filter {
                    $0.accountKey == entry.accountKey && $0.date >= data.startDate && $0.date <= data.endDate
                }
                .sorted { $0.date < $1.date }.map { InsightChartPoint(key: $0.date, value: $0.value) })
        }
    }
}

struct PortfolioBreakdownView: View {
    let data: PortfolioPerformanceData
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var groups: [OpenAPI.AssetClass: [PortfolioPerformanceBreakdown]] {
        Dictionary(grouping: data.breakdownSummary, by: \.assetClass)
    }
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 230), alignment: .leading)], alignment: .leading) {
            ForEach(groups.keys.sorted { $0.rawValue < $1.rawValue }, id: \.self) { group in
                let rows = groups[group] ?? []
                let value = rows.reduce(0) { $0 + $1.currentValue }
                let gain = rows.reduce(0) { $0 + $1.gainLoss }
                let invested = rows.reduce(0) { $0 + $1.totalInvested }
                PortfolioCard(title: shell.strings.t("portfolio.assetClass." + group.rawValue)) {
                    Text(shell.strings.tc("performance.holdings", rows.count)).font(.caption).foregroundStyle(
                        theme.secondaryLabel)
                    MoneyText(
                        amount: value, currency: data.currency, settings: shell.settings, signed: false, colored: false
                    )
                    .font(.title2.weight(.semibold))
                    HStack {
                        MoneyText(amount: gain, currency: data.currency, settings: shell.settings)
                        Text(signedPercent(invested > 0 ? gain / invested * 100 : 0)).monospacedDigit()
                    }.foregroundStyle(gain >= 0 ? theme.gain : theme.loss)
                    Text(shell.strings.t("portfolio.invested", ["amount": money(invested)]))
                        .font(.caption).foregroundStyle(theme.secondaryLabel)
                }
            }
        }
        if !data.heatmap.years.isEmpty {
            PortfolioCard(
                title: shell.strings.t("performance.monthlyHeatmap"),
                description: shell.strings.t("performance.heatmapDesc"), large: true
            ) {
                ScrollView(.horizontal) {
                    Grid(horizontalSpacing: 5, verticalSpacing: 5) {
                        GridRow {
                            Text(shell.strings.t("performance.year"))
                            ForEach(1...12, id: \.self) { month in Text(monthLabel(month)).frame(minWidth: 48) }
                            Text(shell.strings.t("performance.ytd")).frame(minWidth: 58)
                        }.font(.caption.weight(.medium)).foregroundStyle(theme.secondaryLabel)
                        ForEach(data.heatmap.years, id: \.self) { year in
                            if let months = data.heatmap.data[String(year)] {
                                GridRow {
                                    Text(String(year)).font(.caption.weight(.medium)).monospacedDigit()
                                    ForEach(0..<12, id: \.self) { index in
                                        heatCell(index < months.count ? months[index] : nil)
                                            .accessibilityLabel("\(monthLabel(index + 1)) \(year)")
                                            .accessibilityValue(
                                                index < months.count
                                                    ? months[index].map { signedPercent($0, digits: 2) }
                                                        ?? shell.strings.t("common.noData2")
                                                    : shell.strings.t("common.noData2"))
                                    }
                                    heatCell(yearReturn(months))
                                }
                            }
                        }
                    }
                }
                HStack(spacing: 4) {
                    Text(shell.strings.t("performance.loss"))
                    ForEach([-3, -2, -1, 0, 1, 2, 3], id: \.self) { value in
                        Rectangle().fill(
                            value == 0
                                ? theme.foreground.opacity(0.08)
                                : (value > 0 ? theme.gain : theme.loss).opacity(Double(abs(value)) * 0.22)
                        )
                        .frame(width: 25, height: 16).clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                    Text(shell.strings.t("performance.gain"))
                }.font(.caption).foregroundStyle(theme.secondaryLabel).frame(maxWidth: .infinity)
            }
        }
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 20) {
                performers(top: true)
                performers(top: false)
            }
            VStack(spacing: 20) {
                performers(top: true)
                performers(top: false)
            }
        }
    }
    private func performers(top: Bool) -> some View {
        PortfolioCard(title: shell.strings.t(top ? "performance.topPerformers" : "performance.bottomPerformers")) {
            ForEach(
                data.breakdownSummary.sorted {
                    top ? $0.gainLossPercent > $1.gainLossPercent : $0.gainLossPercent < $1.gainLossPercent
                }.prefix(5)
            ) { row in
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.name).font(.callout.weight(.medium))
                        Text(row.symbol ?? shell.strings.t("portfolio.assetClass." + row.assetClass.rawValue)).font(.caption)
                            .foregroundStyle(theme.secondaryLabel)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(signedPercent(row.gainLossPercent)).monospacedDigit().foregroundStyle(
                            row.gainLossPercent >= 0 ? theme.gain : theme.loss)
                        MoneyText(amount: row.gainLoss, currency: data.currency, settings: shell.settings).font(
                            .caption)
                        if let fx = row.fxGain, row.currency != data.currency {
                            PortfolioInlineDisclosure(
                                label: shell.strings.t("portfolio.fxShort") + " " + money(fx, signed: true),
                                explanation: shell.strings.t("portfolio.fxEffect")
                            )
                            .font(.caption).foregroundStyle(theme.secondaryLabel)
                        }
                    }
                }.padding(.vertical, 6)
            }
        }.frame(minWidth: 280)
    }
    private func heatCell(_ value: Decimal?) -> some View {
        let amount = value ?? 0
        let magnitude = abs(amount)
        let ratio = magnitude / max(data.heatmap.maxAbsPct, 1)
        let opacity =
            magnitude >= Decimal(25) / 10 || ratio > Decimal(72) / 100
            ? 0.7
            : magnitude >= 1 || ratio > Decimal(42) / 100 ? 0.4 : 0.2
        let color =
            value == nil || magnitude < Decimal(25) / 100
            ? theme.foreground.opacity(0.04)
            : (amount >= 0 ? theme.gain : theme.loss).opacity(opacity)
        return Text(value.map { signedPercent($0, digits: 2) } ?? "—")
            .font(.caption.monospaced()).frame(minWidth: 48).padding(.vertical, 8)
            .background(color, in: RoundedRectangle(cornerRadius: 6))
            .help(value.map { signedPercent($0, digits: 2) } ?? shell.strings.t("common.noData2"))
    }
    private func yearReturn(_ months: [Decimal?]) -> Decimal? {
        let known = months.compactMap { $0 }
        return known.isEmpty ? nil : (known.reduce(1) { $0 * (1 + $1 / 100) } - 1) * 100
    }
    private func monthLabel(_ month: Int) -> String {
        let date = Calendar.current.date(from: DateComponents(year: 2026, month: month, day: 1)) ?? Date()
        return date.formatted(
            Date.FormatStyle(locale: LanguageLocale.locale(shell.strings.language)).month(.abbreviated))
    }
    private func signedPercent(_ value: Decimal, digits: Int = 1) -> String {
        (value > 0 ? "+" : "") + VisionFormat.percent(value, digits: digits, locale: shell.settings.numberFormat.locale)
    }
    private func money(_ value: Decimal, signed: Bool = false) -> String {
        MoneyText.text(value, currency: data.currency, settings: shell.settings, signed: signed)
    }
}
