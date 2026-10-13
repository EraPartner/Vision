import SwiftUI
import VisionNativeCore

struct AnalysisWorkbenchReportView: View {
    let output: AnalysisExtensionOutput
    let model: AnalysisWorkbenchModel
    let shell: NativeShellModel
    @State private var technical = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var raw: TaxValue { output.raw }
    private func text(_ key: String) -> String { strings.t("analysis.ext.workbench.\(key)") }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            errors(raw["errors"]?.arrayValue ?? [])
            if let summaries = raw["summaries"]?.objectValue {
                Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 8) {
                    ForEach(summaries.keys.sorted(), id: \.self) { id in
                        GridRow {
                            Text(model.fieldLabel(id, strings: strings))
                            Text(verbatim: display(summaries[id])).monospacedDigit().gridColumnAlignment(.trailing)
                        }
                    }
                }.font(.caption).textSelection(.enabled)
            }
            if let rows = output.rows {
                ScrollView(.horizontal) {
                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                        GridRow {
                            ForEach(columns) { column in
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(columnLabel(column)).fontWeight(.medium)
                                    if let unit = column.unit {
                                        Text(unitLabel(unit)).foregroundStyle(theme.tertiaryLabel)
                                    }
                                }
                            }
                        }
                        ForEach(Array(rows.prefix(10).enumerated()), id: \.offset) { _, row in
                            GridRow {
                                ForEach(columns) { Text(verbatim: display(row[$0.id], type: $0.type, id: $0.id)) }
                            }
                        }
                    }.font(.caption).monospacedDigit().textSelection(.enabled)
                }
                Text("\(text("previewRows")): \(min(rows.count, 10)) / \(rows.count)").font(.caption).foregroundStyle(
                    theme.secondaryLabel)
            }
            if let scenarios = raw["scenarios"]?.arrayValue {
                ScrollView(.horizontal) {
                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                        GridRow {
                            Text(text("scenario"))
                            ForEach(Array(model.draft.summaryFormulas.enumerated()), id: \.offset) { _, formula in
                                Text(verbatim: formula["label"]?.stringValue ?? formula["id"]?.stringValue ?? "—")
                            }
                            Text("")
                        }.fontWeight(.medium)
                        ForEach(Array(scenarios.enumerated()), id: \.offset) { _, scenario in
                            GridRow {
                                Text(verbatim: AnalysisPresentation.rawText(scenario["name"]))
                                ForEach(Array(model.draft.summaryFormulas.enumerated()), id: \.offset) { _, formula in
                                    Text(verbatim: display(scenario["summaries"]?[formula["id"]?.stringValue ?? ""]))
                                }
                                Text(
                                    verbatim: (scenario["errors"]?.arrayValue ?? []).compactMap {
                                        $0["message"]?.stringValue
                                    }.joined(separator: "; ")
                                )
                                .foregroundStyle(theme.destructive)
                            }
                        }
                    }.font(.caption).monospacedDigit().textSelection(.enabled)
                }
            }
            if let reason = raw["reason"]?.stringValue, !reason.isEmpty {
                AnalysisPanel {
                    Text(text(raw["converged"] == .bool(true) ? "converged" : "notConverged")).font(.headline)
                        .accessibilityAddTraits(.updatesFrequently)
                    HStack(spacing: 30) {
                        VStack(alignment: .leading) {
                            Text(text("value")).foregroundStyle(theme.secondaryLabel)
                            Text(verbatim: display(raw["value"]))
                        }
                        VStack(alignment: .leading) {
                            Text(text("outcome")).foregroundStyle(theme.secondaryLabel)
                            Text(verbatim: display(raw["outcome"]))
                        }
                    }.font(.callout).monospacedDigit().textSelection(.enabled)
                    DisclosureGroup(text("technicalDetails"), isExpanded: $technical) {
                        Text("\(reason) · \(text("iterations")): \(AnalysisPresentation.rawText(raw["iterations"]))")
                            .font(.caption).textSelection(.enabled).padding(.top, 8)
                    }
                }
            }
            ForEach(Array((raw["lineage"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, lineage in
                Text(
                    "\(AnalysisPresentation.rawText(lineage["type"])): \(AnalysisPresentation.rawText(lineage["inputRows"] ?? .string(""))) / \(AnalysisPresentation.rawText(lineage["outputRows"] ?? .string(""))) \(text("unmatched")): \(AnalysisPresentation.rawText(lineage["unmatchedRows"] ?? .number(0)))"
                )
                .font(.caption).foregroundStyle(theme.secondaryLabel)
            }
        }
    }
    private var columns: [AnalysisColumn] {
        if let declared = output.columns { return declared }
        let existing = Set(model.columns.map(\.id))
        let formulas = model.draft.formulas.filter {
            $0["scope"] == .string("row") && !existing.contains($0["id"]?.stringValue ?? "")
        }
        return model.columns
            + formulas.compactMap { formula in
                guard let id = formula["id"]?.stringValue else { return nil }
                return AnalysisColumn(
                    id: id, type: formula["resultType"]?.stringValue ?? "decimal",
                    label: formula["label"]?.stringValue ?? id)
            }
    }
    private func columnLabel(_ column: AnalysisColumn) -> String {
        let known = model.fieldLabel(column.id, strings: strings)
        return known == column.id
            ? AnalysisPresentation.catalogLabel(column.label ?? column.id, strings: strings) : known
    }
    private func unitLabel(_ unit: AnalysisUnit) -> String {
        let currency = unit.currency ?? unit.currencyColumn.map { model.fieldLabel($0, strings: strings) } ?? ""
        let instrument = unit.instrumentId ?? unit.instrumentColumn.map { model.fieldLabel($0, strings: strings) } ?? ""
        return [text("option.\(unit.kind)"), currency, instrument].filter { !$0.isEmpty }.joined(separator: " · ")
    }
    private func display(_ value: TaxValue?, type: String = "decimal", id: String = "") -> String {
        AnalysisPresentation.format(
            value: value, type: type, id: id, numberFormat: shell.settings.numberFormat.rawValue)
    }
    private func errors(_ errors: [TaxValue]) -> some View {
        ForEach(Array(errors.enumerated()), id: \.offset) { _, error in
            Text(
                "\(AnalysisPresentation.rawText(error["formulaId"]))\(error["rowIndex"]?.decimalValue.map { " (\(NSDecimalNumber(decimal: $0 + 1).stringValue))" } ?? ""): \(AnalysisPresentation.rawText(error["message"]))"
            )
            .font(.callout).foregroundStyle(theme.destructive).textSelection(.enabled)
        }
    }
}
