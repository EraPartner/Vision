import SwiftUI
import VisionNativeCore

struct NativeOnboardingRestoreView: View {
    @Bindable var model: NativeSettingsBackupModel
    let onboarding: NativeOnboardingModel
    let shell: NativeShellModel
    @State private var confirming = false
    @State private var confirmedFile: String?
    @Environment(\.visionTheme) private var theme
    init(onboarding: NativeOnboardingModel, shell: NativeShellModel) {
        self.onboarding = onboarding
        self.model = onboarding.restore
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    var body: some View {
        if model.isAvailable {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "externaldrive").font(.system(size: 14, weight: .medium))
                    .foregroundStyle(theme.success).frame(width: 32, height: 32)
                    .background(
                        theme.success.opacity(0.12),
                        in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                    )
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(strings.t("onboarding.restore.title")).font(.headline)
                    Text(strings.t("onboarding.restore.desc")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                    Button {
                        Task {
                            if let file = await onboarding.selectRestoreFile() {
                                confirmedFile = file
                                confirming = true
                            }
                        }
                    } label: {
                        HStack {
                            if model.restoreRunning { ProgressView().controlSize(.small) }
                            Text(
                                strings.t(
                                    model.restoreRunning ? "settings.restore.running" : "onboarding.restore.button"))
                        }
                    }.buttonStyle(.bordered).controlSize(.small).disabled(model.restoreRunning).padding(.top, 4)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(16)
            .visionCardBackground()
            .confirmationDialog(
                strings.t("settings.restore.confirmTitle"), isPresented: $confirming, titleVisibility: .visible
            ) {
                Button(strings.t("settings.restore.confirmButton")) {
                    Task {
                        if let file = confirmedFile { await model.startRestore(file: file) }
                        confirmedFile = nil
                    }
                }
                Button(strings.t("settings.restore.cancelButton"), role: .cancel) { confirmedFile = nil }
            } message: {
                Text(
                    strings.t("settings.restore.confirmDesc") + "\n"
                        + (confirmedFile.map { URL(fileURLWithPath: $0).lastPathComponent } ?? ""))
            }
            .sheet(
                isPresented: Binding(
                    get: { model.restorePassphrasePresented },
                    set: { if !$0 { model.cancelRestorePassphrase() } })
            ) {
                NativeSettingsBackupPassphraseSheet(model: model, shell: shell)
            }
            .overlay(alignment: .bottom) {
                if !model.usesExternalNotices {
                    NativeSettingsBackupNotices(notices: model.notices, strings: strings, clear: model.clearNotice)
                }
            }
        }
    }
}
