import Charts
import SwiftUI
import VisionNativeCore

/// Percentile bands and invested capital are authoritative server amounts.
/// Double is used only for the chart coordinates and date hit testing.
struct ResearchForecastChart: View {
    let points: [ResearchForecastPoint]
    let currency: CurrencyCode
    let shell: NativeShellModel
    let isLoading: Bool
    @State private var selected: Int?
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    init(points: [ResearchForecastPoint], currency: CurrencyCode, shell: NativeShellModel, isLoading: Bool) {
        self.points = points
        self.currency = currency
        self.shell = shell
        self.isLoading = isLoading
    }
    private struct Series: Identifiable {
        let id: String
        let value: KeyPath<ResearchForecastPoint, Decimal>
        let color: Color
        let width: CGFloat
        var dashed = false
    }
    private var series: [Series] {
        [
            .init(id: "p90", value: \.p90, color: Color(token: theme.palette.accent), width: 1, dashed: true),
            .init(id: "p75", value: \.p75, color: Color(token: theme.palette.accent), width: 1),
            .init(id: "p50", value: \.p50, color: theme.primary, width: 2.5),
            .init(id: "p25", value: \.p25, color: theme.destructive, width: 1),
            .init(id: "p10", value: \.p10, color: theme.destructive, width: 1, dashed: true),
            .init(id: "netInvested", value: \.netInvested, color: theme.secondaryLabel, width: 1.5, dashed: true),
        ]
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 140))], alignment: .leading, spacing: 8) {
                ForEach(series) { line in
                    HStack(spacing: 6) {
                        if line.dashed {
                            Path { path in
                                path.move(to: .zero)
                                path.addLine(to: CGPoint(x: 22, y: 0))
                            }
                            .stroke(line.color, style: StrokeStyle(lineWidth: line.width, dash: [4, 3]))
                            .frame(width: 22, height: 2).accessibilityHidden(true)
                        } else {
                            Rectangle().fill(line.color).frame(width: 22, height: line.width).accessibilityHidden(true)
                        }
                        Text(label(line)).font(.caption).foregroundStyle(theme.secondaryLabel)
                    }
                }
            }
            Text(shell.strings.t("research.forecast.intervalHint")).font(.caption).foregroundStyle(theme.secondaryLabel)
            if isLoading {
                RoundedRectangle(cornerRadius: DesignTokens.Radius.control).fill(theme.muted).frame(height: 360)
                    .accessibilityLabel(shell.strings.t("common.loading"))
            } else if points.isEmpty {
                VisionEmptyState(
                    symbol: "chart.line.uptrend.xyaxis", title: shell.strings.t("research.forecast.noData")
                ) {}
                .frame(height: 360)
            } else {
                Chart {
                    ForEach(series) { line in
                        ForEach(points, id: \.monthIndex) { point in
                            if let date = date(point.date) {
                                LineMark(
                                    x: .value("date", date),
                                    y: .value(label(line), coordinate(point[keyPath: line.value])),
                                    series: .value("series", line.id)
                                )
                                .foregroundStyle(line.color)
                                .interpolationMethod(.monotone)
                                .lineStyle(StrokeStyle(lineWidth: line.width, dash: line.dashed ? [5, 4] : []))
                                .accessibilityLabel(fullDate(point.date) + ", " + label(line))
                                .accessibilityValue(money(point[keyPath: line.value]))
                            }
                        }
                    }
                    if let index = selected, points.indices.contains(index), let date = date(points[index].date) {
                        RuleMark(x: .value("date", date)).foregroundStyle(theme.secondaryLabel.opacity(0.5))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3])).accessibilityHidden(true)
                    }
                }
                .chartLegend(.hidden)
                .chartXAxis {
                    AxisMarks { value in
                        AxisGridLine()
                        AxisTick()
                        if let date = value.as(Date.self) {
                            AxisValueLabel {
                                Text(
                                    date.formatted(
                                        Date.FormatStyle(locale: LanguageLocale.locale(shell.strings.language))
                                            .month(.abbreviated).year()))
                            }
                        }
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { value in
                        AxisGridLine()
                        AxisValueLabel {
                            if let value = value.as(Double.self) { Text(money(Decimal(value))) }
                        }
                    }
                }
                .chartOverlay { proxy in
                    GeometryReader { geometry in
                        Rectangle().fill(.clear).contentShape(Rectangle())
                            .onContinuousHover { phase in
                                switch phase {
                                case .active(let location): select(location.x, proxy: proxy, geometry: geometry)
                                case .ended: if !focused { selected = nil }
                                }
                            }
                            .gesture(
                                DragGesture(minimumDistance: 0).onChanged {
                                    select($0.location.x, proxy: proxy, geometry: geometry)
                                })
                    }
                }
                .frame(height: 360).focusable().focused($focused)
                .onKeyPress(phases: .down, action: move)
                .accessibilityLabel(shell.strings.t("research.forecast.chartTitle"))
                if let index = selected, points.indices.contains(index) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(fullDate(points[index].date)).font(.caption.weight(.semibold))
                        ForEach(series) { line in
                            HStack {
                                Text(label(line)).foregroundStyle(theme.secondaryLabel)
                                Spacer()
                                Text(money(points[index][keyPath: line.value])).monospacedDigit()
                            }.font(.caption)
                        }
                    }.padding(12).background(theme.muted, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md))
                        .accessibilityElement(children: .combine)
                }
            }
        }.onChange(of: points) { _, _ in selected = nil }
    }
    private func label(_ line: Series) -> String { shell.strings.t("research.forecast." + line.id) }
    private func coordinate(_ value: Decimal) -> Double { NSDecimalNumber(decimal: value).doubleValue }
    private func money(_ value: Decimal) -> String {
        ResearchForecastDisplay.money(value, currency: currency, shell: shell)
    }
    private func date(_ day: String) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
    private func fullDate(_ day: String) -> String { VisionFormat.appDate(day, format: shell.settings.dateFormat) }
    private func select(_ x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy) {
        guard let anchor = proxy.plotFrame else { return }
        let frame = geometry[anchor]
        guard let hovered = proxy.value(atX: min(max(0, x - frame.minX), frame.width), as: Date.self) else { return }
        selected = points.indices.min {
            abs((date(points[$0].date) ?? .distantPast).timeIntervalSince(hovered))
                < abs((date(points[$1].date) ?? .distantPast).timeIntervalSince(hovered))
        }
    }
    private func move(_ press: KeyPress) -> KeyPress.Result {
        guard !points.isEmpty else { return .ignored }
        let index = selected ?? 0
        if press.key == .leftArrow {
            selected = max(0, index - 1)
        } else if press.key == .rightArrow {
            selected = min(points.count - 1, index + 1)
        } else if press.key == .home {
            selected = 0
        } else if press.key == .end {
            selected = points.count - 1
        } else if press.key == .escape {
            selected = nil
        } else {
            return .ignored
        }
        return .handled
    }
}
