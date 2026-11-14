import Charts
import SwiftUI
import VisionNativeCore

struct InsightRankedChart: View {
    let rows: [CustomChartEntity]
    let settings: NativeAppSettings
    let currency: CurrencyCode
    let strings: any Localizing
    @State private var selection: String?
    @State private var rowsWidth: CGFloat = 0
    private let onSelectionChange: (String?) -> Void
    @Environment(\.visionTheme) private var theme
    @FocusState private var focused: Bool

    init(
        rows: [CustomChartEntity], settings: NativeAppSettings, currency: CurrencyCode, strings: any Localizing,
        initialSelection: String? = nil, onSelectionChange: @escaping (String?) -> Void = { _ in }
    ) {
        self.rows = rows
        self.settings = settings
        self.currency = currency
        self.strings = strings
        _selection = State(initialValue: initialSelection)
        self.onSelectionChange = onSelectionChange
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if rows.isEmpty { Text(strings.t("table.noData")).foregroundStyle(theme.secondaryLabel) }
            // The web TopRecipientsChart: names in a fixed left gutter, one palette colour per
            // bar (`--chart-1…8`). Drawn as rows rather than a Swift Charts y axis, whose
            // labels sat half a band above their bars.
            // BarChart `layout="horizontal"`: no value labels on the bars; a `valueTickFormat`
            // (`formatAxisCompact`) axis under them on a nice 0…max scale, and the full amount in
            // the hover tooltip titled with the full name.
            let domainMax = Self.domainMax(rows)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { position, row in
                    rankedRow(row, position: position, domainMax: domainMax)
                }
            }
            .padding(.vertical, 4)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { rowsWidth = $0 }
            .overlay(alignment: .topLeading) { tooltip(domainMax: domainMax) }
            .focusable().focused($focused).focusEffectDisabled().onKeyPress(phases: .down) { press in
                guard !rows.isEmpty else { return .ignored }
                let index = selection.flatMap { id in rows.firstIndex { $0.id == id } } ?? 0
                if press.key == .downArrow || press.key == .rightArrow {
                    selection = rows[min(index + 1, rows.count - 1)].id
                } else if press.key == .upArrow || press.key == .leftArrow {
                    selection = rows[max(0, index - 1)].id
                } else if press.characters == "\u{F729}" {
                    selection = rows.first?.id
                } else if press.characters == "\u{F72B}" {
                    selection = rows.last?.id
                } else if press.key == .escape {
                    selection = nil
                } else {
                    return .ignored
                }
                return .handled
            }
            .onChange(of: focused) { _, value in if !value { selection = nil } }
            .onChange(of: selection) { _, value in onSelectionChange(value) }
            .accessibilityValue(
                ChartAccessibility.series(
                    strings, kind: .bar, categoryCount: rows.count, seriesLabels: [strings.t("statsPage.spending")]))
            if !rows.isEmpty { valueAxis(domainMax: domainMax) }
        }
    }

    /// The name gutter (`margin.left` 160) plus the gap before the bars.
    private static let gutter: CGFloat = 172
    private static let rowHeight: CGFloat = 24
    private static let rowSpacing: CGFloat = 6

    private var plotWidth: CGFloat { max(0, rowsWidth - Self.gutter) }

    /// `scaleLinear({ domain: [0, max], nice: true })`.
    private static func domainMax(_ rows: [CustomChartEntity]) -> Double {
        let maximum = rows.map { NSDecimalNumber(decimal: max(0, $0.total)).doubleValue }.max() ?? 0
        guard maximum > 0 else { return 1 }
        return ChartAxisTicks.niceDomain(0, maximum).upperBound
    }

    private func barWidth(_ row: CustomChartEntity, domainMax: Double) -> CGFloat {
        let value = NSDecimalNumber(decimal: max(0, row.total)).doubleValue
        return max(4, plotWidth * CGFloat(min(1, value / domainMax)))
    }

    /// The bottom value axis: five d3 ticks, compact amounts, centred under their positions.
    private func valueAxis(domainMax: Double) -> some View {
        let ticks = ChartAxisTicks.ticks(0, domainMax, count: 5)
        return ZStack(alignment: .topLeading) {
            ForEach(ticks, id: \.self) { tick in
                Text(
                    VisionFormat.currencyAxisCompact(
                        Decimal(tick), code: currency, locale: settings.numberFormat.locale)
                )
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(theme.secondaryLabel)
                .fixedSize()
                .alignmentGuide(.leading) { dimensions in
                    dimensions.width / 2 - (Self.gutter + plotWidth * CGFloat(tick / domainMax))
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 14, alignment: .topLeading)
        .accessibilityHidden(true)
    }

    /// `ChartTooltip` over the hovered bar's end: the full name and the full amount.
    @ViewBuilder private func tooltip(domainMax: Double) -> some View {
        if let selection, let index = rows.firstIndex(where: { $0.id == selection }) {
            let row = rows[index]
            let y = 4 + CGFloat(index) * (Self.rowHeight + Self.rowSpacing) + Self.rowHeight / 2
            ChartHoverTooltip(
                title: row.name,
                items: [
                    ChartTooltipItem(
                        id: row.id, label: strings.t("statsPage.spending"),
                        value: VisionFormat.currency(
                            row.total, code: currency, locale: settings.numberFormat.locale,
                            fractionDigits: settings.showDecimalPlaces),
                        color: barColor(index))
                ],
                anchor: CGPoint(x: Self.gutter + barWidth(row, domainMax: domainMax), y: y),
                bounds: CGSize(width: rowsWidth, height: CGFloat(rows.count) * (Self.rowHeight + Self.rowSpacing))
            )
            .allowsHitTesting(false)
        }
    }
    private func rankedRow(_ row: CustomChartEntity, position: Int, domainMax: Double) -> some View {
        let dimmed = selection != nil && selection != row.id
        return HStack(spacing: 12) {
            Text(row.name)
                .font(.callout)
                .foregroundStyle(selection == row.id ? theme.foreground : theme.secondaryLabel)
                .lineLimit(1).truncationMode(.tail)
                .frame(width: 160, alignment: .trailing)
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(barColor(position))
                .frame(width: barWidth(row, domainMax: domainMax), height: 14)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: Self.rowHeight)
        .opacity(dimmed ? 0.5 : 1)
        .contentShape(Rectangle())
        .onHover { hovering in
            if hovering { selection = row.id } else if selection == row.id { selection = nil }
        }
        .accessibilityElement(children: .combine)
        .animation(.easeOut(duration: DesignTokens.Duration.fast), value: dimmed)
    }

    private func barColor(_ position: Int) -> Color {
        let palette = theme.palette
        let colors = [
            palette.chart1, palette.chart2, palette.chart3, palette.chart4,
            palette.chart5, palette.chart6, palette.chart7, palette.chart8,
        ]
        return Color(token: colors[position % colors.count])
    }
}

struct StatisticsCategoryDonut: View {
    let rows: [StatisticsCategory]
    let settings: NativeAppSettings
    let currency: CurrencyCode
    let strings: any Localizing
    @State private var selected: String?
    private let onSelectionChange: (String?) -> Void
    @State private var angle: Double?
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        rows: [StatisticsCategory], settings: NativeAppSettings, currency: CurrencyCode, strings: any Localizing,
        initialSelection: String? = nil, onSelectionChange: @escaping (String?) -> Void = { _ in }
    ) {
        self.rows = rows
        self.settings = settings
        self.currency = currency
        self.strings = strings
        _selected = State(initialValue: initialSelection)
        self.onSelectionChange = onSelectionChange
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Chart(rows) { row in
                SectorMark(
                    angle: .value(row.name, NSDecimalNumber(decimal: row.total).doubleValue), innerRadius: .ratio(0.6),
                    outerRadius: .ratio(DonutHoverMotion.outer(hovered: row.id == selected, reduceMotion: reduceMotion)),
                    angularInset: 2
                )
                .foregroundStyle(by: .value(strings.t("categories.title"), row.name))
                .accessibilityLabel(row.name)
                .accessibilityValue(MoneyText.text(row.total, currency: currency, settings: settings, signed: false))
            }
            .chartAngleSelection(value: $angle)
            .chartForegroundStyleScale(domain: rows.map(\.name), range: rows.map { color($0.path.first ?? $0.name) })
            .chartLegend(.hidden)
            .chartBackground { _ in
                // `DonutChart`'s centre morph: the hovered slice's swatch and name over its amount.
                if let row = rows.first(where: { $0.id == selected }) {
                    VStack(spacing: 2) {
                        HStack(spacing: 6) {
                            Circle().fill(color(row.path.first ?? row.name)).frame(width: 8, height: 8)
                                .accessibilityHidden(true)
                            Text(row.name).lineLimit(1).truncationMode(.tail)
                        }
                        .font(.footnote).foregroundStyle(theme.secondaryLabel)
                        MoneyText(
                            amount: row.total, currency: currency, settings: settings, signed: false, colored: false
                        )
                        .font(.title3.monospacedDigit()).foregroundStyle(theme.foreground)
                    }
                    .frame(maxWidth: 170)
                    .id(row.id)
                    .transition(DonutHoverMotion.center(reduceMotion: reduceMotion))
                }
            }
            .animation(DonutHoverMotion.arc(reduceMotion: reduceMotion), value: selected)
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    // The hovered slice is worked out from the pointer here and written straight to
                    // `selected` (only on change): going through the angle binding missed a slice the
                    // pointer re-entered, because the same angle fired no change.
                    Rectangle().fill(.clear).contentShape(Rectangle()).onContinuousHover { phase in
                        let hovered: String?
                        switch phase {
                        case .ended: hovered = nil
                        case .active(let point): hovered = row(at: point, proxy: proxy, geometry: geometry)?.id
                        }
                        if selected != hovered { selected = hovered }
                    }
                }
            }
            .frame(height: 300).focusable().focused($focused)
            .onKeyPress(phases: .down) { press in
                guard !rows.isEmpty else { return .ignored }
                let index = selected.flatMap { id in rows.firstIndex { $0.id == id } } ?? 0
                if press.key == .rightArrow || press.key == .downArrow {
                    selected = rows[min(index + 1, rows.count - 1)].id
                } else if press.key == .leftArrow || press.key == .upArrow {
                    selected = rows[max(0, index - 1)].id
                } else if press.characters == "\u{F729}" {
                    selected = rows.first?.id
                } else if press.characters == "\u{F72B}" {
                    selected = rows.last?.id
                } else if press.key == .escape {
                    selected = nil
                } else {
                    return .ignored
                }
                return .handled
            }
            .onChange(of: focused) { _, value in if !value { selected = nil } }
            .onChange(of: selected) { _, value in onSelectionChange(value) }
            .accessibilityValue(ChartAccessibility.proportion(strings, kind: .donut, names: rows.map(\.name)))
            .onChange(of: angle) { _, value in
                guard let value else { return }
                var total = 0.0
                selected =
                    rows.first { row in
                        total += NSDecimalNumber(decimal: row.total).doubleValue
                        return value < total
                    }?.id
            }
            // `ChartLegend` under the donut, each entry carrying its amount ("HOUSING: MORTGAGE · 22.380,00 €").
            ChartLegendRow(items: rows.map(legendItem))
        }
    }
    /// The slice under `point`, inside the ring only.
    private func row(at point: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> StatisticsCategory? {
        guard let plot = proxy.plotFrame else { return nil }
        let bounds = geometry[plot]
        let dx = point.x - bounds.midX
        let dy = point.y - bounds.midY
        let radius = min(bounds.width, bounds.height) / 2
        let distance = hypot(dx, dy)
        guard distance >= radius * 0.6, distance <= radius else { return nil }
        var value = atan2(dx, -dy)
        if value < 0 { value += 2 * .pi }
        let total = NSDecimalNumber(decimal: rows.reduce(0) { $0 + $1.total }).doubleValue
        let position = Double(value / (2 * .pi)) * total
        var end = 0.0
        return rows.first { row in
            end += NSDecimalNumber(decimal: row.total).doubleValue
            return position < end
        }
    }
    private func legendItem(_ row: StatisticsCategory) -> ChartLegendItem {
        let amount = MoneyText.text(row.total, currency: currency, settings: settings, signed: false)
        return ChartLegendItem(id: row.id, label: row.name + " · " + amount, color: color(row.path.first ?? row.name))
    }
    private func color(_ root: String) -> Color {
        var hash: Int32 = 0
        for character in root.trimmingCharacters(in: .whitespaces).uppercased().utf16 {
            hash = hash &* 31 &+ Int32(character)
        }
        let p = theme.palette
        return Color(
            token: [p.chart1, p.chart2, p.chart3, p.chart4, p.chart5, p.chart6, p.chart7, p.chart8][
                Int(abs(Int64(hash)) % 8)])
    }
}
