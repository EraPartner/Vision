import Charts
import SwiftUI
import VisionNativeCore

struct PortfolioTaxAssetClassChart: View {
    let data: PortfolioTaxDashboard
    let shell: NativeShellModel
    var body: some View {
        TaxCard(
            title: shell.strings.t("tax.widget.taxByAssetClass"),
            description: shell.strings.t("tax.taxByAssetClassDesc")
        ) {
            PortfolioTaxBarChart(
                rows: data.taxByAssetClass.map {
                    PortfolioTaxBarRow(
                        id: $0.assetClass.rawValue,
                        label: shell.strings.t("portfolio.assetClass." + $0.assetClass.rawValue),
                        taxes: $0.taxes, fees: $0.fees)
                }, title: shell.strings.t("tax.widget.taxByAssetClass"), currency: data.currency, shell: shell,
                showsLegend: true)
        }
    }
}

struct PortfolioTaxMonthlyCostChart: View {
    let data: PortfolioTaxDashboard
    let shell: NativeShellModel
    var body: some View {
        TaxCard(
            title: shell.strings.t("tax.yearlyTaxFeeTrendTitle", ["year": String(data.year)]),
            description: shell.strings.t("tax.yearlyTaxFeeTrendDesc")
        ) {
            PortfolioTaxBarChart(
                rows: data.yearlyCostTrend.map {
                    PortfolioTaxBarRow(id: $0.period, label: $0.period, taxes: $0.taxes, fees: $0.fees)
                }, title: shell.strings.t("tax.yearlyTaxFeeTrendTitle", ["year": String(data.year)]),
                currency: data.currency, shell: shell)
        }
    }
}

private struct PortfolioTaxBarRow: Identifiable, Equatable {
    let id: String
    let label: String
    let taxes: Decimal
    let fees: Decimal
}

/// Grouped bars retain server order and localized accessibility labels. Double is only a drawing coordinate.
private struct PortfolioTaxBarChart: View {
    let rows: [PortfolioTaxBarRow]
    let title: String
    let currency: CurrencyCode
    let shell: NativeShellModel
    /// The asset-class chart carries its legend under the plot (`ChartCard legend`); the monthly trend has none.
    var showsLegend = false
    @State private var selection: String?
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    private var taxLabel: String { shell.strings.t("tax.taxes") }
    private var feeLabel: String { shell.strings.t("tax.fees") }
    private var taxColor: Color { Color(token: theme.palette.chart5) }
    private var feeColor: Color { Color(token: theme.palette.chart4) }
    /// `BarChart`'s value domain: the baseline stays in view, the top is padded.
    private var yDomain: ClosedRange<Double> {
        ChartAxisTicks.zeroBasedDomain(rows.flatMap { [coordinate($0.taxes), coordinate($0.fees)] })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Chart {
                // Grouped bars on a quantitative index axis: a categorical axis labels every
                // month whatever ticks it is given, so long ranges overlapped.
                ForEach(Array(rows.enumerated()), id: \.element.id) { position, row in
                    RectangleMark(
                        xStart: .value(title, Double(position) - 0.34), xEnd: .value(title, Double(position) - 0.02),
                        yStart: .value(taxLabel, 0.0), yEnd: .value(taxLabel, coordinate(row.taxes))
                    )
                    .foregroundStyle(by: .value(title, taxLabel)).cornerRadius(3)
                    .accessibilityLabel(Text(row.label + " · " + taxLabel))
                    .accessibilityValue(Text(money(row.taxes)))
                    RectangleMark(
                        xStart: .value(title, Double(position) + 0.02), xEnd: .value(title, Double(position) + 0.34),
                        yStart: .value(feeLabel, 0.0), yEnd: .value(feeLabel, coordinate(row.fees))
                    )
                    .foregroundStyle(by: .value(title, feeLabel)).cornerRadius(3)
                    .accessibilityLabel(Text(row.label + " · " + feeLabel))
                    .accessibilityValue(Text(money(row.fees)))
                }
                if let row = selected, let position = rows.firstIndex(of: row) {
                    RuleMark(x: .value(title, Double(position))).foregroundStyle(theme.secondaryLabel.opacity(0.5))
                        .accessibilityHidden(true)
                }
            }
            .chartXScale(domain: -0.5...(Double(max(rows.count, 1)) - 0.5))
            .chartXAxis {
                AxisMarks(values: ChartAxisTicks.evenlySpaced(rows.indices.map(Double.init), count: 12)) { value in
                    AxisValueLabel {
                        if let position = value.as(Double.self), rows.indices.contains(Int(position.rounded())) {
                            Text(rows[Int(position.rounded())].label).font(ChartTickText.font)
                                .foregroundStyle(theme.secondaryLabel)
                        }
                    }
                }
            }
            .chartForegroundStyleScale(
                domain: [taxLabel, feeLabel],
                range: [taxColor, feeColor]
            )
            .chartLegend(.hidden)
            .visionChartYAxis(domain: yDomain) { value in
                VisionFormat.currency(
                    Decimal(value), code: currency, locale: shell.settings.numberFormat.locale,
                    fractionDigits: shell.settings.showDecimalPlaces)
            }
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .onContinuousHover { phase in
                            if case .active(let location) = phase {
                                select(location.x, proxy: proxy, geometry: geometry)
                            } else if selection != nil {
                                selection = nil
                            }
                        }
                        .gesture(
                            DragGesture(minimumDistance: 0).onChanged { value in
                                focused = true
                                select(value.location.x, proxy: proxy, geometry: geometry)
                            })
                }
            }
            .frame(height: 280).focusable().focused($focused).focusEffectDisabled()
            .accessibilityLabel(title).onKeyPress(phases: .down, action: move)
            if showsLegend {
                ChartLegendRow(items: [
                    ChartLegendItem(id: "taxes", label: taxLabel, color: taxColor),
                    ChartLegendItem(id: "fees", label: feeLabel, color: feeColor),
                ])
            }
            if let row = selected {
                VStack(alignment: .leading, spacing: 5) {
                    Text(row.label).font(.caption.weight(.medium))
                    HStack {
                        Text(taxLabel)
                        Spacer()
                        Text(money(row.taxes)).monospacedDigit()
                    }
                    HStack {
                        Text(feeLabel)
                        Spacer()
                        Text(money(row.fees)).monospacedDigit()
                    }
                }.font(.caption).padding(10)
                    .background(
                        theme.foreground.opacity(0.04), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md))
                    .accessibilityElement(children: .combine)
            }
        }
        .onChange(of: rows) { _, _ in selection = nil }
        .onChange(of: focused) { _, value in if !value { selection = nil } }
    }
    private var selected: PortfolioTaxBarRow? { rows.first { $0.id == selection } }
    private func select(_ x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy) {
        // Scrolling re-reports a parked pointer every frame: write on change only.
        func set(_ id: String?) { if selection != id { selection = id } }
        guard let plot = proxy.plotFrame else {
            set(nil)
            return
        }
        let frame = geometry[plot]
        guard let position = proxy.value(atX: min(max(0, x - frame.minX), frame.width), as: Double.self),
            !rows.isEmpty
        else {
            set(nil)
            return
        }
        set(rows[min(max(Int(position.rounded()), 0), rows.count - 1)].id)
    }
    private func move(_ press: KeyPress) -> KeyPress.Result {
        guard !rows.isEmpty else { return .ignored }
        let current = selection.flatMap { id in rows.firstIndex { $0.id == id } }
        let next: Int
        if press.key == .leftArrow {
            next = max(0, (current ?? 1) - 1)
        } else if press.key == .rightArrow {
            next = min(rows.count - 1, (current ?? -1) + 1)
        } else if press.characters == "\u{F729}" {
            next = 0
        } else if press.characters == "\u{F72B}" {
            next = rows.count - 1
        } else if press.key == .escape {
            selection = nil
            return .handled
        } else {
            return .ignored
        }
        selection = rows[next].id
        return .handled
    }
    private func coordinate(_ value: Decimal) -> Double { NSDecimalNumber(decimal: value).doubleValue }
    private func money(_ value: Decimal) -> String {
        MoneyText.text(value, currency: currency, settings: shell.settings, signed: false)
    }
}
