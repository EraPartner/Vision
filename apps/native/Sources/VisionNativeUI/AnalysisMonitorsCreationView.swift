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
                VStack(alignment: .leading, spacing: 6) {
                    Text(strings.t("monitors.kind")).font(.caption)
                    ForEach(AnalysisMonitorKind.allCases, id: \.self) { kind in
                        Button {
                            model.chooseKind(kind)
                        } label: {
                            HStack(alignment: .top) {
                                Image(systemName: kind == draft.kind ? "largecircle.fill.circle" : "circle")
                                Text(strings.t(kind.labelKey)).multilineTextAlignment(.leading)
                                Spacer(minLength: 0)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.visionOutline).tint(kind == draft.kind ? .accentColor : .secondary)
                    }
                }
                if draft.kind == .threshold { analysisTarget } else { dossierTarget }
                if model.hasNewTarget {
                    if draft.kind == .threshold {
                        VStack(alignment: .leading, spacing: 6) {
                            Picker(strings.t("monitors.field"), selection: text(\.fieldId)) {
                                Text(strings.t("monitors.selectField")).tag("")
                                ForEach(model.newColumns, id: \.self) { Text($0).tag($0) }
                            }
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
    private var analysisTarget: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker(
                strings.t("monitors.analysis"),
                selection: Binding(get: { draft.savedAnalysisId }, set: { value in model.chooseAnalysis(value) })
            ) {
                Text(strings.t("monitors.selectAnalysis")).tag("")
                ForEach(model.eligibleAnalyses) { Text($0.name).tag($0.id) }
            }.disabled(model.eligibleAnalyses.isEmpty)
            if model.analysesLoading && model.analyses.isEmpty { ProgressView(strings.t("monitors.targetsLoading")) }
            if model.analysesError != nil {
                AnalysisMonitorsRetry(
                    message: strings.t("monitors.targetsFailed"), loading: model.analysesLoading, strings: strings
                ) { await model.loadAnalyses() }
            } else if !model.analysesLoading && model.eligibleAnalyses.isEmpty {
                Text(strings.t("monitors.noEligibleAnalyses")).font(.callout)
                Button(strings.t("monitors.openAnalysis")) { shell.navigate(to: "/analysis") }
            }
            DisclosureGroup(strings.t("monitors.howAlertsWork")) {
                Text(strings.t("monitors.analysisHint")).font(.caption).foregroundStyle(theme.secondaryLabel).padding(.top, 4)
            }
        }
    }
    private var dossierTarget: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker(strings.t("monitors.dossier"), selection: text(\.dossierId)) {
                Text(strings.t("monitors.selectDossier")).tag("")
                ForEach(model.dossiers?.items ?? []) { Text($0.title).tag($0.id) }
            }
            if model.dossiersLoading && model.dossiers == nil { ProgressView(strings.t("monitors.targetsLoading")) }
            if model.dossiersError != nil {
                AnalysisMonitorsRetry(
                    message: strings.t("monitors.targetsFailed"), loading: model.dossiersLoading, strings: strings
                ) { await model.loadDossiers() }
            } else if !model.dossiersLoading && model.dossiers?.total == 0 {
                Text(strings.t("monitors.noDossiers")).font(.callout)
                Button(strings.t("monitors.openDossiers")) { shell.navigate(to: "/research/dossiers") }
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
            Picker(
                strings.t("monitors.operator"),
                selection: Binding(get: { draft.operator }, set: { value in model.updateNew { $0.operator = value } })
            ) {
                ForEach(AnalysisMonitorOperator.allCases, id: \.self) {
                    Text(strings.t("monitors." + $0.rawValue)).tag($0)
                }
            }.pickerStyle(.segmented)
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
