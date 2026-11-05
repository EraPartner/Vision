import Foundation
import Network

@MainActor
final class PortfolioConnectivity {
    private var monitor: NWPathMonitor?
    func start(_ receive: @escaping @MainActor @Sendable (Bool) -> Void) {
        guard monitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { path in
            let online = path.status == .satisfied
            Task { @MainActor in receive(online) }
        }
        monitor.start(queue: DispatchQueue(label: "vision.portfolio.connectivity"))
        self.monitor = monitor
    }
    func stop() {
        monitor?.cancel()
        monitor = nil
    }
}
