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
            if model.route == "openai-api" { cloudInputs }
            if model.route == "openai-api", let preview = model.preview { payloadPreview(preview) }
            AIInvestigationPrivacyView(
                route: model.route, disclosureMode: model.disclosureMode, researchMode: model.researchMode,
                depth: model.depth, shell: shell)
            Divider()
            lifecycle
            Divider()
            AIInvestigationHistoryView(model: model, shell: shell)
            if let error = model.error {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle").accessibilityHidden(true)
                    Text(error == "aiResearch.failed" ? strings.t(error) : error).textSelection(.enabled)
                }.font(.callout).foregroundStyle(theme.destructive)
            }
            if model.job?.state == "waiting" { clarification }
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
                    Picker(strings.t("aiResearch.route"), selection: field(\.route)) {
                        Text(strings.t("aiResearch.localModel")).tag("local")
                        Text(strings.t("aiResearch.openAi")).tag("openai-api").disabled(!model.openAiEnabled)
                    }.pickerStyle(.segmented)
                    Picker(
                        strings.t("aiResearch.depth"),
                        selection: Binding(get: { model.depth }, set: { model.depthOverride = $0 })
                    ) {
                        Text(strings.t("aiResearch.quick")).tag("quick")
                        Text(strings.t("aiResearch.detailed")).tag("detailed")
                    }.pickerStyle(.segmented)
                }
                Picker(strings.t("aiResearch.researchMode"), selection: field(\.researchMode)) {
                    Text(strings.t("aiResearch.localOnly")).tag("local-only")
                    Text(strings.t("aiResearch.publicProviders")).tag("public-providers")
                    Text(strings.t("aiResearch.publicWeb")).tag("public-web")
                }.pickerStyle(.segmented).disabled(
                    model.route == "openai-api" && model.disclosureMode == "cloud-synthesis-selected")
            }.padding(.top, 12)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(strings.t("aiResearch.configure")).font(.callout.weight(.medium))
                Text(settingsSummary).font(.caption).foregroundStyle(theme.secondaryLabel)
            }
        }
    }
    @ViewBuilder private var publicInputs: some View {
        if model.researchMode == "public-web" {
            input(
                "aiResearch.publicWebQuery", placeholder: "aiResearch.publicWebQueryPlaceholder",
                text: field(\.publicWebQuery))
            Text(strings.t("aiResearch.publicWebQueryHelp")).font(.caption).foregroundStyle(theme.secondaryLabel)
        }
        if model.researchMode == "public-providers" {
            input(
                "aiResearch.publicSymbols", placeholder: "aiResearch.publicSymbolsPlaceholder",
                text: field(\.publicSymbols))
            Text(strings.t("aiResearch.publicSymbolsHelp")).font(.caption).foregroundStyle(theme.secondaryLabel)
        }
    }
    private var openAiModelPicker: some View {
        Picker(
            strings.t("aiResearch.openAiModel"),
            selection: Binding<String>(get: { model.openAiModel }, set: { model.openAiModelOverride = $0 })
        ) {
            if model.openAiModels.isEmpty { Text(strings.t("aiResearch.noOpenAiModels")).tag("") }
            ForEach(model.openAiModels, id: \.id) { (option: OpenAIResearchModel) in
                Text(openAiOptionLabel(option)).tag(option.id)
            }
        }.disabled(!model.openAiEnabled || model.openAiModels.isEmpty)
    }
    private func openAiOptionLabel(_ option: OpenAIResearchModel) -> String {
        let identity: String = "\(option.label) (\(option.id))"
        guard option.isDefault else { return identity }
        let defaultLabel: String = strings.t("aiResearch.defaultModel")
        return "\(identity) — \(defaultLabel)"
    }
    private var cloudInputs: some View {
        VStack(alignment: .leading, spacing: 14) {
            openAiModelPicker
            if let option = model.selectedOpenAiModel {
                Text(
                    strings.t(
                        "aiResearch.modelRates",
                        ["input": rate(option.inputMicrosPerMillion), "output": rate(option.outputMicrosPerMillion)])
                )
                .font(.caption).foregroundStyle(theme.secondaryLabel)
            }
            Text(strings.t("aiResearch.apiOnlyBilling")).font(.caption).foregroundStyle(theme.secondaryLabel)
            Picker(
                strings.t("aiResearch.disclosureMode"),
                selection: Binding(
                    get: { model.disclosureMode },
                    set: { value in
                        model.disclosureMode = value
                        if value == "cloud-synthesis-selected" { model.researchMode = "local-only" }
                    })
            ) {
                Text(strings.t("aiResearch.cloudPublic")).tag("cloud-plan-public")
                Text(strings.t("aiResearch.selectedSummary")).tag("selected-summary")
                Text(strings.t("aiResearch.cloudSynthesisSelected")).tag("cloud-synthesis-selected")
            }
            switch model.disclosureMode {
            case "selected-summary":
                textArea(
                    label: "aiResearch.selectedSummary", placeholder: "aiResearch.selectedSummaryPlaceholder",
                    text: field(\.selectedSummary), minimumHeight: 70)
            case "cloud-synthesis-selected":
                textArea(
                    label: "aiResearch.cloudSynthesisSelected", placeholder: "aiResearch.selectedEvidencePlaceholder",
                    text: field(\.selectedEvidence), minimumHeight: 120)
            default:
                textArea(
                    label: "aiResearch.cloudPublic", placeholder: "aiResearch.publicQuestionPlaceholder",
                    text: field(\.publicQuestion), minimumHeight: 70)
            }
            Text(
                strings.t(
                    model.disclosureMode == "cloud-synthesis-selected"
                        ? "aiResearch.summary.reviewEvidence" : "aiResearch.summary.reviewPayload")
            )
            .font(.caption).foregroundStyle(theme.secondaryLabel)
            if let preflight = model.status?.raw["openai"]?["agentCloakPreflight"],
                preflight["enabled"]?.boolValue == true
            {
                Text(
                    strings.t(
                        preflight["location"] == .string("desktop-loopback")
                            ? "aiResearch.agentCloakDesktopPreflight" : "aiResearch.agentCloakPreflight")
                )
                .font(.caption).foregroundStyle(theme.secondaryLabel)
            }
            if ["selected-summary", "cloud-synthesis-selected"].contains(model.disclosureMode) {
                Text(strings.t("aiResearch.reversibleReferenceHint")).font(.caption).foregroundStyle(
                    theme.secondaryLabel)
            }
        }
    }
    private func payloadPreview(_ preview: AIDisclosurePreview) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if preview.agentCloakPreflight["enabled"]?.boolValue == true {
                Text(strings.t("aiResearch.agentCloakPassed")).font(.caption).foregroundStyle(theme.secondaryLabel)
            }
            if let scope = preview.referenceScope {
                Text(
                    strings.t(
                        "aiResearch.reversibleReferenceWarning",
                        ["count": scope["count"]?.decimalValue.map(VisionFormat.plain) ?? ""])
                )
                .font(.caption).foregroundStyle(theme.warning)
            }
            AIInvestigationJSONBlock(value: preview.payload)
        }
    }
    private var lifecycle: some View {
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { lifecycleActions }
                VStack(alignment: .leading, spacing: 10) { lifecycleActions }
            }
            Text(
                model.job.map { strings.t("aiResearch.jobState", ["state": $0.state]) }
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
                Text(
                    strings.t(
                        model.route == "local"
                            ? "aiResearch.run" : model.preview == nil ? "aiResearch.preview" : "aiResearch.consentRun"))
            }
        }.buttonStyle(.visionPrimary).disabled(model.runDisabled)
        if model.grantId != nil {
            Button(strings.t("aiResearch.revoke")) { Task { await model.revokeActiveGrant() } }
        }
        if let job = model.job {
            if !["completed", "failed", "cancelled", "partial"].contains(job.state) {
                Button(strings.t("aiResearch.cancel")) { Task { await model.cancel() } }
            }
            if ["partial", "failed"].contains(job.state) {
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
                    .textFieldStyle(.roundedBorder).accessibilityLabel(strings.t("aiResearch.clarificationNeeded"))
                Button(strings.t("aiResearch.resume")) { Task { await model.resume() } }
                    .disabled(!model.canClarify)
            }
        }
    }
    private func field(_ key: ReferenceWritableKeyPath<AIInvestigationModel, String>) -> Binding<String> {
        Binding(get: { model[keyPath: key] }, set: { model[keyPath: key] = $0 })
    }
    private func input(_ label: String, placeholder: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(strings.t(label)).font(.caption)
            TextField(strings.t(placeholder), text: text).textFieldStyle(.roundedBorder).accessibilityLabel(
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
    private func rate(_ micros: Decimal) -> String {
        (micros / 1_000_000).formatted(
            Decimal.FormatStyle(locale: LanguageLocale.locale(strings.language)).precision(.fractionLength(0...6))
                .rounded(rule: .toNearestOrAwayFromZero))
    }
}
