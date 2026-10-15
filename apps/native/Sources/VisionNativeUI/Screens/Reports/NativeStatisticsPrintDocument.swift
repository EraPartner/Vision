import AppKit
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

    /// Table rows are materialized from the frozen graph before pagination. Every
    /// continuation uses the same column widths resolved from the complete table.
    @MainActor public static func printBlocks(
        presentation: NativeStatisticsPrintPresentation, width: CGFloat,
        sections: [NativeStatisticsPrintSection]? = nil
    ) -> [NSView] {
        (sections ?? presentation.snapshot.sections).flatMap { section in
            let view = StatisticsView(screens: presentation.screens, shell: presentation.shell, printSection: section)
            if let blocks = view.rowAwarePrintBlocks(presentation: presentation, width: width) { return blocks }
            return [
                NSHostingView(
                    rootView: NativeStatisticsPrintDocument(
                        presentation: presentation, sections: [section], pageWidth: width
                    ).frame(width: width)) as NSView
            ]
        }
    }
}

/// Print-only strings; financial values have already been formatted by the same
/// Decimal presentation functions as the loaded page. No row factory reads a model.
struct NativeStatisticsPrintTable {
    struct Row {
        let id: String
        let values: [String]
        var emphasized = false
        var indentation: CGFloat = 0
    }
    let id: String
    let headings: [String]
    let columns: [String]
    let rows: [Row]
    var footer: Row?
    var notes: [String] = []

    @MainActor func block(presentation: NativeStatisticsPrintPresentation, width: CGFloat) -> NSView {
        let layout = NativeStatisticsPrintTableLayout(
            width: width, columns: columns, rows: rows + (footer.map { [$0] } ?? []))
        func host<Content: View>(_ content: Content, id: String) -> NSView {
            let view = NSHostingView(
                rootView: content.frame(width: width, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .environment(\.locale, presentation.snapshot.settings.numberFormat.locale)
                    .environment(
                        \.visionTheme, VisionTheme(selection: presentation.snapshot.theme, isPrintReport: true)
                    )
                    .preferredColorScheme(.light))
            view.identifier = NSUserInterfaceItemIdentifier(id)
            return view
        }
        let header = NativePagePrintRow { _ in
            host(
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(headings.enumerated()), id: \.offset) { index, heading in
                        Text(heading).font(index == 0 ? .headline : .caption)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    NativeStatisticsPrintTableRow(
                        row: .init(id: "header", values: columns, emphasized: true), layout: layout)
                }.padding(.horizontal, layout.inset).padding(.vertical, 8), id: id + ".header")
        }
        let body = rows.map { row in
            NativePagePrintRow { _ in
                host(
                    NativeStatisticsPrintTableRow(row: row, layout: layout)
                        .padding(.horizontal, layout.inset).padding(.vertical, 4), id: id + ".row." + row.id)
            }
        }
        let footerView: NativePagePrintRow? =
            footer != nil || !notes.isEmpty
            ? NativePagePrintRow { _ in
                host(
                    VStack(alignment: .leading, spacing: 8) {
                        if let footer { NativeStatisticsPrintTableRow(row: footer, layout: layout) }
                        ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                            Text(note).font(.footnote).fixedSize(horizontal: false, vertical: true)
                        }
                    }.padding(.horizontal, layout.inset).padding(.vertical, 8), id: id + ".footer")
            } : nil
        let table = NativePagePrintTableBlock(header: header, rows: body, footer: footerView, spacing: 2)
        table.identifier = NSUserInterfaceItemIdentifier(id)
        return table
    }
}

/// Widths are calculated once per full frozen table and printable width, never
/// independently on each page or from the subset of rows fitting that page.
struct NativeStatisticsPrintTableLayout {
    let widths: [CGFloat]
    let spacing: CGFloat
    let inset: CGFloat = 16

    @MainActor init(width: CGFloat, columns: [String], rows: [NativeStatisticsPrintTable.Row]) {
        let count = max(1, columns.count)
        let available = max(1, width - 32)
        spacing = min(8, available / CGFloat(count * 3))
        let contentWidth = max(1, available - spacing * CGFloat(count - 1))
        let weights: [CGFloat] = columns.enumerated().map { index, heading in
            let font =
                index == 0
                ? NSFont.systemFont(ofSize: 11) : NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
            let values = [heading] + rows.compactMap { $0.values.indices.contains(index) ? $0.values[index] : nil }
            let maximum = values.map { ($0 as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
            return min(index == 0 ? 200 : 140, max(index == 0 ? 90 : 44, maximum))
        }
        let total = max(1, weights.reduce(0, +))
        widths = weights.map { contentWidth * $0 / total }
    }
}

private struct NativeStatisticsPrintTableRow: View {
    let row: NativeStatisticsPrintTable.Row
    let layout: NativeStatisticsPrintTableLayout
    var body: some View {
        HStack(alignment: .top, spacing: layout.spacing) {
            ForEach(Array(row.values.enumerated()), id: \.offset) { index, value in
                Text(value)
                    .font(.system(size: 11, weight: row.emphasized ? .semibold : .regular))
                    .monospacedDigit()
                    .multilineTextAlignment(index == 0 ? .leading : .trailing)
                    .padding(.leading, index == 0 ? min(row.indentation, layout.widths[index] * 0.35) : 0)
                    .frame(width: layout.widths[index], alignment: index == 0 ? .leading : .trailing)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
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
