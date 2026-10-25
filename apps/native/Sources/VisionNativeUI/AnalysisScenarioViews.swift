import SwiftUI
import VisionNativeCore

struct AnalysisAssumptionsView: View {
    @Bindable var model: AnalysisWorkbenchModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private func t(_ key: String) -> String { shell.strings.t("analysis.ext.workbench." + key) }
    private func text(_ index: Int, _ key: String) -> Binding<String> {
        Binding(
            get: {
                model.draft.assumptions.indices.contains(index)
                    ? model.draft.assumptions[index][key]?.stringValue ?? "" : ""
            },
            set: {
                if model.draft.assumptions.indices.contains(index) { model.draft.assumptions[index][key] = .string($0) }
            })
    }
    private func unit(_ index: Int, _ key: String, fallback: String = "") -> Binding<String> {
        Binding(
            get: { model.draft.assumptions[index]["unit"]?[key]?.stringValue ?? fallback },
            set: {
                var unit = model.draft.assumptions[index]["unit"] ?? .object([:])
                unit[key] = .string(key == "currency" ? String($0.uppercased().prefix(3)) : $0)
                model.draft.assumptions[index]["unit"] = unit
            })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(t("assumptionsHelp")).font(.callout).foregroundStyle(theme.secondaryLabel)
            ForEach(model.draft.assumptions.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: 12) {
                    AnalysisWorkbenchTextField(key: "id", value: text(index, "id"), shell: shell)
                    AnalysisWorkbenchTextField(key: "label", value: text(index, "label"), shell: shell)
                    AnalysisWorkbenchTextField(
                        key: "value",
                        value: Binding(
                            get: {
                                let item = model.draft.assumptions[index]
                                let value = model.draft.assumptionValues[item["id"]?.stringValue ?? ""]
                                return AnalysisPresentation.rawText(
                                    value == nil || value == .null ? item["defaultValue"] ?? .string("") : value)
                            }, set: { model.draft.setAssumptionValue(at: index, text: $0) }), shell: shell)
                    AnalysisWorkbenchPicker(
                        key: "unitKind",
                        value: Binding(
                            get: {
                                model.draft.assumptions[index]["unit"]?["kind"]?.stringValue ?? ""
                            }, set: { model.draft.setAssumptionUnit(at: index, kind: $0) }),
                        choices: ["money", "percentage", "quantity", "count", "duration"], shell: shell)
                    if model.draft.assumptions[index]["unit"]?["kind"] == .string("money") {
                        AnalysisWorkbenchTextField(key: "currency", value: unit(index, "currency"), shell: shell)
                    }
                    if model.draft.assumptions[index]["unit"]?["kind"] == .string("percentage") {
                        AnalysisWorkbenchPicker(
                            key: "percentageBasis", value: unit(index, "percentageBasis", fallback: "ratio"),
                            choices: ["ratio", "percent"], shell: shell, clearable: false, segmented: true)
                    }
                    Button(t("remove"), role: .destructive) { model.draft.assumptions.remove(at: index) }
                        .buttonStyle(.visionOutline).controlSize(.small)
                }.padding(12)
                .background(
                    theme.background.opacity(0.4),
                    in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                        .strokeBorder(theme.border.opacity(0.6)))
            }
            Button(t("addAssumption")) { model.draft.addAssumption() }.buttonStyle(.visionOutline)
        }
    }
}
struct AnalysisScenariosView: View {
    @Bindable var model: AnalysisWorkbenchModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private func t(_ key: String) -> String { shell.strings.t("analysis.ext.workbench." + key) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.draft.assumptions.isEmpty || model.draft.summaryFormulas.isEmpty {
                Text(t("scenarioPrerequisites")).font(.callout).foregroundStyle(theme.secondaryLabel)
            }
            AnalysisWorkbenchPicker(
                key: "scenarioTask", value: $model.scenarioTask, choices: ["compare", "explore", "seek"], shell: shell,
                clearable: false, segmented: true)
            Text(t("scenarioHelp." + model.scenarioTask)).font(.callout).foregroundStyle(theme.secondaryLabel)
            if model.scenarioTask == "compare" { comparison } else { exploration }
        }
    }
    private var comparison: some View {
        VStack(alignment: .leading, spacing: 12) {
            AnalysisWorkbenchTextField(key: "name", value: $model.scenarioName, shell: shell)
            Button(t("copyScenario")) {
                model.draft.copyScenario(
                    name: model.scenarioName, id: "scenario_\(Int(Date().timeIntervalSince1970 * 1000))")
                model.scenarioName = ""
            }.buttonStyle(.visionOutline).disabled(
                model.scenarioName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || model.draft.assumptions.isEmpty)
            ForEach(model.draft.scenarios.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: 10) {
                    Text(model.draft.scenarios[index]["name"]?.stringValue ?? "").font(.headline)
                    ForEach(Array(model.draft.assumptions.enumerated()), id: \.offset) { _, assumption in
                        let id = assumption["id"]?.stringValue ?? ""
                        let label = assumption["label"]?.stringValue ?? ""
                        VStack(alignment: .leading, spacing: 4) {
                            Text(label.isEmpty ? id : label).font(.callout)
                            TextField(label.isEmpty ? id : label, text: scenarioValue(index, id: id)).textFieldStyle(
                                .vision)
                        }
                    }
                    Button(t("remove"), role: .destructive) { model.draft.scenarios.remove(at: index) }
                        .buttonStyle(.visionOutline).controlSize(.small)
                }.padding(12)
                .background(
                    theme.background.opacity(0.4),
                    in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                        .strokeBorder(theme.border.opacity(0.6)))
            }
            Button(t("compare")) { Task { await model.compare() } }.buttonStyle(.visionPrimary).disabled(
                !model.canCompare)
        }
    }
    private func scenarioValue(_ index: Int, id: String) -> Binding<String> {
        Binding(
            get: { AnalysisPresentation.rawText(model.draft.scenarios[index]["assumptions"]?[id] ?? .string("")) },
            set: { text in
                var rows = model.draft.scenarios
                var values = rows[index]["assumptions"] ?? .object([:])
                values[id] = .string(text)
                rows[index]["assumptions"] = values
                model.draft.scenarios = rows
            })
    }
    private var exploration: some View {
        VStack(alignment: .leading, spacing: 12) {
            AnalysisWorkbenchPicker(
                key: "outcome", value: $model.outcomeId,
                choices: model.draft.summaryFormulas.compactMap { $0["id"]?.stringValue }, shell: shell,
                labels: { model.fieldLabel($0, strings: shell.strings) })
            AnalysisWorkbenchPicker(
                key: "variable", value: $model.variableId,
                choices: model.draft.assumptions.compactMap { $0["id"]?.stringValue }, shell: shell,
                labels: { model.fieldLabel($0, strings: shell.strings) })
            if model.scenarioTask == "explore" {
                AnalysisWorkbenchTextField(key: "grid", value: $model.grid, shell: shell)
                AnalysisWorkbenchPicker(
                    key: "variable2", value: $model.variable2Id,
                    choices: model.draft.assumptions.compactMap { $0["id"]?.stringValue }, shell: shell,
                    labels: { model.fieldLabel($0, strings: shell.strings) })
                if !model.variable2Id.isEmpty {
                    AnalysisWorkbenchTextField(key: "grid", value: $model.grid2, shell: shell)
                }
                Button(t("sensitivity")) { Task { await model.explore() } }.buttonStyle(.visionPrimary).disabled(
                    !model.canExplore)
            } else {
                AnalysisWorkbenchTextField(key: "target", value: $model.target, shell: shell)
                AnalysisWorkbenchTextField(key: "lower", value: $model.lower, shell: shell)
                AnalysisWorkbenchTextField(key: "upper", value: $model.upper, shell: shell)
                Button(t("goal")) { Task { await model.seek() } }.buttonStyle(.visionPrimary).disabled(
                    !model.canExplore)
            }
        }
    }
}
