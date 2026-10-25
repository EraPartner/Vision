import SwiftUI
import VisionNativeCore

struct AnalysisMonitorsCreationView: View {
    let model: AnalysisMonitorsModel
    let shell: NativeShellModel
    @FocusState private var focus: AnalysisMonitorInput?
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var draft: AnalysisMonitorDraft { model.newDraft }
    var body: some View {
        AdminCard(padding: 24) {
            VStack(alignment: .leading, spacing: 14) {
                Text(strings.t("monitors.newRule")).font(Font.visionTitle3).accessibilityAddTraits(.isHeader)
                VisionSegmentedControl(
                    selection: Binding(get: { draft.kind }, set: { model.chooseKind($0) }),
                    values: AnalysisMonitorKind.allCases, title: { strings.t($0.labelKey) },
                    label: strings.t("monitors.kind"), vertical: true)
                if draft.kind == .threshold { analysisTarget } else { dossierTarget }
                if model.hasNewTarget {
                    if draft.kind == .threshold {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(strings.t("monitors.field")).font(.caption)
                            VisionSelect(
                                selection: text(\.fieldId),
                                options: fieldOptions,
                                accessibilityLabel: strings.t("monitors.field"), expands: true)
                            condition
                        }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(strings.t("monitors.ruleTitle")).font(.caption)
                        TextField(strings.t("monitors.ruleTitle"), text: text(\.title)).textFieldStyle(.vision)
                            .focused($focus, equals: .title)
                    }
                    Text(strings.t("monitors.baselineHint")).font(.caption).foregroundStyle(theme.secondaryLabel)
                    AnalysisMonitorsScheduleView(draft: draft, strings: strings, update: model.updateNew, focus: $focus)
                    Button(strings.t("monitors.create"), systemImage: "plus") { Task { await model.create() } }
                        .buttonStyle(.visionPrimary)
                }
            }
            .disabled(model.isBusy)
            .onSubmit { Task { await model.create() } }
            .onChange(of: model.validationRevision) { _, _ in
                if !model.validationIsEdit { focus = model.validation }
            }
        }
    }
    private var fieldOptions: [VisionSelectOption<String>] {
        var options = [VisionSelectOption(value: "", title: strings.t("monitors.selectField"))]
        for column in model.newColumns { options.append(VisionSelectOption(value: column, title: column)) }
        return options
    }
    private var analysisEntries: [VisionSelectEntry<SavedAnalysisID>] {
        model.eligibleAnalyses.map { .option(VisionSelectOption(value: $0.id, title: $0.name)) }
    }
    private var dossierEntries: [VisionSelectEntry<ResearchDossierID>] {
        (model.dossiers?.items ?? []).map { .option(VisionSelectOption(value: $0.id, title: $0.title)) }
    }
    private var analysisTarget: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(strings.t("monitors.analysis")).font(.caption)
            VisionSelect(
                selection: Binding(get: { draft.savedAnalysisId }, set: { value in model.chooseAnalysis(value) }),
                entries: analysisEntries, placeholder: strings.t("monitors.selectAnalysis"),
                accessibilityLabel: strings.t("monitors.analysis"), expands: true
            ).disabled(model.eligibleAnalyses.isEmpty)
            if model.analysesLoading && model.analyses.isEmpty { ProgressView(strings.t("monitors.targetsLoading")) }
            if model.analysesError != nil {
                AnalysisMonitorsRetry(
                    message: strings.t("monitors.targetsFailed"), loading: model.analysesLoading, strings: strings
                ) { await model.loadAnalyses() }
            } else if !model.analysesLoading && model.eligibleAnalyses.isEmpty {
                // `<Alert>`: the notice and its button in a tinted inset row.
                HStack(spacing: 8) {
                    Text(strings.t("monitors.noEligibleAnalyses")).font(.callout)
                    Spacer(minLength: 0)
                    Button(strings.t("monitors.openAnalysis")) { shell.navigate(to: "/analysis") }
                        .buttonStyle(.vision(.outline, size: .sm))
                }
                .visionInsetPanel(padding: 12, cornerRadius: DesignTokens.Radius.control, bordered: true)
            }
            DisclosureGroup(strings.t("monitors.howAlertsWork")) {
                Text(strings.t("monitors.analysisHint")).font(.caption).foregroundStyle(theme.secondaryLabel).padding(.top, 4)
            }
        }
    }
    private var dossierTarget: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(strings.t("monitors.dossier")).font(.caption)
            VisionSelect(
                selection: Binding(
                    get: { draft.dossierId }, set: { value in model.updateNew { $0.dossierId = value } }),
                entries: dossierEntries, placeholder: strings.t("monitors.selectDossier"),
                accessibilityLabel: strings.t("monitors.dossier"), expands: true)
            if model.dossiersLoading && model.dossiers == nil { ProgressView(strings.t("monitors.targetsLoading")) }
            if model.dossiersError != nil {
                AnalysisMonitorsRetry(
                    message: strings.t("monitors.targetsFailed"), loading: model.dossiersLoading, strings: strings
                ) { await model.loadDossiers() }
            } else if !model.dossiersLoading && model.dossiers?.total == 0 {
                Text(strings.t("monitors.noDossiers")).font(.callout)
                Button(strings.t("monitors.openDossiers")) { shell.navigate(to: "/research/dossiers") }
                    .buttonStyle(.visionOutline)
            }
            if let page = model.dossiers, page.total > 500 || model.dossierOffset > 0 {
                AnalysisMonitorsPager(
                    offset: model.dossierOffset, total: page.total, pageSize: 500, strings: strings,
                    change: model.changeDossierPage)
            }
        }
    }
    private var condition: some View {
        VStack(alignment: .leading, spacing: 8) {
            VisionSegmentedControl(
                selection: Binding(get: { draft.operator }, set: { value in model.updateNew { $0.operator = value } }),
                values: AnalysisMonitorOperator.allCases, title: { strings.t("monitors." + $0.rawValue) },
                label: strings.t("monitors.operator"))
            VStack(alignment: .leading, spacing: 4) {
                Text(strings.t("monitors.threshold")).font(.caption)
                TextField(strings.t("monitors.threshold"), text: text(\.threshold)).textFieldStyle(.vision)
                    .focused($focus, equals: .threshold)
            }
        }
    }
    private func text(_ key: WritableKeyPath<AnalysisMonitorDraft, String>) -> Binding<String> {
        Binding(get: { draft[keyPath: key] }, set: { value in model.updateNew { $0[keyPath: key] = value } })
    }
}
