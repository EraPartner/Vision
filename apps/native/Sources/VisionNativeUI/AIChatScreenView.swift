import SwiftUI
import VisionNativeCore

struct AIChatScreenView: View {
    let screens: AIChatScreens
    let shell: NativeShellModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var connectivity = PortfolioConnectivity()
    @State private var visible = false
    private let path = "/ai-chat"

    private var visitKey: String {
        shell.route.string + "|" + String(shell.settingsRevision) + "|" + String(screens.isOnline)
            + "|" + shell.strings.language.rawValue
    }
    private var currentSettings: NativeAppSettings {
        var settings = shell.settings
        // The source Investigation uses useLanguage, including an immediate language change
        // before the debounced app_settings save is acknowledged.
        settings.language = shell.strings.language.rawValue
        return settings
    }
    private var pollKey: String {
        String(visible) + "|" + String(describing: scenePhase) + "|" + String(screens.isOnline)
            + "|" + String(screens.chat.statusPollInterval ?? -1)
    }
    private var canPoll: Bool { visible && scenePhase == .active && screens.isOnline && shell.route.path == path }

    var body: some View {
        AIChatView(model: screens.chat, investigation: screens.investigation, shell: shell)
            .task(id: visitKey) {
                let route = shell.route
                guard route.path == path else { return }
                screens.configure(settings: currentSettings)
                await screens.didAppear(route: route)
            }
            .task(id: pollKey) {
                while canPoll, let seconds = screens.chat.statusPollInterval {
                    do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
                    guard canPoll, !Task.isCancelled else { return }
                    await screens.chat.pollStatus()
                }
            }
            .onAppear {
                visible = true
                screens.investigation.isForeground = scenePhase == .active
                connectivity.start { online in
                    guard visible else { return }
                    let reconnecting = !screens.isOnline && online
                    screens.isOnline = online
                    screens.investigation.isOnline = online
                    if reconnecting {
                        Task {
                            guard visible, shell.route.path == path else { return }
                            await screens.refresh(route: shell.route)
                        }
                    }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                screens.investigation.isForeground = phase == .active
                guard phase == .active, visible, shell.route.path == path else { return }
                Task {
                    guard visible, shell.route.path == path else { return }
                    screens.configure(settings: currentSettings)
                    await screens.refresh(route: shell.route)
                }
            }
            .onDisappear {
                visible = false
                connectivity.stop()
                if !shell.isTemporarilyCovered(path) { screens.didDisappear() }
            }
    }
}
