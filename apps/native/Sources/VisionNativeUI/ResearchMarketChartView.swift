import Charts
import SwiftUI
import VisionNativeCore

struct ResearchMarketChartView: View {
    let data: ResearchChartData
    let range: String
    let positive: Bool
    let showsVolume: Bool
    let shell: NativeShellModel
    @State private var selected: Int?
    @State private var selectsVolume = false
    @FocusState private var focused: Bool
    @State private var plotCache = ChartLinePlotCache()
    @Environment(\.visionTheme) private var theme
    /// `isPositive ? hsl(var(--accent)) : hsl(var(--destructive))` in MarketLookupPage.
    private var color: Color { positive ? theme.accent : theme.destructive }
    var body: some View {
        // Converted once per loaded series: a hover re-renders this body for every point it
        // crosses, and the series can hold thousands of daily closes.
        let plot = plotCache.plot(for: data.points)
        // The web AreaChart's value domain: the closes plus 8 %, niced, never zero-based.
        let domain = ChartAxisTicks.fittedDomain(plot.closes)
        VStack(alignment: .leading, spacing: 10) {
            Chart {
                ForEach(plot.marks, id: \.offset) { mark in
                    AreaMark(
                        x: .value("Time", mark.time),
                        yStart: .value("Price", domain.lowerBound),
                        yEnd: .value("Price", mark.close)
                    )
                    .foregroundStyle(ChartFill.areaGradient(color))
                    .interpolationMethod(.monotone)
                    LineMark(
                        x: .value("Time", mark.time),
                        y: .value("Price", mark.close)
                    )
                    .foregroundStyle(color)
                    .lineStyle(StrokeStyle(lineWidth: 2))
                    .interpolationMethod(.monotone)
                }
                if let selected, plot.times.indices.contains(selected) {
                    RuleMark(x: .value("Time", plot.times[selected])).foregroundStyle(
                        theme.secondaryLabel.opacity(0.6))
                }
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 6)) { value in
                    AxisTick()
                    AxisValueLabel {
                        if let date = value.as(Date.self) {
                            Text(tick(date)).font(ChartTickText.font).foregroundStyle(theme.secondaryLabel)
                        }
                    }
                }
            }
            .visionChartYAxis(domain: domain) { amount in
                amount.formatted(
                    .number.locale(shell.settings.numberFormat.locale).precision(.fractionLength(0...2)))
            }
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let location):
                                selectsVolume = false
                                select(location.x, proxy: proxy, geometry: geometry, plot: plot)
                            case .ended: selected = nil
                            }
                        }
                        .gesture(
                            DragGesture(minimumDistance: 0).onChanged { value in
                                focused = true
                                selectsVolume = false
                                select(value.location.x, proxy: proxy, geometry: geometry, plot: plot)
                            })
                }
            }
            .frame(height: 320).focusable().focused($focused).focusEffectDisabled()
            .onKeyPress(.leftArrow) {
                move(-1)
                return .handled
            }.onKeyPress(.rightArrow) {
                move(1)
                return .handled
            }
            .onKeyPress(.escape) {
                selected = nil
                return .handled
            }.onChange(of: data.raw) { _, _ in selected = nil }
            .accessibilityLabel(shell.strings.t("market.priceChart"))
            if showsVolume {
                // Its bars do not depend on the selection, so a hover leaves them alone.
                MarketVolumeBars(
                    bars: plot.bars, count: plot.times.count, color: theme.mutedForeground,
                    label: shell.strings.t("market.volume"),
                    onHover: { position in
                        guard let position else {
                            selected = nil
                            return
                        }
                        selectsVolume = true
                        selected = position
                    }
                )
                .equatable()
            }
            if let selected, data.points.indices.contains(selected) {
                let point = data.points[selected]
                let date = ResearchMarketDisplay.date(point.time)
                HStack {
                    Text(
                        VisionFormat.appDate(date, format: shell.settings.dateFormat, timeZone: .current) + " "
                            + VisionFormat.time(date, locale: shell.settings.numberFormat.locale, timeZone: .current))
                    Spacer()
                    if selectsVolume, let volume = point.volume {
                        Text(ResearchMarketDisplay.compact(volume, shell: shell)).monospacedDigit()
                    } else if let close = point.close {
                        Text(
                            ResearchMarketDisplay.money(
                                close, currency: data.currency ?? "USD", shell: shell, digits: 2)
                        ).monospacedDigit()
                    }
                }.font(.caption).padding(10).background(theme.card, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md))
            }
        }
    }
    private func tick(_ date: Date) -> String {
        let locale = LanguageLocale.locale(shell.strings.language)
        let template = range == "1d" ? "jm" : ["1y", "5y", "max"].contains(range) ? "MMMyy" : "dMMM"
        let formatter = FormatterCache.shared("researchMarket.tick|\(locale.identifier)|\(template)") {
            () -> DateFormatter in
            let made = DateFormatter()
            made.locale = locale
            made.setLocalizedDateFormatFromTemplate(template)
            if template == "jm", made.dateFormat.hasPrefix("h:") {
                made.dateFormat = "h" + made.dateFormat
            }
            return made
        }
        return formatter.string(from: date)
    }
    private func select(_ x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy, plot: ChartLinePlot) {
        guard let frame = proxy.plotFrame, let date: Date = proxy.value(atX: x - geometry[frame].origin.x) else {
            selected = nil
            return
        }
        let nearest = plot.nearestOffset(to: date)
        if nearest != selected { selected = nearest }
    }
    private func move(_ step: Int) {
        if !data.points.isEmpty {
            selected = min(max((selected ?? (step > 0 ? -1 : data.points.count)) + step, 0), data.points.count - 1)
        }
    }
}

/// The volume strip under the price chart: one evenly spaced band per point (the web `BarChart`
/// band scale), not a bar on the time axis, whose bars were thin slivers with gaps at weekends.
/// Equatable on what it draws, so the price chart's hover does not rebuild its bars.
private struct MarketVolumeBars: View, Equatable {
    let bars: [ChartLinePlot.Bar]
    let count: Int
    let color: Color
    let label: String
    let onHover: (Int?) -> Void

    static func == (lhs: MarketVolumeBars, rhs: MarketVolumeBars) -> Bool {
        lhs.count == rhs.count && lhs.color == rhs.color && lhs.label == rhs.label
            && lhs.bars.count == rhs.bars.count && lhs.bars.first?.volume == rhs.bars.first?.volume
            && lhs.bars.last?.volume == rhs.bars.last?.volume
    }

    var body: some View {
        Chart {
            ForEach(bars, id: \.offset) { bar in
                RectangleMark(
                    xStart: .value("Time", Double(bar.offset) - 0.375),
                    xEnd: .value("Time", Double(bar.offset) + 0.375),
                    yStart: .value("Volume", 0.0),
                    yEnd: .value("Volume", bar.volume)
                )
                .foregroundStyle(color).cornerRadius(2)
            }
        }
        .chartXScale(domain: -0.5...(Double(max(count, 1)) - 0.5))
        .chartXAxis(.hidden).chartYAxis(.hidden)
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let location): onHover(index(location.x, proxy: proxy, geometry: geometry))
                        case .ended: onHover(nil)
                        }
                    }
                    .gesture(
                        DragGesture(minimumDistance: 0).onChanged { value in
                            onHover(index(value.location.x, proxy: proxy, geometry: geometry))
                        })
            }
        }
        .frame(height: 60).accessibilityLabel(label)
    }

    /// The x axis counts points, so a position maps straight to a point index.
    private func index(_ x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy) -> Int? {
        guard let frame = proxy.plotFrame,
            let position: Double = proxy.value(atX: x - geometry[frame].origin.x), count > 0
        else { return nil }
        return min(max(Int(position.rounded()), 0), count - 1)
    }
}
