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
    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(sections) { section in NativeTaxPrintSectionView(presentation: presentation, section: section) }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true).allowsHitTesting(false)
            .environment(\.locale, presentation.snapshot.settings.numberFormat.locale)
            .environment(
                \.visionTheme,
                VisionTheme(
                    selection: ThemeSelection(
                        variant: presentation.snapshot.theme.variant, appearance: .light,
                        colorblindGainLoss: presentation.snapshot.theme.colorblindGainLoss,
                        systemAccentColor: presentation.snapshot.theme.systemAccentColor,
                        systemAccentForegroundColor: presentation.snapshot.theme.systemAccentForegroundColor))
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
                            "• " + strings.t("tax.household.issue.severity." + issue.severity) + ": "
                                + strings.t("tax.household.issue." + issue.code)
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
                totalIncludingProperty: data.totalTaxIncludingPropertyEstimate)
        case .taxRules:
            TaxRulesView(strings: strings, initiallyExpanded: snapshot.localState.rulesExpanded)
        case .householdBreakdown:
            TaxHouseholdBreakdownView(overview: overview, data: data, shell: shell)
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
                initialComparisonYear: snapshot.localState.comparisonYear)
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
        return overview.result.issues.filter { seen.insert($0.code).inserted }
    }
}
