import SwiftUI
import VisionNativeCore

struct HomeForecastDiagnostics: View {
    let model: HomeModel
    let settings: NativeAppSettings
    let strings: any Localizing
    @Environment(\.visionDismissDialog) private var dismiss
    @Environment(\.visionTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VisionDialogHeader(
                    title: strings.t("cashflow.diagnostics.title"), closeLabel: strings.t("common.close"),
                    onClose: { dismiss() })
                .keyboardShortcut(.cancelAction)
                if model.isForecastLoading {
                    ProgressView()
                } else if let diagnostics = model.forecast?.diagnostics {
                    let ranked = diagnostics.backtest.sorted { $0.mae < $1.mae }
                    let hasPersisted = !(model.forecastAccuracy?.methods.isEmpty ?? true)
                    Text(
                        strings.t("cashflow.diagnostics.desc", ["months": String(diagnostics.history_months)])
                    ).foregroundStyle(theme.secondaryLabel)
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 8) {
                            Text(strings.t("cashflow.diagnostics.accuracy")).font(.headline)
                                .accessibilityAddTraits(.isHeader)
                            Spacer(minLength: 8)
                            if hasPersisted {
                                Label(strings.t("cashflow.diagnostics.persistedHistory"), systemImage: "cylinder.split.1x2")
                                    .font(.caption).foregroundStyle(theme.secondaryLabel)
                            }
                        }
                        accuracy(ranked)
                        Text(
                            hasPersisted
                                ? strings.t("cashflow.diagnostics.backtestNoteWithHistory")
                                : strings.t(
                                    "cashflow.diagnostics.backtestNote",
                                    ["n": String(diagnostics.history_months), "currency": currency.rawValue])
                        ).font(.footnote).foregroundStyle(theme.secondaryLabel)
                    }
                    // The weights the ensemble applied, computed on the server.
                    let weights = diagnostics.ensemble_weights ?? [:]
                    if !weights.isEmpty {
                        let topWeight = max(weights.values.max() ?? 0, 0)
                        VStack(alignment: .leading, spacing: 8) {
                            Text(strings.t("cashflow.diagnostics.suggestedWeights")).font(.headline)
                                .accessibilityAddTraits(.isHeader)
                            Text(strings.t("cashflow.diagnostics.weightsNote")).font(.footnote).foregroundStyle(
                                theme.secondaryLabel
                            )
                            .padding(.bottom, 4)
                            ForEach(ranked) { method in
                                if let weight = weights[method.id] {
                                    weightRow(method, weight: weight, topWeight: topWeight)
                                }
                            }
                        }
                    }
                } else {
                    Text(model.forecastError ?? strings.t("cashflow.loadError")).foregroundStyle(
                        theme.secondaryLabel)
                    Button(strings.t("common.retry")) { Task { await model.loadDiagnostics() } }
                        .buttonStyle(.visionOutline)
                }
            }.padding(24)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .task { await model.loadDiagnostics() }
            .onDisappear { model.forecastOptions.diagnostics = false }
    }

    private var currency: CurrencyCode { model.forecast?.currency ?? LedgerCurrency.display(settings) }

    /// `METHOD_COLORS`: each forecasting method keeps its chart colour; an unknown one takes the eighth.
    private func color(_ method: String) -> Color {
        let order = [
            "simple_avg", "weighted_avg", "ewma", "holt_winters", "prophet_lite", "monte_carlo_parametric",
            "monte_carlo_block_bootstrap",
        ]
        let colors = theme.chartColors
        let index = order.firstIndex(of: method) ?? 7
        return index < colors.count ? colors[index] : theme.primary
    }

    /// The accuracy `<Table>` in its bordered frame: method, MAE, RMSE, MAPE, months, rank, MAE trend.
    private func accuracy(_ ranked: [InsightForecast.Backtest]) -> some View {
        VisionTable(
            columns: [.leading, .trailing, .trailing, .trailing, .trailing, .leading, .leading], columnSpacing: 20,
            fixedColumns: [6]
        ) {
            Group {
                Text(strings.t("cashflow.diagnostics.method"))
                Text(verbatim: "MAE")
                Text(verbatim: "RMSE")
                Text(verbatim: "MAPE")
                Text(strings.t("cashflow.diagnostics.months"))
                Text(strings.t("cashflow.diagnostics.rank"))
                Text(strings.t("cashflow.diagnostics.maeTrend"))
            }
            .font(.footnote.weight(.medium)).foregroundStyle(theme.secondaryLabel).lineLimit(1)
            .padding(.vertical, 10)
            .accessibilityAddTraits(.isHeader)
            ForEach(Array(ranked.enumerated()), id: \.element.id) { index, method in
                VisionTableDivider()
                Group {
                    HStack(spacing: 8) {
                        Circle().fill(color(method.id)).frame(width: 10, height: 10).accessibilityHidden(true)
                        Text(method.label).fontWeight(.medium).lineLimit(2)
                    }
                    amount(method.mae)
                    amount(method.rmse)
                    Text(mapeText(method.mape)).monospacedDigit()
                    Text(String(method.months)).monospacedDigit().foregroundStyle(theme.secondaryLabel)
                    rank(index + 1)
                    trend(method)
                }
                .padding(.vertical, 8)
            }
        }
        .padding(.horizontal, 16)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                .strokeBorder(theme.border.opacity(0.6)))
    }

    /// MAPE to one decimal; "N/A" without one or above 9999 %, as on the web.
    private func mapeText(_ mape: Decimal?) -> String {
        guard let mape, mape <= 9999 else { return "N/A" }
        return VisionFormat.percent(mape, digits: 1, locale: settings.numberFormat.locale)
    }

    /// `RankBadge`: a warning badge for the best method, muted for the next two, plain text after.
    @ViewBuilder
    private func rank(_ rank: Int) -> some View {
        if rank <= 3 {
            VisionBadge(text: "#\(rank)", tone: rank == 1 ? .warning : .muted, small: true)
        } else {
            Text(verbatim: "#\(rank)").font(.footnote).foregroundStyle(theme.secondaryLabel)
        }
    }

    /// The MAE sparkline (`w-24`, 24 pt tall): the persisted history when there is one, else
    /// the backtest's own months.
    @ViewBuilder
    private func trend(_ method: InsightForecast.Backtest) -> some View {
        let persisted = model.forecastAccuracy?.methods.first { $0.id == method.id }?.history
        let history = (persisted?.count ?? 0) > 1 ? persisted ?? [] : method.per_month
        let values = history.map { NSDecimalNumber(decimal: $0.mae).doubleValue }
        if values.count > 1 {
            ForecastSparkline(values: values)
                .stroke(color(method.id), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                .frame(width: 96, height: 24)
                .accessibilityLabel(strings.t("cashflow.diagnostics.maeTrend"))
        } else {
            Text(verbatim: "—").font(.footnote).foregroundStyle(theme.secondaryLabel).frame(width: 96, alignment: .leading)
        }
    }

    /// One ensemble weight: the method's dot and name (`w-44`), its bar against the largest
    /// weight and the rounded percentage.
    private func weightRow(_ method: InsightForecast.Backtest, weight: Decimal, topWeight: Decimal) -> some View {
        let share = topWeight > 0 ? NSDecimalNumber(decimal: weight / topWeight).doubleValue : 0
        let percent = Int((NSDecimalNumber(decimal: weight).doubleValue * 100).rounded())
        return HStack(spacing: 12) {
            Circle().fill(color(method.id)).frame(width: 8, height: 8).accessibilityHidden(true)
            Text(method.label).font(.footnote).lineLimit(1).truncationMode(.tail)
                .frame(width: 176, alignment: .leading)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(theme.foreground.opacity(0.08))
                    Capsule().fill(color(method.id)).frame(width: proxy.size.width * min(1, max(0, share)))
                }
            }
            .frame(height: 6)
            Text(verbatim: "\(percent)%").font(.footnote).monospacedDigit().foregroundStyle(theme.secondaryLabel)
                .frame(width: 36, alignment: .trailing)
        }
        .accessibilityElement(children: .combine)
    }

    private func amount(_ value: Decimal) -> some View {
        MoneyText(
            amount: value, currency: currency, settings: settings, signed: false, colored: false)
    }
}

/// `Sparkline` (components/charts/Sparkline.tsx): the values across the width, the range padded
/// by a tenth and inset 2 pt top and bottom.
private struct ForecastSparkline: Shape {
    let values: [Double]

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard values.count > 1, let low = values.min(), let high = values.max() else { return path }
        let pad = high != low ? (high - low) * 0.1 : 1
        let bottom = low - pad
        let span = (high + pad) - bottom
        for (index, value) in values.enumerated() {
            let x = rect.minX + rect.width * CGFloat(index) / CGFloat(values.count - 1)
            let y = rect.maxY - 2 - (rect.height - 4) * CGFloat((value - bottom) / span)
            if index == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
        }
        return path
    }
}
