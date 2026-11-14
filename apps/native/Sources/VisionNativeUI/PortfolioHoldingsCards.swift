import SwiftUI
import VisionNativeCore

struct PortfolioHoldingActionsMenu: View {
    let holding: PortfolioHolding
    let model: PortfolioModel
    let editing: PortfolioEditingModel
    let shell: NativeShellModel
    var page = PortfolioHoldingsPage.stocks
    private var strings: any Localizing { shell.strings }
    var body: some View {
        VisionMenu {
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
                Button(strings.t("portfolio.classify.menu"), systemImage: "tag") {
                    Task { await editing.classification.open(investmentIds: [holding.id]) }
                }
                Divider()
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
    private var deleteKey: String { page.deleteKey }
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
            page: isProperty ? .realEstate : .savings)
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
    private var isSavings: Bool { holding.assetClass == .savings }
    private var isMatured: Bool { days.map { $0 <= 0 } ?? false }
    private var maturingSoon: Bool { days.map { $0 > 0 && $0 <= 30 } ?? false }
    /// SavingsPage `CardHeader`: a 40 pt tinted tile (PiggyBank on primary for savings, Shield on
    /// accent for bonds), the title, then the type badge and the accent `x % p.a.` rate.
    private var savingsHeader: some View {
        let tint = isSavings ? theme.primary : theme.accent
        return HStack(alignment: .top, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: isSavings ? "banknote" : "shield").font(.system(size: 17, weight: .medium))
                    .foregroundStyle(tint).frame(width: 40, height: 40)
                    .background(
                        tint.opacity(0.12),
                        in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                    )
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Button(holding.name) { Task { await model.openDetail(id: holding.id) } }
                        .buttonStyle(.plain).font(Font.visionTitle3).lineLimit(1)
                    HStack(spacing: 8) {
                        VisionBadge(text: strings.t(isSavings ? "portfolio.savings" : "portfolio.bond"), small: true)
                        if holding.interestRate != 0 {
                            Text(
                                VisionFormat.percent(
                                    holding.interestRate, digits: 2, locale: shell.settings.numberFormat.locale)
                                    + " " + strings.t("savings.pa")
                            )
                            .font(.callout).monospacedDigit().foregroundStyle(theme.accent)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
            actionsMenu
        }
    }
    /// SavingsPage `CardContent`: the balance and the interest earned side by side as `type-title-2`
    /// amounts, then the `FactRow` list between hairlines.
    @ViewBuilder private var savingsBody: some View {
        let earned = holding.totalIncome
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text(strings.t("portfolio.currentBalance")).font(.caption).foregroundStyle(theme.tertiaryLabel)
                MoneyText(
                    amount: holding.currentValue, currency: currency, settings: shell.settings, signed: false,
                    colored: false
                ).font(.visionCardTitle)
            }.frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 2) {
                Text(strings.t("portfolio.interestEarned")).font(.caption).foregroundStyle(theme.tertiaryLabel)
                Text(money(earned, signed: true)).font(.visionCardTitle).monospacedDigit()
                    .foregroundStyle(earned > 0 ? theme.gain : earned < 0 ? theme.loss : theme.foreground)
            }.frame(maxWidth: .infinity, alignment: .trailing)
        }
        let projects = holding.interestRate != 0 && holding.projectedAnnualInterest > 0
        let charged = holding.totalFees > 0 || holding.totalTaxes > 0
        if projects || holding.maturityDate != nil || charged {
            VStack(spacing: 0) {
                Rectangle().fill(theme.border.opacity(0.5)).frame(height: 1)
                if projects {
                    factRow(
                        strings.t("portfolio.projectedAnnualInterest"),
                        money(holding.projectedAnnualInterest, signed: true), tone: theme.primary)
                    if holding.accruedInterest > 0 {
                        factRow(
                            strings.t("portfolio.accruedUnpaid"), money(holding.accruedInterest, signed: true),
                            tone: theme.gain)
                    }
                }
                if let date = holding.maturityDate {
                    maturityRow(date)
                }
                if charged {
                    factRow(
                        strings.t("portfolio.feesAndTaxesPaid"), money(-(holding.feesAndTaxes ?? 0), signed: true),
                        tone: theme.loss)
                }
            }
        }
    }
    private func maturityRow(_ date: String) -> some View {
        let tone: Color? = isMatured ? theme.accent : maturingSoon ? theme.primary : nil
        let label = strings.t(isMatured ? "portfolio.matured" : "portfolio.matures")
        let detail = !isMatured ? days.map { strings.t("portfolio.daysRemaining", ["days": String($0)]) } : nil
        return VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 16) {
                Label(label, systemImage: "calendar").font(.footnote).foregroundStyle(theme.secondaryLabel)
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 0) {
                    Text(VisionFormat.appDate(date, format: shell.settings.dateFormat)).font(.body)
                        .monospacedDigit().foregroundStyle(tone ?? theme.foreground)
                    if let detail {
                        Text(detail).font(.caption).monospacedDigit().foregroundStyle(theme.tertiaryLabel)
                    }
                }.multilineTextAlignment(.trailing)
            }.padding(.vertical, 8)
            Rectangle().fill(theme.border.opacity(0.5)).frame(height: 1)
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
                if isProperty { propertyBody } else { savingsBody }
            }
        }.overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card).stroke(
                isProperty ? Color.clear : isMatured ? theme.accent.opacity(0.6)
                    : maturingSoon ? theme.primary.opacity(0.6) : .clear))
    }
}
