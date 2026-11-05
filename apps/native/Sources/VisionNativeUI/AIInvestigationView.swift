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
    private static func researchModeKey(_ mode: AIResearchMode) -> String {
        switch mode {
        case .localOnly: return "aiResearch.localOnly"
        case .publicProviders: return "aiResearch.publicProviders"
        case .publicWeb: return "aiResearch.publicWeb"
        // Never offered: the control lists the three known modes.
        case .unknown(let raw): return raw
        }
    }
    private var settings: some View {
        DisclosureGroup(isExpanded: $settingsExpanded) {
            VStack(alignment: .leading, spacing: 16) {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 280), alignment: .leading)], alignment: .leading, spacing: 16
                ) {
                    VisionSegmentedControl(
                        selection: Binding(get: { model.depth }, set: { model.depthOverride = $0 }),
                        values: [AIInvestigationDepth.quick, .detailed],
                        title: { strings.t($0 == .quick ? "aiResearch.quick" : "aiResearch.detailed") }
                    )
                    .visionAccessibilityLabel(strings.t("aiResearch.depth"))
                }
                VisionSegmentedControl(
                    selection: field(\.researchMode),
                    values: [AIResearchMode.localOnly, .publicProviders, .publicWeb],
                    title: { strings.t(Self.researchModeKey($0)) }
                )
                .visionAccessibilityLabel(strings.t("aiResearch.researchMode"))
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
                    .buttonStyle(.visionOutline)
            }
            if [.partial, .failed].contains(job.state) {
                Button(strings.t("aiResearch.resume")) { Task { await model.resume() } }
                    .buttonStyle(.visionOutline)
            }
            Button(strings.t("aiResearch.deleteInvestigation"), role: .destructive) { Task { await model.deleteJob() } }
                .buttonStyle(.visionOutline)
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
                    .buttonStyle(.visionPrimary).disabled(!model.canClarify)
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
        TextEditor(text: text).visionTextEditor(minHeight: minimumHeight)
            .overlay(alignment: .topLeading) {
                if text.wrappedValue.isEmpty {
                    Text(strings.t(placeholder)).font(VisionControlMetrics.fieldFont).foregroundStyle(theme.tertiaryLabel)
                        .padding(.horizontal, VisionControlMetrics.fieldHorizontalPadding)
                        .padding(.vertical, VisionControlMetrics.textAreaVerticalPadding)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .accessibilityLabel(strings.t(label))
    }
}
