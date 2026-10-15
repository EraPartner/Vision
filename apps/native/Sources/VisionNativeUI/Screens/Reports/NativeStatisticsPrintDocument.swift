import SwiftUI
import VisionNativeCore

/// The current tab, rendered from an isolated snapshot graph. No page loaders, appearance
/// tasks, report export machinery, interactive menus or live model references are mounted.
public struct NativeStatisticsPrintDocument: View {
    private let presentation: NativeStatisticsPrintPresentation
    private let sections: [NativeStatisticsPrintSection]
    private let pageWidth: CGFloat?
    public init(
        presentation: NativeStatisticsPrintPresentation, sections: [NativeStatisticsPrintSection]? = nil,
        pageWidth: CGFloat? = nil
    ) {
        self.presentation = presentation
        self.sections = sections ?? presentation.snapshot.sections
        self.pageWidth = pageWidth
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(sections) { section in
                NativeStatisticsPrintSectionView(presentation: presentation, section: section)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true).allowsHitTesting(false)
            .environment(\.locale, presentation.snapshot.settings.numberFormat.locale)
            .environment(\.visionTheme, VisionTheme(selection: presentation.snapshot.theme, isPrintReport: true))
            .environment(\.nativePrintPageWidth, pageWidth)
            .preferredColorScheme(.light)
    }
}

private struct NativePrintPageWidthKey: EnvironmentKey {
    static let defaultValue: CGFloat? = nil
}

extension EnvironmentValues {
    /// Supplied before AppKit measures a frozen section, so table sizing does not
    /// depend on an asynchronous geometry callback or a mounted screen's width.
    var nativePrintPageWidth: CGFloat? {
        get { self[NativePrintPageWidthKey.self] }
        set { self[NativePrintPageWidthKey.self] = newValue }
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
                        } else if let error = snapshot.savedErrors[id] {
                            Text(error)
                        }
                    }
                }
            }
        default:
            StatisticsView(screens: presentation.screens, shell: presentation.shell, printSection: section)
        }
    }
}
