import SwiftUI
import VisionNativeCore

/// Section mounts retain app-lifetime preference writers while retiring only the
/// section's transient reads. The source router remains responsible for history.
struct NativeSettingsScreenView: View {
    let shell: NativeShellModel
    let model: NativeSettingsModel
    let ai: NativeSettingsAIModel
    let backup: NativeSettingsBackupModel
    let about: NativeSettingsAboutModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var connectivity = PortfolioConnectivity()
    @State private var visible = false
    /// The last section the shell reported: the dialog animates out after the shell has cleared
    /// it, and the pane must not jump to General (or reload) while it fades.
    @State private var lastSection = "general"
    private var section: String { shell.settingsSection ?? lastSection }
    private var loadKey: String { section + "|" + String(model.isOnline) }
    private var pollKey: String {
        section + "|" + String(visible) + "|" + String(ai.isOnline) + "|"
            + String(describing: scenePhase) + "|" + String(ai.statusPollInterval ?? -1)
    }

    init(
        shell: NativeShellModel, model: NativeSettingsModel, ai: NativeSettingsAIModel,
        backup: NativeSettingsBackupModel, about: NativeSettingsAboutModel
    ) {
        self.shell = shell
        self.model = model
        self.ai = ai
        self.backup = backup
        self.about = about
    }

    var body: some View {
        NativeSettingsWindow(
            model: model, shell: shell, ai: ai, backup: backup, about: about, section: section,
            onSelectSection: shell.selectSettingsSection, onClose: shell.closeSettings,
            restartOnboarding: { await about.restartOnboarding() },
            resetPreferences: { await model.resetPreferences() }
        )
        .disabled(model.isSuspendedForRestore)
        .environment(\.nativeNoticeCenter, shell.notices)
        .overlay(alignment: .bottom) {
            NativeNoticeHost(center: shell.notices, strings: shell.strings)
        }
        .task(id: loadKey) {
            await model.load()
            guard !Task.isCancelled else { return }
            switch section {
            case "statistics": await model.loadOptions()
            case "behavior":
                async let categories: Void = model.loadCategories()
                async let services: Void = model.loadServices()
                _ = await (categories, services)
            case "ai":
                ai.configure(appRaw: model.appRaw)
                await ai.load()
            case "backup": await backup.load()
            default: break
            }
        }
        .task(id: pollKey) {
            while visible, section == "ai", scenePhase == .active, ai.isOnline,
                let seconds = ai.statusPollInterval
            {
                do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
                guard !Task.isCancelled, visible, section == "ai", scenePhase == .active, ai.isOnline else { return }
                await ai.pollStatus()
            }
        }
        .onAppear {
            visible = true
            ai.isForeground = scenePhase == .active
            connectivity.start { online in
                guard visible else { return }
                model.isOnline = online
                ai.isOnline = online
            }
        }
        .onChange(of: shell.settingsSection, initial: true) { _, next in if let next { lastSection = next } }
        .onChange(of: section) { old, new in
            if old == "ai", new != "ai" { ai.didDisappear() }
            if old == "backup", new != "backup" { backup.didDisappear() }
        }
        .onChange(of: model.appRaw) { _, raw in ai.configure(appRaw: raw) }
        .onChange(of: scenePhase) { _, phase in ai.isForeground = phase == .active }
        .onDisappear {
            visible = false
            connectivity.stop()
            ai.didDisappear()
            backup.didDisappear()
        }
    }
}
