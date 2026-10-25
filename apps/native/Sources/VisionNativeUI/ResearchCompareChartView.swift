import Charts
import SwiftUI
import VisionNativeCore

struct ResearchCompareChartView: View {
    let data: ResearchComparePresentation
    let shell: NativeShellModel
    @State private var selected: Int?
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Chart {
                ForEach(Array(data.symbols.enumerated()), id: \.element) { _, symbol in
                    ForEach(data.rows) { row in
                        if let value = row.values[symbol] {
                            LineMark(
                                x: .value(
                                    shell.strings.t("portfolioImport.session.fields.date"),
                                    ResearchCompareStyle.date(row.time)),
                                y: .value(
                                    shell.strings.t("research.compare.rebased"),
                                    NSDecimalNumber(decimal: value).doubleValue),
                                series: .value(shell.strings.t("research.compare.symbol"), symbol)
                            )
                            .foregroundStyle(by: .value(shell.strings.t("research.compare.symbol"), symbol))
                            .lineStyle(StrokeStyle(lineWidth: 2)).interpolationMethod(.monotone)
                        }
                    }
                }
                RuleMark(y: .value("100", 100)).lineStyle(StrokeStyle(lineWidth: 1, dash: [5, 4])).foregroundStyle(
                    theme.secondaryLabel.opacity(0.5)
                )
                .annotation(position: .leading) { Text("100").font(.caption) }
                if let selected, data.rows.indices.contains(selected) {
                    RuleMark(
                        x: .value(
                            shell.strings.t("portfolioImport.session.fields.date"),
                            ResearchCompareStyle.date(data.rows[selected].time))
                    ).foregroundStyle(
                        theme.secondaryLabel.opacity(0.5))
                }
            }
            .chartForegroundStyleScale(
                domain: data.symbols,
                range: data.symbols.indices.map { ResearchCompareStyle.color($0, palette: theme.palette) }
            )
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 6)) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let date = value.as(Date.self) {
                            Text(VisionFormat.appDate(date, format: shell.settings.dateFormat, timeZone: .current))
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let value = value.as(Double.self) {
                            Text(value.formatted(.number.precision(.fractionLength(0)).grouping(.never)))
                        }
                    }
                }
            }
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let point): select(point.x, proxy: proxy, geometry: geometry)
                            case .ended: selected = nil
                            }
                        }
                        .gesture(
                            DragGesture(minimumDistance: 0).onChanged { value in
                                focused = true
                                select(value.location.x, proxy: proxy, geometry: geometry)
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
                }.padding(12).background(theme.card, in: RoundedRectangle(cornerRadius: 10)).overlay(
                    RoundedRectangle(cornerRadius: 10).stroke(theme.border))
            }
        }
    }
    private func select(_ x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy) {
        guard let frame = proxy.plotFrame, let date: Date = proxy.value(atX: x - geometry[frame].origin.x) else {
            selected = nil
            return
        }
        selected = data.rows.indices.min { a, b in
            abs(ResearchCompareStyle.date(data.rows[a].time).timeIntervalSince(date))
                < abs(ResearchCompareStyle.date(data.rows[b].time).timeIntervalSince(date))
        }
    }
    private func move(_ step: Int) {
        guard !data.rows.isEmpty else { return }
        selected = min(max((selected ?? (step > 0 ? -1 : data.rows.count)) + step, 0), data.rows.count - 1)
    }
}
