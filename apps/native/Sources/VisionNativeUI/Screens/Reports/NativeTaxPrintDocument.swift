import AppKit
import SwiftUI
import VisionNativeCore

/// No ScrollView, page loaders, appearance tasks, menu actions or live model references.
/// The SDK can host individual section blocks to paginate before opening the native printer.
public struct NativeTaxPrintDocument: View {
    private let presentation: NativeTaxPrintPresentation
    private let sections: [NativeTaxPrintSection]
    public init(presentation: NativeTaxPrintPresentation, sections: [NativeTaxPrintSection]? = nil) {
        self.presentation = presentation
        self.sections = sections ?? presentation.snapshot.sections
    }
    /// Table factories keep the frozen column geometry while the common paginator repeats headers.
    @MainActor public static func printBlocks(
        presentation: NativeTaxPrintPresentation, width: CGFloat,
        sections: [NativeTaxPrintSection]? = nil
    ) -> [NSView] {
        let snapshot = presentation.snapshot
        let overview = snapshot.overview
        let data = snapshot.dashboard
        let shell = presentation.shell
        return (sections ?? snapshot.sections).compactMap { section -> NSView? in
            switch section {
            case .pitBreakdown where snapshot.localState.pitExpanded:
                return TaxPITBreakdownView(
                    overview: overview, shell: shell, portfolioTaxes: data.portfolioTaxesForYear,
                    totalIncludingPortfolio: data.totalTaxIncludingPortfolio,
                    totalIncludingProperty: data.totalTaxIncludingPropertyEstimate,
                    initiallyExpanded: true
                ).printTable(width: width)
            case .householdBreakdown where snapshot.localState.householdExpanded:
                return TaxHouseholdBreakdownView(
                    overview: overview, data: data, shell: shell, initiallyExpanded: true, printLayout: true
                ).printTable(width: width)
            case .yearComparison:
                return TaxYearComparisonView(
                    model: presentation.dashboard, overview: overview, shell: shell,
                    initialComparisonYear: snapshot.localState.comparisonYear, printLayout: true
                ).printTable(width: width)
            default:
                return NativePrintHostingView(
                    rootView: NativeTaxPrintDocument(presentation: presentation, sections: [section])
                        .frame(width: width))
            }
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(sections) { section in NativeTaxPrintSectionView(presentation: presentation, section: section) }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true).allowsHitTesting(false)
            .environment(\.locale, presentation.snapshot.settings.numberFormat.locale)
            .environment(
                \.visionTheme,
                VisionTheme(selection: presentation.snapshot.theme, isPrintReport: true)
            )
            .preferredColorScheme(.light)
    }
}

public struct NativeTaxPrintSectionView: View {
    private let presentation: NativeTaxPrintPresentation
    private let section: NativeTaxPrintSection
    public init(presentation: NativeTaxPrintPresentation, section: NativeTaxPrintSection) {
        self.presentation = presentation
        self.section = section
    }
    private var snapshot: NativeTaxPrintSnapshot { presentation.snapshot }
    private var overview: OpenAPI.BelgianTaxOverview { snapshot.overview }
    private var data: TaxDashboardData { snapshot.dashboard }
    private var shell: NativeShellModel { presentation.shell }
    private var strings: any Localizing { snapshot.strings }
    public var body: some View {
        content
    }
    @ViewBuilder private var content: some View {
        switch section {
        case .header:
            VisionPageHeader(
                title: strings.t("tax.page.title"),
                subtitle: strings.t("tax.page.subtitle", ["year": String(snapshot.year)]), symbol: "percent"
            ) { EmptyView() }
        case .masthead:
            TaxMastheadView(overview: overview, actions: presentation.actions, shell: shell)
        case .trendStrip:
            TaxTrendStripView(model: presentation.dashboard, overview: overview, shell: shell)
        case .disclaimer:
            TaxCard(title: strings.t("tax.belgianRulesDesc")) {
                Text(strings.t("tax.disclaimerTitle") + ": " + strings.t("tax.disclaimerText"))
                if overview.storedValueInvalid { Text("• " + strings.t("tax.household.storedUnreadable")) }
                if !overview.isHistorical {
                    ForEach(uniqueIssues, id: \.code) { issue in
                        Text(
                            "• " + strings.t("tax.household.issue.severity." + issue.severity.rawValue) + ": "
                                + strings.t("tax.household.issue." + issue.code.rawValue)
                        ).font(.callout)
                    }
                }
            }
        case .noProfile:
            TaxCard {
                VisionEmptyState(
                    symbol: "person.crop.circle.badge.plus", title: strings.t("tax.noProfile.title"),
                    description: strings.t("tax.noProfile.desc")
                ) {
                    Button(strings.t("tax.profile.setup")) {}
                }
            }
        case .summaryCards:
            TaxComputationFlowView(
                overview: overview, shell: shell, portfolioTaxes: data.portfolioTaxesForYear,
                totalIncludingPortfolio: data.totalTaxIncludingPortfolio,
                totalIncludingProperty: data.totalTaxIncludingPropertyEstimate)
        case .pitBreakdown:
            TaxPITBreakdownView(
                overview: overview, shell: shell, portfolioTaxes: data.portfolioTaxesForYear,
                totalIncludingPortfolio: data.totalTaxIncludingPortfolio,
                totalIncludingProperty: data.totalTaxIncludingPropertyEstimate,
                initiallyExpanded: snapshot.localState.pitExpanded)
        case .taxRules:
            TaxRulesView(strings: strings, initiallyExpanded: snapshot.localState.rulesExpanded)
        case .householdBreakdown:
            TaxHouseholdBreakdownView(
                overview: overview, data: data, shell: shell, initiallyExpanded: snapshot.localState.householdExpanded,
                printLayout: true)
        case .incomeBreakdown:
            TaxMonthlyIncomeView(model: presentation.dashboard, overview: overview, shell: shell)
        case .currentInputs:
            TaxCurrentInputsView(overview: overview, data: data, shell: shell)
        case .suggestions:
            SuggestedDeductionsView(suggestions: data.suggestions, shell: shell, onEditProfile: {})
        case .deductionCandidates:
            if snapshot.deductionError != nil {
                TaxCard(title: strings.t("tax.deductionCandidates.title")) {
                    Text(strings.t("tax.deductionCandidates.unavailable"))
                }
            } else {
                TaxDeductionsView(
                    model: presentation.deductions, shell: shell,
                    household: try? TaxValue(encoding: overview.liveHousehold), canApply: false, onApply: { _ in false }
                )
                if let error = snapshot.deductionApplyError { Text(error) }
            }
        case .yearComparison:
            TaxYearComparisonView(
                model: presentation.dashboard, overview: overview, shell: shell,
                initialComparisonYear: snapshot.localState.comparisonYear, printLayout: true)
        case .yearlyOverview:
            TaxYearlyOverviewView(model: presentation.dashboard, overview: overview, shell: shell)
        case .automation:
            TaxCard(title: strings.t("tax.automation.title")) {
                Text(strings.t("tax.automation.automatic") + ": " + strings.t("tax.automation.automaticDesc"))
                Text(strings.t("tax.automation.manualLabel") + ": " + strings.t("tax.automation.manualDesc"))
                Text(strings.t("tax.automation.investmentLabel") + ": " + strings.t("tax.automation.investmentDesc"))
            }
        }
    }
    private var uniqueIssues: [OpenAPI.BelgianTaxHouseholdTaxIssue] {
        var seen = Set<String>()
        return overview.result.issues.filter { seen.insert($0.code.rawValue).inserted }
    }
}

/// Presentation-only cells. Values are formatted from the immutable snapshot; no fiscal work runs here.
struct NativeTaxPrintCell {
    var text: String
    var detail: String? = nil
    var strong = false
    var tone: NativeTaxPrintTone = .normal
    var pill = false
    var symbol: String? = nil
    var symbolTone: NativeTaxPrintTone = .secondary
}

enum NativeTaxPrintTone {
    case normal, secondary, gain, loss, warning, info
    func color(_ theme: VisionTheme) -> Color {
        switch self {
        case .normal: theme.foreground
        case .secondary: theme.secondaryLabel
        case .gain: theme.gain
        case .loss: theme.loss
        case .warning: theme.warning
        case .info: theme.info
        }
    }
}

@MainActor enum NativeTaxPrintTable {
    static let inset: CGFloat = 20
    static let spacing: CGFloat = 10

    static func make(
        id: String, title: String, description: String, notes: [String] = [],
        columns: [NativeTaxPrintCell], rows: [[NativeTaxPrintCell]],
        shell: NativeShellModel, width: CGFloat, footer: NativePagePrintRow? = nil
    ) -> NSView {
        let widths = columnWidths(columns: columns, rows: rows, width: width)
        let header = NativePagePrintRow { width in
            host(
                VStack(alignment: .leading, spacing: 8) {
                    Text(title).font(.headline)
                    Text(description).font(.callout).foregroundStyle(.secondary)
                    ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                        Text(note).font(.caption).foregroundStyle(.secondary)
                    }
                    NativeTaxPrintCells(cells: columns, widths: widths, header: true)
                }.padding(.horizontal, inset).padding(.vertical, 12),
                shell: shell, width: width, id: id + ".header")
        }
        let printedRows = rows.enumerated().map { index, cells in
            NativePagePrintRow { width in
                host(
                    VStack(alignment: .leading, spacing: 6) {
                        NativeTaxPrintCells(cells: cells, widths: widths)
                        Divider()
                    }.padding(.horizontal, inset).padding(.vertical, 4),
                    shell: shell, width: width, id: id + ".row.\(index)")
            }
        }
        return NativePagePrintTableBlock(header: header, rows: printedRows, footer: footer, spacing: 0)
    }

    static func host<Content: View>(
        _ content: Content, shell: NativeShellModel, width: CGFloat, id: String
    ) -> NSView {
        let view = NativePrintHostingView(
            rootView:
                content
                .frame(width: width, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                .environment(\.locale, shell.settings.numberFormat.locale)
                .environment(\.visionTheme, VisionTheme(selection: shell.theme, isPrintReport: true))
                .preferredColorScheme(.light).allowsHitTesting(false))
        view.identifier = NSUserInterfaceItemIdentifier(id)
        return view
    }

    /// All frozen rows participate once per printable width; a page subset never changes columns.
    private static func columnWidths(
        columns: [NativeTaxPrintCell], rows: [[NativeTaxPrintCell]], width: CGFloat
    ) -> [CGFloat] {
        guard !columns.isEmpty else { return [] }
        let available = max(1, width - inset * 2 - spacing * CGFloat(columns.count - 1))
        let font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
        var preferred = columns.map { ($0.text as NSString).size(withAttributes: [.font: font]).width + 20 }
        for cells in rows {
            for (index, cell) in cells.enumerated() where preferred.indices.contains(index) {
                let measured = (cell.text as NSString).size(withAttributes: [.font: font]).width
                let detail = cell.detail.map { ($0 as NSString).size(withAttributes: [.font: font]).width + 12 } ?? 0
                preferred[index] = max(preferred[index], measured + (cell.pill ? 20 : 4), detail)
            }
        }
        let minimum = (0..<columns.count).map { min($0 == 0 ? 80 : 60, available / CGFloat(columns.count)) }
        let remaining = max(0, available - minimum.reduce(0, +))
        let weights = zip(preferred, minimum).map { max(1, $0 - $1) }
        let total = weights.reduce(0, +)
        return zip(minimum, weights).map { $0 + remaining * $1 / total }
    }
}

private struct NativeTaxPrintCells: View {
    let cells: [NativeTaxPrintCell]
    let widths: [CGFloat]
    var header = false
    @Environment(\.visionTheme) private var theme
    var body: some View {
        HStack(alignment: .top, spacing: NativeTaxPrintTable.spacing) {
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                VStack(alignment: index == 0 ? .leading : .trailing, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(cell.text)
                            .font(header || cell.pill ? .caption : .body)
                            .fontWeight(header || cell.strong ? .semibold : .regular)
                            .monospacedDigit()
                            .foregroundStyle(cell.tone.color(theme))
                            .fixedSize(horizontal: false, vertical: true)
                        if let symbol = cell.symbol {
                            Image(systemName: symbol).foregroundStyle(cell.symbolTone.color(theme))
                        }
                    }
                    .padding(.horizontal, cell.pill ? 8 : 0).padding(.vertical, cell.pill ? 4 : 0)
                    .background(cell.pill ? cell.tone.color(theme).opacity(0.1) : Color.clear, in: Capsule())
                    if let detail = cell.detail {
                        Text(detail).font(.caption2.weight(.medium))
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(theme.border.opacity(0.7)))
                    }
                }
                .frame(width: widths[index], alignment: index == 0 ? .leading : .trailing)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
