import SwiftUI
import VisionNativeCore

struct PortfolioHoldingActionsMenu: View {
    let holding: PortfolioHolding
    let model: PortfolioModel
    let editing: PortfolioEditingModel
    let shell: NativeShellModel
    var deletePrefix = "stocks"
    private var strings: any Localizing { shell.strings }
    var body: some View {
        Menu {
            Button(strings.t("invDetail.trigger"), systemImage: "info.circle") {
                Task { await model.openDetail(id: holding.id) }
            }
            if holding.isActive, let investment = model.investment(id: holding.id) {
                Button(strings.t("form.addTransaction.title"), systemImage: "plus") {
                    Task {
                        guard await model.loadHistory(investmentId: investment.id),
                            model.historyInvestmentId == investment.id
                        else { return }
                        editing.bindTransactions(model.transactions)
                        editing.beginAddTransaction(investment: investment, bookingCurrency: holding.currency)
                    }
                }
                Button(strings.t("portfolio.archiveInvestment"), systemImage: "archivebox") {
                    editing.confirmArchive(investment: investment)
                }
                Button(strings.t(deleteKey), systemImage: "trash", role: .destructive) {
                    editing.confirmDeleteInvestment(
                        investment: investment, titleKey: deleteKey, descriptionKey: deleteKey + "Desc")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .accessibilityLabel(strings.t("portfolio.row.menu", ["name": holding.name]))
    }
    private var deleteKey: String {
        switch deletePrefix {
        case "crypto": "crypto.deleteAsset"
        case "realestate": "realestate.deleteProperty"
        case "savings": "savings.deleteAccount"
        default: "portfolio.deleteInvestment"
        }
    }
}

struct PortfolioAssetCard: View {
    let holding: PortfolioHolding
    let model: PortfolioModel
    let editing: PortfolioEditingModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var isProperty: Bool { holding.assetClass == "real_estate" }
    private var maturity: Date? { holding.maturityDate.flatMap { VisionFormat.parseTimestamp($0 + "T00:00:00") } }
    private var days: Int? {
        maturity.map {
            Calendar.current.dateComponents(
                [.day], from: Calendar.current.startOfDay(for: Date()), to: Calendar.current.startOfDay(for: $0)
            ).day ?? 0
        }
    }
    private var nearingMaturity: Bool { days.map { $0 <= 30 } ?? false }
    var body: some View {
        AdminCard {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    Image(systemName: isProperty ? "building.2" : holding.assetClass == "bond" ? "shield" : "banknote")
                        .font(.title2).foregroundStyle(theme.primary).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Button(holding.name) { Task { await model.openDetail(id: holding.id) } }
                            .buttonStyle(.plain).font(.headline)
                        if isProperty, let location = holding.location, !location.isEmpty {
                            Label(location, systemImage: "mappin").font(.callout).foregroundStyle(theme.secondaryLabel)
                        } else if !isProperty {
                            VisionBadge(text: strings.t("portfolio.assetClass." + holding.assetClass))
                            if holding.interestRate != 0 {
                                let rate = holding.interestRate
                                Text(
                                    VisionFormat.percent(rate, digits: 2, locale: shell.settings.numberFormat.locale)
                                        + " " + strings.t("savings.pa")
                                )
                                .font(.caption).foregroundStyle(theme.secondaryLabel)
                            }
                        }
                    }
                    Spacer()
                    PortfolioHoldingActionsMenu(
                        holding: holding, model: model, editing: editing, shell: shell,
                        deletePrefix: isProperty ? "realestate" : "savings")
                }
                if isProperty {
                    TaxMoneyRow(title: strings.t("portfolio.purchasePrice"), amount: holding.totalBuyCost, shell: shell)
                    TaxMoneyRow(
                        title: strings.t("portfolio.currentValue"), amount: holding.currentValue, shell: shell,
                        strong: true)
                    Divider()
                    TaxMoneyRow(
                        title: strings.t("portfolio.appreciation"), amount: holding.totalAppreciation, shell: shell,
                        signed: true,
                        tone: holding.totalAppreciation >= 0 ? theme.gain : theme.loss)
                    TaxMoneyRow(title: strings.t("portfolio.rentalIncome"), amount: holding.totalIncome, shell: shell)
                    if let monthly = holding.estimatedMonthlyRent {
                        Text(
                            "~"
                                + MoneyText.text(
                                    monthly, currency: holding.currency, settings: shell.settings, signed: false) + " "
                                + strings.t("realestate.perMonth")
                        )
                        .font(.caption).foregroundStyle(theme.secondaryLabel)
                        let yield = holding.currentValue > 0 ? monthly * 12 / holding.currentValue * 100 : 0
                        LabeledContent(
                            strings.t("portfolio.yield"),
                            value: VisionFormat.percent(yield, digits: 2, locale: shell.settings.numberFormat.locale)
                                + " " + strings.t("portfolio.annual"))
                    }
                    if let municipality = holding.municipality, !municipality.isEmpty {
                        LabeledContent(strings.t("invDetail.municipality"), value: municipality)
                    }
                    if let cadastral = holding.cadastralIncome {
                        LabeledContent(
                            strings.t("invDetail.cadastralIncome"),
                            value: MoneyText.text(
                                cadastral,
                                currency: holding.originalCurrency, settings: shell.settings, signed: false))
                    }
                    if let rate = holding.municipalityTaxRate {
                        LabeledContent(
                            strings.t("invDetail.municipalityTaxRate"),
                            value: VisionFormat.percent(rate, digits: 2, locale: shell.settings.numberFormat.locale))
                    }
                    let returnAmount =
                        holding.totalAppreciation + holding.totalIncome - holding.totalFees - holding.totalTaxes
                    LabeledContent(
                        strings.t("portfolio.totalROI"),
                        value: VisionFormat.percent(
                            holding.totalBuyCost > 0 ? returnAmount / holding.totalBuyCost * 100 : 0,
                            digits: 2, locale: shell.settings.numberFormat.locale))
                } else {
                    TaxMoneyRow(
                        title: strings.t("portfolio.currentBalance"), amount: holding.currentValue, shell: shell,
                        strong: true)
                    TaxMoneyRow(title: strings.t("portfolio.interestEarned"), amount: holding.totalIncome, shell: shell)
                    if holding.interestRate != 0 {
                        Divider()
                        TaxMoneyRow(
                            title: strings.t("portfolio.projectedAnnualInterest"),
                            amount: holding.projectedAnnualInterest, shell: shell, tone: theme.gain)
                        if holding.accruedInterest > 0 {
                            TaxMoneyRow(
                                title: strings.t("portfolio.accruedUnpaid"), amount: holding.accruedInterest,
                                shell: shell)
                        }
                    }
                    if let date = holding.maturityDate {
                        LabeledContent(
                            strings.t((days ?? 1) <= 0 ? "portfolio.matured" : "portfolio.matures"),
                            value: VisionFormat.appDate(date, format: shell.settings.dateFormat)
                        )
                        .foregroundStyle(nearingMaturity ? theme.warning : theme.secondaryLabel)
                        if let days, days > 0 {
                            Text(strings.t("portfolio.daysRemaining", ["days": String(days)]))
                                .font(.caption).foregroundStyle(nearingMaturity ? theme.warning : theme.secondaryLabel)
                        }
                    }
                }
                if holding.totalFees + holding.totalTaxes > 0 {
                    TaxMoneyRow(
                        title: strings.t(isProperty ? "portfolio.feesAndTaxes" : "portfolio.feesAndTaxesPaid"),
                        amount: -(holding.totalFees + holding.totalTaxes), shell: shell, signed: true, tone: theme.loss)
                }
            }
        }.overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card).stroke(
                nearingMaturity ? theme.warning.opacity(0.6) : .clear))
    }
}
