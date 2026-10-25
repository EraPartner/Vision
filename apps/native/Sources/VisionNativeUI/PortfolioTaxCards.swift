import SwiftUI
import VisionNativeCore

/// Fiscal amounts are supplied by the TypeScript dashboard. These cards only format them.
///
/// PortfolioTaxSummaryCards: the year's total costs as the headline on the left and, from `xl`,
/// the supporting figures beside it in three columns (two rows); below `xl` they sit under it.
struct PortfolioTaxSummaryView: View {
    let data: PortfolioTaxDashboard
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var separator: Character? { shell.settings.numberFormat.locale.decimalSeparator?.first }

    var body: some View {
        VisionBreakpointReader(breakpoint: VisionBreakpoint.xl) { wide in
            TaxCard {
                if wide {
                    HStack(alignment: .top, spacing: 24) {
                        hero.frame(width: 260, alignment: .leading)
                        figures
                    }
                } else {
                    hero
                    figures
                }
            }
        }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(strings.t("tax.totalCosts")).font(.caption).foregroundStyle(theme.tertiaryLabel)
            RollingNumber(
                value: money(data.totals.totalTaxesAndFees), decimalSeparator: separator, display: .largeTitle
            )
            .monospacedDigit().foregroundStyle(theme.loss)
            Text(strings.t("tax.combinedTaxesAndFeesYear", ["year": String(data.year)]))
                .font(.footnote).foregroundStyle(theme.secondaryLabel)
        }
        .accessibilityElement(children: .combine)
    }

    /// `grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-3`.
    private var figures: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 32, alignment: .topLeading), count: 3),
            alignment: .leading, spacing: 24
        ) {
            metric(
                "tax.totalTaxesPaid", amount: data.totals.totalTaxes,
                detail: strings.t("tax.acrossAllInvestmentsYear", ["year": String(data.year)]), color: theme.loss)
            metric(
                "tax.totalFeesPaid", amount: data.totals.totalFees,
                detail: strings.t("tax.brokerAndMgmtFeesYear", ["year": String(data.year)]), color: theme.loss)
            effectiveRate
            metric(
                "tax.totalWithPIT", amount: data.totals.portfolioTaxesPlusPIT,
                detail: strings.t("tax.totalWithPITDesc"), color: theme.primary)
            metric(
                "tax.manualAdjustments", amount: data.totals.totalManualCosts,
                detail: strings.t("tax.manualAdjustmentsDescShort"), color: theme.foreground)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var effectiveRate: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(strings.t("tax.effectiveTaxRate")).font(.caption).foregroundStyle(theme.tertiaryLabel)
            Text(
                VisionFormat.percent(
                    data.totals.effectiveTaxRate, digits: 1, locale: shell.settings.numberFormat.locale)
            )
            .font(Font.visionTitle3).monospacedDigit()
            .foregroundStyle(data.totals.effectiveTaxRate > 25 ? theme.loss : theme.foreground)
            Text(strings.t("tax.onRealizedGains")).font(.footnote).foregroundStyle(theme.secondaryLabel)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func metric(_ key: String, amount: Decimal, detail: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(strings.t(key)).font(.caption).foregroundStyle(theme.tertiaryLabel)
            RollingNumber(value: money(amount), decimalSeparator: separator, display: .title3)
                .foregroundStyle(color)
            Text(detail).font(.footnote).foregroundStyle(theme.secondaryLabel)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    /// `fmt(value)`: the amount without a sign, as the web's currency formatter writes it.
    private func money(_ value: Decimal) -> String {
        MoneyText.text(value, currency: data.currency, settings: shell.settings, signed: false)
    }
}

struct PortfolioTaxCostTypesView: View {
    let data: PortfolioTaxDashboard
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        TaxCard(title: strings.t("tax.widget.taxTypes"), description: strings.t("tax.taxTypesDesc")) {
            if !data.taxBreakdown.isEmpty { breakdown("tax.taxes", rows: data.taxBreakdown) }
            if !data.feeBreakdown.isEmpty { breakdown("tax.fees", rows: data.feeBreakdown) }
            Divider()
            Text(strings.t("tax.gainsContext")).font(.headline)
            TaxMoneyRow(
                title: strings.t("portfolio.realizedGains"), amount: data.totals.totalRealizedGain,
                shell: shell, signed: true, tone: data.totals.totalRealizedGain >= 0 ? theme.gain : theme.loss)
            TaxMoneyRow(
                title: strings.t("portfolio.unrealizedGains"), amount: data.totals.totalUnrealizedGain,
                shell: shell, signed: true, tone: data.totals.totalUnrealizedGain >= 0 ? theme.gain : theme.loss)
        }
    }
    private func breakdown(_ title: String, rows: [PortfolioTaxCostBreakdown]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t(title)).font(.headline)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                TaxMoneyRow(title: strings.t(row.nameKey), amount: row.value, shell: shell, tone: theme.loss)
            }
        }
    }
}

struct PortfolioTaxRecordedManualView: View {
    let data: PortfolioTaxDashboard
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    var body: some View {
        TaxCard(
            title: shell.strings.t("tax.recordedVsManual"), description: shell.strings.t("tax.recordedVsManualDesc")
        ) {
            TaxMoneyRow(
                title: shell.strings.t("tax.recordedTaxes"), amount: data.totals.totalRecordedTaxes,
                shell: shell, tone: theme.loss)
            TaxMoneyRow(
                title: shell.strings.t("tax.recordedFees"), amount: data.totals.totalRecordedFees,
                shell: shell, tone: theme.loss)
            TaxMoneyRow(
                title: shell.strings.t("tax.manualTaxAdjustments"), amount: data.totals.totalManualTaxes,
                shell: shell, tone: theme.secondaryLabel)
            TaxMoneyRow(
                title: shell.strings.t("tax.manualFeeAdjustments"), amount: data.totals.totalManualFees,
                shell: shell, tone: theme.secondaryLabel)
            Divider()
            TaxMoneyRow(
                title: shell.strings.t("tax.totalCosts"), amount: data.totals.totalTaxesAndFees,
                shell: shell, strong: true, tone: theme.primary)
        }
    }
}

struct PortfolioTaxBudgetView: View {
    let data: PortfolioTaxDashboard
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    var body: some View {
        TaxCard(title: shell.strings.t("tax.budgetTitle"), description: shell.strings.t("tax.portfolioBudgetLikeDesc"))
        {
            TaxMoneyRow(
                title: shell.strings.t("tax.card.totalPIT"), amount: data.totals.totalPIT,
                shell: shell, tone: theme.loss)
            TaxMoneyRow(
                title: shell.strings.t("tax.totalTaxesPaid"), amount: data.totals.totalTaxes,
                shell: shell, tone: theme.loss)
            Divider()
            TaxMoneyRow(
                title: shell.strings.t("tax.totalWithPIT"), amount: data.totals.portfolioTaxesPlusPIT,
                shell: shell, strong: true, tone: theme.primary)
        }
    }
}

struct PortfolioTaxProfileInputsView: View {
    let inputs: TaxDashboardCurrentInputs
    let overview: OpenAPI.BelgianTaxOverview
    let shell: NativeShellModel
    private var strings: any Localizing { shell.strings }
    var body: some View {
        TaxCard(title: strings.t("tax.profile.currentInputs"), description: strings.t("tax.portfolioProfileInputsDesc"))
        {
            LabeledContent(strings.t("tax.profile.field.employmentType")) {
                VisionBadge(text: strings.t("tax.profile.employment." + inputs.employmentType + ".label"))
            }
            TaxMoneyRow(
                title: strings.t("tax.profile.field.grossAnnualIncome"), amount: inputs.grossAnnualIncome, shell: shell)
            TaxMoneyRow(
                title: strings.t("tax.profile.field.otherTaxableIncome"), amount: inputs.otherTaxableIncome,
                shell: shell)
            TaxMoneyRow(
                title: strings.t("tax.profile.field.personalExemption"),
                amount: overview.calculation.personalExemptionAmount, shell: shell)
            LabeledContent(
                strings.t("tax.profile.field.dependents"),
                value:
                    "\(inputs.dependentChildren) \(strings.t("tax.profile.field.children")) / \(inputs.dependentOtherPersons) \(strings.t("tax.profile.field.others"))"
            )
            LabeledContent(
                strings.t("tax.profile.field.disabilityExemptions"),
                value:
                    strings.t(inputs.isDisabled || inputs.isSpouseDisabled ? "common.applied" : "common.none"))
        }
    }
}

struct PortfolioTaxInvestmentBreakdownView: View {
    let data: PortfolioTaxDashboard
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        TaxCard(
            title: strings.t("tax.widget.investmentBreakdown"), description: strings.t("tax.investmentBreakdownDesc")
        ) {
            ForEach(data.investmentBreakdown, id: \.id) { investment in
                HStack(alignment: .top, spacing: 20) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(investment.name).fontWeight(.medium)
                            if let symbol = investment.symbol {
                                Text(symbol).font(.caption.monospaced()).foregroundStyle(theme.secondaryLabel)
                            }
                            VisionBadge(text: strings.t("portfolio.assetClass." + investment.assetClass.rawValue))
                        }
                        Text(
                            strings.t("tax.taxes") + ": " + money(investment.recordedTaxes) + " + "
                                + money(investment.manualTaxes))
                        Text(
                            strings.t("tax.fees") + ": " + money(investment.recordedFees) + " + "
                                + money(investment.manualFees))
                        if investment.realizedGain != 0 {
                            Text(
                                strings.t("tax.realized") + ": "
                                    + MoneyText.text(
                                        investment.realizedGain,
                                        currency: data.currency, settings: shell.settings, signed: true)
                            )
                            .foregroundStyle(investment.realizedGain >= 0 ? theme.gain : theme.loss)
                        }
                    }.font(.footnote).foregroundStyle(theme.secondaryLabel)
                    Spacer(minLength: 0)
                    VStack(alignment: .trailing, spacing: 3) {
                        Text(money(investment.total)).font(.headline).monospacedDigit().foregroundStyle(theme.loss)
                        Text(strings.t("tax.totalCosts")).font(.caption).foregroundStyle(theme.tertiaryLabel)
                    }
                }.padding(.vertical, 8).accessibilityElement(children: .combine)
                if investment.id != data.investmentBreakdown.last?.id { Divider() }
            }
        }
    }
    private func money(_ value: Decimal) -> String {
        MoneyText.text(value, currency: data.currency, settings: shell.settings, signed: false)
    }
}

struct PortfolioTaxRulesView: View {
    let data: PortfolioTaxDashboard
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        TaxCard(title: strings.t("tax.widget.belgianRules"), description: strings.t("tax.belgianRulesDesc")) {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 200), alignment: .leading)], alignment: .leading, spacing: 20
            ) {
                dividendMetric(
                    "tax.dividendIncomeTracked", value: data.dividend.totalDividendIncome,
                    detail: strings.t("tax.fromDividendTransactions"), tone: theme.foreground)
                dividendMetric(
                    "tax.dividendWhtPaid", value: data.dividend.grossDividendWht,
                    detail: strings.t("tax.witheldAtSource"), tone: theme.loss)
                dividendMetric(
                    "tax.dividendWhtReclaim", value: data.dividend.dividendWhtReclaim,
                    detail: strings.t("tax.firstExemptBelgianDividends") + " (" + money(data.dividend.dividendExemption)
                        + ")", tone: theme.gain)
                dividendMetric(
                    "tax.dividendWhtNetCost", value: data.dividend.dividendWhtNetCost,
                    detail: strings.t("tax.afterReclaim"), tone: theme.loss)
            }
            if data.dividend.unknownDividendConventionCount > 0 {
                Label(
                    strings.tc("tax.dividendConventionIncomplete", data.dividend.unknownDividendConventionCount),
                    systemImage: "exclamationmark.triangle"
                )
                .font(.callout).foregroundStyle(theme.warning)
            }
            Divider()
            estimate(
                "tax.tobRecorded", badge: strings.t("tax.transactionTax"), description: "tax.tobTrackedFromBuyTaxes",
                amount: data.estimates.tobRecorded)
            estimate(
                "tax.tobAutoEstimate", badge: strings.t("tax.estimated"), description: "tax.tobAutoEstimateDesc",
                amount: data.estimates.tobAutoEstimate)
            if data.estimates.tacrEstimate > 0 {
                estimate(
                    "tax.tacrEstimate", badge: rate(data.taxTable.badgePercent.securitiesAccountTaxRate, digits: 2),
                    description: "tax.tacrEstimateDesc", amount: data.estimates.tacrEstimate)
            }
            if data.estimates.cgtEstimate > 0 {
                estimate(
                    "tax.cgtEstimate", badge: rate(data.taxTable.badgePercent.capitalGainsTaxRate, digits: 0),
                    description: "tax.cgtEstimateDesc", amount: data.estimates.cgtEstimate)
            }
            if data.estimates.reyndersEstimate > 0 {
                estimate(
                    "tax.reyndersEstimate", badge: rate(data.taxTable.badgePercent.reyndersTaxRate, digits: 0),
                    description: "tax.reyndersEstimateDesc", amount: data.estimates.reyndersEstimate)
            }
            Divider()
            note("tax.currentlyAutomaticLabel", text: "tax.currentlyAutomaticPortfolio")
            note("tax.manualAdjustmentsLabel", text: "tax.manualAdjustmentsDesc")
            note("tax.notAutomaticLabel", text: "tax.notAutomaticPortfolio")
        }
    }
    private func dividendMetric(_ title: String, value: Decimal?, detail: String, tone: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(strings.t(title)).font(.caption).foregroundStyle(theme.secondaryLabel)
            Text(value.map(money) ?? strings.t("tax.incomplete")).font(.title3).monospacedDigit()
                .foregroundStyle(value == nil ? theme.secondaryLabel : tone)
            Text(detail).font(.footnote).foregroundStyle(theme.secondaryLabel)
        }.accessibilityElement(children: .combine)
    }
    private func estimate(_ title: String, badge: String, description: String, amount: Decimal) -> some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(strings.t(title)).fontWeight(.medium)
                    VisionBadge(text: badge)
                }
                Text(strings.t(description)).font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
            Spacer(minLength: 0)
            Text(money(amount)).font(.headline).monospacedDigit().foregroundStyle(theme.loss)
        }.padding(.vertical, 4).accessibilityElement(children: .combine)
    }
    private func note(_ title: String, text: String) -> some View {
        (Text(strings.t(title)).fontWeight(.semibold) + Text(" " + strings.t(text)))
            .font(.callout).foregroundStyle(theme.secondaryLabel)
    }
    private func money(_ value: Decimal) -> String {
        MoneyText.text(value, currency: data.currency, settings: shell.settings, signed: false)
    }
    private func rate(_ percent: Decimal, digits: Int) -> String {
        VisionFormat.percent(percent, digits: digits, locale: shell.settings.numberFormat.locale)
    }
}
