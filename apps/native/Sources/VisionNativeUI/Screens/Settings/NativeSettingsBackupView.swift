import SwiftUI
import VisionNativeCore

struct NativeSettingsBackupView: View {
    @Bindable var model: NativeSettingsBackupModel
    let shell: NativeShellModel
    @State private var confirmingRestore = false
    @Environment(\.visionTheme) private var theme
    init(model: NativeSettingsBackupModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    var body: some View {
        NativeSettingsSection(title: strings.t("settings.tab.backup")) {
            if !model.isAvailable {
                NativeSettingsGroup {
                    VStack(spacing: 4) {
                        Text(strings.t("settings.backup.electronOnly"))
                        Text(strings.t("settings.backup.description")).font(.caption).foregroundStyle(
                            theme.secondaryLabel)
                    }.frame(maxWidth: .infinity).padding(24)
                }
            } else {
                backupGroup
                passphraseGroup
                restoreGroup
            }
        }
        .confirmationDialog(
            strings.t("settings.restore.confirmTitle"), isPresented: $confirmingRestore, titleVisibility: .visible
        ) {
            Button(strings.t("settings.restore.confirmButton"), role: .destructive) {
                Task { await model.confirmRestore() }
            }
            Button(strings.t("settings.restore.cancelButton"), role: .cancel) { model.cancelRestoreConfirmation() }
        } message: {
            Text(
                strings.t("settings.restore.confirmDesc") + "\n"
                    + (model.pendingConfirmationFile.map { URL(fileURLWithPath: $0).lastPathComponent } ?? ""))
        }
        .sheet(
            isPresented: Binding(
                get: { model.restorePassphrasePresented }, set: { if !$0 { model.cancelRestorePassphrase() } })
        ) {
            NativeSettingsBackupPassphraseSheet(model: model, shell: shell)
        }
        .overlay(alignment: .bottom) {
            if !model.usesExternalNotices {
                NativeSettingsBackupNotices(notices: model.notices, strings: strings, clear: model.clearNotice)
            }
        }
    }
    private var backupGroup: some View {
        NativeSettingsGroup(
            title: strings.t("settings.backup.title"), description: strings.t("settings.backup.description")
        ) {
            NativeSettingsRow(
                title: strings.t("settings.backup.directory"), description: strings.t("settings.backup.directoryHint"),
                stacked: true
            ) {
                HStack {
                    Text(model.backupDir.isEmpty ? strings.t("settings.backup.notConfigured") : model.backupDir)
                        .font(.system(.callout, design: .monospaced)).textSelection(.enabled).lineLimit(1)
                        .truncationMode(.head)
                        .frame(maxWidth: .infinity, alignment: .leading).help(model.backupDir)
                        .padding(8).background(theme.background, in: RoundedRectangle(cornerRadius: 6))
                    Button {
                        Task { await model.browseDirectory() }
                    } label: {
                        Label(
                            strings.t(model.backupDir.isEmpty ? "settings.backup.browse" : "settings.backup.change"),
                            systemImage: "folder")
                    }.disabled(model.backupLoading)
                }
            }
            Divider()
            NativeSettingsRow(
                title: strings.t("settings.backup.backupOnQuit"),
                description: strings.t("settings.backup.backupOnQuitHint")
            ) {
                Toggle(
                    strings.t("settings.backup.backupOnQuit"),
                    isOn: Binding(get: { model.backupOnQuit }, set: model.setBackupOnQuit)
                )
                .labelsHidden().toggleStyle(.switch).disabled(model.backupDir.isEmpty)
            }
            Divider()
            NativeSettingsRow(
                title: strings.t("settings.backup.runNow"), description: strings.t("settings.backup.formatNote")
            ) {
                Button {
                    Task { await model.runBackup() }
                } label: {
                    HStack {
                        if model.backupRunning { ProgressView().controlSize(.small) }
                        Text(strings.t(model.backupRunning ? "settings.backup.running" : "settings.backup.runNow"))
                    }
                }.disabled(model.backupRunning || model.backupDir.isEmpty)
            }
        }
    }
    private var passphraseGroup: some View {
        NativeSettingsGroup(
            title: strings.t("settings.backup.passphrase.title"),
            description: strings.t("settings.backup.passphrase.description")
        ) {
            NativeSettingsRow(
                title: strings.t("settings.backup.passphrase.label"), description: strings.t(model.passphraseStatusKey),
                stacked: true
            ) {
                HStack {
                    SecureField(strings.t("settings.backup.passphrase.placeholder"), text: $model.backupPassphrase)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel(strings.t("settings.backup.passphrase.label"))
                    Button {
                        Task { await model.savePassphrase() }
                    } label: {
                        HStack {
                            if model.savingBackupPassphrase { ProgressView().controlSize(.small) }
                            Text(strings.t("settings.backup.passphrase.save"))
                        }
                    }
                    Button(strings.t("settings.backup.passphrase.clear")) { Task { await model.clearPassphrase() } }
                }.disabled(model.passphraseControlsDisabled)
                if model.encryptionStatus?.secureStorageAvailable != true {
                    Text(strings.t("settings.backup.passphrase.unavailable")).font(.caption).foregroundStyle(
                        theme.destructive)
                }
            }
            if model.showsReminder {
                Divider()
                NativeSettingsRow(
                    title: strings.t("settings.backup.passphrase.reminderTitle"),
                    description: strings.t("settings.backup.passphrase.reminderDesc")
                ) {
                    Button(strings.t("settings.backup.passphrase.bannerDismiss")) {
                        Task { await model.dismissReminder() }
                    }
                }
            }
        }
    }
    private var restoreGroup: some View {
        NativeSettingsGroup(
            title: strings.t("settings.restore.title"), description: strings.t("settings.restore.description")
        ) {
            NativeSettingsRow(title: strings.t("settings.restore.selectFile"), stacked: true) {
                HStack {
                    Text(
                        model.restoreFile.isEmpty
                            ? strings.t("settings.restore.noFile")
                            : URL(fileURLWithPath: model.restoreFile).lastPathComponent
                    )
                    .font(.system(.callout, design: .monospaced)).lineLimit(1).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).help(model.restoreFile)
                    .padding(8).background(theme.background, in: RoundedRectangle(cornerRadius: 6))
                    Button {
                        Task { await model.selectRestoreFile() }
                    } label: {
                        Label(strings.t("settings.restore.selectFile"), systemImage: "folder")
                    }
                    .disabled(model.restoreRunning)
                }
            }
            Divider()
            NativeSettingsRow(
                title: strings.t("settings.restore.runNow"), description: strings.t("settings.restore.warning"),
                destructive: true
            ) {
                Button(role: .destructive) {
                    model.requestRestoreConfirmation()
                    confirmingRestore = model.pendingConfirmationFile != nil
                } label: {
                    HStack {
                        if model.restoreRunning { ProgressView().controlSize(.small) }
                        Text(strings.t(model.restoreRunning ? "settings.restore.running" : "settings.restore.runNow"))
                    }
                }.disabled(model.restoreRunning || model.restoreFile.isEmpty)
            }
        }
    }
}

struct NativeSettingsBackupNotices: View {
    let notices: [ScreenNotice]
    let strings: any Localizing
    let clear: (Int) -> Void
    var body: some View {
        VStack(spacing: 8) {
            ForEach(notices) { notice in
                NoticeToast(
                    notice: .init(
                        id: notice.id, kind: notice.kind, key: notice.key, variables: notice.variables,
                        detail: NativeSettingsBackupNotice.detail(notice, strings: strings)), strings: strings,
                    clear: { _ in }
                )
                .task(id: notice.id) {
                    do {
                        try await Task.sleep(for: NativeSettingsBackupNotice.duration(notice))
                        clear(notice.id)
                    } catch {}
                }
            }
        }
    }
}
