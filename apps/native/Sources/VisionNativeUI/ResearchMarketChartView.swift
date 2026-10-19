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
    private var color: Color { positive ? theme.primary : theme.destructive }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Chart {
                ForEach(Array(data.points.enumerated()), id: \.offset) { _, point in
                    if let close = point.close {
                        AreaMark(
                            x: .value("Time", ResearchMarketDisplay.date(point.time)),
                            y: .value("Price", NSDecimalNumber(decimal: close).doubleValue)
                        )
                        .foregroundStyle(
                            LinearGradient(
                                colors: [color.opacity(0.3), color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                        LineMark(
                            x: .value("Time", ResearchMarketDisplay.date(point.time)),
                            y: .value("Price", NSDecimalNumber(decimal: close).doubleValue)
                        ).foregroundStyle(color)
                    }
                }
                if let selected, data.points.indices.contains(selected) {
                    RuleMark(x: .value("Time", ResearchMarketDisplay.date(data.points[selected].time))).foregroundStyle(
                        theme.secondaryLabel.opacity(0.6))
                }
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 6)) { value in
                    AxisGridLine()
                    AxisValueLabel { if let date = value.as(Date.self) { Text(tick(date)) } }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let amount = value.as(Double.self) {
                            Text(
                                amount.formatted(
                                    .number.locale(shell.settings.numberFormat.locale).precision(.fractionLength(0...2))
                                ))
                        }
                    }
                }
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
                    ForEach(Array(data.points.enumerated()), id: \.offset) { _, point in
                        if let volume = point.volume {
                            BarMark(
                                x: .value("Time", ResearchMarketDisplay.date(point.time)),
                                y: .value("Volume", NSDecimalNumber(decimal: volume).doubleValue)
                            ).foregroundStyle(theme.secondaryLabel.opacity(0.4))
                        }
                    }
                }.chartXAxis(.hidden).chartYAxis(.hidden)
                    .chartOverlay { proxy in
                        GeometryReader { geometry in
                            Rectangle().fill(.clear).contentShape(Rectangle())
                                .onContinuousHover { phase in
                                    switch phase {
                                    case .active(let location):
                                        selectsVolume = true
                                        select(location.x, proxy: proxy, geometry: geometry)
                                    case .ended: selected = nil
                                    }
                                }
                                .gesture(
                                    DragGesture(minimumDistance: 0).onChanged { value in
                                        selectsVolume = true
                                        select(value.location.x, proxy: proxy, geometry: geometry)
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
                }.font(.caption).padding(10).background(theme.card, in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
    private func tick(_ date: Date) -> String {
        let locale = shell.settings.numberFormat.locale
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
    private func move(_ step: Int) {
        if !data.points.isEmpty {
            selected = min(max((selected ?? (step > 0 ? -1 : data.points.count)) + step, 0), data.points.count - 1)
        }
    }
}
