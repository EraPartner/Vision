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
    /// `hooks/useRestoreBackup.tsx`'s AlertDialog: `max-w-lg p-6 gap-5`, a lock-led
    /// title, a labelled passphrase input with its reveal toggle,
    /// and a right-aligned outline Cancel / primary Restore footer.
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: "lock").font(.system(size: 15, weight: .semibold)).accessibilityHidden(true)
                    Text(strings.t("settings.restore.passphraseTitle")).font(.visionCardTitle)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .foregroundStyle(theme.foreground)
                .accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
                Text(strings.t("settings.restore.passphraseDesc")).font(.body).foregroundStyle(theme.secondaryLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(strings.t("settings.restore.passphraseLabel")).font(.callout.weight(.medium))
                    .foregroundStyle(theme.foreground)
                HStack(spacing: 6) {
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
                            .foregroundStyle(theme.secondaryLabel)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(
                        strings.t(
                            model.showRestorePassphrase
                                ? "settings.restore.hidePassphrase" : "settings.restore.showPassphrase"))
                }
                if let file = model.pendingRestoreFile {
                    Text(verbatim: URL(fileURLWithPath: file).lastPathComponent)
                        .font(.system(.footnote, design: .monospaced)).foregroundStyle(theme.secondaryLabel)
                        .textSelection(.enabled)
                }
            }
            VisionDialogFooter {
                Button(strings.t("settings.restore.cancelButton")) { model.cancelRestorePassphrase() }
                    .buttonStyle(.visionOutline).keyboardShortcut(.cancelAction).disabled(model.restoreSubmitting)
                Button {
                    Task { await model.submitRestorePassphrase() }
                } label: {
                    HStack(spacing: 6) {
                        if model.restoreSubmitting { ProgressView().controlSize(.small) }
                        Text(strings.t("settings.restore.passphraseSubmit"))
                    }
                }.buttonStyle(.visionPrimary).disabled(model.restorePassphrase.isEmpty || model.restoreSubmitting)
            }
        }.visionDialogPadding().frame(width: 512, alignment: .leading)
            .interactiveDismissDisabled(model.restoreSubmitting).onAppear { focused = true }
            .overlay(alignment: .bottom) {
                if !model.usesExternalNotices {
                    NativeSettingsBackupNotices(notices: model.notices, strings: strings, clear: model.clearNotice)
                }
            }
    }
}
