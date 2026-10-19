import SwiftUI
import VisionNativeCore

struct PortfolioDetailSheet: View {
    let model: PortfolioModel
    let editing: PortfolioEditingModel
    let shell: NativeShellModel
    @State private var tab = "performance"
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let error = model.error {
                Text(error).foregroundStyle(theme.destructive)
                Button(strings.t("common.retry")) {
                    Task { await model.load(currency: shell.settings.defaultCurrency, force: true) }
                }.buttonStyle(.visionOutline)
            }
            if let holding = model.selectedInvestment {
                header(holding)
                if !holding.isActive {
                    Label(strings.t("portfolio.archivedExcluded"), systemImage: "archivebox")
                        .font(.callout).foregroundStyle(theme.secondaryLabel)
                        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            theme.foreground.opacity(0.04),
                            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
                }
                Picker(strings.t("invDetail.breakdown"), selection: $tab) {
                    Text(strings.t("invDetail.tab.performance")).tag("performance")
                    Text(strings.t("invDetail.tab.transactions", ["n": String(model.transactions.count)])).tag(
                        "transactions")
                }.pickerStyle(.segmented).labelsHidden().frame(maxWidth: .infinity)
                if tab == "performance" {
                    ScrollView { performance(holding) }.frame(maxHeight: 620)
                } else {
                    PortfolioDetailHistoryTable(model: model, editing: editing, holding: holding, shell: shell)
                        .frame(minHeight: 280, maxHeight: 620)
                }
                if holding.isActive, let investment = model.investment(id: holding.id) {
                    HStack {
                        Spacer()
                        Button(strings.t("form.addTransaction.title"), systemImage: "plus") {
                            // Only a complete history may seed the instrument's broker default.
                            if model.historyComplete && !model.historyLoading {
                                editing.bindTransactions(model.transactions)
                            }
                            editing.beginAddTransaction(investment: investment, bookingCurrency: holding.currency)
                        }.buttonStyle(.visionPrimary)
                    }
                }
            } else {
                if model.isFetching || model.historyLoading {
                    ProgressView().frame(maxWidth: .infinity).padding(50)
                } else if model.error == nil {
                    Text(strings.t("apiError.notFound"))
                        .foregroundStyle(theme.secondaryLabel).frame(maxWidth: .infinity).padding(50)
                    Button(strings.t("common.retry")) {
                        Task { await model.load(currency: shell.settings.defaultCurrency, force: true) }
                    }.buttonStyle(.visionOutline)
                }
                Button(strings.t("common.close")) { model.closeDetail() }
                    .buttonStyle(.visionOutline).keyboardShortcut(.cancelAction)
            }
        }.visionDialogPadding().frame(minWidth: 640, idealWidth: 672)
            .portfolioEditingPresentation(model: editing, shell: shell)
            .onChange(of: model.selectedInvestment?.isActive) { previous, current in
                if previous == true && current != true && model.error == nil { model.closeDetail() }
            }
    }
    /// `InvestmentDetailDialog`'s header: symbol, linked name and badges on one line, the
    /// close control top right, then the outline Edit and Archive actions.
    private func header(_ holding: PortfolioHolding) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 8) {
                if let symbol = holding.symbol {
                    Text(symbol).font(.headline.monospaced()).foregroundStyle(theme.primary)
                    Button(holding.name) { research(holding, symbol: symbol) }.buttonStyle(.visionLink)
                        .font(.visionCardTitle).lineLimit(1).accessibilityAddTraits(.isHeader)
                } else {
                    Text(holding.name).font(.visionCardTitle).foregroundStyle(theme.foreground).lineLimit(1)
                        .accessibilityAddTraits(.isHeader)
                }
                VisionBadge(text: assetClassLabel(holding.assetClass), small: true)
                if !holding.isActive { VisionBadge(text: strings.t("portfolio.archived"), tone: .outline, small: true) }
                if holding.oversold {
                    VisionBadge(text: strings.t("portfolio.oversold.label"), tone: .warning, small: true)
                        .help(strings.t("portfolio.oversold.description"))
                }
                Spacer(minLength: 0)
                VisionDialogCloseButton(label: strings.t("common.close")) { model.closeDetail() }
                    .keyboardShortcut(.cancelAction)
            }
            if holding.isActive, let investment = model.investment(id: holding.id) {
                HStack(spacing: 8) {
                    Button(strings.t("common.edit"), systemImage: "pencil") {
                        editing.beginEditInvestment(investment: investment)
                    }
                    .accessibilityLabel(strings.t("common.edit") + ": " + holding.name)
                    .disabled(!model.historyComplete || model.historyLoading)
                    Button(strings.t("portfolio.archiveInvestment"), systemImage: "archivebox") {
                        editing.confirmArchive(investment: investment)
                    }
                    .accessibilityLabel(strings.t("portfolio.archiveInvestment") + ": " + holding.name)
                    .disabled(!model.historyComplete || model.historyLoading)
                }
                .buttonStyle(.visionOutline).controlSize(.small)
            }
        }
    }
    /// `getAssetClassLabel`: the raw class when no `portfolio.assetClass.*` label exists.
    private func assetClassLabel(_ value: String) -> String {
        let key = "portfolio.assetClass." + value
        let text = strings.t(key)
        return text == key ? value : text
    }
    private func research(_ holding: PortfolioHolding, symbol: String) {
        model.closeDetail()
        shell.navigate(
            to: NativeRoute(
                path: "/research/market",
                query: [
                    URLQueryItem(name: "symbol", value: symbol),
                    URLQueryItem(name: "investmentId", value: String(holding.id)),
                ]
            ).string)
    }
    private func performance(_ holding: PortfolioHolding) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 30) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(strings.t("invDetail.currentValue")).font(.caption).foregroundStyle(theme.secondaryLabel)
                    Text(money(holding.currentValue, currency: holding.currency)).font(.largeTitle).monospacedDigit()
                    PortfolioPriceFreshnessCaption(holdings: [holding], shell: shell)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 6) {
                    Text(strings.t("invDetail.totalGainLoss")).font(.caption).foregroundStyle(theme.secondaryLabel)
                    Text(money(holding.gainLoss, currency: holding.currency, signed: true)).font(.title)
                        .monospacedDigit()
                        .foregroundStyle(holding.gainLoss >= 0 ? theme.gain : theme.loss)
                    Text(
                        VisionFormat.percent(
                            holding.gainLossPercent, digits: 2, locale: shell.settings.numberFormat.locale)
                    ).monospacedDigit()
                }
            }
            AdminCard {
                VStack(alignment: .leading, spacing: 10) {
                    Text(strings.t("invDetail.breakdown")).font(.headline)
                    row("invDetail.totalCost", holding.totalBuyCost, currency: holding.currency)
                    if ["stock", "etf", "crypto", "metals"].contains(holding.assetClass) {
                        LabeledContent(
                            strings.t("invDetail.unitsHeld"),
                            value: VisionFormat.decimal(
                                holding.totalUnits, fractionDigits: 4, locale: shell.settings.numberFormat.locale))
                        row("invDetail.avgCostPerUnit", holding.avgCostBasis, currency: holding.currency)
                        if holding.currentPrice != 0 {
                            row("invDetail.currentPrice", holding.currentPrice, currency: holding.currency)
                        }
                    }
                    if ["savings", "bond"].contains(holding.assetClass), holding.interestRate != 0 {
                        LabeledContent(
                            strings.t("invDetail.interestRate"),
                            value: VisionFormat.percent(
                                holding.interestRate, digits: 2, locale: shell.settings.numberFormat.locale))
                    }
                    if holding.assetClass == "real_estate" {
                        if let place = holding.municipality {
                            LabeledContent(strings.t("invDetail.municipality"), value: place)
                        }
                        if let cadastral = holding.cadastralIncome {
                            row("invDetail.cadastralIncome", cadastral, currency: holding.originalCurrency)
                        }
                        if let rate = holding.municipalityTaxRate {
                            LabeledContent(
                                strings.t("invDetail.municipalityTaxRate"),
                                value: VisionFormat.percent(rate, digits: 2, locale: shell.settings.numberFormat.locale)
                            )
                        }
                    }
                    Divider()
                    row("invDetail.realizedGain", holding.realizedGain, currency: holding.currency, signed: true)
                    row("invDetail.unrealizedGain", holding.unrealizedGain, currency: holding.currency, signed: true)
                    if holding.totalIncome != 0 {
                        row("invDetail.totalIncome", holding.totalIncome, currency: holding.currency)
                    }
                    if holding.totalFees + holding.totalTaxes != 0 {
                        row(
                            "invDetail.feesAndTaxes", -(holding.totalFees + holding.totalTaxes),
                            currency: holding.currency, signed: true
                        )
                    }
                }
            }
            if holding.originalCurrency != holding.currency, holding.fxGain != nil {
                AdminCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(strings.t("invDetail.fxAttribution")).font(.headline)
                        row(
                            "portfolio.nativeValue", holding.nativeCurrentValue, currency: holding.originalCurrency,
                            params: ["currency": holding.originalCurrency])
                        row(
                            "invDetail.investedAtHistoricalRates", holding.totalInvested, currency: holding.currency,
                            params: ["currency": holding.currency])
                        row("portfolio.assetGain", holding.assetGain, currency: holding.currency, signed: true)
                        row("portfolio.fxEffect", holding.fxGain, currency: holding.currency, signed: true)
                        if holding.usedFallbackRate == true {
                            Text(strings.t("portfolio.fxFallbackNote")).font(.caption).foregroundStyle(theme.warning)
                        }
                    }
                }
            }
            if ["savings", "bond"].contains(holding.assetClass), holding.interestRate != 0 {
                AdminCard {
                    row(
                        "portfolio.projectedAnnualInterest", holding.projectedAnnualInterest, currency: holding.currency
                    )
                    if holding.accruedInterest > 0 {
                        row("portfolio.accruedUnpaid", holding.accruedInterest, currency: holding.currency)
                    }
                }
            }
            if holding.assetClass == "real_estate" {
                AdminCard {
                    row(
                        "invDetail.totalAppreciation", holding.totalAppreciation, currency: holding.currency,
                        signed: true)
                    row("portfolio.rentalIncome", holding.totalIncome, currency: holding.currency)
                }
            }
            if let error = model.historyError {
                Text(error).foregroundStyle(theme.destructive)
                Button(strings.t("common.retry")) { Task { await model.openDetail(id: holding.id) } }
                    .buttonStyle(.visionOutline)
            }
        }.padding(.trailing, 4)
    }
    private func row(
        _ key: String, _ amount: Decimal?, currency: String, signed: Bool = false, params: [String: String] = [:]
    ) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(strings.t(key, params))
            Spacer()
            Text(amount.map { money($0, currency: currency, signed: signed) } ?? "—").monospacedDigit()
                .foregroundStyle(signed ? ((amount ?? 0) >= 0 ? theme.gain : theme.loss) : theme.foreground)
        }.accessibilityElement(children: .combine)
    }
    private func money(_ amount: Decimal, currency: String, signed: Bool = false) -> String {
        MoneyText.text(amount, currency: currency, settings: shell.settings, signed: signed)
    }
}
