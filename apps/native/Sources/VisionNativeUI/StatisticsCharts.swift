import Charts
import SwiftUI
import VisionNativeCore

struct InsightRankedChart: View {
    let rows: [CustomChartEntity]
    let settings: NativeAppSettings
    let currency: CurrencyCode
    let strings: any Localizing
    @State private var selection: String?
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
            let maximum = rows.map(\.total).max() ?? 0
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { position, row in
                    rankedRow(row, position: position, maximum: maximum)
                }
            }
            .padding(.vertical, 4)
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
        }
    }
    private func rankedRow(_ row: CustomChartEntity, position: Int, maximum: Decimal) -> some View {
        let ratio = maximum > 0 ? NSDecimalNumber(decimal: max(0, row.total) / maximum).doubleValue : 0
        let dimmed = selection != nil && selection != row.id
        return HStack(spacing: 12) {
            Text(row.name)
                .font(.callout)
                .foregroundStyle(selection == row.id ? theme.foreground : theme.secondaryLabel)
                .lineLimit(1).truncationMode(.tail)
                .frame(width: 160, alignment: .trailing)
            GeometryReader { proxy in
                HStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(barColor(position))
                        .frame(width: max(4, (proxy.size.width - 96) * ratio), height: 14)
                    MoneyText(
                        amount: row.total, currency: currency, settings: settings, signed: false, colored: false
                    )
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                }
                .frame(height: proxy.size.height, alignment: .leading)
            }
        }
        .frame(height: 24)
        .opacity(dimmed ? 0.5 : 1)
        .contentShape(Rectangle())
        .onHover { hovering in
            if hovering { selection = row.id } else if selection == row.id { selection = nil }
        }
        .help(row.name)
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
        VStack {
            Chart(rows) { row in
                SectorMark(
                    angle: .value(row.name, NSDecimalNumber(decimal: row.total).doubleValue), innerRadius: .ratio(0.6),
                    outerRadius: .ratio(row.id == selected ? 1 : 0.93), angularInset: 2
                )
                .foregroundStyle(by: .value(strings.t("categories.title"), row.name))
                .accessibilityLabel(row.name)
                .accessibilityValue(MoneyText.text(row.total, currency: currency, settings: settings, signed: false))
            }
            .chartAngleSelection(value: $angle)
            .chartForegroundStyleScale(domain: rows.map(\.name), range: rows.map { color($0.path.first ?? $0.name) })
            .chartLegend(position: .bottom)
            .chartBackground { _ in
                if let row = rows.first(where: { $0.id == selected }) {
                    VStack(spacing: 4) {
                        Text(row.name).font(.caption).multilineTextAlignment(.center)
                        MoneyText(
                            amount: row.total, currency: currency, settings: settings, signed: false, colored: false
                        )
                        .font(.caption.weight(.medium))
                    }.frame(maxWidth: 135)
                }
            }
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle().fill(.clear).contentShape(Rectangle()).onContinuousHover { phase in
                        switch phase {
                        case .ended: selected = nil
                        case .active(let point):
                            guard let plot = proxy.plotFrame else { return }
                            let bounds = geometry[plot]
                            let dx = point.x - bounds.midX
                            let dy = point.y - bounds.midY
                            let radius = min(bounds.width, bounds.height) / 2
                            let distance = hypot(dx, dy)
                            if distance < radius * 0.6 || distance > radius {
                                selected = nil
                                return
                            }
                            var value = atan2(dx, -dy)
                            if value < 0 { value += 2 * .pi }
                            angle =
                                Double(value / (2 * .pi))
                                * NSDecimalNumber(decimal: rows.reduce(0) { $0 + $1.total }).doubleValue
                        }
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
            .onChange(of: angle) { _, value in
                guard let value else { return }
                var total = 0.0
                selected =
                    rows.first { row in
                        total += NSDecimalNumber(decimal: row.total).doubleValue
                        return value < total
                    }?.id
            }
        }
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
