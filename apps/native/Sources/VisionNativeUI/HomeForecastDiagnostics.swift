import SwiftUI
import VisionNativeCore

struct HomeForecastDiagnostics: View {
    let model: HomeModel
    let settings: NativeAppSettings
    let strings: any Localizing
    @State private var selected: [String: String] = [:]
    @State private var range: [String: String] = [:]
    @Environment(\.dismiss) private var dismiss
    @Environment(\.visionTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text(strings.t("cashflow.diagnostics.title")).font(.visionCardTitle)
                    Spacer()
                    Button(strings.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
                }
                if model.isForecastLoading {
                    ProgressView()
                } else if let diagnostics = model.forecast?.diagnostics {
                    Text(
                        strings.t("cashflow.diagnostics.desc", ["months": String(diagnostics.history_months)])
                    ).foregroundStyle(theme.secondaryLabel)
                    Text(strings.t("cashflow.diagnostics.accuracy")).font(.headline)
                    accuracy(diagnostics)
                    Text(
                        strings.t(
                            "cashflow.diagnostics.backtestNote",
                            [
                                "n": String(diagnostics.history_months),
                                "currency": model.forecast?.currency ?? settings.defaultCurrency,
                            ])
                    ).font(.footnote).foregroundStyle(theme.secondaryLabel)
                    Text(strings.t("cashflow.diagnostics.suggestedWeights")).font(.headline)
                    Text(strings.t("cashflow.diagnostics.weightsNote")).font(.footnote).foregroundStyle(
                        theme.secondaryLabel)
                    let weights = diagnostics.suggestedWeights
                    let maxWeight = weights.values.max() ?? 1
                    ForEach(diagnostics.backtest.sorted { $0.mae < $1.mae }) { method in
                        if let weight = weights[method.id] {
                            HStack {
                                Text(method.label)
                                Spacer()
                                Text(
                                    VisionFormat.decimal(
                                        100 * weight, fractionDigits: 1, locale: settings.numberFormat.locale) + "%")
                            }
                            ProgressView(value: NSDecimalNumber(decimal: weight / maxWeight).doubleValue).tint(
                                theme.primary)
                        }
                    }
                } else {
                    Text(model.forecastError ?? strings.t("cashflow.loadError")).foregroundStyle(
                        theme.secondaryLabel)
                    Button(strings.t("common.retry")) { Task { await model.loadDiagnostics() } }
                }
            }.padding(24)
        }.frame(width: 720, height: 660)
            .task { await model.loadDiagnostics() }
            .onDisappear { model.forecastOptions.diagnostics = false }
    }

    private func accuracy(_ diagnostics: InsightForecast.Diagnostics) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 10) {
                GridRow {
                    Text(strings.t("cashflow.diagnostics.rank"))
                    Text(strings.t("cashflow.diagnostics.method"))
                    Text("MAE")
                    Text("RMSE")
                    Text("MAPE")
                    Text(strings.t("cashflow.diagnostics.months"))
                }.font(.caption.weight(.semibold)).foregroundStyle(theme.secondaryLabel)
                ForEach(
                    Array(diagnostics.backtest.sorted { $0.mae < $1.mae }.enumerated()), id: \.element.id
                ) { index, method in
                    GridRow {
                        Text("#\(index + 1)").foregroundStyle(index == 0 ? theme.warning : theme.secondaryLabel)
                        Text(method.label)
                        amount(method.mae)
                        amount(method.rmse)
                        Text(
                            method.mape.map {
                                $0 > 9999
                                    ? "—"
                                    : VisionFormat.decimal(
                                        $0, fractionDigits: 1, locale: settings.numberFormat.locale) + "%"
                            } ?? "—")
                        Text(String(method.months))
                    }.font(.caption)
                }
            }
            .padding(12)
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                    .strokeBorder(theme.border.opacity(0.6)))
            ForEach(diagnostics.backtest.sorted { $0.mae < $1.mae }) { method in
                let persisted = model.forecastAccuracy?.methods.first { $0.id == method.id }
                let history = persisted?.history ?? method.per_month
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(method.label).font(.caption.weight(.medium))
                        if persisted != nil {
                            Text(strings.t("cashflow.diagnostics.persistedHistory")).font(.caption)
                                .foregroundStyle(theme.secondaryLabel)
                        }
                    }
                    InsightTimelineChart(
                        series: [
                            InsightChartSeries(
                                id: method.id, label: "MAE",
                                points: history.map { InsightChartPoint(key: $0.month, value: $0.mae) })
                        ],
                        currency: model.forecast?.currency ?? settings.defaultCurrency, settings: settings,
                        title: strings.t("cashflow.diagnostics.maeTrend"), height: 70,
                        selection: Binding(get: { selected[method.id] }, set: { selected[method.id] = $0 }),
                        rangeStart: Binding(get: { range[method.id] }, set: { range[method.id] = $0 }))
                }
            }
        }
    }
    private func amount(_ value: Decimal) -> some View {
        MoneyText(
            amount: value, currency: model.forecast?.currency ?? settings.defaultCurrency,
            settings: settings, signed: false, colored: false)
    }
}
