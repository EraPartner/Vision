import Charts
import SwiftUI
import VisionNativeCore

/// Plot coordinates alone use Double. Selection, endpoint comparisons and every
/// readout retain the Decimal figures delivered by the portfolio service.
struct PortfolioSeriesChart: View {
    let series: [InsightChartSeries]
    let title: String
    let currency: String
    let shell: NativeShellModel
    var percent = false
    var area = false
    var height: CGFloat = 280
    var colors: [String: Color] = [:]
    @State private var selected: String?
    @State private var rangeStart: String?
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    private var keys: [String] { Array(Set(series.flatMap { $0.points.map(\.key) })).sorted() }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Chart {
                ForEach(series) { line in
                    ForEach(line.points) { point in
                        if area && !line.dashed {
                            AreaMark(
                                x: .value(title, point.key), y: .value(line.label, coordinate(point.value)),
                                stacking: .unstacked
                            )
                            .foregroundStyle(by: .value(title, line.id)).opacity(0.12)
                            .accessibilityHidden(true)
                        }
                        LineMark(
                            x: .value(title, point.key), y: .value(line.label, coordinate(point.value)),
                            series: .value(title, line.id)
                        )
                        .foregroundStyle(by: .value(title, line.id))
                        .lineStyle(StrokeStyle(lineWidth: 2, dash: line.dashed ? [5, 4] : []))
                        .accessibilityLabel(line.label + ". " + dateLabel(point.key))
                        .accessibilityValue(format(point.value))
                    }
                }
                if let selected, keys.contains(selected) {
                    RuleMark(x: .value(title, selected)).foregroundStyle(theme.secondaryLabel.opacity(0.5))
                }
                if let selected, let rangeStart, keys.contains(selected), keys.contains(rangeStart) {
                    RectangleMark(
                        xStart: .value(title, min(selected, rangeStart)),
                        xEnd: .value(title, max(selected, rangeStart))
                    )
                    .foregroundStyle(theme.primary.opacity(0.08))
                }
            }
            .chartXScale(domain: keys)
            .chartForegroundStyleScale(
                domain: series.map(\.id),
                range: series.enumerated().map { index, line in
                    colors[line.id] ?? Color(token: palette[index % palette.count])
                }
            )
            .chartLegend(.hidden)
            .chartXAxis {
                AxisMarks(values: ChartAxisTicks.evenlySpaced(keys)) { value in
                    AxisGridLine()
                    AxisValueLabel { if let key = value.as(String.self) { Text(dateLabel(key)) } }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading) { value in
                    AxisGridLine()
                    AxisValueLabel { if let value = value.as(Double.self) { Text(format(Decimal(value), axis: true)) } }
                }
            }
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let location): selected = key(location.x, proxy: proxy, geometry: geometry)
                            case .ended: if rangeStart == nil { selected = nil }
                            }
                        }
                        .gesture(
                            DragGesture(minimumDistance: 0).onChanged { value in
                                focused = true
                                if rangeStart == nil {
                                    rangeStart = key(value.startLocation.x, proxy: proxy, geometry: geometry)
                                }
                                selected = key(value.location.x, proxy: proxy, geometry: geometry)
                            })
                }
            }
            .frame(height: height).focusable().focused($focused).focusEffectDisabled()
            .accessibilityLabel(title)
            .onKeyPress(phases: .down, action: moveSelection)
            .onChange(of: series) { _, _ in
                selected = nil
                rangeStart = nil
            }
            .onChange(of: focused) { _, focused in
                if !focused {
                    selected = nil
                    rangeStart = nil
                }
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), alignment: .leading)], alignment: .leading) {
                ForEach(Array(series.enumerated()), id: \.element.id) { index, line in
                    HStack(spacing: 6) {
                        if line.dashed {
                            Rectangle().fill(colors[line.id] ?? Color(token: palette[index % palette.count]))
                                .frame(width: 16, height: 2)
                        } else {
                            Circle().fill(colors[line.id] ?? Color(token: palette[index % palette.count]))
                                .frame(width: 7, height: 7)
                        }
                        Text(line.label).font(.caption).foregroundStyle(theme.secondaryLabel)
                    }
                }
            }
            if let selected, keys.contains(selected) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(rangeStart.map { "\(dateLabel($0)) – \(dateLabel(selected))" } ?? dateLabel(selected))
                        .font(.caption.weight(.medium))
                    ForEach(series) { line in
                        if let value = line.points.first(where: { $0.key == selected })?.value {
                            HStack {
                                Text(line.label).foregroundStyle(theme.secondaryLabel)
                                Spacer()
                                Text(format(value)).monospacedDigit()
                                if let rangeStart, let start = line.points.first(where: { $0.key == rangeStart })?.value
                                {
                                    Text("Δ").accessibilityHidden(true)
                                    Text(format(value - start, signed: true)).monospacedDigit()
                                }
                            }.font(.caption)
                        }
                    }
                }.padding(10).background(theme.foreground.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityElement(children: .combine)
            }
        }
    }
    private var palette: [HSLColor] {
        [
            theme.palette.chart1, theme.palette.chart2, theme.palette.chart3,
            theme.palette.chart4, theme.palette.chart5, theme.palette.chart6, theme.palette.chart7,
            theme.palette.chart8,
        ]
    }
    private func coordinate(_ value: Decimal) -> Double { NSDecimalNumber(decimal: value).doubleValue }
    private func format(_ value: Decimal, axis: Bool = false, signed: Bool = false) -> String {
        if percent {
            return (signed && value > 0 ? "+" : "")
                + VisionFormat.percent(
                    value,
                    digits: axis ? 0 : 2, locale: shell.settings.numberFormat.locale)
        }
        return VisionFormat.currency(
            value, code: currency, locale: shell.settings.numberFormat.locale,
            fractionDigits: axis ? 0 : shell.settings.showDecimalPlaces, signed: signed)
    }
    private func dateLabel(_ key: String) -> String {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count >= 2,
            let date = Calendar.current.date(
                from: DateComponents(
                    year: parts[0], month: parts[1], day: parts.count > 2 ? parts[2] : 1))
        else { return key }
        return date.formatted(
            Date.FormatStyle(locale: shell.settings.numberFormat.locale)
                .month(.abbreviated).day(.twoDigits).year(.twoDigits))
    }
    private func key(_ x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy) -> String? {
        guard let anchor = proxy.plotFrame else { return nil }
        let frame = geometry[anchor]
        return proxy.value(atX: min(max(0, x - frame.minX), frame.width), as: String.self)
    }
    private func moveSelection(_ press: KeyPress) -> KeyPress.Result {
        guard !keys.isEmpty else { return .ignored }
        let current = selected.flatMap(keys.firstIndex) ?? keys.count - 1
        let next: Int
        if press.key == .leftArrow {
            next = max(0, current - 1)
        } else if press.key == .rightArrow {
            next = min(keys.count - 1, current + 1)
        } else if press.characters == "\u{F729}" {
            next = 0
        } else if press.characters == "\u{F72B}" {
            next = keys.count - 1
        } else if press.key == .escape {
            selected = nil
            rangeStart = nil
            return .handled
        } else {
            return .ignored
        }
        if press.modifiers.contains(.shift), rangeStart == nil {
            rangeStart = keys[current]
        } else if !press.modifiers.contains(.shift) {
            rangeStart = nil
        }
        selected = keys[next]
        return .handled
    }
}

struct PortfolioCard<Content: View>: View {
    let title: String
    var description: String? = nil
    /// `CardTitle` default (type-title-2) rather than `variant="sm"` (type-title-3).
    var large = false
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) private var theme
    var body: some View {
        AdminCard(padding: 24) {
            VStack(alignment: .leading, spacing: 14) {
                Text(title).font(large ? .visionCardTitle : VisionFonts.display(17, relativeTo: .title3))
                    .accessibilityAddTraits(.isHeader)
                if let description { Text(description).foregroundStyle(theme.secondaryLabel) }
                content()
            }
        }
    }
}

struct PortfolioInlineDisclosure: View {
    let label: String
    let explanation: String
    @State private var open = false
    var body: some View {
        Button(label) { open = true }.buttonStyle(.plain).help(explanation)
            .accessibilityLabel(label == "ⓘ" ? explanation : label + ". " + explanation)
            .popover(isPresented: $open) { Text(explanation).padding(16).frame(maxWidth: 320) }
    }
}
