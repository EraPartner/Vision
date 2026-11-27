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
    /// Range compare (`scrubbable`): drag, or click, move, click.
    @State private var scrub = ChartScrub()
    @FocusState private var focused: Bool
    /// The volume strip takes keyboard focus too, like the web's keyboard-enabled `BarChart`.
    @FocusState private var volumeFocused: Bool
    @State private var plotCache = ChartLinePlotCache()
    /// The chart's width, for the web's date tick count.
    @State private var chartWidth: CGFloat = 0
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
                if scrub.range == nil, let selected, plot.times.indices.contains(selected) {
                    RuleMark(x: .value("Time", plot.times[selected])).foregroundStyle(
                        theme.secondaryLabel.opacity(0.6))
                }
            }
            .chartXAxis {
                // AreaChart's bottom axis: `numTicks={Math.max(2, Math.floor(innerWidth / 90))}`.
                // d3 `scaleTime().ticks(n)` dates: `.automatic(desiredCount:)` picked coarser steps.
                AxisMarks(
                    values: plot.times.first.flatMap { first in
                        plot.times.last.map { last in
                            TimeAxisTicks.values(from: first, to: last, count: max(2, Int(chartWidth / 90)))
                        }
                    } ?? []
                ) { value in
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
                    ChartRangeCompareLayer(
                        scrub: $scrub, plot: proxy.plotFrame.map { geometry[$0] } ?? .zero,
                        view: ChartScrubView(scrub, count: plot.times.count, series: plot.scrubSeries()),
                        indexAt: { x in proxy.value(atX: x, as: Date.self).flatMap { plot.nearestOffset(to: $0) } },
                        xOf: { plot.times.indices.contains($0) ? proxy.position(forX: plot.times[$0]) : nil },
                        yOf: { _, value in proxy.position(forY: value) },
                        colorOf: { _ in color },
                        titleOf: pointTitle,
                        deltaOf: { row in
                            ChartScrubDelta.text(
                                start: row.start, end: row.end,
                                formatValue: { money(Decimal($0)) },
                                formatPercent: { percent($0) })
                        },
                        onHover: { position in
                            selectsVolume = false
                            if selected != position { selected = position }
                        },
                        onPress: { focused = true })
                    // The web AreaChart's active dot and floating `ChartTooltip`, so the layout
                    // under the chart never moves.
                    if !selectsVolume, scrub.range == nil, let selected, plot.times.indices.contains(selected),
                        data.points.indices.contains(selected), let close = data.points[selected].close,
                        let frame = proxy.plotFrame.map({ geometry[$0] }),
                        let x = proxy.position(forX: plot.times[selected]),
                        let y = proxy.position(forY: NSDecimalNumber(decimal: close).doubleValue)
                    {
                        let point = CGPoint(x: frame.minX + x, y: frame.minY + y)
                        ChartHoverRings(rings: [ChartHoverRing(id: "close", point: point, color: color)])
                        ChartHoverTooltip(
                            title: pointTitle(selected),
                            items: [
                                ChartTooltipItem(
                                    id: "close", label: shell.strings.t("market.priceChart"), value: money(close),
                                    color: color)
                            ],
                            anchor: point, bounds: geometry.size)
                    }
                }
            }
            .frame(height: 320)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { chartWidth = $0 }
            .focusable().focused($focused).chartFocusRing(focused)
            .onKeyPress(phases: .down) { press in
                ChartKeyboard.handle(press, scrub: &scrub, selected: &selected, count: plot.times.count)
            }
            .onChange(of: data.raw) { _, _ in selected = nil }
            .onChange(of: plot.scrubTimeline, initial: true) { _, timeline in scrub.sync(timeline: timeline) }
            .onChange(of: focused) { _, focused in
                if !focused {
                    selected = nil
                    scrub.clear()
                }
            }
            .accessibilityLabel(shell.strings.t("market.priceChart"))
            .chartAccessibilitySummary { strings in
                ChartAccessibility.series(
                    strings, kind: .area, categoryCount: plot.times.count,
                    seriesLabels: [strings.t("market.priceChart")])
            }
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
                // The hovered bar's floating `ChartTooltip`, over the strip so nothing below moves.
                .overlay {
                    GeometryReader { geometry in
                        if selectsVolume, scrub.range == nil, let selected, data.points.indices.contains(selected),
                            let volume = data.points[selected].volume, plot.times.count > 0
                        {
                            ChartHoverTooltip(
                                title: pointTitle(selected),
                                items: [
                                    ChartTooltipItem(
                                        id: "volume", label: shell.strings.t("market.volume"),
                                        value: ResearchMarketDisplay.compact(volume, shell: shell),
                                        color: theme.mutedForeground)
                                ],
                                anchor: CGPoint(
                                    x: geometry.size.width * (CGFloat(selected) + 0.5) / CGFloat(plot.times.count), y: 0),
                                bounds: geometry.size)
                        }
                    }
                    .allowsHitTesting(false)
                }
                .focusable().focused($volumeFocused).chartFocusRing(volumeFocused)
                .onKeyPress(phases: .down) { press in
                    if press.key == .escape {
                        guard selected != nil else { return .ignored }
                        selected = nil
                        return .handled
                    }
                    guard let key = press.chartKey,
                        let next = ChartKeyboard.index(for: key, from: selected, count: plot.times.count)
                    else { return .ignored }
                    selectsVolume = true
                    selected = next
                    return .handled
                }
                .onChange(of: volumeFocused) { _, focused in if !focused { selected = nil } }
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
    private func pointTitle(_ index: Int) -> String {
        guard data.points.indices.contains(index) else { return "" }
        let date = ResearchMarketDisplay.date(data.points[index].time)
        return VisionFormat.appDate(date, format: shell.settings.dateFormat, timeZone: .current) + " "
            + VisionFormat.time(date, locale: shell.settings.numberFormat.locale, timeZone: .current)
    }
    private func money(_ value: Decimal) -> String {
        ResearchMarketDisplay.money(value, currency: data.currency ?? "USD", shell: shell, digits: 2)
    }
    private func percent(_ value: Double) -> String {
        VisionFormat.percent(Decimal(value), digits: 1, locale: shell.settings.numberFormat.locale)
    }
}

/// The volume strip under the price chart: one evenly spaced band per point (the web `BarChart`
/// band scale), not a bar on the time axis, whose bars were thin slivers with gaps at weekends.
/// Equatable on what it draws, so the price chart's hover does not rebuild its bars. Every bar is
/// compared: a refresh that changes only a middle volume must redraw that bar.
struct MarketVolumeBars: View, Equatable {
    let bars: [ChartLinePlot.Bar]
    let count: Int
    let color: Color
    let label: String
    let onHover: (Int?) -> Void

    nonisolated static func == (lhs: MarketVolumeBars, rhs: MarketVolumeBars) -> Bool {
        lhs.count == rhs.count && lhs.color == rhs.color && lhs.label == rhs.label
            && lhs.bars == rhs.bars
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
        .chartAccessibilitySummary { strings in
            ChartAccessibility.series(strings, kind: .bar, categoryCount: count, seriesLabels: [label])
        }
    }

    /// The x axis counts points, so a position maps straight to a point index.
    private func index(_ x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy) -> Int? {
        guard let frame = proxy.plotFrame,
            let position: Double = proxy.value(atX: x - geometry[frame].origin.x), count > 0
        else { return nil }
        return min(max(Int(position.rounded()), 0), count - 1)
    }
}
