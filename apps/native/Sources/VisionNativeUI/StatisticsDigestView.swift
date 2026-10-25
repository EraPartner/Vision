import SwiftUI
import VisionNativeCore

/// InsightsDigestPanel: a card titled with the number of things worth a look, a collapsed
/// summary of the finding kinds, the findings themselves in inset lists once expanded, and the
/// month-end cash forecast as a standing alert row.
struct StatisticsDigestView: View {
    let model: StatisticsDigestModel
    let settings: NativeAppSettings
    let strings: any Localizing
    var isPrinting = false
    @Environment(\.visionTheme) private var theme

    var body: some View {
        if model.isLoading {
            InsightsCard(title: strings.t("insights.panel.loading")) {
                ProgressView().frame(maxWidth: .infinity)
            }
        } else if let data = model.data {
            if data.findingCount == 0 && data.cashForecast == nil {
                emptyCard
            } else {
                panel(data)
            }
        } else if let error = model.error {
            Text(error).foregroundStyle(theme.destructive)
        }
    }

    // MARK: Card

    /// Nothing to report: a dashed card with a check mark.
    private var emptyCard: some View {
        let shape = RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
        return HStack(spacing: 12) {
            Image(systemName: "checkmark.circle").font(.system(size: 18))
                .foregroundStyle(Color(token: theme.palette.accent)).accessibilityHidden(true)
            Text(strings.t("insights.panel.empty")).fontWeight(.medium).foregroundStyle(theme.foreground)
            Spacer(minLength: 0)
        }
        .padding(VisionPageLayout.padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(shape.fill(theme.card.opacity(0.7)))
        .overlay(shape.strokeBorder(theme.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        .accessibilityElement(children: .combine)
    }

    /// The header badge counts findings plus a forecast that is an alert.
    private func badgeCount(_ data: StatisticsDigest) -> Int {
        data.findingCount + (data.cashForecast?.prominence == .alert ? 1 : 0)
    }

    private func panel(_ data: StatisticsDigest) -> some View {
        let count = badgeCount(data)
        return InsightsCard(
            title: strings.t("insights.panel.title"), subtitle: strings.t("insights.panel.desc"),
            badge: count > 0 ? String(count) : nil,
            actions: {
                if data.findingCount > 0, !isPrinting { toggleButton }
            },
            content: { panelBody(data) })
    }

    private var toggleButton: some View {
        Button {
            model.expanded.toggle()
        } label: {
            HStack(spacing: 8) {
                Text(strings.t(model.expanded ? "insights.panel.hideDetails" : "insights.panel.showDetails"))
                Image(systemName: model.expanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 11, weight: .semibold)).accessibilityHidden(true)
            }
        }
        .buttonStyle(.vision(.ghost, size: .sm))
    }

    private func panelBody(_ data: StatisticsDigest) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if model.expanded {
                findings(data)
            } else {
                summary(data)
            }
            if let cash = data.cashForecast { forecast(cash) }
            if let error = model.error { Text(error).foregroundStyle(theme.destructive).font(.caption) }
        }
    }

    // MARK: Collapsed summary

    private struct SummaryItem: Identifiable {
        let label: String
        let count: Int
        var id: String { label }
    }

    private func summaryItems(_ data: StatisticsDigest) -> [SummaryItem] {
        [
            SummaryItem(label: strings.t("insights.panel.newSubscriptions"), count: data.subscriptionCreep.new.count),
            SummaryItem(label: strings.t("insights.panel.priceChanges"), count: data.subscriptionCreep.priceChanges.count),
            SummaryItem(label: strings.t("insights.panel.categoryOverspend"), count: data.categoryOutliers.count),
        ].filter { $0.count > 0 }
    }

    @ViewBuilder private func summary(_ data: StatisticsDigest) -> some View {
        let items = summaryItems(data)
        if !items.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 20) {
                ForEach(items) { item in
                    HStack(spacing: 8) {
                        Text(String(item.count)).fontWeight(.medium).monospacedDigit()
                            .foregroundStyle(theme.foreground)
                        Text(item.label)
                    }
                }
                Spacer(minLength: 0)
            }
            .font(.callout).foregroundStyle(theme.secondaryLabel)
        }
    }

    // MARK: Findings

    private func findings(_ data: StatisticsDigest) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            if !data.subscriptionCreep.new.isEmpty { newSubscriptions(data.subscriptionCreep.new) }
            if !data.subscriptionCreep.priceChanges.isEmpty { priceChanges(data.subscriptionCreep.priceChanges) }
            if !data.categoryOutliers.isEmpty { overspend(data.categoryOutliers) }
        }
    }

    private func section<Rows: View>(_ title: String, @ViewBuilder rows: () -> Rows) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(strings.t(title)).font(.headline).foregroundStyle(theme.foreground)
                .accessibilityAddTraits(.isHeader)
            rows()
        }
    }

    private func insetList<Row: Identifiable, RowView: View>(
        _ rows: [Row], @ViewBuilder row: @escaping (Row) -> RowView
    ) -> some View {
        InsightsInsetList {
            ForEach(rows) { item in
                row(item)
                if item.id != rows.last?.id { InsightsInsetDivider() }
            }
        }
    }

    private func newSubscriptions(_ rows: [StatisticsDigest.NewSubscription]) -> some View {
        section("insights.panel.newSubscriptions") {
            insetList(rows) { row in
                findingRow(
                    symbol: "creditcard", tint: theme.secondaryLabel, title: row.recipientName,
                    kind: "insights.panel.newSubscriptions", dismissal: row.dismissal,
                    key: "new:\(row.id.rawValue)",
                    subtitle: { Text(strings.t("recurring.pattern.\(row.detectedPattern)")) },
                    trailing: { amount(row.latestAmount, currency: row.currency).fontWeight(.medium) })
            }
        }
    }

    private func priceChanges(_ rows: [StatisticsDigest.PriceChange]) -> some View {
        section("insights.panel.priceChanges") {
            insetList(rows) { row in
                findingRow(
                    symbol: nil, tint: theme.secondaryLabel, title: row.recipientName,
                    kind: "insights.panel.priceChanges", dismissal: row.dismissal, key: "price:\(row.id.rawValue)",
                    subtitle: {
                        HStack(spacing: 8) {
                            amount(row.previousAmount, currency: row.currency).strikethrough()
                            Text("\u{2192}").accessibilityHidden(true)
                            amount(row.newAmount, currency: row.currency).fontWeight(.medium)
                                .foregroundStyle(row.percentChange > 0 ? theme.loss : theme.gain)
                        }
                    },
                    trailing: {
                        DeltaPill(
                            row.percentChange,
                            label: VisionFormat.decimal(
                                row.percentChange, fractionDigits: 1, locale: settings.numberFormat.locale)
                                + "%",
                            invert: true)
                    })
            }
        }
    }

    private func overspend(_ rows: [StatisticsDigest.Outlier]) -> some View {
        section("insights.panel.categoryOverspend") {
            insetList(rows) { row in
                findingRow(
                    symbol: "chart.pie", tint: theme.loss, title: row.categoryName,
                    kind: "insights.panel.categoryOverspend", dismissal: row.dismissal, key: "outlier:\(row.id)",
                    subtitle: { outlierSubtitle(row) },
                    trailing: { EmptyView() })
            }
        }
    }

    private func outlierSubtitle(_ row: StatisticsDigest.Outlier) -> some View {
        let currency = LedgerCurrency.display(settings)
        let typical = strings.t(
            "insights.panel.vsTypical",
            [
                "day": String(row.comparisonEndDay),
                "amount": MoneyText.text(row.baselineMedian, currency: currency, settings: settings, signed: false),
            ])
        let thisMonth = strings.t("insights.panel.thisMonth", ["day": String(row.comparisonEndDay)])
        return HStack(spacing: 4) {
            amount(row.currentAmount, currency: currency).fontWeight(.medium).foregroundStyle(theme.loss)
            Text(thisMonth + " \u{00B7} " + typical).lineLimit(1)
        }
    }

    /// `ListRow`: an optional leading glyph, the title over a footnote subtitle, trailing
    /// content and the dismiss button.
    private func findingRow<Subtitle: View, Trailing: View>(
        symbol: String?, tint: Color, title: String, kind: String, dismissal: JSONValue, key: String,
        @ViewBuilder subtitle: () -> Subtitle, @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(alignment: .center, spacing: 12) {
            if let symbol {
                Image(systemName: symbol).font(.system(size: 15)).foregroundStyle(tint)
                    .frame(width: 28, height: 28).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(title).lineLimit(1).foregroundStyle(theme.foreground)
                subtitle().font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
            Spacer(minLength: 8)
            trailing()
            if !isPrinting {
                Button {
                    Task { await model.dismiss(dismissal, key: key) }
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.vision(.ghost, size: .iconXs)).disabled(model.dismissing.contains(key))
                .accessibilityLabel(strings.t("insights.dismissFinding", ["kind": strings.t(kind), "name": title]))
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }

    // MARK: Cash forecast

    /// The standing month-end read: a destructive-tinted alert when it is `alert`, a plain one
    /// otherwise.
    private func forecast(_ cash: OpenAPI.CashForecastInsight) -> some View {
        let isAlert = cash.prominence == .alert
        let shape = RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
        return section("insights.panel.cashForecast") {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: isAlert ? "exclamationmark.triangle" : "wallet.pass")
                    .font(.system(size: 15)).foregroundStyle(isAlert ? theme.destructive : theme.foreground)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(
                        strings.t(
                            "insights.panel.monthEndNetCashflow",
                            [
                                "amount": MoneyText.text(
                                    cash.monthEndNetCashflow, currency: cash.currency, settings: settings,
                                    signed: false)
                            ])
                    )
                    .fontWeight(isAlert ? .medium : .regular)
                    .foregroundStyle(isAlert ? theme.destructive : theme.secondaryLabel)
                    if let low = cash.monthEndNetCashflowLow, let high = cash.monthEndNetCashflowHigh {
                        HStack(spacing: 4) {
                            amount(low, currency: cash.currency)
                            Text("\u{2013}")
                            amount(high, currency: cash.currency)
                        }
                        .font(.footnote).foregroundStyle(theme.secondaryLabel)
                    }
                    if cash.movedSignificantly {
                        Text(strings.t("insights.panel.significantMove")).font(.footnote)
                            .foregroundStyle(isAlert ? theme.destructive : theme.secondaryLabel)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(shape.fill(isAlert ? theme.destructive.opacity(0.08) : theme.card.opacity(0.7)))
            .overlay(
                shape.strokeBorder(isAlert ? theme.destructive.opacity(0.4) : theme.border.opacity(0.6), lineWidth: 1))
            .accessibilityElement(children: .combine)
        }
    }

    private func amount(_ value: Decimal, currency: CurrencyCode) -> Text {
        MoneyText.styled(
            MoneyText.text(value, currency: currency, settings: settings, signed: false),
            decimalSeparator: settings.numberFormat.locale.decimalSeparator?.first, color: theme.foreground)
    }
}
