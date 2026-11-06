import Charts
import SwiftUI
import VisionNativeCore

struct ResearchCompareChartView: View {
    let data: ResearchComparePresentation
    let shell: NativeShellModel
    @State private var selected: Int?
    /// Range compare (`scrubbable`): drag, or click, move, click.
    @State private var scrub = ChartScrub()
    @FocusState private var focused: Bool
    @State private var plotCache = ComparePlotCache()
    @Environment(\.visionTheme) private var theme
    var body: some View {
        // Converted once per result: a hover re-renders this body for every row it crosses.
        let plot = plotCache.plot(for: data)
        let yDomain = ChartAxisTicks.fittedDomain(plot.values + [100])
        let dateTitle = shell.strings.t("portfolioImport.session.fields.date")
        let rebasedTitle = shell.strings.t("research.compare.rebased")
        let symbolTitle = shell.strings.t("research.compare.symbol")
        return VStack(alignment: .leading, spacing: 12) {
            Chart {
                ForEach(plot.lines, id: \.symbol) { line in
                    ForEach(line.marks, id: \.offset) { mark in
                        LineMark(
                            x: .value(dateTitle, mark.time),
                            y: .value(rebasedTitle, mark.value),
                            series: .value(symbolTitle, line.symbol)
                        )
                        .foregroundStyle(by: .value(symbolTitle, line.symbol))
                        .lineStyle(StrokeStyle(lineWidth: 2)).interpolationMethod(.monotone)
                    }
                }
                RuleMark(y: .value("100", 100.0)).lineStyle(StrokeStyle(lineWidth: 1, dash: [5, 4])).foregroundStyle(
                    theme.secondaryLabel.opacity(0.5)
                )
                .annotation(position: .leading) { Text("100").font(.caption) }
                if scrub.range == nil, let selected, plot.times.indices.contains(selected) {
                    RuleMark(x: .value(dateTitle, plot.times[selected])).foregroundStyle(
                        theme.secondaryLabel.opacity(0.5))
                }
            }
            .chartForegroundStyleScale(
                domain: data.symbols,
                range: data.symbols.indices.map { ResearchCompareStyle.color($0, palette: theme.palette) }
            )
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 6)) { value in
                    AxisTick()
                    AxisValueLabel {
                        if let date = value.as(Date.self) {
                            Text(VisionFormat.appDate(date, format: shell.settings.dateFormat, timeZone: .current))
                                .font(ChartTickText.font).foregroundStyle(theme.secondaryLabel)
                        }
                    }
                }
            }
            .visionChartYAxis(domain: yDomain) { value in
                value.formatted(.number.precision(.fractionLength(0)).grouping(.never))
            }
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    ChartRangeCompareLayer(
                        scrub: $scrub, plot: proxy.plotFrame.map { geometry[$0] } ?? .zero,
                        view: ChartScrubView(scrub, count: plot.times.count, series: plot.scrubSeries),
                        indexAt: { x in
                            proxy.value(atX: x, as: Date.self).flatMap {
                                ChartLinePlot.nearest(in: plot.times, ascending: plot.ascending, to: $0)
                            }
                        },
                        xOf: { plot.times.indices.contains($0) ? proxy.position(forX: plot.times[$0]) : nil },
                        yOf: { _, value in proxy.position(forY: value) },
                        colorOf: { key in
                            ResearchCompareStyle.color(data.symbols.firstIndex(of: key) ?? 0, palette: theme.palette)
                        },
                        titleOf: rowTitle,
                        deltaOf: { row in
                            ChartScrubDelta.text(
                                start: row.start, end: row.end,
                                formatValue: { ResearchCompareStyle.fixed(Decimal($0)) },
                                formatPercent: {
                                    VisionFormat.percent(
                                        Decimal($0), digits: 1, locale: shell.settings.numberFormat.locale)
                                })
                        },
                        onHover: { index in if selected != index { selected = index } },
                        onPress: { focused = true })
                }
            }
            .frame(height: 340).focusable().focused($focused).focusEffectDisabled()
            .onKeyPress(phases: .down) { press in
                ChartKeyboard.handle(press, scrub: &scrub, selected: &selected, count: data.rows.count)
            }
            .onChange(of: focused) { _, value in
                if !value {
                    selected = nil
                    scrub.clear()
                }
            }
            .onChange(of: data.raw) { _, _ in selected = nil }
            .onChange(of: plot.scrubTimeline, initial: true) { _, timeline in scrub.sync(timeline: timeline) }
            .accessibilityLabel(shell.strings.t("research.compare.rebased"))
            .chartAccessibilitySummary { strings in
                ChartAccessibility.series(
                    strings, kind: .line, categoryCount: data.rows.count, seriesLabels: data.symbols)
            }
            if scrub.range == nil, let selected, data.rows.indices.contains(selected) {
                VStack(alignment: .leading, spacing: 5) {
                    let row = data.rows[selected]
                    Text(rowTitle(selected)).font(.caption.weight(.medium))
                    ForEach(Array(data.symbols.enumerated()), id: \.element) { index, symbol in
                        HStack {
                            Circle().fill(ResearchCompareStyle.color(index, palette: theme.palette)).frame(
                                width: 7, height: 7
                            ).accessibilityHidden(true)
                            Text(symbol).font(.caption.monospaced())
                            Spacer()
                            Text(ResearchCompareStyle.fixed(row.values[symbol])).font(.caption).monospacedDigit()
                        }
                    }
                }.padding(12).background(theme.card, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control)).overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.control).stroke(theme.border))
            }
        }
    }
    private func rowTitle(_ index: Int) -> String {
        guard data.rows.indices.contains(index) else { return "" }
        let time = data.rows[index].time
        return ResearchCompareStyle.dateLabel(time, settings: shell.settings) + " "
            + VisionFormat.time(
                ResearchCompareStyle.date(time), locale: shell.settings.numberFormat.locale, timeZone: .current)
    }
}

/// The compare chart's lines as plot coordinates, with long ones thinned (`ChartDecimation`).
struct ComparePlot {
    struct Mark {
        let offset: Int
        let time: Date
        let value: Double
    }

    struct Line {
        let symbol: String
        let marks: [Mark]
    }

    let lines: [Line]
    /// One time per row.
    let times: [Date]
    let ascending: Bool
    /// Every rebased value, for the value domain.
    let values: [Double]
    /// One range-compare series per symbol over the rows.
    let scrubSeries: [ChartScrubSeries]
    let scrubTimeline: String

    init(data: ResearchComparePresentation) {
        let times = data.rows.map { ResearchCompareStyle.date($0.time) }
        var lines: [Line] = []
        for symbol in data.symbols {
            var marks: [Mark] = []
            for (offset, row) in data.rows.enumerated() {
                guard let value = row.values[symbol] else { continue }
                marks.append(Mark(offset: offset, time: times[offset], value: NSDecimalNumber(decimal: value).doubleValue))
            }
            let kept = ChartDecimation.indices(of: marks.map(\.value))
            lines.append(Line(symbol: symbol, marks: kept.count == marks.count ? marks : kept.map { marks[$0] }))
        }
        // The web LineChart's value domain: every rebased value of every row.
        let values = data.rows.flatMap { row in row.values.values.map { NSDecimalNumber(decimal: $0).doubleValue } }
        self.lines = lines
        scrubSeries = data.symbols.map { symbol in
            let values = data.rows.map { row in row.values[symbol].map { NSDecimalNumber(decimal: $0).doubleValue } }
            return ChartScrubSeries(key: symbol, label: symbol) { values.indices.contains($0) ? values[$0] : nil }
        }
        scrubTimeline = ChartScrub.timeline(
            count: times.count, first: times.first?.timeIntervalSince1970, last: times.last?.timeIntervalSince1970)
        self.times = times
        ascending = ChartLinePlot.isAscending(times)
        self.values = values
    }
}

/// Keeps the `ComparePlot` of the last result it saw; equal rows compare in O(1) while they
/// share a buffer.
final class ComparePlotCache {
    private var rows: [ResearchComparePresentation.Row]?
    private var symbols: [String] = []
    private var plot: ComparePlot?

    func plot(for data: ResearchComparePresentation) -> ComparePlot {
        if let plot, let rows, rows == data.rows, symbols == data.symbols { return plot }
        rows = data.rows
        symbols = data.symbols
        let made = ComparePlot(data: data)
        plot = made
        return made
    }
}
