import AppKit
import SwiftUI
import VisionNativeCore

struct TaxComputationFlowView: View {
    let overview: OpenAPI.BelgianTaxOverview
    let shell: NativeShellModel
    let portfolioTaxes: Decimal?
    let totalIncludingPortfolio: Decimal?
    let totalIncludingProperty: Decimal?
    @Environment(\.visionTheme) private var theme
    private var c: OpenAPI.BelgianTaxHistoricalCalculation { overview.calculation }
    private var strings: any Localizing { shell.strings }

    var body: some View {
        TaxCard(
            title: strings.t("tax.flow.title"),
            description: strings.t("tax.flow.description", ["year": String(overview.year)])
        ) {
            VStack(alignment: .leading, spacing: 14) {
                stage(
                    "tax.card.profileGrossIncome", c.grossIncome, tone: theme.gain,
                    note: "tax.card.profileGrossIncome.desc")
                Text(strings.t("tax.flow.opGroup.deductions")).font(.caption).foregroundStyle(theme.secondaryLabel)
                operation("tax.pit.row.employeeSS", c.employeeSocialSecurity, sign: "−")
                operation("tax.profile.field.professionalExpenses", c.professionalExpenses, sign: "−")
                operation("tax.profile.section.otherDeductions.title", c.otherDeductionsTotal, sign: "−")
                stage("tax.pit.row.taxableIncome", c.taxableIncome)
                Text(strings.t("tax.flow.op.brackets")).foregroundStyle(theme.secondaryLabel)
                stage("tax.pit.row.federalAfter", c.federalPITAfterReductions, tone: theme.loss)
                operation("tax.pit.row.communalSurcharge", c.communalSurcharge, sign: "+")
                stage("tax.pit.row.totalPIT", c.totalPIT, tone: theme.loss)
                TaxMoneyRow(title: strings.t("tax.card.monthlyTaxReserve"), amount: c.monthlyTaxReserve, shell: shell)
                Text(strings.t("tax.flow.opGroup.alsoOwed")).font(.caption).foregroundStyle(theme.secondaryLabel)
                operation("tax.pit.row.employeeSS", c.employeeSocialSecurity, sign: "+")
                operation("tax.pit.row.specialSS", c.specialSocialSecurityContribution, sign: "+")
                operation("tax.pit.row.propertyTaxEstimate", c.propertyTaxEstimate, sign: "+")
                stage("tax.pit.row.totalBurden", c.totalTaxBurden, tone: theme.loss)
                if let rate = c.effectiveRate {
                    LabeledContent(
                        strings.t("tax.masthead.meta.effectiveBurden"),
                        value: VisionFormat.percent(rate, digits: 1, locale: shell.settings.numberFormat.locale))
                }
                Text(strings.t("tax.flow.op.netOut")).foregroundStyle(theme.secondaryLabel)
                if let income = c.spouseProfessionalIncome, income > 0 {
                    operation("tax.pit.row.spouseIncome", income, sign: "+")
                }
                stage(
                    "tax.card.netTakeHome", c.netTakeHome,
                    tone: (c.netTakeHome ?? 0) >= 0 ? theme.gain : theme.loss, note: "tax.card.netTakeHome.desc")
                Divider()
                Text(strings.t("tax.flow.coda.title")).font(.caption).foregroundStyle(theme.secondaryLabel)
                TaxMoneyRow(
                    title: strings.t("tax.pit.row.portfolioTaxesYear", ["year": String(overview.year)]),
                    amount: portfolioTaxes, shell: shell, tone: theme.loss)
                TaxMoneyRow(
                    title: strings.t("tax.pit.row.totalTaxInclPortfolio"),
                    amount: totalIncludingPortfolio, shell: shell, strong: true)
                TaxMoneyRow(
                    title: strings.t("tax.pit.row.totalWithPropertyEstimate"),
                    amount: totalIncludingProperty, shell: shell, strong: true)
            }
        }
    }
    private func stage(_ key: String, _ amount: Decimal?, tone: Color? = nil, note: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            TaxMoneyRow(title: strings.t(key), amount: amount, shell: shell, strong: true, tone: tone, rolling: true)
            if let note { Text(strings.t(note)).font(.caption).foregroundStyle(theme.secondaryLabel) }
        }.padding(.top, 4)
    }
    private func operation(_ key: String, _ amount: Decimal?, sign: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(strings.t(key)).foregroundStyle(theme.secondaryLabel)
            Spacer()
            Text(
                amount.map {
                    sign
                        + MoneyText.text(
                            $0, currency: shell.settings.defaultCurrency,
                            settings: shell.settings, signed: false)
                } ?? "—"
            ).monospacedDigit()
        }.font(.callout).padding(.leading, 16).accessibilityElement(children: .combine)
    }
}

struct TaxPITBreakdownView: View {
    let overview: OpenAPI.BelgianTaxOverview
    let shell: NativeShellModel
    let portfolioTaxes: Decimal?
    let totalIncludingPortfolio: Decimal?
    let totalIncludingProperty: Decimal?
    @State private var expanded: Bool
    private let onExpandedChange: ((Bool) -> Void)?
    @Environment(\.visionTheme) private var theme
    init(
        overview: OpenAPI.BelgianTaxOverview, shell: NativeShellModel, portfolioTaxes: Decimal?,
        totalIncludingPortfolio: Decimal?, totalIncludingProperty: Decimal?, initiallyExpanded: Bool = false,
        onExpandedChange: ((Bool) -> Void)? = nil
    ) {
        self.overview = overview
        self.shell = shell
        self.portfolioTaxes = portfolioTaxes
        self.totalIncludingPortfolio = totalIncludingPortfolio
        self.totalIncludingProperty = totalIncludingProperty
        self._expanded = State(initialValue: initiallyExpanded)
        self.onExpandedChange = onExpandedChange
    }

    private var strings: any Localizing { shell.strings }
    private var rows: [(String, Decimal?, String)] {
        let c = overview.calculation
        return [
            ("taxableIncome", c.taxableIncome, "base"),
            ("bracket1", c.federalPITBracket1, "tax"), ("bracket2", c.federalPITBracket2, "tax"),
            ("bracket3", c.federalPITBracket3, "tax"), ("bracket4", c.federalPITBracket4, "tax"),
            ("federalBefore", c.federalPITBeforeExemption, "total"),
            ("personalExemptionBenefit", c.personalExemptionBenefit, "reduction"),
            ("federalTaxCredits", c.federalTaxCredits, "reduction"),
            ("federalAfter", c.federalPITAfterReductions, "total"),
            ("communalSurcharge", c.communalSurcharge, "tax"),
            ("specialSS", c.specialSocialSecurityContribution, "tax"), ("totalPIT", c.totalPIT, "grand"),
            ("portfolioTaxesYear", portfolioTaxes, "tax"), ("totalTaxInclPortfolio", totalIncludingPortfolio, "grand"),
            ("propertyTaxEstimate", c.propertyTaxEstimate, "tax"),
            ("totalWithPropertyEstimate", totalIncludingProperty, "grand"),
        ]
    }
    var body: some View {
        TaxCard {
            VisionDisclosure(
                title: strings.t("tax.pit.title"),
                isExpanded: Binding(
                    get: { expanded },
                    set: { value in
                        expanded = value
                        onExpandedChange?(value)
                    })
            ) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(strings.t("tax.pit.description")).foregroundStyle(theme.secondaryLabel)
                    Text(strings.t("tax.pit.tooltip")).font(.caption).foregroundStyle(theme.secondaryLabel)
                    HStack {
                        Text(strings.t("tax.pit.table.component"))
                        Spacer()
                        Text(strings.t("tax.pit.table.amount"))
                    }.font(.caption.weight(.semibold)).padding(.top, 10)
                    ForEach(rows, id: \.0) { key, amount, tone in
                        VStack(alignment: .leading, spacing: 2) {
                            TaxMoneyRow(
                                title: strings.t("tax.pit.row." + key, ["year": String(overview.year)]),
                                amount: amount, shell: shell, signed: tone == "reduction",
                                strong: tone == "grand" || tone == "total",
                                tone: tone == "reduction" ? theme.gain : tone == "tax" ? theme.loss : nil)
                            if key.hasPrefix("bracket"), let index = key.last {
                                VisionBadge(
                                    text: strings.t("tax.pit.bracketRange" + String(index)), tone: .outline, small: true
                                )
                            }
                        }
                        Divider()
                    }
                }.padding(.top, 12)
            }
        }
        .onAppear { onExpandedChange?(expanded) }
        .onDisappear { onExpandedChange?(false) }
    }
}

struct TaxCurrentInputsView: View {
    let overview: OpenAPI.BelgianTaxOverview
    let data: TaxDashboardData
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        let inputs = data.currentInputs
        let c = overview.calculation
        TaxCard(title: strings.t("tax.profile.currentInputs"), description: strings.t("tax.profile.currentInputs.desc"))
        {
            LabeledContent(strings.t("tax.profile.field.employmentType")) {
                VisionBadge(text: strings.t("tax.profile.employment." + inputs.employmentType + ".label"))
            }
            TaxMoneyRow(
                title: strings.t("tax.profile.field.grossAnnualIncome"), amount: inputs.grossAnnualIncome, shell: shell)
            TaxMoneyRow(
                title: strings.t("tax.profile.field.otherTaxableIncome"), amount: inputs.otherTaxableIncome,
                shell: shell)
            if inputs.professionalExpenseMethod == "lump_sum" {
                LabeledContent(
                    strings.t("tax.profile.field.professionalExpenses"),
                    value: strings.t("tax.profile.field.professionalExpenses.lump"))
            } else {
                TaxMoneyRow(
                    title: strings.t("tax.profile.field.professionalExpenses"),
                    amount: inputs.actualProfessionalExpenses, shell: shell)
            }
            LabeledContent(
                strings.t("tax.profile.field.dependents"),
                value:
                    "\(inputs.dependentChildren) \(strings.t("tax.profile.field.children")) / \(inputs.dependentOtherPersons) \(strings.t("tax.profile.field.others"))"
            )
            TaxMoneyRow(
                title: strings.t("tax.profile.field.personalExemption"), amount: c.personalExemptionAmount, shell: shell
            )
            LabeledContent(
                strings.t("tax.profile.field.disabilityExemptions"),
                value: strings.t(inputs.isDisabled || inputs.isSpouseDisabled ? "common.applied" : "common.none"))
            Divider()
            TaxMoneyRow(
                title: strings.t("tax.pit.row.federalAfter"), amount: c.federalPITAfterReductions, shell: shell,
                strong: true, tone: theme.loss)
            TaxMoneyRow(
                title: strings.t("tax.pit.row.communalSurcharge"), amount: c.communalSurcharge, shell: shell,
                tone: theme.loss)
            TaxMoneyRow(
                title: strings.t("tax.pit.row.employeeSS"), amount: c.employeeSocialSecurity, shell: shell,
                tone: theme.loss)
            TaxMoneyRow(
                title: strings.t("tax.pit.row.specialSS"), amount: c.specialSocialSecurityContribution, shell: shell,
                tone: theme.loss)
            TaxMoneyRow(
                title: strings.t("tax.pit.row.totalBurden"), amount: c.totalTaxBurden, shell: shell, strong: true)
        }
    }
}

struct TaxHouseholdBreakdownView: View {
    let overview: OpenAPI.BelgianTaxOverview
    let data: TaxDashboardData
    let shell: NativeShellModel
    @State private var expanded: Bool
    private let onExpandedChange: ((Bool) -> Void)?
    private let printLayout: Bool
    @Environment(\.visionTheme) private var theme
    init(
        overview: OpenAPI.BelgianTaxOverview, data: TaxDashboardData, shell: NativeShellModel,
        initiallyExpanded: Bool = false, printLayout: Bool = false, onExpandedChange: ((Bool) -> Void)? = nil
    ) {
        self.overview = overview
        self.data = data
        self.shell = shell
        self._expanded = State(initialValue: initiallyExpanded)
        self.printLayout = printLayout
        self.onExpandedChange = onExpandedChange
    }

    private var strings: any Localizing { shell.strings }
    private var partners: [OpenAPI.BelgianTaxPartnerTaxResult] { overview.result.partners }
    var body: some View {
        if !data.householdBreakdownRows.isEmpty, partners.count > 1 {
            TaxCard {
                VisionDisclosure(
                    title: strings.t("tax.householdBreakdown.title"),
                    isExpanded: Binding(
                        get: { expanded },
                        set: { value in
                            expanded = value
                            onExpandedChange?(value)
                        })
                ) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(strings.t("tax.householdBreakdown.description", ["year": String(overview.year)]))
                            .foregroundStyle(theme.secondaryLabel)
                        TaxTableViewport(isPrinting: printLayout) {
                            Grid(alignment: .leading, horizontalSpacing: printLayout ? 10 : 24, verticalSpacing: 10) {
                                GridRow {
                                    Text(strings.t("tax.pit.table.component")).font(.caption.weight(.semibold))
                                    ForEach(partners, id: \.partnerId) { partner in
                                        Text(
                                            TaxYearPresentation.partner(
                                                partner.partnerId, overview: overview, strings: strings)
                                        ).font(.caption.weight(.semibold))
                                    }
                                    Text(strings.t("tax.householdBreakdown.column.household")).font(
                                        .caption.weight(.semibold))
                                }
                                ForEach(data.householdBreakdownRows) { row in
                                    GridRow {
                                        Text(
                                            strings.t(
                                                row.key == "taxableIncome"
                                                    ? "tax.pit.row.taxableIncome"
                                                    : "tax.householdBreakdown.row." + row.key))
                                        ForEach(partners, id: \.partnerId) { partner in
                                            amount(row.partnerAmounts[partner.partnerId], tone: row.tone)
                                        }
                                        amount(row.household, tone: row.tone)
                                    }
                                }
                                if let recorded = data.recordedIncomeByPartner {
                                    Divider().gridCellColumns(partners.count + 2)
                                    GridRow { Text(strings.t("tax.householdBreakdown.recorded.title")).font(.headline) }
                                    GridRow {
                                        Text(strings.t("tax.householdBreakdown.recorded.entered"))
                                        ForEach(partners, id: \.partnerId) { partner in amount(partner.grossIncome) }
                                        amount(overview.result.totals.grossIncome)
                                    }
                                    GridRow {
                                        Text(strings.t("tax.householdBreakdown.recorded.transactions"))
                                        ForEach(partners, id: \.partnerId) { partner in
                                            amount(partner.partnerId == "A" ? recorded.A : recorded.B)
                                        }
                                        amount(recorded.A + recorded.B)
                                    }
                                }
                            }.frame(minWidth: printLayout ? nil : 620, alignment: .leading)
                        }
                        if data.recordedIncomeByPartner != nil {
                            Text(strings.t("tax.householdBreakdown.recorded.note")).font(.caption).foregroundStyle(
                                theme.secondaryLabel)
                        }
                        LabeledContent(
                            strings.t("tax.householdBreakdown.assessment"),
                            value: strings.t("tax.household.assessment.mode." + overview.result.assessment.mode))
                        if overview.result.assessment.mode == "joint" {
                            LabeledContent(strings.t("tax.householdBreakdown.quotient"), value: quotientDescription)
                            if overview.result.quotient.applied {
                                TaxMoneyRow(
                                    title: strings.t("tax.householdBreakdown.quotient.benefit"),
                                    amount: overview.result.quotient.benefit, shell: shell, tone: theme.gain)
                            }
                        }
                        VisionBadge(text: overview.result.assessment.legalBasis, tone: .outline)
                        Text(strings.t("tax.household.assessment.reason." + overview.result.assessment.reason)).font(
                            .caption
                        ).foregroundStyle(theme.secondaryLabel)
                    }.padding(.top, 12)
                }
            }
            .onAppear { onExpandedChange?(expanded) }
            .onDisappear { onExpandedChange?(false) }
        }
    }
    private var quotientDescription: String {
        let q = overview.result.quotient
        guard q.applied, let from = q.fromPartnerId, let to = q.toPartnerId else {
            return strings.t("tax.householdBreakdown.quotient.notApplied")
        }
        return strings.t(
            "tax.householdBreakdown.quotient.transfer",
            [
                "amount": MoneyText.text(
                    q.transfer, currency: shell.settings.defaultCurrency, settings: shell.settings, signed: false),
                "from": TaxYearPresentation.partner(from, overview: overview, strings: strings),
                "to": TaxYearPresentation.partner(to, overview: overview, strings: strings),
            ])
    }
    private func amount(_ value: Decimal?, tone: String = "base") -> some View {
        Text(
            value.map {
                MoneyText.text(
                    tone == "reduction" ? -$0 : $0,
                    currency: shell.settings.defaultCurrency, settings: shell.settings,
                    signed: tone == "reduction" || tone == "adjustment")
            } ?? "—"
        )
        .monospacedDigit().foregroundStyle(tone == "reduction" ? theme.gain : theme.foreground)
        .fontWeight(tone == "total" ? .semibold : .regular)
    }
}

extension TaxPITBreakdownView {
    /// This is called only for the frozen, expanded print disclosure.
    @MainActor func printTable(width: CGFloat) -> NSView {
        let printedRows: [[NativeTaxPrintCell]] = rows.map { key, amount, tone in
            let strong = tone == "grand" || tone == "total"
            let detail =
                key.hasPrefix("bracket") ? key.last.map { strings.t("tax.pit.bracketRange" + String($0)) } : nil
            let label = NativeTaxPrintCell(
                text: strings.t("tax.pit.row." + key, ["year": String(overview.year)]), detail: detail, strong: strong)
            let value =
                amount.map {
                    MoneyText.text(
                        $0, currency: shell.settings.defaultCurrency, settings: shell.settings,
                        signed: tone == "reduction")
                } ?? "—"
            let numeric = NativeTaxPrintCell(
                text: value, strong: strong, tone: tone == "reduction" ? .gain : tone == "tax" ? .loss : .normal)
            return [label, numeric]
        }
        return NativeTaxPrintTable.make(
            id: "tax.pit", title: strings.t("tax.pit.title"), description: strings.t("tax.pit.description"),
            notes: [strings.t("tax.pit.tooltip")],
            columns: [
                .init(text: strings.t("tax.pit.table.component")), .init(text: strings.t("tax.pit.table.amount")),
            ],
            rows: printedRows, shell: shell, width: width)
    }
}

extension TaxHouseholdBreakdownView {
    @MainActor func printTable(width: CGFloat) -> NSView? {
        guard !data.householdBreakdownRows.isEmpty, partners.count > 1 else { return nil }
        var columns = [NativeTaxPrintCell(text: strings.t("tax.pit.table.component"))]
        columns += partners.map {
            NativeTaxPrintCell(text: TaxYearPresentation.partner($0.partnerId, overview: overview, strings: strings))
        }
        columns.append(.init(text: strings.t("tax.householdBreakdown.column.household")))
        var printedRows: [[NativeTaxPrintCell]] = data.householdBreakdownRows.map { row in
            let title = strings.t(
                row.key == "taxableIncome" ? "tax.pit.row.taxableIncome" : "tax.householdBreakdown.row." + row.key)
            var cells = [NativeTaxPrintCell(text: title)]
            cells += partners.map { printAmount(row.partnerAmounts[$0.partnerId], tone: row.tone) }
            cells.append(printAmount(row.household, tone: row.tone))
            return cells
        }
        if let recorded = data.recordedIncomeByPartner {
            var heading = [NativeTaxPrintCell(text: strings.t("tax.householdBreakdown.recorded.title"), strong: true)]
            heading += Array(repeating: NativeTaxPrintCell(text: ""), count: columns.count - 1)
            printedRows.append(heading)
            var entered = [NativeTaxPrintCell(text: strings.t("tax.householdBreakdown.recorded.entered"))]
            entered += partners.map { printAmount($0.grossIncome) }
            entered.append(printAmount(overview.result.totals.grossIncome))
            printedRows.append(entered)
            var transactions = [NativeTaxPrintCell(text: strings.t("tax.householdBreakdown.recorded.transactions"))]
            transactions += partners.map { printAmount($0.partnerId == "A" ? recorded.A : recorded.B) }
            transactions.append(printAmount(recorded.A + recorded.B))
            printedRows.append(transactions)
        }
        let footer = NativePagePrintRow { width in
            NativeTaxPrintTable.host(
                TaxHouseholdPrintFooter(
                    overview: overview, shell: shell, hasRecordedIncome: data.recordedIncomeByPartner != nil,
                    quotientDescription: quotientDescription),
                shell: shell, width: width, id: "tax.household.footer")
        }
        return NativeTaxPrintTable.make(
            id: "tax.household", title: strings.t("tax.householdBreakdown.title"),
            description: strings.t("tax.householdBreakdown.description", ["year": String(overview.year)]),
            columns: columns, rows: printedRows, shell: shell, width: width, footer: footer)
    }

    private func printAmount(_ value: Decimal?, tone: String = "base") -> NativeTaxPrintCell {
        let text =
            value.map {
                MoneyText.text(
                    tone == "reduction" ? -$0 : $0, currency: shell.settings.defaultCurrency,
                    settings: shell.settings, signed: tone == "reduction" || tone == "adjustment")
            } ?? "—"
        return .init(text: text, strong: tone == "total", tone: tone == "reduction" ? .gain : .normal)
    }
}

private struct TaxHouseholdPrintFooter: View {
    let overview: OpenAPI.BelgianTaxOverview
    let shell: NativeShellModel
    let hasRecordedIncome: Bool
    let quotientDescription: String
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if hasRecordedIncome {
                Text(strings.t("tax.householdBreakdown.recorded.note")).font(.caption).foregroundStyle(
                    theme.secondaryLabel)
            }
            LabeledContent(
                strings.t("tax.householdBreakdown.assessment"),
                value: strings.t("tax.household.assessment.mode." + overview.result.assessment.mode))
            if overview.result.assessment.mode == "joint" {
                LabeledContent(strings.t("tax.householdBreakdown.quotient"), value: quotientDescription)
                if overview.result.quotient.applied {
                    TaxMoneyRow(
                        title: strings.t("tax.householdBreakdown.quotient.benefit"),
                        amount: overview.result.quotient.benefit, shell: shell, tone: theme.gain)
                }
            }
            Text(overview.result.assessment.legalBasis).font(.caption)
                .padding(6).overlay(RoundedRectangle(cornerRadius: 8).stroke(theme.border))
            Text(strings.t("tax.household.assessment.reason." + overview.result.assessment.reason))
                .font(.caption).foregroundStyle(theme.secondaryLabel)
        }.padding(NativeTaxPrintTable.inset).frame(maxWidth: .infinity, alignment: .leading)
    }
}
