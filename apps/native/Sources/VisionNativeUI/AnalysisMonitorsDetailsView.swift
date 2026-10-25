import SwiftUI
import VisionNativeCore

struct AnalysisMonitorsDetailsView: View {
    let model: AnalysisMonitorsModel
    let strings: any Localizing
    @FocusState private var focus: AnalysisMonitorInput?
    @Environment(\.visionTheme) private var theme
    var body: some View {
        if let rule = model.selectedRule, let draft = model.editDraft {
            AdminCard(padding: 24) {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(strings.t("monitors.ruleDetails")).font(Font.visionTitle3).accessibilityAddTraits(.isHeader)
                        Text(strings.t(rule.kind.labelKey) + " · " + rule.targetLabel).font(.caption).foregroundStyle(
                            theme.secondaryLabel)
                        HStack {
                            Button(strings.t("monitors.checkNow"), systemImage: "checklist") {
                                Task { await model.check(rule) }
                            }.disabled(model.isBusy)
                            Button(strings.t("monitors.delete"), role: .destructive) { model.deletingRule = rule }
                                .disabled(model.isBusy)
                        }.buttonStyle(.visionOutline).controlSize(.small)
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(strings.t("monitors.ruleTitle")).font(.caption)
                            TextField(strings.t("monitors.ruleTitle"), text: text(draft, \.title)).textFieldStyle(
                                .vision
                            ).focused($focus, equals: .title)
                        }
                        Toggle(
                            strings.t("monitors.enabled"),
                            isOn: Binding(
                                get: { draft.enabled }, set: { value in model.updateEdit { $0.enabled = value } }))
                        if rule.kind == .threshold {
                            Picker(strings.t("monitors.field"), selection: text(draft, \.fieldId)) {
                                Text(strings.t("monitors.selectField")).tag("")
                                ForEach(model.editColumns, id: \.self) { Text($0).tag($0) }
                            }
                            Picker(
                                strings.t("monitors.operator"),
                                selection: Binding(
                                    get: { draft.operator }, set: { value in model.updateEdit { $0.operator = value } })
                            ) {
                                ForEach(AnalysisMonitorOperator.allCases, id: \.self) {
                                    Text(strings.t("monitors." + $0.rawValue)).tag($0)
                                }
                            }.pickerStyle(.segmented)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(strings.t("monitors.threshold")).font(.caption)
                                TextField(strings.t("monitors.threshold"), text: text(draft, \.threshold))
                                    .textFieldStyle(.vision).focused($focus, equals: .threshold)
                            }
                        }
                        AnalysisMonitorsScheduleView(
                            draft: draft, strings: strings, update: model.updateEdit, focus: $focus)
                        Button(strings.t("monitors.save"), systemImage: "square.and.arrow.down") {
                            Task { await model.save() }
                        }.buttonStyle(.visionPrimary)
                    }.disabled(model.isBusy).onSubmit { Task { await model.save() } }
                    Divider()
                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                        GridRow {
                            Text(strings.t("monitors.nextDue")).foregroundStyle(theme.secondaryLabel)
                            Text(AnalysisMonitorPresentation.dateTime(rule.nextDueAt)).monospacedDigit()
                        }
                        GridRow {
                            Text(strings.t("monitors.lastChecked")).foregroundStyle(theme.secondaryLabel)
                            Text(AnalysisMonitorPresentation.dateTime(rule.lastCheckedAt)).monospacedDigit()
                        }
                        GridRow {
                            Text(strings.t("monitors.lastStatus")).foregroundStyle(theme.secondaryLabel)
                            AnalysisMonitorsStatus(status: rule.lastStatus, strings: strings)
                        }
                    }.font(.callout)
                    if let observation = rule.lastObservation {
                        AnalysisMonitorsObservationView(item: observation, strings: strings)
                    }
                }
                .onChange(of: model.validationRevision) { _, _ in if model.validationIsEdit { focus = model.validation }
                }
            }
        }
    }
    private func text(_ draft: AnalysisMonitorDraft, _ key: WritableKeyPath<AnalysisMonitorDraft, String>) -> Binding<
        String
    > {
        Binding(get: { draft[keyPath: key] }, set: { value in model.updateEdit { $0[keyPath: key] = value } })
    }
}
