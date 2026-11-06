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

    /// The web AboutSection "Updates" group: the status row, then Check for updates with the
    /// install button while a newer release exists.
    private func updatesGroup(_ updates: NativeUpdateModel) -> some View {
        NativeSettingsGroup(
            title: strings.t("settings.app.updates"), description: strings.t("settings.app.updatesHintElectron")
        ) {
            if let status = updates.status {
                updateStatusRow(status)
                Divider()
            }
            NativeSettingsRow(title: strings.t("settings.app.checkForUpdates"), description: applyPhaseText(updates)) {
                HStack(spacing: 8) {
                    Button {
                        Task { await updates.checkNow() }
                    } label: {
                        HStack(spacing: 6) {
                            if updates.isChecking { ProgressView().controlSize(.small) }
                            Text(strings.t("settings.app.checkForUpdates"))
                        }
                    }
                    .buttonStyle(.visionOutline).disabled(updates.isChecking || updates.isApplying)
                    if let status = updates.status, !status.upToDate {
                        Button {
                            Task { await updates.apply() }
                        } label: {
                            HStack(spacing: 6) {
                                if updates.isApplying { ProgressView().controlSize(.small) }
                                Text(installLabel(updates))
                            }
                        }
                        .buttonStyle(.visionPrimary).disabled(updates.isApplying || updates.isChecking)
                    }
                }
            }
        }
    }

    private func updateStatusRow(_ status: NativeUpdateStatus) -> some View {
        let current = status.currentVersion.isEmpty ? nil : status.currentVersion
        let title =
            status.upToDate
            ? strings.t("settings.app.runningLatest") + (current.map { " (\($0))" } ?? "") + "."
            : strings.t("settings.app.versionAvailable", ["version": status.latestVersion ?? ""])
                + (current.map { " (\(strings.t("settings.app.current")) \($0))" } ?? "") + "."
        let summary = status.releaseSummary
        return HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.body).foregroundStyle(status.upToDate ? theme.success : theme.warning)
                if !status.upToDate, let published = status.publishedAt, !published.isEmpty {
                    Text(
                        strings.t("settings.app.released") + " "
                            + VisionFormat.appDate(published, format: shell.settings.dateFormat)
                    )
                    .font(.footnote).foregroundStyle(theme.secondaryLabel)
                }
                if !status.upToDate, !summary.isEmpty {
                    Text(summary).font(.footnote).foregroundStyle(theme.secondaryLabel).lineLimit(2)
                }
                if let error = status.error, !error.isEmpty {
                    Text(error).font(.footnote).foregroundStyle(theme.destructive)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // Gated on the resolved URL, like the web's `safeHref`.
            if let url = status.releaseNotesURL {
                Button {
                    shell.updates?.openURL?(url)
                } label: {
                    Label(strings.t("update.releaseNotes"), systemImage: "arrow.up.right")
                }
                .buttonStyle(.visionGhost)
                .accessibilityLabel(strings.t("aria.openReleaseNotes"))
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 13)
    }

    private func applyPhaseText(_ updates: NativeUpdateModel) -> String? {
        guard updates.isApplying else { return nil }
        switch updates.applyPhase {
        case .backingUp: return strings.t("update.backingUp")
        case .downloading: return strings.t("update.downloading")
        default: return strings.t("settings.app.restarting")
        }
    }

    private func installLabel(_ updates: NativeUpdateModel) -> String {
        if updates.applyPhase == .restarting { return strings.t("settings.app.restarting2") }
        return updates.isApplying ? strings.t("update.installing") : strings.t("settings.app.installUpdate")
    }
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
                    }.buttonStyle(.visionOutline)
                }.padding(24)
            }
            if let updates = shell.updates { updatesGroup(updates) }
            NativeSettingsGroup {
                NativeSettingsRow(
                    title: strings.t("settings.app.onboardingWizard"),
                    description: strings.t("settings.app.onboardingWizardHint")
                ) {
                    Button(strings.t("settings.app.restart")) { Task { await restartOnboarding() } }
                        .buttonStyle(.visionOutline).disabled(model.restartingOnboarding)
                }
                Divider()
                NativeSettingsRow(
                    title: strings.t("settings.app.adminMode"), description: strings.t("settings.app.adminModeHint")
                ) {
                    Toggle(strings.t("settings.app.adminMode"), isOn: $adminMode)
                        .labelsHidden().toggleStyle(.visionSwitchLabelless)
                        .disabled(!preferencesLoaded)
                }
            }
            NativeSettingsGroup(title: strings.t("settings.app.reset")) {
                NativeSettingsRow(
                    title: strings.t("settings.app.resetAll"), description: strings.t("settings.app.resetAllHint"),
                    destructive: true
                ) {
                    // Web: `variant="outline"` with destructive text.
                    Button(strings.t("settings.app.reset"), role: .destructive) { confirmingReset = true }
                        .buttonStyle(.visionOutline).disabled(!preferencesLoaded)
                }
            }
        }
        // The web `useConfirmDialog` AlertDialog rather than a system alert.
        .sheet(isPresented: $confirmingReset) {
            NativeSettingsConfirmSheet(
                title: strings.t("settings.app.resetAllConfirm.title"),
                message: strings.t("settings.app.resetAllConfirm.desc"),
                confirmLabel: strings.t("settings.app.resetAllConfirm.action"),
                cancelLabel: strings.t("common.cancel"),
                onConfirm: {
                    confirmingReset = false
                    Task { await resetPreferences() }
                },
                onCancel: { confirmingReset = false })
        }
        .overlay(alignment: .bottom) {
            if !model.usesExternalNotices {
                NativeSettingsBackupNotices(notices: model.notices, strings: strings, clear: model.clearNotice)
            }
        }
    }
}
