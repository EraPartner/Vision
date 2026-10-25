import SwiftUI
import VisionNativeCore

struct AnalysisPreparationStepView: View {
    @Bindable var model: AnalysisWorkbenchModel
    let shell: NativeShellModel
    var onAdded: () -> Void
    @Environment(\.visionTheme) private var theme
    private func t(_ key: String) -> String { shell.strings.t("analysis.ext.workbench." + key) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            AnalysisWorkbenchPicker(
                key: "step", value: $model.step.type, choices: AnalysisPreparationStepDraft.types, shell: shell,
                clearable: false)
            Text(t("stepHelp." + model.step.type)).font(.callout).foregroundStyle(theme.secondaryLabel)
            if ["lookup", "append"].contains(model.step.type), model.attachments.isEmpty {
                Text(t("attachmentRequired")).font(.callout).foregroundStyle(theme.secondaryLabel)
            }
            if ["convert", "lookup"].contains(model.step.type) { fieldPicker("column", value: $model.step.column) }
            if model.step.type == "convert" {
                AnalysisWorkbenchPicker(
                    key: "targetType", value: $model.step.targetType,
                    choices: ["string", "decimal", "integer", "date", "boolean"], shell: shell, clearable: false,
                    segmented: true)
            }
            if ["lookup", "append"].contains(model.step.type) {
                AnalysisWorkbenchPicker(
                    key: "attachment", value: $model.step.inputId,
                    choices: model.attachments.compactMap { $0["id"]?.stringValue }, shell: shell, labels: { $0 })
            }
            if model.step.type == "lookup" {
                AnalysisWorkbenchPicker(
                    key: "inputKey", value: $model.step.inputKey,
                    choices: (model.attachments.first { $0["id"]?.stringValue == model.step.inputId }?["columns"]?
                        .arrayValue ?? []).compactMap { $0["id"]?.stringValue },
                    shell: shell, labels: { $0 })
            }
            if ["calculate", "lookup", "unpivot"].contains(model.step.type) {
                AnalysisWorkbenchTextField(key: "outputId", value: $model.step.outputId, shell: shell)
            }
            if model.step.type == "calculate" {
                AnalysisWorkbenchTextField(key: "expression", value: $model.step.expression, shell: shell)
            }
            if model.step.type == "unpivot" {
                AnalysisWorkbenchColumnChecks(key: "values", ids: $model.step.selected, model: model, shell: shell)
                AnalysisWorkbenchTextField(key: "valueColumn", value: $model.step.unpivotValueColumn, shell: shell)
            }
            if model.step.type == "pivot" {
                AnalysisWorkbenchColumnChecks(key: "groups", ids: $model.step.groups, model: model, shell: shell)
                fieldPicker("nameColumn", value: $model.step.nameColumn)
                fieldPicker("valueColumn", value: $model.step.valueColumn)
                AnalysisWorkbenchPicker(
                    key: "aggregate", value: $model.step.aggregate,
                    choices: ["sum", "last", "count", "average", "min", "max"], shell: shell)
            }
            if model.step.hasUnpivotConflict(columnIds: model.columnIds) {
                Text(t("outputNamesConflict")).foregroundStyle(theme.destructive)
            }
            Button(t("addStep")) { if model.addStep() { onAdded() } }.buttonStyle(.visionOutline).disabled(
                !model.step.isValid(columnIds: model.columnIds))
        }.padding(12)
                .background(
                    theme.background.opacity(0.4),
                    in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                        .strokeBorder(theme.border.opacity(0.6)))
    }
    private func fieldPicker(_ key: String, value: Binding<String>) -> some View {
        AnalysisWorkbenchPicker(
            key: key, value: value, choices: model.columnIds, shell: shell,
            labels: { model.fieldLabel($0, strings: shell.strings) })
    }
}
struct AnalysisCalendarView: View {
    @Bindable var model: AnalysisWorkbenchModel
    let shell: NativeShellModel
    private func t(_ key: String) -> String { shell.strings.t("analysis.ext.workbench." + key) }
    private func text(_ key: String, fallback: String = "") -> Binding<String> {
        Binding(get: { model.time[key]?.stringValue ?? fallback }, set: { model.updateTime(key, value: .string($0)) })
    }
    private func columns(_ key: String) -> Binding<[String]> {
        Binding(
            get: { (model.time[key]?.arrayValue ?? []).compactMap(\.stringValue) },
            set: { model.updateTime(key, value: .array($0.map(TaxValue.string))) })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            AnalysisWorkbenchPicker(
                key: "dateColumn", value: text("dateColumn"), choices: model.columnIds,
                shell: shell, labels: { model.fieldLabel($0, strings: shell.strings) })
            AnalysisWorkbenchPicker(
                key: "bucket", value: text("bucket"), choices: ["day", "week", "month", "quarter", "year"],
                shell: shell, clearable: false, segmented: true)
            AnalysisWorkbenchPicker(
                key: "aggregate", value: text("aggregation", fallback: "sum"), choices: ["sum", "last", "average"],
                shell: shell, clearable: false, segmented: true)
            AnalysisWorkbenchColumnChecks(key: "values", ids: columns("valueColumns"), model: model, shell: shell)
            AnalysisWorkbenchColumnChecks(key: "groups", ids: columns("groupColumns"), model: model, shell: shell)
            AnalysisWorkbenchPicker(
                key: "missing", value: text("missing"), choices: ["null", "zero"], shell: shell, clearable: false,
                segmented: true)
            AnalysisWorkbenchTextField(
                key: "rollingWindow",
                value: Binding(
                    get: {
                        model.time["rollingWindow"] == .null
                            ? "" : AnalysisPresentation.rawText(model.time["rollingWindow"])
                    },
                    set: { text in
                        if text.isEmpty {
                            model.updateTime("rollingWindow", value: .number(0))
                        } else if text.range(
                            of: #"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$"#, options: .regularExpression)
                            != nil,
                            let number = Decimal(string: text, locale: Locale(identifier: "en_US_POSIX"))
                        {
                            model.updateTime("rollingWindow", value: .number(number))
                        } else {
                            model.updateTime("rollingWindow", value: .null)
                        }
                    }), shell: shell)
            Button(t("compareTime")) { Task { await model.run(apply: true) } }.buttonStyle(.visionPrimary).disabled(
                !model.canApplyTime)
        }
    }
}
