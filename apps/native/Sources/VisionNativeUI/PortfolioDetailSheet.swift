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
        VStack(alignment: .leading, spacing: 18) {
            if let error = model.error {
                Text(error).foregroundStyle(theme.destructive)
                Button(strings.t("common.retry")) {
                    Task { await model.load(currency: shell.settings.defaultCurrency, force: true) }
                }
            }
            if let holding = model.selectedInvestment {
                header(holding)
                if !holding.isActive {
                    Label(strings.t("portfolio.archivedExcluded"), systemImage: "archivebox")
                        .font(.callout).foregroundStyle(theme.secondaryLabel)
                }
                Picker(strings.t("invDetail.breakdown"), selection: $tab) {
                    Text(strings.t("invDetail.tab.performance")).tag("performance")
                    Text(strings.t("invDetail.tab.transactions", ["n": String(model.transactions.count)])).tag(
                        "transactions")
                }.pickerStyle(.segmented)
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
                            editing.bindTransactions(model.transactions)
                            editing.beginAddTransaction(investment: investment, bookingCurrency: holding.currency)
                        }.buttonStyle(.borderedProminent).disabled(!model.historyComplete || model.historyLoading)
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(50)
                Button(strings.t("common.close")) { model.closeDetail() }.keyboardShortcut(.cancelAction)
            }
        }.padding(24).frame(minWidth: 680, idealWidth: 800)
            .portfolioEditingPresentation(model: editing, shell: shell)
            .onChange(of: model.selectedInvestment?.isActive) { previous, current in
                if previous == true && current != true && model.error == nil { model.closeDetail() }
            }
    }
    private func header(_ holding: PortfolioHolding) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                if let symbol = holding.symbol {
                    Text(symbol).font(.caption.weight(.semibold)).foregroundStyle(theme.secondaryLabel)
                    Button(holding.name) { research(holding, symbol: symbol) }.buttonStyle(.link).font(
                        .title2.weight(.semibold))
                } else {
                    Text(holding.name).font(.title2.weight(.semibold))
                }
                HStack {
                    VisionBadge(text: strings.t("portfolio.assetClass." + holding.assetClass))
                    if !holding.isActive { VisionBadge(text: strings.t("portfolio.archived"), tone: .muted) }
                    if holding.oversold {
                        VisionBadge(text: strings.t("portfolio.oversold.label"), tone: .warning)
                            .help(strings.t("portfolio.oversold.description"))
                    }
                }
            }
            Spacer()
            if holding.isActive, let investment = model.investment(id: holding.id) {
                Button(strings.t("common.edit"), systemImage: "pencil") {
                    editing.beginEditInvestment(investment: investment)
                }
                .disabled(!model.historyComplete || model.historyLoading)
                Button {
                    editing.confirmArchive(investment: investment)
                } label: {
                    Image(systemName: "archivebox")
                }
                .accessibilityLabel(strings.t("portfolio.archiveInvestment")).disabled(
                    !model.historyComplete || model.historyLoading)
            }
            Button {
                model.closeDetail()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless).accessibilityLabel(strings.t("common.close")).keyboardShortcut(.cancelAction)
        }
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
