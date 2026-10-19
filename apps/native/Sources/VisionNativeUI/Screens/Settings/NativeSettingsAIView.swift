import SwiftUI
import VisionNativeCore

struct NativeSettingsAIView: View {
    let model: NativeSettingsAIModel
    let settings: NativeSettingsModel
    let shell: NativeShellModel
    @FocusState private var benchmarkFocused: Bool
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        NativeSettingsSection(title: strings.t("settings.section.ai")) {
            NativeSettingsGroup(title: strings.t("settings.aiChat.section")) {
                NativeSettingsRow(title: strings.t("settings.aiChat.status"), stacked: true) {
                    VStack(alignment: .leading, spacing: 5) {
                        Label(
                            strings.t(model.statusLabelKey),
                            systemImage: model.ollamaStatus?.ok == true ? "checkmark.circle.fill" : "circle.fill"
                        )
                        .foregroundStyle(model.ollamaStatus?.ok == true ? theme.success : theme.secondaryLabel)
                        if let status = model.ollamaStatus {
                            if !(status.displayUrl ?? status.baseUrl).isEmpty {
                                Text(status.displayUrl ?? status.baseUrl).font(.caption.monospaced()).textSelection(
                                    .enabled)
                            }
                            if !status.ok {
                                if let error = status.error { Text(error).foregroundStyle(theme.destructive) }
                                if let hint = status.hint { Text(hint).foregroundStyle(theme.secondaryLabel) }
                            }
                        }
                    }
                }
                Divider()
                NativeSettingsSelectRow(
                    title: strings.t("settings.aiChat.defaultModel"),
                    description: strings.t("settings.aiChat.defaultModelHint"),
                    value: Binding(
                        get: { model.selectedLocalModel }, set: { settings.setAppValue("aiDefaultModel", .string($0)) }),
                    options: localOptions
                ).disabled(!model.canSelectLocalModel)
            }
            NativeSettingsGroup(title: strings.t("settings.aiOpenAi.section")) {
                NativeSettingsSelectRow(
                    title: strings.t("settings.aiOpenAi.defaultModel"),
                    description: strings.t("settings.aiOpenAi.defaultModelHint"),
                    value: Binding(
                        get: { model.selectedOpenAiModel },
                        set: { settings.setAppValue("openAiDefaultModel", .string($0)) }),
                    options: openAiOptions
                ).disabled(!model.canSelectOpenAiModel)
            }
            agentCloak
            preferences
            NativeSettingsGroup(
                title: strings.t("settings.research.section"), description: strings.t("settings.research.hint")
            ) {
                ForEach(Array((model.providerStatuses?.items ?? []).enumerated()), id: \.element.id) { index, status in
                    if index > 0 { Divider() }
                    provider(status)
                }
                if model.isLoadingProviders {
                    NativeSettingsRow(title: strings.t("settings.research.loading")) { ProgressView() }
                }
            }
        }
    }
    private var localOptions: [NativeSettingsOption] {
        let rows = model.ollamaModels ?? []
        if rows.isEmpty { return [.init(value: model.selectedLocalModel, label: strings.t(model.modelPlaceholderKey))] }
        return rows.map { .init(value: $0.name, label: $0.name) }
    }
    private var openAiOptions: [NativeSettingsOption] {
        if model.openAiModels.isEmpty {
            return [.init(value: model.selectedOpenAiModel, label: strings.t(model.openAiPlaceholderKey))]
        }
        return model.openAiModels.map { .init(value: $0.id, label: "\($0.label) (\($0.id))") }
    }
    private var agentCloak: some View {
        NativeSettingsGroup(
            title: strings.t("settings.agentCloak.section"), description: strings.t("settings.agentCloak.description")
        ) {
            NativeSettingsRow(title: strings.t("settings.agentCloak.status"), stacked: true) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(strings.t(model.desktopLabelKey))
                    if let status = model.desktopStatus {
                        if !status.openAiEnabled { Text(strings.t("settings.agentCloak.openAiHint")) }
                        if !status.available { Text(strings.t("settings.agentCloak.connectionHint")) }
                        if status.enabled && !status.mappingKeyConfigured {
                            Text(strings.t("settings.agentCloak.keyMissingHint")).foregroundStyle(theme.destructive)
                        }
                    }
                    if let error = model.desktopMutationError ?? model.desktopReadError {
                        Text(error).foregroundStyle(theme.destructive).accessibilityLabel(error)
                    }
                }.font(.callout)
            }
            Divider()
            NativeSettingsRow(
                title: strings.t("settings.agentCloak.protection"),
                description: strings.t("settings.agentCloak.protectionHint"), stacked: true
            ) {
                HStack {
                    Button(strings.t("settings.agentCloak.checkAgain")) { Task { await model.checkAgentCloak() } }
                        .disabled(!model.canCheckDesktop)
                    Button(
                        strings.t(
                            model.desktopStatus?.enabled == true
                                ? "settings.agentCloak.disable" : "settings.agentCloak.enable")
                    ) {
                        Task { await model.toggleAgentCloak() }
                    }.disabled(!model.canToggleDesktop)
                }
            }
        }
    }
    private var preferences: some View {
        NativeSettingsGroup(
            title: strings.t("settings.analysisPreferences.title"),
            description: strings.t("settings.analysisPreferences.description")
        ) {
            NativeSettingsSelectRow(
                title: strings.t("settings.analysisPreferences.answerDepth"),
                description: strings.t("settings.analysisPreferences.answerDepthHint"),
                value: Binding(
                    get: { model.selectedAnswerDepth },
                    set: { settings.setAppValue("aiAnswerDepth", $0 == "product-default" ? nil : .string($0)) }),
                options: ["product-default", "quick", "detailed"].map {
                    .init(
                        value: $0,
                        label: strings.t(
                            "settings.analysisPreferences." + ($0 == "product-default" ? "productDefault" : $0)))
                })
            Divider()
            NativeSettingsRow(
                title: strings.t("settings.analysisPreferences.benchmark"),
                description: strings.t("settings.analysisPreferences.benchmarkHint"), stacked: true
            ) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        TextField(
                            strings.t("settings.analysisPreferences.benchmarkPlaceholder"),
                            text: Binding(get: { model.benchmarkDraft }, set: { model.updateBenchmarkDraft($0) })
                        )
                        .textFieldStyle(.vision).focused($benchmarkFocused)
                        .onChange(of: benchmarkFocused) { wasFocused, focused in
                            if wasFocused && !focused {
                                model.commitBenchmark { settings.setAppValue("analysisBenchmark", $0) }
                            }
                        }
                        Button(strings.t("settings.analysisPreferences.clear")) {
                            model.clearBenchmark { settings.setAppValue("analysisBenchmark", $0) }
                        }
                    }
                    if model.benchmarkError {
                        Text(strings.t("settings.analysisPreferences.invalidBenchmark")).foregroundStyle(
                            theme.destructive
                        ).font(.caption)
                    }
                }
            }
        }
    }
    private func provider(_ status: NativeSettingsAIProviderStatus) -> some View {
        let sourceKey =
            status.source == "settings"
            ? "settings.research.sourceSettings"
            : status.source == "env" ? "settings.research.sourceEnv" : "settings.research.sourceNone"
        return NativeSettingsRow(title: status.label, stacked: true) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    if status.configured {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(theme.success).accessibilityHidden(
                            true)
                    }
                    Text(strings.t(sourceKey) + (status.masked.map { " · " + $0 } ?? "")).font(.caption)
                        .foregroundStyle(status.configured ? theme.success : theme.secondaryLabel)
                }
                HStack {
                    SecureField(
                        strings.t("settings.research.placeholder"),
                        text: Binding(
                            get: { model.keyInput(status.provider) }, set: { model.setKeyInput(status.provider, $0) })
                    )
                    .textFieldStyle(.vision).font(.body.monospaced()).accessibilityLabel(status.label)
                    Button(strings.t("settings.research.save")) {
                        Task { await model.saveProviderKey(status.provider) }
                    }.disabled(!model.canSaveKey(status.provider))
                    if status.source == "settings" {
                        Button(strings.t("settings.research.clear")) {
                            Task { await model.clearProviderKey(status.provider) }
                        }.disabled(!model.canClearKey(status.provider))
                    }
                }
                Text(status.envVar).font(.caption.monospaced()).foregroundStyle(theme.tertiaryLabel)
            }
        }
    }
}
