import SwiftUI
import VisionNativeCore

struct AnalysisResultTable: View {
    let result: AnalysisResult
    var datasets: [AnalysisDataset] = []
    let shell: NativeShellModel
    var onSort: (String) -> Void = { _ in }
    var onDrill: ((AnalysisRow) -> Void)? = nil
    @State private var mode = AnalysisValueDisplayMode.exact
    @State private var page = 0
    @Environment(\.visionTheme) private var theme
    private var columns: [AnalysisColumn] {
        result.declaredColumns?.isEmpty == false ? result.declaredColumns! : result.columns
    }
    private var pageSize: Int { max(1, shell.settings.defaultPageSize) }
    private var pages: Int { max(1, (result.rows.count + pageSize - 1) / pageSize) }
    private var current: Int { min(page, pages - 1) }
    private var loaded: ArraySlice<AnalysisRow> { result.rows.dropFirst(current * pageSize).prefix(pageSize) }
    private var strings: any Localizing { shell.strings }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VisionSegmentedControl(
                    selection: $mode, values: [AnalysisValueDisplayMode.exact, .formatted, .raw],
                    title: { strings.t(Self.modeKey($0)) }, size: .sm
                )
                .visionAccessibilityLabel(strings.t("analysis.displayValues")).fixedSize()
                Text(strings.t("analysis.displayPrecisionHelp")).font(.caption).foregroundStyle(theme.secondaryLabel)
            }
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 0) {
                    GridRow {
                        ForEach(columns) { column in
                            Button {
                                onSort(column.id)
                            } label: {
                                Text(label(column.id))
                                Image(systemName: "arrow.up.arrow.down").font(.caption2)
                            }.buttonStyle(.plain).font(.caption.weight(.medium))
                                .padding(.vertical, 10).accessibilityLabel(label(column.id))
                        }
                    }
                    ForEach(Array(loaded.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(columns) { column in
                                Text(verbatim: display(row[column.id], column: column))
                                    .font(mode == .raw ? .caption.monospaced() : .caption)
                                    .monospacedDigit().lineLimit(1).truncationMode(.tail).frame(
                                        maxWidth: 300, alignment: .leading
                                    )
                                    .help(
                                        AnalysisPresentation.rawText(
                                            row[column.id] == .null ? .string("") : row[column.id])
                                    )
                                    .padding(.vertical, 9)
                                    .gridColumnAlignment(
                                        AnalysisPresentation.isNumeric(column.type) ? .trailing : .leading)
                            }
                        }.contentShape(Rectangle()).onTapGesture(count: 2) { onDrill?(row) }
                            .focusable(onDrill != nil).onKeyPress(.return) {
                                guard let onDrill else { return .ignored }
                                onDrill(row)
                                return .handled
                            }.accessibilityElement(children: .contain)
                            .accessibilityAction(named: Text(strings.t("analysis.sourceRows"))) { onDrill?(row) }
                    }
                }.padding(.horizontal, 12).textSelection(.enabled)
            }.overlay(RoundedRectangle(cornerRadius: DesignTokens.Radius.md).stroke(theme.border))
            if result.rows.count > pageSize {
                HStack {
                    Text(
                        strings.t(
                            "analysis.loadedPage",
                            [
                                "start": String(current * pageSize + 1),
                                "end": String(min((current + 1) * pageSize, result.rows.count)),
                                "total": String(result.rows.count),
                            ])
                    )
                    .font(.caption).foregroundStyle(theme.secondaryLabel)
                    Spacer()
                    Button(strings.t("analysis.previous")) { page = max(0, current - 1) }.disabled(current == 0)
                    Button(strings.t("analysis.next")) { page = current + 1 }.disabled(current + 1 == pages)
                }.buttonStyle(.visionOutline).controlSize(.small).accessibilityElement(children: .contain).accessibilityLabel(strings.t("analysis.loadedRows"))
            }
        }.onChange(of: result) { page = 0 }
    }
    private static func modeKey(_ mode: AnalysisValueDisplayMode) -> String {
        switch mode {
        case .exact: return "analysis.exactValues"
        case .formatted: return "analysis.formattedValues"
        case .raw: return "analysis.rawValues"
        }
    }
    private func display(_ value: AnalysisValue?, column: AnalysisColumn) -> String {
        if mode == .formatted, column.type == "date", let raw = value?.stringValue {
            let parts = raw.split(separator: "-").compactMap { Int($0) }
            if raw.range(of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"#, options: .regularExpression) != nil, parts.count == 3 {
                return PlannedDay(year: parts[0], month: parts[1], day: parts[2]).text(
                    format: shell.settings.dateFormat)
            }
        }
        return AnalysisPresentation.format(
            value: value, type: column.type, id: column.id,
            numberFormat: shell.settings.numberFormat.rawValue, mode: mode,
            decimalPlaces: shell.settings.showDecimalPlaces)
    }
    private func label(_ id: String) -> String {
        let catalog: [TaxValue] = datasets.map {
            .object(["fields": .array($0.fields.map(\.raw)), "measures": .array($0.measures.map(\.raw))])
        }
        return AnalysisPresentation.columnLabel(result: result.raw, id: id, datasets: catalog, strings: strings)
    }
}
