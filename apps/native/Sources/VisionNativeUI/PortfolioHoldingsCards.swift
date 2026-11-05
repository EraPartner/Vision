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
        .buttonStyle(.vision(.ghost, size: .iconSm)).menuStyle(.button).menuIndicator(.hidden).fixedSize()
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
    private var isProperty: Bool { holding.assetClass == .realEstate }
    private var maturity: Date? { holding.maturityDate.flatMap { VisionFormat.parseTimestamp($0 + "T00:00:00") } }
    private var days: Int? {
        maturity.map {
            Calendar.current.dateComponents(
                [.day], from: Calendar.current.startOfDay(for: Date()), to: Calendar.current.startOfDay(for: $0)
            ).day ?? 0
        }
    }
    private var nearingMaturity: Bool { days.map { $0 <= 30 } ?? false }
    private var currency: CurrencyCode { shell.settings.portfolioCurrency }
    private func money(_ amount: Decimal, signed: Bool = false) -> String {
        MoneyText.text(amount, currency: currency, settings: shell.settings, signed: signed)
    }
    private func percent(_ value: Decimal, digits: Int, signed: Bool = false) -> String {
        (signed && value > 0 ? "+" : "") + VisionFormat.percent(value, digits: digits, locale: shell.settings.numberFormat.locale)
    }
    private var actionsMenu: some View {
        PortfolioHoldingActionsMenu(
            holding: holding, model: model, editing: editing, shell: shell,
            deletePrefix: isProperty ? "realestate" : "savings")
    }
    /// The web property `CardHeader`: a 40 pt icon tile, the serif title and the location.
    private var propertyHeader: some View {
        HStack(alignment: .top, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "building.2").font(.system(size: 17, weight: .medium))
                    .foregroundStyle(theme.primary).frame(width: 40, height: 40)
                    .background(
                        theme.primary.opacity(0.12),
                        in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                    )
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Button(holding.name) { Task { await model.openDetail(id: holding.id) } }
                        .buttonStyle(.plain).font(Font.visionTitle3).lineLimit(1)
                    if let location = holding.location, !location.isEmpty {
                        Label(location, systemImage: "mappin").font(.callout).foregroundStyle(theme.secondaryLabel)
                            .lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 0)
            actionsMenu
        }
    }
    private var savingsHeader: some View {
        HStack(alignment: .top) {
            Image(systemName: holding.assetClass == .bond ? "shield" : "banknote")
                .font(.title2).foregroundStyle(theme.primary).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Button(holding.name) { Task { await model.openDetail(id: holding.id) } }
                    .buttonStyle(.plain).font(.headline)
                VisionBadge(text: strings.t("portfolio.assetClass." + holding.assetClass.rawValue))
                if holding.interestRate != 0 {
                    let rate = holding.interestRate
                    Text(
                        VisionFormat.percent(rate, digits: 2, locale: shell.settings.numberFormat.locale)
                            + " " + strings.t("savings.pa")
                    )
                    .font(.caption).foregroundStyle(theme.secondaryLabel)
                }
            }
            Spacer()
            actionsMenu
        }
    }
    /// The web property body: purchase price and current value side by side as large serif
    /// amounts, then a `dl` of label-left / value-right rows between hairlines.
    @ViewBuilder private var propertyBody: some View {
        let monthly = holding.monthlyRent ?? 0
        let yield = holding.currentValue > 0 ? monthly * 12 / holding.currentValue * 100 : 0
        let returnAmount = holding.propertyReturn ?? 0
        let roi = holding.totalBuyCost > 0 ? returnAmount / holding.totalBuyCost * 100 : 0
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text(strings.t("portfolio.purchasePrice")).font(.caption).foregroundStyle(theme.tertiaryLabel)
                MoneyText(
                    amount: holding.totalBuyCost, currency: currency, settings: shell.settings, signed: false,
                    colored: false
                ).font(.visionCardTitle)
            }.frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 2) {
                Text(strings.t("portfolio.currentValue")).font(.caption).foregroundStyle(theme.tertiaryLabel)
                MoneyText(
                    amount: holding.currentValue, currency: currency, settings: shell.settings, signed: false,
                    colored: false
                ).font(.visionCardTitle).foregroundStyle(theme.primary)
            }.frame(maxWidth: .infinity, alignment: .trailing)
        }
        VStack(spacing: 0) {
            Rectangle().fill(theme.border.opacity(0.5)).frame(height: 1)
            factRow(
                strings.t("portfolio.appreciation"), money(holding.totalAppreciation, signed: true),
                tone: holding.totalAppreciation >= 0 ? theme.gain : theme.loss)
            factRow(
                strings.t("portfolio.rentalIncome"), money(holding.totalIncome, signed: true),
                detail: monthly > 0 ? "~" + money(monthly) + strings.t("realestate.perMonth") : nil,
                tone: holding.totalIncome >= 0 ? theme.gain : theme.loss)
            if let municipality = holding.municipality, !municipality.isEmpty {
                factRow(strings.t("invDetail.municipality"), municipality)
            }
            if let cadastral = holding.cadastralIncome {
                factRow(
                    strings.t("invDetail.cadastralIncome"),
                    MoneyText.text(
                        cadastral, currency: holding.originalCurrency, settings: shell.settings, signed: false))
            }
            if let rate = holding.municipalityTaxRate {
                factRow(strings.t("invDetail.municipalityTaxRate"), percent(rate, digits: 2))
            }
            factRow(strings.t("portfolio.yield"), percent(yield, digits: 1) + " " + strings.t("portfolio.annual"))
            factRow(strings.t("portfolio.totalROI")) {
                DeltaPill(roi, label: percent(roi, digits: 1, signed: true))
            }
            if holding.totalFees + holding.totalTaxes > 0 {
                factRow(
                    strings.t("portfolio.feesAndTaxes"), money(-(holding.feesAndTaxes ?? 0), signed: true),
                    tone: theme.loss)
            }
        }
    }
    /// `FactRow`: `flex justify-between gap-4 py-2`, the label in the footnote size on the left,
    /// the value right-aligned with an optional caption under it, a hairline between rows.
    private func factRow(_ label: String, _ value: String, detail: String? = nil, tone: Color? = nil) -> some View {
        factRow(label, detail: detail) {
            MoneyText.styled(
                value, decimalSeparator: shell.settings.numberFormat.locale.decimalSeparator?.first,
                color: tone ?? theme.foreground
            ).monospacedDigit().foregroundStyle(tone ?? theme.foreground)
        }
    }
    private func factRow<Value: View>(
        _ label: String, detail: String? = nil, @ViewBuilder value: () -> Value
    ) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 16) {
                Text(label).font(.footnote).foregroundStyle(theme.secondaryLabel)
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 0) {
                    value().font(.body)
                    if let detail {
                        Text(detail).font(.caption).monospacedDigit().foregroundStyle(theme.tertiaryLabel)
                    }
                }.multilineTextAlignment(.trailing)
            }.padding(.vertical, 8)
            Rectangle().fill(theme.border.opacity(0.5)).frame(height: 1)
        }
    }
    var body: some View {
        AdminCard {
            VStack(alignment: .leading, spacing: 16) {
                if isProperty { propertyHeader } else { savingsHeader }
                if isProperty {
                    propertyBody
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
                        HStack {
                            Text(strings.t((days ?? 1) <= 0 ? "portfolio.matured" : "portfolio.matures"))
                            Spacer(minLength: 0)
                            Text(VisionFormat.appDate(date, format: shell.settings.dateFormat))
                        }
                        .foregroundStyle(nearingMaturity ? theme.warning : theme.secondaryLabel)
                        if let days, days > 0 {
                            Text(strings.t("portfolio.daysRemaining", ["days": String(days)]))
                                .font(.caption).foregroundStyle(nearingMaturity ? theme.warning : theme.secondaryLabel)
                        }
                    }
                }
                if !isProperty, holding.totalFees + holding.totalTaxes > 0 {
                    TaxMoneyRow(
                        title: strings.t("portfolio.feesAndTaxesPaid"),
                        amount: -(holding.feesAndTaxes ?? 0), shell: shell, signed: true, tone: theme.loss)
                }
            }
        }.overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card).stroke(
                nearingMaturity ? theme.warning.opacity(0.6) : .clear))
    }
}
