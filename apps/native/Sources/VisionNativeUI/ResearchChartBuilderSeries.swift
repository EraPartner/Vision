import SwiftUI
import VisionNativeCore

struct ResearchChartBuilderSeriesView: View {
    @Bindable var model: ResearchChartBuilderModel
    let shell: NativeShellModel
    @State private var showsEconomicHelp = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private let providers = ["", "yahoo", "twelve_data", "finnhub", "fmp", "alpha_vantage"]
    var body: some View {
        ResearchCard(title: strings.t("research.builder.series")) {
            Text(strings.t("research.builder.startHelp")).font(.callout).foregroundStyle(theme.secondaryLabel)
            ForEach(Array(model.state.series.enumerated()), id: \.element.id) { index, series in
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Circle().fill(ResearchCompareStyle.color(index, palette: theme.palette)).frame(
                            width: 10, height: 10
                        ).accessibilityHidden(true)
                        Text(series.macro?.title ?? series.symbol).font(.callout.weight(.medium)).lineLimit(2).visionTooltip(
                            series.macro?.title ?? series.symbol)
                        if series.field == "volume" {
                            Text(strings.t("research.builder.volume")).font(.caption).foregroundStyle(
                                theme.secondaryLabel)
                        }
                        Spacer()
                        Menu {
                            Button(strings.t("research.builder.removeSeries"), role: .destructive) {
                                model.removeSeries(id: series.id)
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                        }
                        .menuIndicator(.hidden).accessibilityLabel(strings.t("research.builder.seriesMenu", ["name": label(series)]))
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) { seriesControls(series) }
                        VStack(alignment: .leading, spacing: 10) { seriesControls(series) }
                    }
                }.padding(.vertical, 8)
            }
            if model.state.series.count < 5 { ResearchChartBuilderSearchView(model: model, shell: shell) }
            DisclosureGroup(isExpanded: $showsEconomicHelp) {
                Text(strings.t("research.builder.economicHint")).font(.callout).foregroundStyle(theme.secondaryLabel)
                    .padding(.top, 8)
            } label: {
                Text(strings.t("research.builder.sourceHelp")).font(.callout)
            }
            if model.state.series.contains(where: { $0.field == "price" }) {
                ResearchChartBuilderIndicatorsView(model: model, shell: shell)
            }
        }.disabled(!model.isStorageLoaded || model.isStorageAction).zIndex(model.isSearchOpen ? 20 : 0)
    }
    @ViewBuilder private func seriesControls(_ series: ResearchChartBuilderSeries) -> some View {
        if series.field != "volume" {
            VisionSelect(
                selection: field(series, \.type), options: typeOptions(series),
                accessibilityLabel: strings.t("customChart.chartType") + ": " + label(series)
            ).frame(minWidth: 110)
        }
        VisionSelect(
            selection: field(series, \.axis),
            options: [
                VisionSelectOption(value: "left", title: strings.t("research.builder.axisLeft")),
                VisionSelectOption(value: "right", title: strings.t("research.builder.axisRight")),
            ], accessibilityLabel: strings.t("research.builder.axisLabel") + ": " + label(series)
        ).frame(minWidth: 120)
        if let macro = series.macro {
            VisionBadge(text: macro.provider.capitalized, tone: .secondary, small: true)
                .accessibilityLabel(strings.t("research.builder.providerLabel") + ": " + macro.provider)
        } else {
            VisionSelect(
                selection: field(series, \.provider), options: providerOptions,
                accessibilityLabel: strings.t("research.builder.providerLabel") + ": " + label(series)
            ).frame(minWidth: 150)
        }
    }
    private func typeOptions(_ series: ResearchChartBuilderSeries) -> [VisionSelectOption<String>] {
        var options = [
            VisionSelectOption(value: "line", title: strings.t("research.builder.type.line")),
            VisionSelectOption(value: "area", title: strings.t("research.builder.type.area")),
        ]
        if series.macro == nil {
            options.append(
                VisionSelectOption(value: "candlestick", title: strings.t("research.builder.type.candlestick")))
        }
        return options
    }
    private var providerOptions: [VisionSelectOption<String>] {
        providers.map { provider in
            VisionSelectOption(
                value: provider,
                title: provider.isEmpty
                    ? strings.t("research.builder.providerAuto") : provider.replacingOccurrences(of: "_", with: " "))
        }
    }
    private func field(
        _ series: ResearchChartBuilderSeries, _ path: WritableKeyPath<ResearchChartBuilderSeries, String>
    ) -> Binding<String> {
        .init(
            get: { model.state.series.first { $0.id == series.id }?[keyPath: path] ?? series[keyPath: path] },
            set: { value in model.updateSeries(id: series.id) { $0[keyPath: path] = value } })
    }
    private func label(_ series: ResearchChartBuilderSeries) -> String {
        (series.macro?.title ?? series.symbol)
            + (series.field == "volume" ? " (" + strings.t("research.builder.volume") + ")" : "")
    }
}

struct ResearchChartBuilderIndicatorsView: View {
    @Bindable var model: ResearchChartBuilderModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            Text(strings.t("research.builder.indicators")).font(.headline)
            Text(strings.t("research.builder.indicatorHelp")).font(.caption).foregroundStyle(theme.secondaryLabel)
            HStack {
                ForEach(["sma", "ema", "bollinger"], id: \.self) { type in
                    Button {
                        model.addIndicator(type: type)
                    } label: {
                        Label(type.uppercased(), systemImage: "plus")
                    }.buttonStyle(.vision(.outline, size: .sm)).disabled(model.state.indicators.count >= 20)
                }
            }
            ForEach(model.state.indicators) { indicator in
                HStack {
                    let name = indicator.type == "bollinger" ? "BB" : indicator.type.uppercased()
                    Text(name).font(.callout.monospaced().weight(.medium)).frame(width: 55, alignment: .leading)
                    Text(strings.t("research.builder.period")).font(.caption).foregroundStyle(theme.secondaryLabel)
                    TextField(
                        "",
                        text: Binding(
                            get: {
                                String(
                                    model.state.indicators.first { $0.id == indicator.id }?.period ?? indicator.period)
                            },
                            set: { raw in
                                model.setIndicatorPeriod(id: indicator.id, raw: raw)
                            })
                    ).textFieldStyle(.vision).multilineTextAlignment(.center).frame(width: 75)
                        .onKeyPress(.upArrow) {
                            model.setIndicatorPeriod(id: indicator.id, raw: String(indicator.period + 1))
                            return .handled
                        }
                        .onKeyPress(.downArrow) {
                            model.setIndicatorPeriod(id: indicator.id, raw: String(indicator.period - 1))
                            return .handled
                        }
                        .accessibilityLabel(strings.t("research.builder.indicatorPeriod", ["indicator": name]))
                    Menu {
                        Button(strings.t("research.builder.removeIndicator"), role: .destructive) {
                            model.removeIndicator(id: indicator.id)
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .menuIndicator(.hidden).accessibilityLabel(
                        strings.t(
                            "research.builder.indicatorMenu",
                            ["indicator": name + " (" + String(indicator.period) + ")"]))
                }.frame(maxWidth: 430, alignment: .leading)
            }
        }
    }
}
