import SwiftUI
import VisionNativeCore

struct NativeSettingsAboutView: View {
    let model: NativeSettingsAboutModel
    let shell: NativeShellModel
    @Binding var adminMode: Bool
    let preferencesLoaded: Bool
    let restartOnboarding: @MainActor () async -> Void
    let resetPreferences: @MainActor () async -> Void
    @State private var confirmingReset = false
    @Environment(\.visionTheme) private var theme
    init(
        model: NativeSettingsAboutModel, shell: NativeShellModel, adminMode: Binding<Bool>,
        preferencesLoaded: Bool = true, restartOnboarding: @escaping @MainActor () async -> Void,
        resetPreferences: @escaping @MainActor () async -> Void
    ) {
        self.model = model
        self.shell = shell
        _adminMode = adminMode
        self.preferencesLoaded = preferencesLoaded
        self.restartOnboarding = restartOnboarding
        self.resetPreferences = resetPreferences
    }
    private var strings: any Localizing { shell.strings }
    var body: some View {
        NativeSettingsSection(title: strings.t("settings.section.about")) {
            NativeSettingsGroup {
                HStack(spacing: 16) {
                    Image(systemName: "eye.fill").font(.system(size: 28)).foregroundStyle(theme.primaryForeground)
                        .frame(width: 56, height: 56).background(
                            theme.primary,
                            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                        ).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.appName).font(.visionCardTitle)
                        Text(strings.t("settings.app.version", ["version": model.version ?? "—"])).font(.body)
                            .foregroundStyle(theme.secondaryLabel)
                        Text(strings.t("settings.app.license", ["license": model.license])).font(.footnote)
                            .foregroundStyle(theme.tertiaryLabel)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 8) {
                        Link(destination: NativeSettingsAboutModel.repositoryURL) {
                            Label(strings.t("settings.app.sourceCode"), systemImage: "arrow.up.right")
                        }
                        Link(destination: NativeSettingsAboutModel.documentationURL) {
                            Label(strings.t("settings.app.documentation"), systemImage: "arrow.up.right")
                        }
                    }.buttonStyle(.bordered)
                }.padding(24)
            }
            // ADR-204 §5 cuts the updater, including check/install/release controls.
            NativeSettingsGroup {
                NativeSettingsRow(
                    title: strings.t("settings.app.onboardingWizard"),
                    description: strings.t("settings.app.onboardingWizardHint")
                ) {
                    Button(strings.t("settings.app.restart")) { Task { await restartOnboarding() } }.disabled(
                        model.restartingOnboarding)
                }
                Divider()
                NativeSettingsRow(
                    title: strings.t("settings.app.adminMode"), description: strings.t("settings.app.adminModeHint")
                ) {
                    Toggle(strings.t("settings.app.adminMode"), isOn: $adminMode).labelsHidden().toggleStyle(.switch)
                        .disabled(!preferencesLoaded)
                }
            }
            NativeSettingsGroup(title: strings.t("settings.app.reset")) {
                NativeSettingsRow(
                    title: strings.t("settings.app.resetAll"), description: strings.t("settings.app.resetAllHint"),
                    destructive: true
                ) {
                    Button(strings.t("settings.app.reset"), role: .destructive) { confirmingReset = true }.disabled(
                        !preferencesLoaded)
                }
            }
        }
        .confirmationDialog(
            strings.t("settings.app.resetAllConfirm.title"), isPresented: $confirmingReset, titleVisibility: .visible
        ) {
            Button(strings.t("settings.app.resetAllConfirm.action"), role: .destructive) {
                Task { await resetPreferences() }
            }
            Button(strings.t("common.cancel"), role: .cancel) {}
        } message: {
            Text(strings.t("settings.app.resetAllConfirm.desc"))
        }
        .overlay(alignment: .bottom) {
            if !model.usesExternalNotices {
                NativeSettingsBackupNotices(notices: model.notices, strings: strings, clear: model.clearNotice)
            }
        }
    }
}
