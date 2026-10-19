import SwiftUI
import VisionNativeCore

struct NativeSettingsBackupPassphraseSheet: View {
    @Bindable var model: NativeSettingsBackupModel
    let shell: NativeShellModel
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    init(model: NativeSettingsBackupModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label(strings.t("settings.restore.passphraseTitle"), systemImage: "lock").font(.visionCardTitle)
            Text(strings.t("settings.restore.passphraseDesc")).font(.callout).foregroundStyle(theme.secondaryLabel)
            VStack(alignment: .leading, spacing: 7) {
                Text(strings.t("settings.restore.passphraseLabel")).font(.callout)
                HStack {
                    Group {
                        if model.showRestorePassphrase {
                            TextField("", text: $model.restorePassphrase)
                        } else {
                            SecureField("", text: $model.restorePassphrase)
                        }
                    }.textFieldStyle(.vision).focused($focused).disabled(model.restoreSubmitting)
                        .accessibilityLabel(strings.t("settings.restore.passphraseLabel"))
                        .onSubmit { Task { await model.submitRestorePassphrase() } }
                    Button {
                        model.showRestorePassphrase.toggle()
                        focused = true
                    } label: {
                        Image(systemName: model.showRestorePassphrase ? "eye.slash" : "eye")
                    }
                    .buttonStyle(.plain).accessibilityLabel(
                        strings.t(
                            model.showRestorePassphrase
                                ? "settings.restore.hidePassphrase" : "settings.restore.showPassphrase"))
                }
                if let file = model.pendingRestoreFile {
                    Text(URL(fileURLWithPath: file).lastPathComponent).font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
            HStack {
                Button(strings.t("settings.restore.cancelButton")) { model.cancelRestorePassphrase() }.keyboardShortcut(
                    .cancelAction
                ).disabled(model.restoreSubmitting)
                Spacer()
                Button {
                    Task { await model.submitRestorePassphrase() }
                } label: {
                    HStack {
                        if model.restoreSubmitting { ProgressView().controlSize(.small) }
                        Text(strings.t("settings.restore.passphraseSubmit"))
                    }
                }.buttonStyle(.visionPrimary).disabled(model.restorePassphrase.isEmpty || model.restoreSubmitting)
            }
        }.padding(24).frame(width: 460).interactiveDismissDisabled(model.restoreSubmitting).onAppear { focused = true }
            .overlay(alignment: .bottom) {
                if !model.usesExternalNotices {
                    NativeSettingsBackupNotices(notices: model.notices, strings: strings, clear: model.clearNotice)
                }
            }
    }
}
