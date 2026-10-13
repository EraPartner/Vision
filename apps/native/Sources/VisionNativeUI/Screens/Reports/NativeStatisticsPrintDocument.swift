import SwiftUI
import VisionNativeCore

/// The current tab, rendered from an isolated snapshot graph. No page loaders, appearance
/// tasks, report export machinery, interactive menus or live model references are mounted.
public struct NativeStatisticsPrintDocument: View {
    private let presentation: NativeStatisticsPrintPresentation
    private let sections: [NativeStatisticsPrintSection]
    public init(presentation: NativeStatisticsPrintPresentation, sections: [NativeStatisticsPrintSection]? = nil) {
        self.presentation = presentation
        self.sections = sections ?? presentation.snapshot.sections
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(sections) { section in
                NativeStatisticsPrintSectionView(presentation: presentation, section: section)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true).allowsHitTesting(false)
            .environment(\.locale, presentation.snapshot.settings.numberFormat.locale)
            .environment(
                \.visionTheme,
                VisionTheme(selection: ThemeSelection(
                    variant: presentation.snapshot.theme.variant, appearance: .light,
                    colorblindGainLoss: presentation.snapshot.theme.colorblindGainLoss,
                    systemAccentColor: presentation.snapshot.theme.systemAccentColor,
                    systemAccentForegroundColor: presentation.snapshot.theme.systemAccentForegroundColor)))
            .preferredColorScheme(.light)
    }
}

public struct NativeStatisticsPrintSectionView: View {
    private let presentation: NativeStatisticsPrintPresentation
    private let section: NativeStatisticsPrintSection
    public init(presentation: NativeStatisticsPrintPresentation, section: NativeStatisticsPrintSection) {
        self.presentation = presentation
        self.section = section
    }
    private var snapshot: NativeStatisticsPrintSnapshot { presentation.snapshot }
    public var body: some View {
        switch section {
        case .customHeader:
            Text(snapshot.strings.t("customChart.tab")).font(.title2)
            if !snapshot.savedCharts.isEmpty {
                Text(snapshot.strings.tc("customChart.savedCount", snapshot.savedCharts.count))
            }
        case .customStatus:
            if let error = snapshot.savedError { Text(error) }
        case .savedChart(let id):
            if let chart = snapshot.savedCharts.first(where: { $0.id == id }) {
                AdminCard {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(chart.name).font(.headline)
                        if let dataset = snapshot.savedDatasets[id] {
                            CustomChartPlot(
                                dataset: dataset, kind: CustomChartDraft(chart: chart).kind,
                                settings: snapshot.settings, strings: snapshot.strings,
                                selection: .constant(snapshot.savedLocalState.selection[String(id)]),
                                range: .constant(snapshot.savedLocalState.rangeStart[String(id)]))
                        } else if let error = snapshot.savedErrors[id] { Text(error) }
                    }
                }
            }
        default:
            StatisticsView(screens: presentation.screens, shell: presentation.shell, printSection: section)
        }
    }
}
