import SwiftUI
import VisionNativeCore

struct AnalysisReusableView: View {
    let model: AnalysisWorkspaceModel
    let shell: NativeShellModel
    @State private var sourcesOpen = false
    @State private var preferencesOpen = false
    @State private var filesOpen = false
    @State private var proposalOpen = false
    @State private var nameMissing = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }

    init(model: AnalysisWorkspaceModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    var body: some View {
        AnalysisPanel(title: strings.t("analysis.saveTitle"), description: strings.t("analysis.saveHelp")) {
            VStack(alignment: .leading, spacing: 6) {
                Text(strings.t("analysis.namePlaceholder")).font(.callout)
                TextField(strings.t("analysis.namePlaceholder"), text: text(\.name)).textFieldStyle(.vision)
                if nameMissing {
                    Text(strings.t("analysis.nameRequired")).font(.footnote).foregroundStyle(theme.destructive)
                }
            }
            DisclosureGroup(strings.t("analysis.sourcesLabel"), isExpanded: $sourcesOpen) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(strings.t("analysis.sourcesPlaceholder")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                    TextEditor(text: text(\.sourceReferences)).frame(minHeight: 100)
                        .accessibilityLabel(strings.t("analysis.sourcesLabel"))
                }.padding(.top, 8)
            }
            DisclosureGroup(strings.t("analysis.runPreferences"), isExpanded: $preferencesOpen) {
                preferences.padding(.top, 12)
            }
            DisclosureGroup(strings.t("analysis.filesAndScenarios"), isExpanded: $filesOpen) {
                VStack(alignment: .leading, spacing: 10) {
                    if model.displayedResult != nil
                        && (!model.exportInputsKnown || model.queryOutdated || model.transformationsOutdated)
                    {
                        Text(strings.t("analysis.exportNeedsRun")).font(.footnote).foregroundStyle(theme.warning)
                    }
                    AnalysisInterchangeView(model: model, shell: shell)
                }.padding(.top, 12)
            }
            Button(
                strings.t(model.selectedSaved == nil ? "analysis.save" : "analysis.saveVersion"),
                systemImage: "square.and.arrow.down"
            ) {
                if model.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    nameMissing = true
                } else {
                    Task { await model.save() }
                }
            }.buttonStyle(.visionPrimary).frame(maxWidth: .infinity)
                .disabled(model.displayedResult == nil || model.isSaving || model.savedAction)
            if let saved = model.selectedSaved {
                versions(saved)
                DisclosureGroup(strings.t("analysis.aiEditProposal"), isExpanded: $proposalOpen) {
                    proposal.padding(.top, 12)
                }
            }
        }
        .onChange(of: model.name) { _, _ in nameMissing = false }
        .onChange(of: model.displayedResult == nil) { _, empty in if empty { nameMissing = false } }
    }

    private var preferences: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(strings.t("analysis.reportingCurrency")).font(.callout)
                TextField(model.effectivePreferences.currency.rawValue, text: normalized(\.runCurrency, limit: 3))
                    .textFieldStyle(.vision).accessibilityLabel(strings.t("analysis.reportingCurrency"))
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(strings.t("analysis.benchmark")).font(.callout)
                TextField(
                    model.effectivePreferences.benchmark ?? strings.t("analysis.none"),
                    text: normalized(\.runBenchmark, limit: 32)
                )
                .textFieldStyle(.vision).disabled(model.runWithoutBenchmark)
                .accessibilityLabel(strings.t("analysis.benchmark"))
                Toggle(
                    strings.t("analysis.noBenchmarkForRun"),
                    isOn: Binding(
                        get: { model.runWithoutBenchmark }, set: { model.runWithoutBenchmark = $0 }))
            }
            Picker(strings.t("analysis.answerDepth"), selection: text(\.runAnswerDepth)) {
                Text(strings.t("analysis.useDefault")).tag("")
                Text(strings.t("aiResearch.quick")).tag("quick")
                Text(strings.t("aiResearch.detailed")).tag("detailed")
            }.pickerStyle(.segmented)
            Picker(strings.t("analysis.language"), selection: text(\.runLanguage)) {
                Text(strings.t("analysis.useDefault")).tag("")
                Text(strings.t("settings.general.lang.en")).tag("en")
                Text(strings.t("settings.general.lang.nl")).tag("nl")
            }.pickerStyle(.segmented)
            Text(strings.t("analysis.preferencePrecedence")).font(.footnote).foregroundStyle(theme.secondaryLabel)
        }
    }

    private func versions(_ saved: AnalysisSaved) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(strings.t("analysis.version", ["version": String(saved.version)])).font(.footnote).foregroundStyle(
                theme.secondaryLabel)
            Button(strings.t(model.versionsLoading ? "common.loading" : "analysis.versionHistory")) {
                Task { await model.loadVersions() }
            }.buttonStyle(.visionOutline).disabled(model.versionsLoading)
            if let versions = model.versions {
                let earlier = versions.map(\.version).filter { $0 != saved.version }
                if earlier.isEmpty {
                    Text(strings.t("analysis.noEarlierVersions")).font(.callout).foregroundStyle(theme.secondaryLabel)
                }
                ForEach(earlier, id: \.self) { version in
                    Button(strings.t("analysis.restoreVersion", ["version": String(version)])) {
                        Task { await model.restoreVersion(version) }
                    }.buttonStyle(.borderless).disabled(model.savedAction || model.isSaving)
                }
            }
        }
    }

    private var proposal: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(strings.t("analysis.aiEditProposalPlaceholder")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            TextEditor(text: text(\.proposalJson)).font(.caption.monospaced()).frame(minHeight: 150)
                .accessibilityLabel(strings.t("analysis.aiEditProposalPlaceholder"))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(theme.border.opacity(0.6)))
            ViewThatFits(in: .horizontal) {
                HStack { proposalButtons }
                VStack(alignment: .leading) { proposalButtons }
            }
            if let preview = model.proposalPreview {
                AnalysisCodeText(text: pretty(.object(["before": preview.before, "after": preview.after])))
            }
        }
    }
    @ViewBuilder private var proposalButtons: some View {
        Button(strings.t("analysis.generateProposal")) {
            Task { await model.generateProposal(instruction: model.proposalJson, model: nil) }
        }.buttonStyle(.visionPrimary).disabled(
            model.isProposalLoading || model.proposalJson.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        Button(strings.t("analysis.revalidateProposal")) { Task { await model.previewProposal() } }.buttonStyle(.visionOutline
        ).disabled(model.isProposalLoading)
        if model.proposalPreview != nil {
            Button(strings.t("analysis.applyProposal")) { Task { await model.applyProposal() } }
                .buttonStyle(.visionOutline).disabled(model.savedAction || model.isSaving)
        }
    }
    private func text(_ path: ReferenceWritableKeyPath<AnalysisWorkspaceModel, String>) -> Binding<String> {
        Binding(get: { model[keyPath: path] }, set: { model[keyPath: path] = $0 })
    }
    private func normalized(_ path: ReferenceWritableKeyPath<AnalysisWorkspaceModel, String>, limit: Int) -> Binding<
        String
    > {
        Binding(get: { model[keyPath: path] }, set: { model[keyPath: path] = String($0.uppercased().prefix(limit)) })
    }
    private func pretty(_ value: TaxValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? "—"
    }
}

struct AnalysisSavedLibraryView: View {
    let model: AnalysisWorkspaceModel
    let shell: NativeShellModel
    var onSelect: () -> Void = {}
    @State private var deletion: AnalysisSaved?
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    init(model: AnalysisWorkspaceModel, shell: NativeShellModel, onSelect: @escaping () -> Void = {}) {
        self.model = model
        self.shell = shell
        self.onSelect = onSelect
    }
    var body: some View {
        AnalysisPanel(title: strings.t("analysis.savedTitle")) {
            if let error = model.savedError {
                Text(error).foregroundStyle(theme.destructive)
                Button(strings.t("common.retry")) { Task { await model.loadSavedList() } }
            }
            if model.isSavedLoading && model.saved.isEmpty {
                ProgressView().frame(maxWidth: .infinity).padding(20)
            } else if model.saved.isEmpty {
                Text(strings.t("analysis.noneSaved")).font(.callout).foregroundStyle(theme.secondaryLabel).padding(
                    .vertical, 18)
            } else {
                ForEach(model.saved) { saved in
                    HStack(alignment: .top, spacing: 10) {
                        Button {
                            model.selectSaved(saved)
                            onSelect()
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(saved.name).fontWeight(.medium).foregroundStyle(theme.foreground)
                                Text("v\(saved.version) · \(refreshStatusLabel(saved.refreshStatus.rawValue))").font(.footnote).foregroundStyle(
                                    theme.secondaryLabel)
                                if let error = saved.lastError?["message"]?.stringValue {
                                    Text(error).font(.footnote).foregroundStyle(theme.destructive)
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityLabel(saved.name)
                        Menu {
                            Button(strings.t("analysis.refresh"), systemImage: "play") {
                                Task { await model.runSaved(id: saved.id) }
                            }
                            Divider()
                            Button(strings.t("analysis.delete"), systemImage: "trash", role: .destructive) {
                                deletion = saved
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                        }
                        .menuIndicator(.hidden)
                        .accessibilityLabel(strings.t("analysis.rowMenu", ["name": saved.name]))
                        .disabled(model.savedAction || model.isSaving)
                    }.padding(10)
                        .background(
                            model.selectedSaved?.id == saved.id ? theme.primary.opacity(0.07) : Color.clear,
                            in: RoundedRectangle(cornerRadius: 8)
                        )
                        .accessibilityElement(children: .contain)
                    if saved.id != model.saved.last?.id { Divider() }
                }
            }
        }
        .alert(
            strings.t("analysis.deleteConfirmTitle"),
            isPresented: Binding(
                get: { deletion != nil }, set: { if !$0 { deletion = nil } })
        ) {
            Button(strings.t("common.cancel"), role: .cancel) { deletion = nil }
            Button(strings.t("common.delete"), role: .destructive) {
                guard let saved = deletion else { return }
                deletion = nil
                Task { await model.deleteSaved(id: saved.id) }
            }
        } message: {
            Text(strings.t("analysis.deleteConfirm", ["name": deletion?.name ?? ""]))
        }
    }
    /// The saved analysis `refreshStatus` wire value through its locale key, or as-is.
    private func refreshStatusLabel(_ status: String) -> String {
        let key = "analysis.refreshStatus." + status
        let text = strings.t(key)
        return text == key ? status : text
    }
}
