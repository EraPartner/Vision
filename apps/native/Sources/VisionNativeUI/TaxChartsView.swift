import SwiftUI
import VisionNativeCore

/// The tax engine supplies every chart amount, including historical and frozen-year
/// calculations. These views only format figures and provide chart interaction.
struct TaxMonthlyIncomeView: View {
    let model: TaxDashboardModel
    let overview: OpenAPI.BelgianTaxOverview
    let shell: NativeShellModel
    var openIncomeSources: (() -> Void)? = nil
    @State private var selection: String?
    @State private var rangeStart: String?
    @Environment(\.visionTheme) private var theme

    private var data: TaxDashboardData? {
        guard let data = model.data, data.year == overview.year,
            data.currency == shell.settings.defaultCurrency
        else { return nil }
        return data
    }

    var body: some View {
        TaxChartCard(
            title: shell.strings.t("tax.incomeBreakdown.title"),
            description: shell.strings.t("tax.incomeBreakdown.description")
        ) {
            if let data {
                if !data.hasIncomeSources {
                    TaxIncomeSourcesEmptyView(strings: shell.strings, openIncomeSources: openIncomeSources)
                } else if data.monthlyIncomeTax.isEmpty {
                    TaxChartEmptyView(strings: shell.strings)
                } else {
                    InsightTimelineChart(
                        series: [
                            InsightChartSeries(
                                id: "income", label: shell.strings.t("tax.chart.income"),
                                points: data.monthlyIncomeTax.map {
                                    InsightChartPoint(key: $0.period, value: $0.income)
                                }),
                            InsightChartSeries(
                                id: "pitReserve", label: shell.strings.t("tax.chart.pitReserve"),
                                points: data.monthlyIncomeTax.map {
                                    InsightChartPoint(key: $0.period, value: $0.estimatedTax)
                                }),
                        ], currency: data.currency, settings: shell.settings,
                        title: shell.strings.t("tax.incomeBreakdown.title"), bars: true, height: 280,
                        customColors: ["income": theme.primary, "pitReserve": Color(token: theme.palette.chart5)],
                        selection: $selection, rangeStart: $rangeStart
                    )
                    .environment(\.locale, shell.settings.numberFormat.locale)
                }
            } else {
                TaxChartLoadView(model: model, strings: shell.strings)
            }
        }
        .onChange(of: context) { _, _ in
            selection = nil
            rangeStart = nil
        }
    }

    private var context: String { "\(overview.year):\(shell.settings.defaultCurrency)" }
}

struct TaxYearlyOverviewView: View {
    let model: TaxDashboardModel
    let overview: OpenAPI.BelgianTaxOverview
    let shell: NativeShellModel
    var openIncomeSources: (() -> Void)? = nil
    @State private var selection: String?
    @State private var rangeStart: String?
    @Environment(\.visionTheme) private var theme

    private var data: TaxDashboardData? {
        guard let data = model.data, data.year == overview.year,
            data.currency == shell.settings.defaultCurrency
        else { return nil }
        return data
    }

    var body: some View {
        TaxChartCard(
            title: shell.strings.t("tax.yearly.title"),
            description: shell.strings.t("tax.yearly.description")
        ) {
            if let data {
                if !data.hasIncomeSources {
                    TaxIncomeSourcesEmptyView(strings: shell.strings, openIncomeSources: openIncomeSources)
                } else if data.yearlyIncome.isEmpty {
                    TaxChartEmptyView(strings: shell.strings)
                } else {
                    InsightTimelineChart(
                        series: [
                            InsightChartSeries(
                                id: "net", label: shell.strings.t("tax.chart.netAfterTax"),
                                points: data.yearlyIncome.map { InsightChartPoint(key: $0.year, value: $0.netAfterTax) }
                            ),
                            InsightChartSeries(
                                id: "pit", label: shell.strings.t("tax.chart.pit"),
                                points: data.yearlyIncome.map {
                                    InsightChartPoint(key: $0.year, value: $0.estimatedTax)
                                }),
                        ], currency: data.currency, settings: shell.settings,
                        title: shell.strings.t("tax.yearly.title"), bars: true, height: 300,
                        customColors: ["net": theme.primary, "pit": Color(token: theme.palette.chart5)],
                        selection: $selection, rangeStart: $rangeStart
                    )
                    .environment(\.locale, shell.settings.numberFormat.locale)
                    if data.yearlyIncome.contains(where: \.isApproximated) {
                        Label(shell.strings.t("tax.yearly.approximatedNote"), systemImage: "info.circle")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            } else {
                TaxChartLoadView(model: model, strings: shell.strings)
            }
        }
        .onChange(of: context) { _, _ in
            selection = nil
            rangeStart = nil
        }
    }

    private var context: String { "\(overview.year):\(shell.settings.defaultCurrency)" }
}

struct TaxTrendStripView: View {
    let model: TaxDashboardModel
    let overview: OpenAPI.BelgianTaxOverview
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var data: TaxDashboardData? {
        guard let data = model.data, data.year == overview.year,
            data.currency == shell.settings.defaultCurrency
        else { return nil }
        return data
    }

    var body: some View {
        if let data, data.yearCalculations.count > 1 {
            let years = Array(data.yearCalculations.sorted { $0.year > $1.year }.prefix(8))
            let maxPIT = years.map(\.calculation.totalPIT).max() ?? 0
            TaxChartCard(
                title: shell.strings.t("tax.trendStrip.title"),
                description: shell.strings.t("tax.trendStrip.description")
            ) {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), alignment: .leading)], spacing: 8) {
                    ForEach(years, id: \.year) { year in
                        Button {
                            shell.replaceQuery("year", with: String(year.year))
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text(String(year.year)).font(.caption).monospacedDigit()
                                    Spacer(minLength: 0)
                                    TaxChartYearStatusView(
                                        isFiled: year.isFiled,
                                        hasFrozenCalculation: year.hasFrozenCalculation, strings: shell.strings)
                                }
                                Text(currency(year.calculation.totalPIT)).font(.headline).monospacedDigit()
                                    .lineLimit(1).minimumScaleFactor(0.8)
                                Text(
                                    "\(year.calculation.effectiveRate.map { VisionFormat.percent($0, locale: shell.settings.numberFormat.locale) } ?? "—") \(shell.strings.t("tax.trendStrip.effective"))"
                                )
                                .font(.caption).foregroundStyle(theme.secondaryLabel)
                                GeometryReader { geometry in
                                    Capsule().fill(theme.foreground.opacity(0.08))
                                    Capsule().fill(theme.primary.opacity(year.year == overview.year ? 1 : 0.4))
                                        .frame(
                                            width: geometry.size.width
                                                * widthRatio(year.calculation.totalPIT, max: maxPIT))
                                }.frame(height: 4).accessibilityHidden(true)
                            }
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                theme.primary.opacity(year.year == overview.year ? 0.08 : 0.02),
                                in: RoundedRectangle(cornerRadius: 10)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .strokeBorder(year.year == overview.year ? theme.primary.opacity(0.45) : .clear))
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(year.year == overview.year ? .isSelected : [])
                    }
                }
            }
        }
    }

    private func currency(_ value: Decimal) -> String {
        VisionFormat.currency(
            value, code: shell.settings.defaultCurrency,
            locale: shell.settings.numberFormat.locale, fractionDigits: 0)
    }
    private func widthRatio(_ value: Decimal, max maximum: Decimal) -> CGFloat {
        guard maximum > 0 else { return 0 }
        return CGFloat(NSDecimalNumber(decimal: min(1, max(Decimal(4) / 100, value / maximum))).doubleValue)
    }
}

struct TaxYearComparisonView: View {
    let model: TaxDashboardModel
    let overview: OpenAPI.BelgianTaxOverview
    let shell: NativeShellModel
    @State private var compareYear: Int?
    @Environment(\.visionTheme) private var theme

    private var data: TaxDashboardData? {
        guard let data = model.data, data.year == overview.year,
            data.currency == shell.settings.defaultCurrency
        else { return nil }
        return data
    }
    private var available: [TaxDashboardYearCalculation] {
        data?.yearCalculations.filter { $0.year != overview.year }.sorted { $0.year > $1.year } ?? []
    }
    private var defaultYear: Int? { available.first(where: { $0.year < overview.year })?.year ?? available.first?.year }
    private var selected: TaxDashboardYearCalculation? {
        available.first(where: { $0.year == compareYear }) ?? available.first(where: { $0.year == defaultYear })
    }

    var body: some View {
        if let data, data.yearCalculations.count > 1, let selected {
            TaxChartCard(
                title: shell.strings.t("tax.comparison.title", ["year": String(overview.year)]),
                description: shell.strings.t("tax.comparison.description")
            ) {
                Picker(
                    shell.strings.t("tax.comparison.versus"),
                    selection: Binding(
                        get: { selected.year }, set: { compareYear = $0 })
                ) {
                    ForEach(available, id: \.year) { year in
                        HStack {
                            Text(String(year.year))
                            TaxChartYearStatusView(
                                isFiled: year.isFiled,
                                hasFrozenCalculation: year.hasFrozenCalculation, strings: shell.strings)
                        }.tag(year.year)
                    }
                }
                .accessibilityLabel(shell.strings.t("tax.comparison.selectYear"))
                .frame(maxWidth: 240, alignment: .leading)
                ScrollView(.horizontal) {
                    Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 12) {
                        GridRow {
                            Text(shell.strings.t("tax.comparison.header.metric"))
                            Text(String(overview.year)).gridColumnAlignment(.trailing)
                            HStack {
                                Text(String(selected.year))
                                TaxChartYearStatusView(
                                    isFiled: selected.isFiled,
                                    hasFrozenCalculation: selected.hasFrozenCalculation, strings: shell.strings)
                            }.gridColumnAlignment(.trailing)
                            Text(shell.strings.t("tax.comparison.header.delta")).gridColumnAlignment(.trailing)
                        }.font(.caption.weight(.medium)).foregroundStyle(theme.secondaryLabel)
                        comparisonRow(
                            "grossIncome", a: overview.calculation.grossIncome,
                            b: selected.calculation.grossIncome, higherIsBetter: true)
                        comparisonRow(
                            "totalPIT", a: overview.calculation.totalPIT,
                            b: selected.calculation.totalPIT, higherIsBetter: false)
                        comparisonRow(
                            "effectiveRate", a: overview.calculation.effectiveRate,
                            b: selected.calculation.effectiveRate, higherIsBetter: false, isPercent: true)
                        comparisonRow(
                            "netTakeHome", a: overview.calculation.netTakeHome,
                            b: selected.calculation.netTakeHome, higherIsBetter: true)
                    }.frame(minWidth: 640, maxWidth: .infinity, alignment: .leading)
                }
            }
            .onChange(of: overview.year) { _, _ in compareYear = defaultYear }
            .onChange(of: available.map(\.year)) { _, years in
                if let compareYear, !years.contains(compareYear) { self.compareYear = defaultYear }
            }
        }
    }

    private func comparisonRow(
        _ key: String, a: Decimal?, b: Decimal?, higherIsBetter: Bool,
        isPercent: Bool = false
    ) -> some View {
        GridRow {
            Text(shell.strings.t("tax.comparison.row.\(key)"))
            Text(format(a, percent: isPercent)).fontWeight(.medium).monospacedDigit()
            Text(format(b, percent: isPercent)).foregroundStyle(theme.secondaryLabel).monospacedDigit()
            if let a, let b {
                deltaCell(a: a, b: b, higherIsBetter: higherIsBetter, percent: isPercent)
            } else {
                Text("—").foregroundStyle(theme.secondaryLabel)
            }
        }
    }
    private func deltaCell(a: Decimal, b: Decimal, higherIsBetter: Bool, percent: Bool) -> some View {
        let delta = a - b
        let zero = abs(delta) < Decimal(5) / 1000
        let color = zero ? theme.secondaryLabel : ((delta > 0) == higherIsBetter ? theme.gain : theme.loss)
        return Text(deltaLabel(delta, baseline: b, percent: percent, zero: zero))
            .font(.caption.weight(.medium)).monospacedDigit().foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(color.opacity(0.1), in: Capsule())
    }
    private func format(_ value: Decimal?, percent: Bool = false, signed: Bool = false) -> String {
        guard let value else { return "—" }
        let locale = shell.settings.numberFormat.locale
        if percent { return VisionFormat.percent(value, locale: locale) }
        return VisionFormat.currency(
            value, code: shell.settings.defaultCurrency,
            locale: locale, fractionDigits: 0, signed: signed)
    }
    private func deltaLabel(_ delta: Decimal, baseline: Decimal, percent: Bool, zero: Bool) -> String {
        let amount = format(percent ? abs(delta) : delta, percent: percent, signed: !percent)
        guard baseline != 0, !zero else { return amount }
        let change = delta / abs(baseline) * 100
        let sign = change > 0 ? "+" : ""
        return "\(amount) (\(sign)\(VisionFormat.percent(change, locale: shell.settings.numberFormat.locale)))"
    }
}

struct TaxChartYearStatusView: View {
    let isFiled: Bool
    let hasFrozenCalculation: Bool
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme

    var body: some View {
        if isFiled {
            Image(systemName: "lock.fill").foregroundStyle(theme.warning)
                .accessibilityLabel(strings.t("tax.yearSwitcher.filedAria"))
        } else if hasFrozenCalculation {
            Image(systemName: "snowflake").foregroundStyle(theme.info)
                .accessibilityLabel(strings.t("tax.yearSwitcher.frozenAria"))
        }
    }
}

private struct TaxChartCard<Content: View>: View {
    let title: String
    let description: String
    @ViewBuilder let content: () -> Content
    @Environment(\.visionTheme) private var theme

    var body: some View {
        AdminCard {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.headline).accessibilityAddTraits(.isHeader)
                    Text(description).font(.subheadline).foregroundStyle(theme.secondaryLabel)
                }
                content()
            }
        }
    }
}

private struct TaxIncomeSourcesEmptyView: View {
    let strings: any Localizing
    let openIncomeSources: (() -> Void)?

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "checklist").font(.title).accessibilityHidden(true)
            Text(strings.t("tax.incomeBreakdown.emptyTitle")).font(.headline)
            Text(strings.t("tax.incomeBreakdown.emptyDesc")).foregroundStyle(.secondary)
            if let openIncomeSources {
                Button(strings.t("tax.incomeBreakdown.emptyCta"), action: openIncomeSources).buttonStyle(.bordered)
            }
        }.frame(maxWidth: .infinity).padding(.vertical, 30).multilineTextAlignment(.center)
    }
}

private struct TaxChartEmptyView: View {
    let strings: any Localizing
    var body: some View {
        Label(strings.t("tax.incomeBreakdown.noData"), systemImage: "checklist")
            .foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 30)
    }
}

private struct TaxChartLoadView: View {
    let model: TaxDashboardModel
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme
    var body: some View {
        if let error = model.error {
            Text(strings.t("tax.page.loadError", ["msg": error])).foregroundStyle(theme.destructive)
        } else {
            ProgressView().frame(maxWidth: .infinity).padding(.vertical, 30)
        }
    }
}
