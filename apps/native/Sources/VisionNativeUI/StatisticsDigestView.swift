import SwiftUI
import VisionNativeCore

struct StatisticsDigestView: View {
    let model: StatisticsDigestModel
    let settings: NativeAppSettings
    let strings: any Localizing
    var isPrinting = false
    @Environment(\.visionTheme) private var theme

    var body: some View {
        if model.isLoading {
            ProgressView().padding()
        } else if let data = model.data {
            AdminCard(padding: VisionPageLayout.padding) {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text(strings.t("insights.panel.title")).font(Font.visionTitle3)
                        Spacer()
                        if data.findingCount > 0, !isPrinting {
                            Button(
                                strings.t(model.expanded ? "insights.panel.hideDetails" : "insights.panel.showDetails")
                            ) { model.expanded.toggle() }
                        }
                    }
                    Text(strings.t("insights.panel.desc")).foregroundStyle(theme.secondaryLabel)
                    if let cash = data.cashForecast {
                        HStack {
                            Text(strings.t("insights.panel.cashForecast"))
                            Spacer()
                            MoneyText(amount: cash.monthEndNetCashflow, currency: cash.currency, settings: settings)
                        }
                        if let low = cash.monthEndNetCashflowLow, let high = cash.monthEndNetCashflowHigh {
                            HStack {
                                amount(low, currency: cash.currency)
                                Text("–")
                                amount(high, currency: cash.currency)
                            }.font(.caption)
                        }
                    }
                    if data.findingCount == 0 && data.cashForecast == nil {
                        Text(strings.t("insights.panel.empty")).foregroundStyle(theme.secondaryLabel)
                    }
                    if model.expanded {
                        ForEach(data.subscriptionCreep.new) { row in
                            finding(
                                title: row.recipientName, kind: "insights.panel.newSubscriptions", body: row.dismissal,
                                key: "new:\(row.id)"
                            ) {
                                Text(strings.t("recurring.pattern.\(row.detectedPattern)")).font(.caption)
                                amount(row.latestAmount, currency: row.currency)
                            }
                        }
                        ForEach(data.subscriptionCreep.priceChanges) { row in
                            finding(
                                title: row.recipientName, kind: "insights.panel.priceChanges", body: row.dismissal,
                                key: "price:\(row.id)"
                            ) {
                                amount(row.previousAmount, currency: row.currency)
                                Image(systemName: "arrow.right")
                                amount(row.newAmount, currency: row.currency)
                                DeltaPill(
                                    row.percentChange,
                                    label: VisionFormat.decimal(
                                        row.percentChange, fractionDigits: 1, locale: settings.numberFormat.locale)
                                        + "%",
                                    invert: true)
                            }
                        }
                        ForEach(data.categoryOutliers) { row in
                            finding(
                                title: row.categoryName, kind: "insights.panel.categoryOverspend", body: row.dismissal,
                                key: "outlier:\(row.id)"
                            ) {
                                amount(row.currentAmount, currency: settings.defaultCurrency)
                                Text(
                                    strings.t(
                                        "insights.panel.vsTypical",
                                        [
                                            "day": String(row.comparisonEndDay),
                                            "amount": MoneyText.text(
                                                row.baselineMedian, currency: settings.defaultCurrency,
                                                settings: settings, signed: false),
                                        ])
                                )
                                .font(.caption)
                            }
                        }
                    }
                    if let error = model.error { Text(error).foregroundStyle(theme.destructive).font(.caption) }
                }
            }
        } else if let error = model.error {
            Text(error).foregroundStyle(theme.destructive)
        }
    }
    private func amount(_ value: Decimal, currency: String) -> some View {
        MoneyText(amount: value, currency: currency, settings: settings, signed: false, colored: false)
    }
    private func finding<Content: View>(
        title: String, kind: String, body: JSONValue, key: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(strings.t(kind)).font(.caption).foregroundStyle(theme.secondaryLabel)
                Text(title).fontWeight(.medium)
            }
            Spacer()
            content()
            if !isPrinting {
                Button {
                    Task { await model.dismiss(body, key: key) }
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.plain).disabled(model.dismissing.contains(key))
                .accessibilityLabel(strings.t("insights.dismissFinding", ["kind": strings.t(kind), "name": title]))
            }
        }.padding(.vertical, 4)
    }
}
