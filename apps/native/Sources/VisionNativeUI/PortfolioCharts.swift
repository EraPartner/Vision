import Charts
import SwiftUI
import VisionNativeCore

/// Plot coordinates alone use Double. Selection, endpoint comparisons and every
/// readout retain the Decimal figures delivered by the portfolio service.
struct PortfolioSeriesChart: View {
    let series: [InsightChartSeries]
    let title: String
    let currency: CurrencyCode
    let shell: NativeShellModel
    var percent = false
    var area = false
    var height: CGFloat = 280
    /// The web's `xTickPattern`: day ticks ("d MMM") for 1M/3M/6M, month ticks ("MMM yy") otherwise.
    var dayTicks = false
    var colors: [String: Color] = [:]
    @State private var selected: String?
    @State private var rangeStart: String?
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    /// The sorted keys and their positions, rebuilt only when the series change.
    @State private var layoutCache = ChartKeyLayoutCache()
    /// Date and value strings of the points' accessibility labels, formatted once per context.
    @State private var labelMemo = ChartLabelMemo()
    private var keys: [String] { layoutCache.layout(for: series).keys }
    /// Each key's position: the x axis is quantitative over these indices, so it draws only
    /// the requested ticks. A String-keyed (categorical) axis drew a grid line and a label
    /// for every day of a long series.
    private var keyIndex: [String: Int] { layoutCache.layout(for: series).index }
    /// The web AreaChart's fitted domain: the data range plus an 8 % margin, niced, not
    /// zero-based, so a slowly growing portfolio fills the plot instead of a flat line at the top.
    private var yDomain: ClosedRange<Double> {
        ChartAxisTicks.fittedDomain(series.flatMap { $0.points.map { coordinate($0.value) } })
    }

    var body: some View {
        let keys = self.keys
        let index = keyIndex
        let domain = yDomain
        VStack(alignment: .leading, spacing: 10) {
            Chart {
                ForEach(series) { line in
                    let color = lineColor(line)
                    ForEach(line.points) { point in
                        if area && !line.dashed, let x = index[point.key] {
                            AreaMark(
                                x: .value(title, x), yStart: .value(line.label, domain.lowerBound),
                                yEnd: .value(line.label, coordinate(point.value)),
                                series: .value(title, line.id)
                            )
                            .foregroundStyle(ChartFill.areaGradient(color))
                            .interpolationMethod(.monotone)
                            .accessibilityHidden(true)
                        }
                        if let x = index[point.key] {
                            LineMark(
                                x: .value(title, x), y: .value(line.label, coordinate(point.value)),
                                series: .value(title, line.id)
                            )
                            .foregroundStyle(color)
                            .lineStyle(
                                StrokeStyle(
                                    lineWidth: line.dashed ? 1.5 : 2.5, lineCap: .round, lineJoin: .round,
                                    dash: line.dashed ? [4, 4] : [])
                            )
                            .interpolationMethod(.monotone)
                            .accessibilityLabel(line.label + ". " + pointDate(point.key))
                            .accessibilityValue(pointValue(point.value))
                        }
                    }
                }
                if let selected, let x = index[selected] {
                    RuleMark(x: .value(title, x)).foregroundStyle(theme.secondaryLabel.opacity(0.5))
                }
                if let selected, let rangeStart, let a = index[selected], let b = index[rangeStart] {
                    RectangleMark(xStart: .value(title, min(a, b)), xEnd: .value(title, max(a, b)))
                        .foregroundStyle(theme.primary.opacity(0.08))
                }
            }
            .chartXScale(domain: 0...max(keys.count - 1, 1))
            .chartLegend(.hidden)
            .chartXAxis {
                AxisMarks(values: ChartAxisTicks.evenlySpaced(Array(keys.indices), count: 7)) { value in
                    AxisValueLabel {
                        if let position = value.as(Int.self), keys.indices.contains(position) {
                            Text(dateLabel(keys[position], pattern: dayTicks ? "d MMM" : "MMM yy"))
                                .font(ChartTickText.font).foregroundStyle(theme.secondaryLabel)
                        }
                    }
                }
            }
            .visionChartYAxis(domain: domain) { format(Decimal($0), axis: true) }
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
            ChartLegendRow(
                items: series.enumerated().map { index, line in
                    ChartLegendItem(
                        id: line.id, label: line.label,
                        color: colors[line.id] ?? Color(token: palette[index % palette.count]), dashed: line.dashed)
                })
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
                }.padding(10)
                    .background(
                        theme.foreground.opacity(0.04), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md)
                    )
                    .accessibilityElement(children: .combine)
            }
        }
    }
    /// What the date and value strings of a point depend on besides the point.
    private var labelContext: String {
        let locale = shell.settings.numberFormat.locale.identifier
        let language = shell.strings.language.rawValue
        return "\(language)|\(locale)|\(currency.rawValue)|\(percent)|\(shell.settings.showDecimalPlaces)"
    }
    private func pointDate(_ key: String) -> String {
        labelMemo.label("d|" + key, context: labelContext) { dateLabel(key) }
    }
    private func pointValue(_ value: Decimal) -> String {
        labelMemo.label("v|" + value.description, context: labelContext) { format(value) }
    }
    private func lineColor(_ line: InsightChartSeries) -> Color {
        let position = series.firstIndex { $0.id == line.id } ?? 0
        return colors[line.id] ?? Color(token: palette[position % palette.count])
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
    /// `formatDate(parseISO(day), pattern, appLanguageToLocale(language))`: month names follow the
    /// app language, never the system or number-format locale. The default is the web's
    /// `CHART_DATE_PATTERNS.detail`.
    private func dateLabel(_ key: String, pattern: String = "d MMM yyyy") -> String {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.current
        guard parts.count >= 2,
            let date = calendar.date(
                from: DateComponents(
                    year: parts[0], month: parts[1], day: parts.count > 2 ? parts[2] : 1))
        else { return key }
        let locale = LanguageLocale.locale(shell.strings.language)
        let formatter = FormatterCache.shared("portfolio.chart|\(locale.identifier)|\(pattern)") {
            () -> DateFormatter in
            let made = DateFormatter()
            made.locale = locale
            made.calendar = Calendar(identifier: .gregorian)
            made.dateFormat = pattern
            return made
        }
        return formatter.string(from: date)
    }
    private func key(_ x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy) -> String? {
        guard let anchor = proxy.plotFrame else { return nil }
        let frame = geometry[anchor]
        guard let position = proxy.value(atX: min(max(0, x - frame.minX), frame.width), as: Double.self) else {
            return nil
        }
        let keys = self.keys
        guard !keys.isEmpty else { return nil }
        return keys[min(max(Int(position.rounded()), 0), keys.count - 1)]
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

struct PortfolioCard<Content: View, Accessory: View>: View {
    let title: String
    var description: String? = nil
    /// `CardTitle` default (type-title-2) rather than `variant="sm"` (type-title-3).
    var large = false
    /// The trailing header control (the web `CardHeader` row's right side).
    @ViewBuilder var accessory: () -> Accessory
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) private var theme

    init(
        title: String, description: String? = nil, large: Bool = false,
        @ViewBuilder accessory: @escaping () -> Accessory, @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.description = description
        self.large = large
        self.accessory = accessory
        self.content = content
    }

    var body: some View {
        AdminCard(padding: 24) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(large ? .visionCardTitle : Font.visionTitle3)
                            .accessibilityAddTraits(.isHeader)
                        if let description { Text(description).foregroundStyle(theme.secondaryLabel) }
                    }
                    Spacer(minLength: 0)
                    accessory()
                }
                content()
            }
        }
    }
}

extension PortfolioCard where Accessory == EmptyView {
    init(
        title: String, description: String? = nil, large: Bool = false, @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(title: title, description: description, large: large, accessory: { EmptyView() }, content: content)
    }
}

struct PortfolioInlineDisclosure: View {
    let label: String
    let explanation: String
    @State private var open = false
    var body: some View {
        Button(label) { open = true }.buttonStyle(.plain).visionTooltip(explanation)
            .accessibilityLabel(label == "ⓘ" ? explanation : label + ". " + explanation)
            .popover(isPresented: $open) { Text(explanation).padding(16).frame(maxWidth: 320) }
    }
}

enum PortfolioChartTicks {
    /// The web `xTickPattern`: day ticks for 1M, 3M and 6M, month ticks for longer periods.
    static func usesDayTicks(_ period: PortfolioPeriod) -> Bool {
        switch period {
        case .oneMonth, .threeMonths, .sixMonths: return true
        case .oneYear, .threeYears, .all: return false
        }
    }
}
