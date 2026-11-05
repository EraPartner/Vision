import SwiftUI
import VisionNativeCore

struct ResearchForecastScreenView: View {
    let screens: ResearchForecastScreens
    let shell: NativeShellModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var connectivity = PortfolioConnectivity()
    @State private var visible = false
    private let path = "/research/forecast"

    private var visitKey: String {
        shell.route.string + "|" + String(shell.settingsRevision) + "|" + String(screens.isOnline)
    }

    var body: some View {
        ResearchForecastView(model: screens.model, shell: shell)
            .task(id: visitKey) {
                let route = shell.route
                guard route.path == path else { return }
                screens.configure(settings: shell.settings)
                await screens.didAppear(route: route)
            }
            .onAppear {
                visible = true
                connectivity.start { if visible { screens.isOnline = $0 } }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active, visible, shell.route.path == path else { return }
                Task {
                    guard visible, shell.route.path == path else { return }
                    screens.configure(settings: shell.settings)
                    await screens.load()
                }
            }
            .onDisappear {
                visible = false
                connectivity.stop()
                if !shell.isTemporarilyCovered(path) { screens.didDisappear() }
            }
    }
}
