import SwiftUI
import VisionNativeCore

public struct AnalysisWorkbenchView: View {
    @Bindable var model: AnalysisWorkbenchModel
    let shell: NativeShellModel
    @State private var preparationOpen = true
    @State private var formulasOpen = true
    @State private var calendarOpen = false
    @State private var assumptionsOpen = false
    @State private var scenariosOpen = false
    @State private var addingStep = false
    @Environment(\.visionTheme) private var theme
    public init(model: AnalysisWorkbenchModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private func t(_ key: String) -> String { strings.t("analysis.ext.workbench." + key) }
    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if model.sourceStale {
                Text(t("sourceStale")).font(.callout).foregroundStyle(theme.warning)
            }
            VStack(alignment: .leading, spacing: 14) {
                Text(strings.t("analysis.workflow.prepare")).font(VisionFonts.display(17, relativeTo: .title3)).accessibilityAddTraits(.isHeader)
                AnalysisPanel {
                    DisclosureGroup(t("preparation"), isExpanded: $preparationOpen) {
                        VStack(alignment: .leading, spacing: 12) {
                            Button(t(addingStep ? "cancelStep" : "newStep")) { addingStep.toggle() }
                            if addingStep {
                                AnalysisPreparationStepView(model: model, shell: shell) { addingStep = false }
                            }
                            ForEach(model.draft.steps.indices, id: \.self) { index in
                                HStack(alignment: .top) {
                                    Text("\(index + 1). " + stepSummary(model.draft.steps[index])).frame(
                                        maxWidth: .infinity, alignment: .leading)
                                    Button(t("remove")) { model.draft.steps.remove(at: index) }
                                }.padding(.vertical, 6)
                            }
                            if !model.draft.steps.isEmpty {
                                Button(t("applySteps")) { Task { await model.run(apply: true) } }
                                    .buttonStyle(.borderedProminent).disabled(!model.canApplySteps)
                            }
                        }.padding(.top, 12)
                    }
                }
                AnalysisPanel {
                    DisclosureGroup(t("time"), isExpanded: $calendarOpen) {
                        AnalysisCalendarView(model: model, shell: shell).padding(.top, 12)
                    }
                }
            }.id("analysis-prepare")
            VStack(alignment: .leading, spacing: 14) {
                Text(strings.t("analysis.workflow.calculate")).font(VisionFonts.display(17, relativeTo: .title3)).accessibilityAddTraits(.isHeader)
                if !model.complete { Text(t("complete")).font(.callout).foregroundStyle(theme.secondaryLabel) }
                if let error = model.error { Text(error).foregroundStyle(theme.destructive).textSelection(.enabled) }
                AnalysisPanel {
                    DisclosureGroup(t("formulas"), isExpanded: $formulasOpen) {
                        AnalysisFormulaEditorView(model: model, shell: shell).padding(.top, 12)
                    }
                }
                AnalysisPanel {
                    DisclosureGroup(t("assumptions"), isExpanded: $assumptionsOpen) {
                        AnalysisAssumptionsView(model: model, shell: shell).padding(.top, 12)
                    }
                }
                AnalysisPanel {
                    DisclosureGroup(t("scenarios"), isExpanded: $scenariosOpen) {
                        AnalysisScenariosView(model: model, shell: shell).padding(.top, 12)
                    }
                }
            }.id("analysis-calculate")
            if model.isBusy {
                HStack {
                    ProgressView().controlSize(.small)
                    Text(t("applying"))
                }
            }
            if let output = model.output { AnalysisWorkbenchReportView(output: output, model: model, shell: shell) }
        }
    }
    private func stepSummary(_ step: TaxValue) -> String {
        let subject = step["columnId"]?.stringValue ?? step["nameColumn"]?.stringValue
        let fields = (step["columnIds"]?.arrayValue ?? []).compactMap(\.stringValue).map {
            model.fieldLabel($0, strings: strings)
        }.joined(separator: ", ")
        return [
            t("option." + (step["type"]?.stringValue ?? "")),
            subject.map { model.fieldLabel($0, strings: strings) } ?? fields,
            step["targetType"]?.stringValue.map { t("option." + $0) } ?? "",
            step["formula"]?["label"]?.stringValue ?? step["formula"]?["id"]?.stringValue ?? "",
        ]
        .filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

extension AnalysisWorkbenchModel {
    func fieldLabel(_ id: String, strings: any Localizing) -> String {
        for items in [draft.formulas, draft.assumptions] {
            if let label = items.first(where: { $0["id"]?.stringValue == id })?["label"]?.stringValue, !label.isEmpty {
                return label
            }
        }
        guard let column = columns.first(where: { $0.id == id }), let label = column.label else { return id }
        return AnalysisSourceLabels.catalog(label, strings: strings)
    }
}

struct AnalysisWorkbenchPicker: View {
    let key: String
    @Binding var value: String
    let choices: [String]
    let shell: NativeShellModel
    var clearable = true
    var labels: ((String) -> String)?
    var segmented = false
    @ViewBuilder var body: some View {
        if segmented { picker.pickerStyle(.segmented) } else { picker.pickerStyle(.menu) }
    }
    private var picker: some View {
        Picker(shell.strings.t("analysis.ext.workbench." + key), selection: $value) {
            if clearable { Text("—").tag("") }
            ForEach(Array(choices.enumerated()), id: \.offset) { _, choice in
                Text(labels?(choice) ?? shell.strings.t("analysis.ext.workbench.option." + choice)).tag(choice)
            }
            if !value.isEmpty, !choices.contains(value) { Text(value).tag(value) }
        }
    }
}
struct AnalysisWorkbenchTextField: View {
    let key: String
    @Binding var value: String
    let shell: NativeShellModel
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(shell.strings.t("analysis.ext.workbench." + key)).font(.callout)
            TextField(shell.strings.t("analysis.ext.workbench." + key), text: $value).textFieldStyle(.roundedBorder)
        }
    }
}
struct AnalysisWorkbenchColumnChecks: View {
    let key: String
    @Binding var ids: [String]
    let model: AnalysisWorkbenchModel
    let shell: NativeShellModel
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(shell.strings.t("analysis.ext.workbench." + key)).font(.callout)
            ViewThatFits(in: .horizontal) {
                HStack { choices }
                VStack(alignment: .leading) { choices }
            }
        }
    }
    private var choices: some View {
        ForEach(model.columns, id: \.id) { column in
            Toggle(
                model.fieldLabel(column.id, strings: shell.strings),
                isOn: Binding(
                    get: { ids.contains(column.id) },
                    set: { checked in
                        if checked {
                            if !ids.contains(column.id) { ids.append(column.id) }
                        } else {
                            ids.removeAll { $0 == column.id }
                        }
                    })
            ).toggleStyle(.checkbox)
        }
    }
}
