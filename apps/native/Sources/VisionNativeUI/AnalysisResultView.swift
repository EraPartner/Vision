import SwiftUI
import VisionNativeCore

public struct AnalysisResultView: View {
    let model: AnalysisWorkspaceModel
    let shell: NativeShellModel
    let focusRequest: Int
    @State private var tab = "table"
    @State private var sqlExpanded = false
    @State private var provenanceExpanded = false
    @FocusState private var headingFocused: Bool
    @Environment(\.visionTheme) private var theme
    public init(model: AnalysisWorkspaceModel, shell: NativeShellModel, focusRequest: Int = 0) {
        self.model = model
        self.shell = shell
        self.focusRequest = focusRequest
    }
    private var strings: any Localizing { shell.strings }
    private static func tabKey(_ tab: String) -> String {
        switch tab {
        case "chart": return "analysis.chart"
        case "pivot": return "analysis.pivot"
        default: return "analysis.tableView"
        }
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let result = model.displayedResult {
                AnalysisPanel {
                    HStack(spacing: 8) {
                        Image(systemName: "cylinder").foregroundStyle(theme.secondaryLabel).accessibilityHidden(true)
                        Text(strings.t("analysis.workflow.present")).font(.visionCardTitle).focusable().focused(
                            $headingFocused
                        )
                        .accessibilityAddTraits(.isHeader)
                        VisionBadge(text: String(result.window.returnedRows), tone: .secondary).monospacedDigit()
                    }
                    Text(strings.t("analysis.resultsHelp")).font(.callout).foregroundStyle(theme.secondaryLabel)
                    if model.queryOutdated || model.transformationsOutdated {
                        Text(strings.t("analysis.resultsOutdated")).foregroundStyle(theme.warning)
                    }
                    if let errors = result.formulaErrors, !errors.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(strings.t("analysis.formulaErrorsNotice"))
                            ForEach(Array(errors.enumerated()), id: \.offset) { _, error in
                                Text(
                                    "\(AnalysisPresentation.rawText(error["formulaId"]))\(error["rowIndex"]?.decimalValue.map { " (" + strings.t("analysis.formulaErrorRow", ["row": NSDecimalNumber(decimal: $0 + 1).stringValue]) + ")" } ?? ""): \(AnalysisPresentation.rawText(error["message"]))"
                                )
                                .font(.caption).textSelection(.enabled)
                            }
                        }.foregroundStyle(theme.warning)
                    }
                    VisionSegmentedControl(
                        selection: $tab, values: ["table", "chart", "pivot"],
                        title: { strings.t(Self.tabKey($0)) },
                        label: strings.t("analysis.resultViews"))
                    if tab == "table" {
                        AnalysisResultTable(
                            result: result, datasets: model.datasets, shell: shell,
                            onSort: { id in Task { await model.sort(by: id) } },
                            onDrill: model.mode == .visual ? { row in Task { await model.drill(row: row) } } : nil)
                        HStack {
                            Text(
                                strings.t(
                                    result.window.kind == "truncated"
                                        ? "analysis.truncated"
                                        : result.window.hasMore == true ? "analysis.moreRows" : "analysis.completeRows")
                            )
                            .font(.caption).foregroundStyle(theme.secondaryLabel)
                            Spacer()
                            Button(strings.t("analysis.previous")) {
                                Task { _ = await model.run(offset: max(0, model.offset - model.plan.limit)) }
                            }
                            .disabled(model.offset == 0 || model.activeRequest != nil)
                            Button(strings.t("analysis.next")) {
                                Task { _ = await model.run(offset: model.offset + model.plan.limit) }
                            }
                            .disabled(
                                result.window.kind != "page" || result.window.hasMore != true
                                    || model.activeRequest != nil)
                        }.buttonStyle(.visionOutline).controlSize(.small)
                        DisclosureGroup(strings.t("analysis.generatedSql"), isExpanded: $sqlExpanded) {
                            AnalysisCodeText(text: result.generatedSql).padding(.top, 8)
                        }
                    }
                    if let coverage = result.coverage {
                        Text(
                            strings.t(
                                "analysis.ext.financial.coverage",
                                [
                                    "status": coverage["status"]?.stringValue ?? "—",
                                    "missing": AnalysisPresentation.rawText(coverage["unavailableRows"] ?? .number(0)),
                                ])
                        )
                        .font(.caption).foregroundStyle(theme.secondaryLabel)
                    }
                    if let provenance = result.provenance?.objectValue {
                        DisclosureGroup(strings.t("analysis.ext.financial.provenance"), isExpanded: $provenanceExpanded)
                        {
                            ForEach(provenance.keys.sorted(), id: \.self) { key in
                                HStack(alignment: .top) {
                                    Text(verbatim: key)
                                    Text(verbatim: AnalysisPresentation.rawText(provenance[key]))
                                }
                                .font(.caption).textSelection(.enabled)
                            }
                        }
                    }
                    if tab == "chart" {
                        AnalysisResultCharts(
                            result: result, spec: Binding(get: { model.chartSpec }, set: { model.chartSpec = $0 }),
                            shell: shell, labels: labels(result))
                    }
                    if tab == "pivot" {
                        if model.mode == .visual, let dataset = model.dataset {
                            AnalysisResultPivot(model: model, dataset: dataset, shell: shell)
                        } else {
                            Text(strings.t("analysis.pivotHelp")).foregroundStyle(theme.secondaryLabel)
                        }
                    }
                }.id("analysis-present")
            }
            if let drill = model.drillResult {
                AnalysisPanel(title: strings.t("analysis.sourceRows")) {
                    AnalysisResultTable(result: drill, datasets: model.datasets, shell: shell)
                }
            }
        }.task(id: focusRequest) { if focusRequest > 0 { headingFocused = true } }
    }
    private func labels(_ result: AnalysisResult) -> [String: String] {
        let datasets: [TaxValue] = model.datasets.map {
            .object(["fields": .array($0.fields.map(\.raw)), "measures": .array($0.measures.map(\.raw))])
        }
        return Dictionary(
            uniqueKeysWithValues: result.effectiveColumns.map {
                (
                    $0.id,
                    AnalysisPresentation.columnLabel(
                        result: result.raw, id: $0.id, datasets: datasets, strings: strings)
                )
            })
    }
}
