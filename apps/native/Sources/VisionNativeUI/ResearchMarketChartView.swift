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
    @Environment(\.visionTheme) private var theme
    /// `isPositive ? hsl(var(--accent)) : hsl(var(--destructive))` in MarketLookupPage.
    private var color: Color { positive ? theme.accent : theme.destructive }
    /// The web AreaChart's value domain: the closes plus 8 %, niced, never zero-based.
    private var priceDomain: ClosedRange<Double> {
        ChartAxisTicks.fittedDomain(data.points.compactMap { $0.close.map { NSDecimalNumber(decimal: $0).doubleValue } })
    }
    var body: some View {
        let domain = priceDomain
        VStack(alignment: .leading, spacing: 10) {
            Chart {
                ForEach(Array(data.points.enumerated()), id: \.offset) { _, point in
                    if let close = point.close {
                        AreaMark(
                            x: .value("Time", ResearchMarketDisplay.date(point.time)),
                            yStart: .value("Price", domain.lowerBound),
                            yEnd: .value("Price", NSDecimalNumber(decimal: close).doubleValue)
                        )
                        .foregroundStyle(ChartFill.areaGradient(color))
                        .interpolationMethod(.monotone)
                        LineMark(
                            x: .value("Time", ResearchMarketDisplay.date(point.time)),
                            y: .value("Price", NSDecimalNumber(decimal: close).doubleValue)
                        )
                        .foregroundStyle(color)
                        .lineStyle(StrokeStyle(lineWidth: 2))
                        .interpolationMethod(.monotone)
                    }
                }
                if let selected, data.points.indices.contains(selected) {
                    RuleMark(x: .value("Time", ResearchMarketDisplay.date(data.points[selected].time))).foregroundStyle(
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
                                select(location.x, proxy: proxy, geometry: geometry)
                            case .ended: selected = nil
                            }
                        }
                        .gesture(
                            DragGesture(minimumDistance: 0).onChanged { value in
                                focused = true
                                selectsVolume = false
                                select(value.location.x, proxy: proxy, geometry: geometry)
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
                Chart {
                    ForEach(Array(data.points.enumerated()), id: \.offset) { offset, point in
                        if let volume = point.volume {
                            // One evenly spaced band per point (the web `BarChart` band scale), not a
                            // bar on the time axis, whose bars were thin slivers with gaps at weekends.
                            RectangleMark(
                                xStart: .value("Time", Double(offset) - 0.375),
                                xEnd: .value("Time", Double(offset) + 0.375),
                                yStart: .value("Volume", 0.0),
                                yEnd: .value("Volume", NSDecimalNumber(decimal: volume).doubleValue)
                            )
                            .foregroundStyle(theme.mutedForeground).cornerRadius(2)
                        }
                    }
                }
                .chartXScale(domain: -0.5...(Double(max(data.points.count, 1)) - 0.5))
                .chartXAxis(.hidden).chartYAxis(.hidden)
                    .chartOverlay { proxy in
                        GeometryReader { geometry in
                            Rectangle().fill(.clear).contentShape(Rectangle())
                                .onContinuousHover { phase in
                                    switch phase {
                                    case .active(let location):
                                        selectsVolume = true
                                        selectVolumeBar(location.x, proxy: proxy, geometry: geometry)
                                    case .ended: selected = nil
                                    }
                                }
                                .gesture(
                                    DragGesture(minimumDistance: 0).onChanged { value in
                                        selectsVolume = true
                                        selectVolumeBar(value.location.x, proxy: proxy, geometry: geometry)
                                    })
                        }
                    }.frame(height: 60).accessibilityLabel(
                        shell.strings.t("market.volume"))
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
    private func select(_ x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy) {
        guard let frame = proxy.plotFrame, let date: Date = proxy.value(atX: x - geometry[frame].origin.x) else {
            selected = nil
            return
        }
        selected = data.points.indices.min {
            abs(ResearchMarketDisplay.date(data.points[$0].time).timeIntervalSince(date))
                < abs(ResearchMarketDisplay.date(data.points[$1].time).timeIntervalSince(date))
        }
    }
    /// The volume chart's x axis counts points, so a position maps straight to a point index.
    private func selectVolumeBar(_ x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy) {
        guard let frame = proxy.plotFrame,
            let position: Double = proxy.value(atX: x - geometry[frame].origin.x), !data.points.isEmpty
        else {
            selected = nil
            return
        }
        selected = min(max(Int(position.rounded()), 0), data.points.count - 1)
    }
    private func move(_ step: Int) {
        if !data.points.isEmpty {
            selected = min(max((selected ?? (step > 0 ? -1 : data.points.count)) + step, 0), data.points.count - 1)
        }
    }
}
