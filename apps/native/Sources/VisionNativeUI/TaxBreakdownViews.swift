import AppKit
import SwiftUI
import VisionNativeCore

/// One line item applied to a stage on the way to the next one (`FlowOperation`).
private struct TaxFlowOperation: Identifiable {
    let id: String
    let label: String
    let amount: Decimal?
    let sign: String
}

/// The operations of a stage: a signed list under an optional heading, or one prose sentence
/// (`FlowOperationGroup`).
private struct TaxFlowGroup {
    var heading: String?
    var items: [TaxFlowOperation] = []
    var prose: String?
}

/// One anchor of the computation (`FlowStage`).
private struct TaxFlowStage: Identifiable {
    let id: String
    let label: String
    let amount: Decimal?
    let tone: Color
    var note: String?
    var chip: String?
    /// Emphasis rank: 0 = step, 1 = subtotal, 2 = the document's conclusion.
    var weight = 0
    var then: TaxFlowGroup?
}

/// TaxComputationFlow: the assessment notice as a vertical timeline. Each stage is a node on a
/// rail with its figure, an optional note and chip, and the operations that carry it into the
/// next stage in a tinted inset box.
struct TaxComputationFlowView: View {
    let overview: OpenAPI.BelgianTaxOverview
    let shell: NativeShellModel
    let portfolioTaxes: Decimal?
    let totalIncludingPortfolio: Decimal?
    let totalIncludingProperty: Decimal?
    @Environment(\.visionTheme) private var theme
    private var c: OpenAPI.BelgianTaxHistoricalCalculation { overview.calculation }
    private var strings: any Localizing { shell.strings }

    private func money(_ amount: Decimal?) -> String {
        amount.map {
            MoneyText.text($0, currency: shell.settings.portfolioCurrency, settings: shell.settings, signed: false)
        } ?? "—"
    }

    private func operation(_ key: String, _ amount: Decimal?, _ sign: String) -> TaxFlowOperation {
        TaxFlowOperation(id: key + sign, label: strings.t(key), amount: amount, sign: sign)
    }

    private var stages: [TaxFlowStage] {
        [grossStage, taxableStage, federalStage, totalPITStage, burdenStage, netStage]
    }

    private var grossStage: TaxFlowStage {
        TaxFlowStage(
            id: "gross", label: strings.t("tax.card.profileGrossIncome"), amount: c.grossIncome, tone: theme.gain,
            note: strings.t("tax.card.profileGrossIncome.desc"), weight: 1,
            then: TaxFlowGroup(
                heading: strings.t("tax.flow.opGroup.deductions"),
                items: [
                    operation("tax.pit.row.employeeSS", c.employeeSocialSecurity, "−"),
                    operation("tax.profile.field.professionalExpenses", c.professionalExpenses, "−"),
                    operation("tax.profile.section.otherDeductions.title", c.otherDeductionsTotal, "−"),
                ]))
    }

    private var taxableStage: TaxFlowStage {
        TaxFlowStage(
            id: "taxable", label: strings.t("tax.pit.row.taxableIncome"), amount: c.taxableIncome,
            tone: theme.foreground, then: TaxFlowGroup(prose: strings.t("tax.flow.op.brackets")))
    }

    private var federalStage: TaxFlowStage {
        TaxFlowStage(
            id: "federal", label: strings.t("tax.pit.row.federalAfter"), amount: c.federalPITAfterReductions,
            tone: theme.loss,
            then: TaxFlowGroup(items: [operation("tax.pit.row.communalSurcharge", c.communalSurcharge, "+")]))
    }

    private var totalPITStage: TaxFlowStage {
        TaxFlowStage(
            id: "totalPit", label: strings.t("tax.pit.row.totalPIT"), amount: c.totalPIT, tone: theme.loss,
            chip: strings.t("tax.card.monthlyTaxReserve") + " · " + money(c.monthlyTaxReserve), weight: 1,
            then: TaxFlowGroup(
                heading: strings.t("tax.flow.opGroup.alsoOwed"),
                items: [
                    operation("tax.pit.row.employeeSS", c.employeeSocialSecurity, "+"),
                    operation("tax.pit.row.specialSS", c.specialSocialSecurityContribution, "+"),
                    operation("tax.pit.row.propertyTaxEstimate", c.propertyTaxEstimate, "+"),
                ]))
    }

    private var burdenStage: TaxFlowStage {
        let locale = shell.settings.numberFormat.locale
        let effective = c.effectiveRate.map { VisionFormat.percent($0, digits: 1, locale: locale) } ?? "—"
        let netOut = strings.t("tax.flow.op.netOut")
        var then = TaxFlowGroup(prose: netOut)
        // The prose line stays a line of its own; the spouse row, when there is one, follows it.
        if let income = c.spouseProfessionalIncome, income > 0 {
            then = TaxFlowGroup(
                items: [
                    TaxFlowOperation(id: "netOut", label: netOut, amount: nil, sign: ""),
                    operation("tax.pit.row.spouseIncome", income, "+"),
                ])
        }
        return TaxFlowStage(
            id: "burden", label: strings.t("tax.pit.row.totalBurden"), amount: c.totalTaxBurden, tone: theme.loss,
            chip: strings.t("tax.masthead.meta.effectiveBurden") + " · " + effective, weight: 1, then: then)
    }

    private var netStage: TaxFlowStage {
        TaxFlowStage(
            id: "net", label: strings.t("tax.card.netTakeHome"), amount: c.netTakeHome,
            tone: (c.netTakeHome ?? 0) >= 0 ? theme.gain : theme.loss,
            note: strings.t("tax.card.netTakeHome.desc"), weight: 2)
    }

    var body: some View {
        TaxCard(
            title: strings.t("tax.flow.title"),
            description: strings.t("tax.flow.description", ["year": String(overview.year)])
        ) {
            let all = stages
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(all.enumerated()), id: \.element.id) { index, stage in
                    TaxFlowStageRow(stage: stage, isLast: index == all.count - 1, shell: shell)
                }
            }
            coda
        }
    }

    /// Figures that sit outside the personal-income-tax chain (`KeyValueRows`).
    private var coda: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(strings.t("tax.flow.coda.title")).font(.caption).foregroundStyle(theme.tertiaryLabel)
            codaRow(
                strings.t("tax.pit.row.portfolioTaxesYear", ["year": String(overview.year)]), portfolioTaxes,
                tone: theme.loss)
            Divider().opacity(0.5)
            codaRow(strings.t("tax.pit.row.totalTaxInclPortfolio"), totalIncludingPortfolio, tone: theme.primary)
            Divider().opacity(0.5)
            codaRow(strings.t("tax.pit.row.totalWithPropertyEstimate"), totalIncludingProperty, tone: theme.primary)
        }
        .padding(.top, 16)
        .overlay(alignment: .top) { Rectangle().fill(theme.border.opacity(0.6)).frame(height: 1) }
        .padding(.top, 8)
    }

    private func codaRow(_ title: String, _ amount: Decimal?, tone: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title).font(.footnote).foregroundStyle(theme.secondaryLabel)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(money(amount)).font(.body.weight(.medium)).monospacedDigit().foregroundStyle(tone)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }
}

/// One node of the TaxComputationFlow timeline.
private struct TaxFlowStageRow: View {
    let stage: TaxFlowStage
    let isLast: Bool
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var settings: NativeAppSettings { shell.settings }

    /// `FIGURE_TYPE`: `type-title-3`, `type-title-2`, `type-title-1`.
    private var figureSize: MoneyDisplaySize {
        switch stage.weight {
        case 2: return .title1
        case 1: return .title2
        default: return .title3
        }
    }

    private func moneyText(_ amount: Decimal?) -> String {
        amount.map {
            MoneyText.text($0, currency: settings.portfolioCurrency, settings: settings, signed: false)
        } ?? "—"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            gutter
            VStack(alignment: .leading, spacing: 0) {
                anchor
                if stage.note != nil || stage.chip != nil { detail.padding(.top, 6) }
                if let group = stage.then { operations(group) }
            }
            .padding(.bottom, isLast ? 4 : 20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// The document's spine: the rail from this node down into the next, and the node.
    private var gutter: some View {
        ZStack(alignment: .top) {
            if !isLast {
                Rectangle().fill(theme.border).frame(width: 1).padding(.top, 12)
            }
            node.padding(.top, 3)
        }
        .frame(width: 16)
        .frame(maxHeight: .infinity)
        .accessibilityHidden(true)
    }

    private var node: some View {
        ZStack {
            if stage.weight > 0 {
                Circle().fill(theme.primary.opacity(0.10)).frame(width: 18, height: 18)
            }
            Circle().fill(Color(token: theme.palette.background)).frame(width: 12, height: 12)
            Circle()
                .strokeBorder(stage.weight == 0 ? theme.border : theme.primary.opacity(0.6), lineWidth: 1)
                .frame(width: 12, height: 12)
        }
        .frame(width: 18, height: 18)
    }

    private var anchor: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 16) {
                label
                Spacer(minLength: 0)
                figure
            }
            VStack(alignment: .leading, spacing: 4) {
                label
                figure
            }
        }
    }

    private var label: some View {
        Text(stage.label)
            .font(stage.weight == 2 ? Font.headline : Font.body.weight(.medium))
            .foregroundStyle(theme.foreground)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var figure: some View {
        RollingNumber(
            value: moneyText(stage.amount), decimalSeparator: settings.numberFormat.locale.decimalSeparator?.first,
            display: figureSize
        )
        .foregroundStyle(stage.tone)
    }

    private var detail: some View {
        HStack(alignment: .center, spacing: 12) {
            if let note = stage.note {
                Text(note).font(.footnote).foregroundStyle(theme.secondaryLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let chip = stage.chip {
                VisionBadge(text: chip, tone: .muted, small: true)
            }
        }
    }

    @ViewBuilder
    private func operations(_ group: TaxFlowGroup) -> some View {
        if let prose = group.prose {
            Text(prose)
                .font(.footnote.italic())
                .foregroundStyle(theme.secondaryLabel)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)
        } else if !group.items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                if let heading = group.heading {
                    Text(heading).font(.caption).foregroundStyle(theme.tertiaryLabel)
                }
                ForEach(group.items) { item in operationRow(item) }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: CGFloat(DesignTokens.Radius.card), style: .continuous)
                    .fill(theme.foreground.opacity(0.04))
            )
            .padding(.top, 12)
        }
    }

    private func operationRow(_ item: TaxFlowOperation) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(item.label).foregroundStyle(theme.secondaryLabel)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !item.sign.isEmpty {
                Text(item.sign + moneyText(item.amount))
                    .fontWeight(.medium).monospacedDigit().foregroundStyle(theme.foreground)
            }
        }
        .font(.footnote)
        .accessibilityElement(children: .combine)
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
                                                partner.partnerId.rawValue, overview: overview, strings: strings)
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
                                            amount(row.partnerAmounts[partner.partnerId.rawValue], tone: row.tone)
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
                                            amount(partner.partnerId == .a ? recorded.A : recorded.B)
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
                            value: strings.t("tax.household.assessment.mode." + overview.result.assessment.mode.rawValue))
                        if overview.result.assessment.mode == .joint {
                            LabeledContent(strings.t("tax.householdBreakdown.quotient"), value: quotientDescription)
                            if overview.result.quotient.applied {
                                TaxMoneyRow(
                                    title: strings.t("tax.householdBreakdown.quotient.benefit"),
                                    amount: overview.result.quotient.benefit, shell: shell, tone: theme.gain)
                            }
                        }
                        VisionBadge(text: overview.result.assessment.legalBasis, tone: .outline)
                        Text(strings.t("tax.household.assessment.reason." + overview.result.assessment.reason.rawValue)).font(
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
                    q.transfer, currency: shell.settings.portfolioCurrency, settings: shell.settings, signed: false),
                "from": TaxYearPresentation.partner(from.rawValue, overview: overview, strings: strings),
                "to": TaxYearPresentation.partner(to.rawValue, overview: overview, strings: strings),
            ])
    }
    private func amount(_ value: Decimal?, tone: String = "base") -> some View {
        Text(
            value.map {
                MoneyText.text(
                    tone == "reduction" ? -$0 : $0,
                    currency: shell.settings.portfolioCurrency, settings: shell.settings,
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
                        $0, currency: shell.settings.portfolioCurrency, settings: shell.settings,
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
            NativeTaxPrintCell(text: TaxYearPresentation.partner($0.partnerId.rawValue, overview: overview, strings: strings))
        }
        columns.append(.init(text: strings.t("tax.householdBreakdown.column.household")))
        var printedRows: [[NativeTaxPrintCell]] = data.householdBreakdownRows.map { row in
            let title = strings.t(
                row.key == "taxableIncome" ? "tax.pit.row.taxableIncome" : "tax.householdBreakdown.row." + row.key)
            var cells = [NativeTaxPrintCell(text: title)]
            cells += partners.map { printAmount(row.partnerAmounts[$0.partnerId.rawValue], tone: row.tone) }
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
            transactions += partners.map { printAmount($0.partnerId == .a ? recorded.A : recorded.B) }
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
                    tone == "reduction" ? -$0 : $0, currency: shell.settings.portfolioCurrency,
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
                value: strings.t("tax.household.assessment.mode." + overview.result.assessment.mode.rawValue))
            if overview.result.assessment.mode == .joint {
                LabeledContent(strings.t("tax.householdBreakdown.quotient"), value: quotientDescription)
                if overview.result.quotient.applied {
                    TaxMoneyRow(
                        title: strings.t("tax.householdBreakdown.quotient.benefit"),
                        amount: overview.result.quotient.benefit, shell: shell, tone: theme.gain)
                }
            }
            Text(overview.result.assessment.legalBasis).font(.caption)
                .padding(6).overlay(RoundedRectangle(cornerRadius: DesignTokens.Radius.md).stroke(theme.border))
            Text(strings.t("tax.household.assessment.reason." + overview.result.assessment.reason.rawValue))
                .font(.caption).foregroundStyle(theme.secondaryLabel)
        }.padding(NativeTaxPrintTable.inset).frame(maxWidth: .infinity, alignment: .leading)
    }
}
