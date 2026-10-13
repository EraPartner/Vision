import SwiftUI
import VisionNativeCore

/// One route owner handles connectivity and visits; the child screens own their polling cadence.
struct ResearchScreenView: View {
    let screens: ResearchScreens
    let shell: NativeShellModel
    let screen: NativeScreen
    @State private var connectivity = PortfolioConnectivity()
    @State private var visible = false

    private var visitKey: String {
        shell.route.string + "|" + String(shell.settingsRevision) + "|" + String(screens.isOnline)
    }

    var body: some View {
        content
            .task(id: visitKey) {
                let route = shell.route
                guard route.path == screen.path else { return }
                screens.configure(settings: shell.settings)
                await screens.didAppear(route: route)
            }
            .onAppear {
                visible = true
                connectivity.start { if visible { screens.isOnline = $0 } }
                if screen == .researchMarketLookup {
                    shell.setLeaveGuard(
                        NativeLeaveGuard(
                            id: screen.path, hasUnsavedChanges: { screens.lookup.action.isDirty },
                            discard: { screens.lookup.action.discardDrafts() }))
                }
            }
            .onDisappear {
                visible = false
                connectivity.stop()
                guard !shell.isTemporarilyCovered(screen.path) else { return }
                screens.didDisappear(route: NativeRoute(path: screen.path))
                if screen == .researchMarketLookup { shell.removeLeaveGuard(id: screen.path) }
            }
    }

    @ViewBuilder private var content: some View {
        switch screen {
        case .researchHome:
            ResearchHomeView(model: screens.home, shell: shell)
        case .researchMarkets:
            ResearchMarketsView(model: screens.markets, shell: shell)
        case .researchMarketLookup:
            ResearchMarketLookupView(model: screens.lookup, shell: shell)
        case .researchWatchlist:
            ResearchWatchlistView(model: screens.watchlist, shell: shell)
        case .researchCompare:
            ResearchCompareView(model: screens.compare, shell: shell)
        default:
            EmptyView()
        }
    }
}
