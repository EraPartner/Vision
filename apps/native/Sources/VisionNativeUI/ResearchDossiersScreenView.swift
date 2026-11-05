import SwiftUI
import VisionNativeCore

struct ResearchDossiersScreenView: View {
    let model: ResearchDossiersModel
    let shell: NativeShellModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var connectivity = PortfolioConnectivity()
    @State private var visible = false
    private let path = "/research/dossiers"

    private var visitKey: String {
        shell.route.string + "|" + String(shell.settingsRevision) + "|" + String(model.isOnline)
    }

    var body: some View {
        ResearchDossiersView(model: model, shell: shell)
            .task(id: visitKey) {
                let route = shell.route
                guard route.path == path else { return }
                model.configure(settings: shell.settings)
                await model.didAppear(route: route)
            }
            .onAppear {
                visible = true
                connectivity.start { if visible { model.isOnline = $0 } }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active, visible, shell.route.path == path else { return }
                Task {
                    guard visible, shell.route.path == path else { return }
                    model.configure(settings: shell.settings)
                    await model.load()
                }
            }
            .onDisappear {
                visible = false
                connectivity.stop()
                if !shell.isTemporarilyCovered(path) { model.didDisappear() }
            }
    }
}
