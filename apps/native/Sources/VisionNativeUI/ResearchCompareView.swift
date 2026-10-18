import SwiftUI
import VisionNativeCore

public struct ResearchCompareView: View {
    @Bindable var model: ResearchCompareModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    public init(model: ResearchCompareModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "chart.line.uptrend.xyaxis").font(.title2).foregroundStyle(theme.primary)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(strings.t("research.compare.title")).font(.largeTitle.weight(.semibold))
                            .accessibilityAddTraits(.isHeader)
                        Text(strings.t("research.compare.subtitle")).foregroundStyle(theme.secondaryLabel)
                    }
                }
                VStack(alignment: .leading, spacing: 10) {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { selectedSymbols }
                        VStack(alignment: .leading, spacing: 8) { selectedSymbols }
                    }.accessibilityLabel(strings.t("research.compare.selected"))
                    if model.state.symbols.count < ResearchCompareURLState.maximumSymbols {
                        ResearchSymbolSearchView(
                            text: Binding(get: { model.search.searchText }, set: { model.search.searchText = $0 }),
                            items: model.search.items, isOpen: model.search.isOpen,
                            isFetching: model.search.isSearching,
                            isUnavailable: model.search.meta?.source == "unavailable",
                            isError: model.search.error != nil,
                            provider: model.search.meta?.provider,
                            placeholder: strings.t("research.compare.addPlaceholder"), shell: shell,
                            onSelect: { item in
                                if let symbol = item.symbol { replace(model.addSymbol(symbol)) }
                            })
                    }
                }
                if model.state.symbols.isEmpty {
                    ResearchCard {
                        VStack(spacing: 8) {
                            Image(systemName: "chart.line.uptrend.xyaxis").font(.largeTitle).foregroundStyle(
                                theme.secondaryLabel
                            ).accessibilityHidden(true)
                            Text(strings.t("research.compare.startTitle")).font(.headline)
                            Text(strings.t("research.compare.startHint")).foregroundStyle(theme.secondaryLabel)
                        }.padding(.vertical, 28).frame(maxWidth: .infinity)
                    }
                } else {
                    Picker(
                        strings.t("research.compare.title"),
                        selection: Binding(get: { model.state.tab }, set: { replace(model.selectTab($0)) })
                    ) {
                        Text(strings.t("research.compare.tabPerformance")).tag("performance")
                        Text(strings.t("research.compare.tabFundamentals")).tag("fundamentals")
                    }.pickerStyle(.segmented).frame(maxWidth: 440)
                    if model.state.tab == "fundamentals" {
                        ResearchCompareFundamentalsView(model: model, shell: shell)
                    } else {
                        performance
                    }
                }
            }.padding(24).frame(maxWidth: 1500, alignment: .leading).frame(maxWidth: .infinity)
        }
    }
    private var selectedSymbols: some View {
        Group {
            if model.state.symbols.isEmpty {
                Text(strings.t("research.compare.empty")).font(.callout).foregroundStyle(theme.secondaryLabel)
            }
            ForEach(Array(model.state.symbols.enumerated()), id: \.element) { index, symbol in
                HStack(spacing: 6) {
                    Circle().fill(ResearchCompareStyle.color(index, palette: theme.palette)).frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                    Text(symbol).font(.callout.monospaced())
                    Button {
                        replace(model.removeSymbol(symbol))
                    } label: {
                        Image(systemName: "xmark").font(.caption)
                    }
                    .buttonStyle(.plain).accessibilityLabel(
                        strings.t("research.compare.removeSymbol", ["symbol": symbol]))
                }.padding(.horizontal, 10).padding(.vertical, 7)
                    .background(theme.foreground.opacity(0.055), in: Capsule())
            }
        }
    }
    private var performance: some View {
        VStack(alignment: .leading, spacing: 20) {
            ResearchCard {
                HStack {
                    Text(strings.t("research.compare.rebased")).font(.headline).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Picker(
                        strings.t("research.compare.rebased"),
                        selection: Binding(get: { model.state.range }, set: { replace(model.selectRange($0)) })
                    ) {
                        ForEach(ResearchCompareURLState.ranges, id: \.self) { range in
                            Text(strings.t("research.range." + range)).tag(range)
                        }
                    }.pickerStyle(.segmented).frame(maxWidth: 360)
                }
                Text(strings.t("research.compare.rebasedHint")).font(.callout).foregroundStyle(theme.secondaryLabel)
                if model.isLoading || model.isPreparing && model.presentation == nil {
                    ProgressView().frame(maxWidth: .infinity).frame(height: 340).accessibilityLabel(
                        strings.t("common.loading"))
                } else if let data = model.presentation, !data.rows.isEmpty {
                    ResearchCompareChartView(data: data, shell: shell)
                } else {
                    Text(strings.t("market.noChartData")).foregroundStyle(theme.secondaryLabel).frame(
                        maxWidth: .infinity
                    ).frame(height: 340)
                }
                if let error = model.presentationError {
                    Text(error).font(.callout).foregroundStyle(theme.destructive).textSelection(.enabled)
                }
            }
            ResearchCompareStatisticsView(model: model, shell: shell)
            if model.state.symbols.count >= 2 {
                ResearchCompareCorrelationView(model: model, shell: shell)
            }
        }
    }
    private func replace(_ route: NativeRoute) { shell.replace(with: route.string) }
}

enum ResearchCompareStyle {
    static func color(_ index: Int, palette: ThemePalette) -> Color {
        let colors = [palette.chart1, palette.chart2, palette.chart3, palette.chart4, palette.chart5, palette.chart6]
        return Color(token: colors[index % colors.count])
    }
    static func fixed(_ value: Decimal?, digits: Int = 2) -> String {
        guard let value, !value.isNaN else { return "—" }
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = false
        formatter.minimumFractionDigits = digits
        formatter.maximumFractionDigits = digits
        formatter.roundingMode = .halfUp
        return formatter.string(from: NSDecimalNumber(decimal: value)) ?? VisionFormat.plain(value)
    }
    static func percent(_ value: Decimal?, settings: NativeAppSettings, signed: Bool = false) -> String {
        guard let value, !value.isNaN else { return "—" }
        let display = value * 100  // Presentation scaling only; the server supplies the fraction.
        let style = Decimal.FormatStyle(locale: settings.numberFormat.locale).precision(.fractionLength(2)).rounded(
            rule: .toNearestOrAwayFromZero)
        return display.formatted(signed ? style.sign(strategy: .always(includingZero: false)) : style) + "%"
    }
    static func compact(_ value: Decimal?) -> String {
        guard let value, !value.isNaN else { return "—" }
        let absolute = value < 0 ? -value : value
        for (threshold, suffix) in [
            (Decimal(1_000_000_000_000), "T"), (Decimal(1_000_000_000), "B"), (Decimal(1_000_000), "M"),
        ] {
            if absolute >= threshold { return fixed(value / threshold) + suffix }
        }
        return VisionFormat.plain(value)
    }
    static func date(_ timestamp: Decimal) -> Date {
        Date(timeIntervalSince1970: NSDecimalNumber(decimal: timestamp).doubleValue / 1000)
    }
    static func dateLabel(_ timestamp: Decimal, settings: NativeAppSettings) -> String {
        VisionFormat.appDate(date(timestamp), format: settings.dateFormat, timeZone: .current)
    }
}
