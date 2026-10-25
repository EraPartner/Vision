import Charts
import SwiftUI
import VisionNativeCore

struct ResearchCompareChartView: View {
    let data: ResearchComparePresentation
    let shell: NativeShellModel
    @State private var selected: Int?
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
                if let selected, plot.times.indices.contains(selected) {
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
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let point): select(point.x, proxy: proxy, geometry: geometry, plot: plot)
                            case .ended: selected = nil
                            }
                        }
                        .gesture(
                            DragGesture(minimumDistance: 0).onChanged { value in
                                focused = true
                                select(value.location.x, proxy: proxy, geometry: geometry, plot: plot)
                            })
                }
            }
            .frame(height: 340).focusable().focused($focused).focusEffectDisabled()
            .onKeyPress(.leftArrow) {
                move(-1)
                return .handled
            }
            .onKeyPress(.rightArrow) {
                move(1)
                return .handled
            }
            .onKeyPress(.escape) {
                selected = nil
                return .handled
            }
            .onChange(of: focused) { _, value in if !value { selected = nil } }
            .onChange(of: data.raw) { _, _ in selected = nil }
            .accessibilityLabel(shell.strings.t("research.compare.rebased"))
            if let selected, data.rows.indices.contains(selected) {
                let row = data.rows[selected]
                VStack(alignment: .leading, spacing: 5) {
                    Text(
                        ResearchCompareStyle.dateLabel(row.time, settings: shell.settings) + " "
                            + VisionFormat.time(
                                ResearchCompareStyle.date(row.time), locale: shell.settings.numberFormat.locale,
                                timeZone: .current)
                    ).font(.caption.weight(.medium))
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
    private func select(_ x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy, plot: ComparePlot) {
        guard let frame = proxy.plotFrame, let date: Date = proxy.value(atX: x - geometry[frame].origin.x) else {
            selected = nil
            return
        }
        let nearest = ChartLinePlot.nearest(in: plot.times, ascending: plot.ascending, to: date)
        if nearest != selected { selected = nearest }
    }
    private func move(_ step: Int) {
        guard !data.rows.isEmpty else { return }
        selected = min(max((selected ?? (step > 0 ? -1 : data.rows.count)) + step, 0), data.rows.count - 1)
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
