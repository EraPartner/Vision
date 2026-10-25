import SwiftUI
import VisionNativeCore

public struct ResearchForecastView: View {
    let model: ResearchForecastModel
    let shell: NativeShellModel
    @State private var assumptionsOpen = false
    @State private var width: CGFloat = 0
    @Environment(\.visionTheme) private var theme
    public init(model: ResearchForecastModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private var currency: String { shell.settings.defaultCurrency.isEmpty ? "EUR" : shell.settings.defaultCurrency }
    private var forecast: ResearchForecastData? {
        guard model.currency.caseInsensitiveCompare(currency) == .orderedSame,
            model.settings.numberFormat == shell.settings.numberFormat,
            let data = model.visibleForecast,
            data.currency == nil || data.currency?.caseInsensitiveCompare(currency) == .orderedSame
        else { return nil }
        return data
    }
    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VisionPageHeader(
                    title: strings.t("research.forecast.title"), subtitle: strings.t("research.forecast.subtitle"),
                    symbol: "chart.line.uptrend.xyaxis")
                controls
                if !model.contributionInvalid && !model.targetInvalid {
                    if model.error != nil {
                        ResearchCard {
                            VisionEmptyState(
                                symbol: "exclamationmark.triangle", title: strings.t("research.forecast.error")
                            ) {}
                        }
                    }
                    if let forecast = forecast, !forecast.available {
                        ResearchCard {
                            VisionEmptyState(
                                symbol: "exclamationmark.triangle",
                                title: strings.t(
                                    forecast.reason == "no_holdings"
                                        ? "research.forecast.noHoldings" : "research.forecast.insufficientHistory")
                            ) {}
                        }
                    } else {
                        summary
                        ResearchCard {
                            HStack {
                                Text(strings.t("research.forecast.chartTitle")).font(.researchCardTitle)
                                    .accessibilityAddTraits(.isHeader)
                                Spacer()
                                if forecast?.lowConfidence == true {
                                    Label(
                                        strings.t("research.forecast.lowConfidence"),
                                        systemImage: "exclamationmark.triangle"
                                    )
                                    .font(.caption).foregroundStyle(theme.warning)
                                }
                            }
                            ResearchForecastChart(
                                points: forecast?.points ?? [], currency: currency, shell: shell,
                                isLoading: model.isFetching && forecast == nil)
                        }
                        if let forecast = forecast, forecast.usedForward == true,
                            !forecast.forwardHoldings.isEmpty
                        {
                            ResearchCard(title: strings.t("research.forecast.forwardInputs")) {
                                Text(strings.t("research.forecast.forwardInputsHint")).font(.callout).foregroundStyle(
                                    theme.secondaryLabel)
                                LazyVGrid(
                                    columns: [GridItem(.adaptive(minimum: 180))], alignment: .leading, spacing: 10
                                ) {
                                    ForEach(forecast.forwardHoldings, id: \.symbol) { holding in
                                        HStack(spacing: 8) {
                                            Text(holding.symbol).font(.callout.monospaced())
                                            Text(
                                                ResearchForecastDisplay.percent(
                                                    holding.expectedAnnual, shell: shell, signed: true)
                                            )
                                            .monospacedDigit().foregroundStyle(
                                                holding.expectedAnnual >= 0 ? theme.gain : theme.loss)
                                        }.font(.caption).padding(8).background(
                                            theme.muted, in: RoundedRectangle(cornerRadius: 8))
                                    }
                                }
                            }
                        }
                    }
                }
            }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
        }
        .onGeometryChange(for: CGFloat.self) {
            $0.size.width
        } action: {
            width = $0
        }
    }
    private var controls: some View {
        ResearchCard {
            LazyVGrid(
                columns: Array(
                    repeating: GridItem(.flexible(), spacing: 24), count: width >= 1024 ? 3 : width >= 768 ? 2 : 1),
                alignment: .leading, spacing: 18
            ) {
                horizon
                contribution
                target
            }
            DisclosureGroup(isExpanded: $assumptionsOpen) {
                VStack(alignment: .leading, spacing: 18) {
                    Picker(strings.t("research.forecast.returnSource"), selection: binding(\.returnSource)) {
                        Text(strings.t("research.forecast.sourceHistorical")).tag("historical")
                        Text(strings.t("research.forecast.sourceBlended")).tag("blended")
                    }.pickerStyle(.segmented)
                    if model.returnSource == "blended" {
                        VStack(spacing: 8) {
                            HStack {
                                Text(
                                    String(100 - model.blendPct) + "% " + strings.t("research.forecast.blendHistorical")
                                )
                                Spacer()
                                Text(String(model.blendPct) + "% " + strings.t("research.forecast.blendForward"))
                            }.font(.caption).foregroundStyle(theme.secondaryLabel)
                            Slider(
                                value: Binding(get: { Double(model.blendPct) }, set: { model.blendPct = Int($0) }),
                                in: 0...100, step: 5
                            )
                            .accessibilityLabel(strings.t("research.forecast.blendLabel"))
                            .accessibilityValue(blendLabel)
                        }
                    }
                    Picker(strings.t("research.forecast.method"), selection: binding(\.method)) {
                        Text(strings.t("research.forecast.methodParametric")).tag("parametric")
                        Text(strings.t("research.forecast.methodBootstrap")).tag("block_bootstrap")
                    }.pickerStyle(.segmented)
                    Picker(strings.t("research.forecast.paths"), selection: binding(\.paths)) {
                        ForEach([500, 1000, 2000], id: \.self) { value in
                            Text(VisionFormat.integer(value, locale: shell.settings.numberFormat.locale)).tag(value)
                        }
                    }.pickerStyle(.segmented)
                }.padding(.top, 14)
            } label: {
                VStack(alignment: .leading, spacing: 5) {
                    Text(strings.t("research.forecast.assumptions")).font(.callout.weight(.medium))
                    Text(assumptionSummary).font(.caption).foregroundStyle(theme.secondaryLabel)
                }
            }
        }
    }
    private var horizon: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(strings.t("research.forecast.horizon")).font(.callout.weight(.medium))
            Picker(strings.t("research.forecast.horizon"), selection: binding(\.horizonMonths)) {
                ForEach([12, 36, 60, 120], id: \.self) { months in
                    Text(strings.t("research.forecast.h" + String(months / 12) + "y")).tag(months)
                }
            }.pickerStyle(.segmented).labelsHidden()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private var contribution: some View {
        decimalField(
            "research.forecast.monthlyContribution", text: binding(\.contributionText), placeholder: "0",
            invalid: model.contributionInvalid, errorKey: "research.forecast.contributionInvalid")
    }
    private var target: some View {
        decimalField(
            "research.forecast.targetValue", text: binding(\.targetText),
            placeholder: strings.t("research.forecast.targetPlaceholder"),
            invalid: model.targetInvalid, errorKey: "research.forecast.targetInvalid")
    }
    private func decimalField(
        _ key: String, text: Binding<String>, placeholder: String, invalid: Bool, errorKey: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(strings.t(key) + " (" + currency + ")").font(.callout.weight(.medium))
            TextField(placeholder, text: text).textFieldStyle(.vision).accessibilityLabel(
                strings.t(key) + " (" + currency + ")"
            )
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.control).stroke(invalid ? theme.destructive : .clear)
            )
            if invalid { Text(strings.t(errorKey)).font(.caption).foregroundStyle(theme.destructive) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private var blendLabel: String {
        strings.t(
            "research.forecast.blendValue",
            ["historical": String(100 - model.blendPct), "forward": String(model.blendPct)])
    }
    private var assumptionSummary: String {
        [
            strings.t(
                model.returnSource == "historical"
                    ? "research.forecast.sourceHistorical" : "research.forecast.sourceBlended")
                + (model.returnSource == "blended" ? " (" + blendLabel + ")" : ""),
            strings.t(
                model.method == "parametric"
                    ? "research.forecast.methodParametric" : "research.forecast.methodBootstrap"),
            strings.t("research.forecast.paths") + ": "
                + VisionFormat.integer(model.paths, locale: shell.settings.numberFormat.locale),
        ]
        .joined(separator: " · ")
    }
    private var summary: some View {
        let forecast = self.forecast
        return LazyVGrid(
            columns: Array(
                repeating: GridItem(.flexible(), spacing: 16), count: width >= 1024 ? 4 : width >= 640 ? 2 : 1),
            spacing: 16
        ) {
            ResearchForecastStat(
                title: strings.t("research.forecast.projectedMedian"),
                value: ResearchForecastDisplay.money(forecast?.projected?.p50, currency: currency, shell: shell),
                subtitle: forecast.map {
                    ResearchForecastDisplay.money($0.projected?.p10, currency: currency, shell: shell) + " – "
                        + ResearchForecastDisplay.money($0.projected?.p90, currency: currency, shell: shell)
                }, symbol: "wallet.pass", loading: model.isFetching && forecast == nil, rolling: true)
            ResearchForecastStat(
                title: strings.t("research.forecast.expectedReturn"),
                value: ResearchForecastDisplay.percent(forecast?.expectedAnnualReturn, shell: shell, signed: true),
                subtitle: strings.t(
                    forecast?.usedForward == true ? "research.forecast.blendedHint" : "research.forecast.historicalHint"
                ), symbol: "chart.line.uptrend.xyaxis", loading: model.isFetching && forecast == nil)
            ResearchForecastStat(
                title: strings.t("research.forecast.volatility"),
                value: ResearchForecastDisplay.percent(forecast?.annualVolatility, shell: shell),
                subtitle: strings.t("research.forecast.annualized"), symbol: "waveform.path",
                loading: model.isFetching && forecast == nil)
            ResearchForecastStat(
                title: strings.t(
                    forecast?.targetValue != nil
                        ? "research.forecast.probTarget" : "research.forecast.probBelowInvested"),
                value: ResearchForecastDisplay.percent(
                    forecast?.targetValue != nil ? forecast?.probTarget : forecast?.probBelowInvested, shell: shell),
                subtitle: ResearchForecastDisplay.money(
                    forecast?.targetValue ?? forecast?.netInvested, currency: currency, shell: shell),
                symbol: "target", loading: model.isFetching && forecast == nil)
        }
    }
    private func binding<Value>(_ key: ReferenceWritableKeyPath<ResearchForecastModel, Value>) -> Binding<Value> {
        Binding(get: { model[keyPath: key] }, set: { model[keyPath: key] = $0 })
    }
}

struct ResearchForecastStat: View {
    let title: String
    let value: String
    let subtitle: String?
    let symbol: String
    let loading: Bool
    var rolling = false
    @Environment(\.visionTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    init(title: String, value: String, subtitle: String?, symbol: String, loading: Bool, rolling: Bool = false) {
        self.title = title
        self.value = value
        self.subtitle = subtitle
        self.symbol = symbol
        self.loading = loading
        self.rolling = rolling
    }
    var body: some View {
        ResearchCard(padding: 20) {
            HStack(spacing: 8) {
                Text(title).font(.body.weight(.medium)).foregroundStyle(theme.secondaryLabel)
                Spacer(minLength: 0)
                Image(systemName: symbol).font(.callout).foregroundStyle(theme.tertiaryLabel).accessibilityHidden(true)
            }
            if loading {
                RoundedRectangle(cornerRadius: 5).fill(theme.muted).frame(width: 112, height: 30)
                    .accessibilityLabel(title)
            } else {
                RollingNumber(value: value, animate: rolling).font(Font.visionTitle1)
            }
            if let subtitle { Text(subtitle).font(.footnote).foregroundStyle(theme.secondaryLabel) }
        }
    }
}

@MainActor enum ResearchForecastDisplay {
    static func money(_ value: Decimal?, currency: String, shell: NativeShellModel) -> String {
        guard let value, !value.isNaN else { return "—" }
        return VisionFormat.currency(
            value, code: currency, locale: shell.settings.numberFormat.locale, fractionDigits: 0)
    }
    static func percent(_ fraction: Decimal?, shell: NativeShellModel, signed: Bool = false, compact: Bool = false)
        -> String
    {
        guard let fraction, !fraction.isNaN else { return "—" }
        let style = Decimal.FormatStyle.Percent(locale: shell.settings.numberFormat.locale).precision(
            compact ? .fractionLength(0...1) : .fractionLength(1)
        )
        .rounded(rule: .toNearestOrAwayFromZero)
        let result =
            signed ? fraction.formatted(style.sign(strategy: .always(includingZero: false))) : fraction.formatted(style)
        return compact ? result : result.replacingOccurrences(of: #"\s+%"#, with: "%", options: .regularExpression)
    }
}
