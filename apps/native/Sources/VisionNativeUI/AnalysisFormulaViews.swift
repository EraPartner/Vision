import SwiftUI
import VisionNativeCore

struct AnalysisFormulaEditorView: View {
    @Bindable var model: AnalysisWorkbenchModel
    let shell: NativeShellModel
    @State private var active = 0
    @State private var fieldSearch = ""
    @State private var selectedFunction = ""
    @FocusState private var focusedExpression: Int?
    @Environment(\.visionTheme) private var theme
    private static let functions = [
        "IF", "COALESCE", "ABS", "ROUND", "YEAR", "MONTH", "DATEADD", "DATEDIFF", "SUM", "AVERAGE", "MIN", "MAX",
        "COUNT", "COUNTIF", "SUMIF", "MEDIAN", "STDEV", "VARIANCE", "NPV", "PV", "FV", "PMT",
    ]
    private func t(_ key: String) -> String { shell.strings.t("analysis.ext.workbench." + key) }
    private func text(_ index: Int, _ key: String) -> Binding<String> {
        Binding(
            get: {
                model.draft.formulas.indices.contains(index) ? model.draft.formulas[index][key]?.stringValue ?? "" : ""
            },
            set: { if model.draft.formulas.indices.contains(index) { model.draft.formulas[index][key] = .string($0) } })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(model.draft.formulas.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: 12) {
                    DisclosureGroup(
                        isExpanded: Binding(
                            get: { active == index },
                            set: { expanded in
                                active = expanded ? index : -1
                                fieldSearch = ""
                            })
                    ) {
                        editor(index)
                    } label: {
                        HStack {
                            Text(formulaLabel(index)).frame(maxWidth: .infinity, alignment: .leading)
                            Text(t("option." + (model.draft.formulas[index]["scope"]?.stringValue ?? "row"))).font(
                                .caption)
                        }
                    }
                }.padding(12)
                .background(
                    theme.background.opacity(0.4),
                    in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                        .strokeBorder(theme.border.opacity(0.6)))
            }
            Button(t("addFormula")) {
                let index = model.draft.formulas.count
                model.draft.addFormula()
                active = index
                focusedExpression = index
            }.buttonStyle(.visionOutline)
            if model.draft.formulas.indices.contains(active) {
                fieldInsertion
                functionInsertion
            }
            if model.previewBusy {
                HStack {
                    ProgressView().controlSize(.small)
                    Text(t("previewLoading"))
                }
            }
            if let error = model.previewError {
                HStack(alignment: .top) {
                    Text(t("previewFailed") + ": " + error).foregroundStyle(theme.destructive).textSelection(.enabled)
                    Spacer()
                    Button(t("retryPreview")) { model.retryPreview() }
                        .buttonStyle(.visionOutline).controlSize(.small)
                }
            }
            if let preview = model.preview { AnalysisWorkbenchReportView(output: preview, model: model, shell: shell) }
            if !model.draft.formulas.isEmpty {
                Button(t("applyFormulas")) { Task { await model.run(apply: true) } }
                    .buttonStyle(.visionPrimary).disabled(!model.canApplyFormulas)
            }
        }
    }
    private func formulaLabel(_ index: Int) -> String {
        let item = model.draft.formulas[index]
        let label = item["label"]?.stringValue ?? ""
        let id = item["id"]?.stringValue ?? ""
        return !label.isEmpty ? label : !id.isEmpty ? id : t("formula")
    }
    @ViewBuilder private func editor(_ index: Int) -> some View {
        AnalysisWorkbenchTextField(key: "label", value: text(index, "label"), shell: shell)
        AnalysisWorkbenchPicker(
            key: "scope", value: text(index, "scope"), choices: ["row", "summary"], shell: shell, clearable: false,
            segmented: true)
        VStack(alignment: .leading, spacing: 4) {
            Text(t("expression")).font(.callout)
            TextField(t("expression"), text: text(index, "expression")).textFieldStyle(.vision)
                .font(.body.monospaced()).focused($focusedExpression, equals: index)
            Menu(t("insertField")) {
                ForEach(model.columns, id: \.id) { column in
                    Button("row." + column.id) { insert("row." + column.id, separated: true) }
                }
                ForEach(Array(model.draft.assumptions.enumerated()), id: \.offset) { _, item in
                    if let id = item["id"]?.stringValue {
                        Button("assumption." + id) { insert("assumption." + id, separated: true) }
                    }
                }
                ForEach(Self.functions, id: \.self) { function in
                    Button(function + "(") { insert(function + "(") }
                }
            }
        }
        let scope = model.draft.formulas[index]["scope"]?.stringValue ?? "row"
        Text(t("scopeHelp." + scope)).font(.callout).foregroundStyle(theme.secondaryLabel)
        if text(index, "expression").wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            scope == "row", let field = model.starterField
        {
            Button(t("startWithField") + " · " + model.fieldLabel(field.id, strings: shell.strings)) {
                text(index, "expression").wrappedValue = "row." + field.id
                focusedExpression = index
            }.buttonStyle(.visionOutline).controlSize(.small)
        }
        DisclosureGroup(t("technicalDetails")) {
            AnalysisWorkbenchTextField(key: "id", value: text(index, "id"), shell: shell).padding(.top, 8)
        }
        Button(t("remove"), role: .destructive) { model.draft.formulas.remove(at: index) }
            .buttonStyle(.visionOutline).controlSize(.small)
    }
    private var fieldInsertion: some View {
        DisclosureGroup(t("insertField")) {
            VStack(alignment: .leading, spacing: 8) {
                TextField(t("searchFields"), text: $fieldSearch).textFieldStyle(.vision)
                let query = fieldSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let matching = model.columns.filter {
                    (model.fieldLabel($0.id, strings: shell.strings) + " " + $0.id).lowercased().contains(query)
                }
                if matching.isEmpty {
                    Text(t(model.columns.isEmpty ? "fieldsNeedResult" : "noMatchingFields")).foregroundStyle(
                        theme.secondaryLabel)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(matching, id: \.id) { column in
                            Button {
                                insert("row." + column.id, separated: true)
                            } label: {
                                HStack {
                                    Text(model.fieldLabel(column.id, strings: shell.strings))
                                    if model.fieldLabel(column.id, strings: shell.strings) != column.id {
                                        Text(column.id).font(.caption.monospaced()).foregroundStyle(
                                            theme.secondaryLabel)
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.buttonStyle(.visionGhost).controlSize(.small)
                        }
                    }
                }.frame(maxHeight: 220)
            }.padding(.top, 8)
        }
    }
    private var functionInsertion: some View {
        DisclosureGroup(t("functionsHelp")) {
            VStack(alignment: .leading, spacing: 8) {
                AnalysisWorkbenchPicker(
                    key: "function",
                    value: Binding(
                        get: { "" },
                        set: { function in
                            guard !function.isEmpty else { return }
                            selectedFunction = function
                            insert(function + "(")
                        }), choices: Self.functions, shell: shell, labels: { $0 })
                Text(t("help")).font(.caption).foregroundStyle(theme.secondaryLabel)
                if !selectedFunction.isEmpty {
                    Text(
                        selectedFunction + ": "
                            + t(
                                ["MEDIAN", "STDEV", "VARIANCE"].contains(selectedFunction)
                                    ? "statisticsHelp"
                                    : ["NPV", "PV", "FV", "PMT"].contains(selectedFunction) ? "financialHelp" : "help")
                    )
                    .font(.caption).foregroundStyle(theme.secondaryLabel)
                }
            }.padding(.top, 8)
        }
    }
    private func insert(_ token: String, separated: Bool = false) {
        guard model.draft.formulas.indices.contains(active) else { return }
        let current = text(active, "expression").wrappedValue
        text(active, "expression").wrappedValue =
            separated ? (current + " " + token).trimmingCharacters(in: .whitespacesAndNewlines) : current + token
        focusedExpression = active
    }
}
