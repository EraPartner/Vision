import Charts
import SwiftUI
import VisionNativeCore

struct InsightRankedChart: View {
    let rows: [CustomChartEntity]
    let settings: NativeAppSettings
    let currency: String
    let strings: any Localizing
    @State private var selection: String?
    private let onSelectionChange: (String?) -> Void
    @Environment(\.visionTheme) private var theme
    @FocusState private var focused: Bool

    init(
        rows: [CustomChartEntity], settings: NativeAppSettings, currency: String, strings: any Localizing,
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
            Chart(rows) { row in
                BarMark(
                    x: .value(row.name, NSDecimalNumber(decimal: row.total).doubleValue), y: .value(row.name, row.id)
                )
                .foregroundStyle(theme.primary)
                .accessibilityLabel(row.name)
                .accessibilityValue(MoneyText.text(row.total, currency: currency, settings: settings, signed: false))
            }
            .chartYScale(domain: rows.map(\.id))
            .chartYAxis {
                AxisMarks { value in
                    AxisValueLabel {
                        if let id = value.as(String.self), let row = rows.first(where: { $0.id == id }) {
                            Text(row.name.count > 20 ? String(row.name.prefix(20)) + "…" : row.name)
                        }
                    }
                }
            }
            .chartYSelection(value: $selection)
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle().fill(.clear).contentShape(Rectangle()).onContinuousHover { phase in
                        switch phase {
                        case .ended: selection = nil
                        case .active(let point):
                            if let plot = proxy.plotFrame {
                                selection = proxy.value(atY: point.y - geometry[plot].minY, as: String.self)
                            }
                        }
                    }
                }
            }
            .frame(height: CGFloat(max(180, min(700, rows.count * 28))))
            .focusable().focused($focused).onKeyPress(phases: .down) { press in
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
            if let row = rows.first(where: { $0.id == selection }) {
                HStack {
                    Text(row.name)
                    Spacer()
                    MoneyText(amount: row.total, currency: currency, settings: settings, signed: false, colored: false)
                }.font(.caption).accessibilityElement(children: .combine)
            }
        }
    }
}

struct StatisticsCategoryDonut: View {
    let rows: [StatisticsCategory]
    let settings: NativeAppSettings
    let currency: String
    let strings: any Localizing
    @State private var selected: String?
    private let onSelectionChange: (String?) -> Void
    @State private var angle: Double?
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme

    init(
        rows: [StatisticsCategory], settings: NativeAppSettings, currency: String, strings: any Localizing,
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
