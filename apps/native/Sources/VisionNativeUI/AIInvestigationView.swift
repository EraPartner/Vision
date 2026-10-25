import SwiftUI
import VisionNativeCore

struct AIInvestigationView: View {
    let model: AIInvestigationModel
    let shell: NativeShellModel
    @State private var settingsExpanded = false
    @FocusState private var questionFocused: Bool
    @Environment(\.visionTheme) private var theme
    init(model: AIInvestigationModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private var settingsSummary: String {
        model.settingsSummary.map { strings.t($0) }.joined(separator: " · ")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(strings.t("aiResearch.title")).font(.researchCardTitle).accessibilityAddTraits(.isHeader)
            question
            Divider()
            settings
            publicInputs
            Divider()
            AIInvestigationDocumentsView(model: model, shell: shell)
            AIInvestigationPrivacyView(researchMode: model.researchMode, depth: model.depth, shell: shell)
            Divider()
            lifecycle
            if let error = model.error {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle").accessibilityHidden(true)
                    Text(error == "aiResearch.failed" ? strings.t(error) : error).textSelection(.enabled)
                }.font(.callout).foregroundStyle(theme.destructive)
            }
            if model.job?.state == .waiting { clarification }
            if let answer = model.job?.result { AIInvestigationAnswerView(answer: answer, shell: shell) }
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
    }
    private var question: some View {
        VStack(alignment: .leading, spacing: 12) {
            textArea(
                label: "aiResearch.question", placeholder: "aiResearch.question", text: field(\.question),
                minimumHeight: 90
            )
            .focused($questionFocused)
            if model.question.isEmpty {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { starters }
                    VStack(alignment: .leading, spacing: 8) { starters }
                }.accessibilityLabel(strings.t("aiResearch.questionIdeas"))
            }
        }
    }
    private var starters: some View {
        ForEach(["spending", "portfolio"], id: \.self) { topic in
            Button(strings.t("aiResearch.starter." + topic + ".label")) {
                model.question = strings.t("aiResearch.starter." + topic + ".question")
                questionFocused = true
            }.buttonStyle(.visionOutline)
        }
    }
    private var settings: some View {
        DisclosureGroup(isExpanded: $settingsExpanded) {
            VStack(alignment: .leading, spacing: 16) {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 280), alignment: .leading)], alignment: .leading, spacing: 16
                ) {
                    Picker(
                        strings.t("aiResearch.depth"),
                        selection: Binding(get: { model.depth }, set: { model.depthOverride = $0 })
                    ) {
                        Text(strings.t("aiResearch.quick")).tag(AIInvestigationDepth.quick)
                        Text(strings.t("aiResearch.detailed")).tag(AIInvestigationDepth.detailed)
                    }.pickerStyle(.segmented)
                }
                Picker(strings.t("aiResearch.researchMode"), selection: field(\.researchMode)) {
                    Text(strings.t("aiResearch.localOnly")).tag(AIResearchMode.localOnly)
                    Text(strings.t("aiResearch.publicProviders")).tag(AIResearchMode.publicProviders)
                    Text(strings.t("aiResearch.publicWeb")).tag(AIResearchMode.publicWeb)
                }.pickerStyle(.segmented)
            }.padding(.top, 12)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(strings.t("aiResearch.configure")).font(.callout.weight(.medium))
                Text(settingsSummary).font(.caption).foregroundStyle(theme.secondaryLabel)
            }
        }
    }
    @ViewBuilder private var publicInputs: some View {
        if model.researchMode == .publicWeb {
            input(
                "aiResearch.publicWebQuery", placeholder: "aiResearch.publicWebQueryPlaceholder",
                text: field(\.publicWebQuery))
            Text(strings.t("aiResearch.publicWebQueryHelp")).font(.caption).foregroundStyle(theme.secondaryLabel)
        }
        if model.researchMode == .publicProviders {
            input(
                "aiResearch.publicSymbols", placeholder: "aiResearch.publicSymbolsPlaceholder",
                text: field(\.publicSymbols))
            Text(strings.t("aiResearch.publicSymbolsHelp")).font(.caption).foregroundStyle(theme.secondaryLabel)
        }
    }
    private var lifecycle: some View {
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { lifecycleActions }
                VStack(alignment: .leading, spacing: 10) { lifecycleActions }
            }
            Text(
                model.job.map { strings.t("aiResearch.jobState", ["state": $0.state.rawValue]) }
                    ?? strings.t("aiResearch.localDefault")
            )
            .font(.caption).foregroundStyle(theme.secondaryLabel)
        }
    }
    @ViewBuilder private var lifecycleActions: some View {
        Button {
            Task { await model.run() }
        } label: {
            HStack(spacing: 8) {
                if model.busy { ProgressView().controlSize(.small) }
                Text(strings.t("aiResearch.run"))
            }
        }.buttonStyle(.visionPrimary).disabled(model.runDisabled)
        if let job = model.job {
            if ![.completed, .failed, .cancelled, .partial].contains(job.state) {
                Button(strings.t("aiResearch.cancel")) { Task { await model.cancel() } }
            }
            if [.partial, .failed].contains(job.state) {
                Button(strings.t("aiResearch.resume")) { Task { await model.resume() } }
            }
            Button(strings.t("aiResearch.deleteInvestigation"), role: .destructive) { Task { await model.deleteJob() } }
        }
    }
    private var clarification: some View {
        ResearchCard {
            Text(model.job?.plan?["ambiguity"]?["question"]?.stringValue ?? strings.t("aiResearch.clarificationNeeded"))
                .font(.callout).foregroundStyle(theme.warning)
            HStack(spacing: 10) {
                TextField(strings.t("aiResearch.clarificationPlaceholder"), text: field(\.clarification))
                    .textFieldStyle(.vision).accessibilityLabel(strings.t("aiResearch.clarificationNeeded"))
                Button(strings.t("aiResearch.resume")) { Task { await model.resume() } }
                    .disabled(!model.canClarify)
            }
        }
    }
    private func field(_ key: ReferenceWritableKeyPath<AIInvestigationModel, String>) -> Binding<String> {
        Binding(get: { model[keyPath: key] }, set: { model[keyPath: key] = $0 })
    }
    private func field(_ key: ReferenceWritableKeyPath<AIInvestigationModel, AIResearchMode>) -> Binding<AIResearchMode> {
        Binding(get: { model[keyPath: key] }, set: { model[keyPath: key] = $0 })
    }
    private func input(_ label: String, placeholder: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(strings.t(label)).font(.caption)
            TextField(strings.t(placeholder), text: text).textFieldStyle(.vision).accessibilityLabel(
                strings.t(label))
        }
    }
    private func textArea(label: String, placeholder: String, text: Binding<String>, minimumHeight: CGFloat)
        -> some View
    {
        TextEditor(text: text).font(.body).scrollContentBackground(.hidden)
            .padding(8).frame(minHeight: minimumHeight)
            .background(theme.background, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control))
            .overlay(alignment: .topLeading) {
                if text.wrappedValue.isEmpty {
                    Text(strings.t(placeholder)).font(.body).foregroundStyle(theme.tertiaryLabel)
                        .padding(.horizontal, 13).padding(.vertical, 16).allowsHitTesting(false).accessibilityHidden(
                            true)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: DesignTokens.Radius.control).stroke(theme.border))
            .accessibilityLabel(strings.t(label))
    }
}
