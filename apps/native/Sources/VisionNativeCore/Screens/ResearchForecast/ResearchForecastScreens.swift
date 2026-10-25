import Foundation
import Observation

@MainActor @Observable public final class ResearchForecastScreens {
    public let model: ResearchForecastModel
    public var isOnline = true { didSet { model.isOnline = isOnline } }
    @ObservationIgnored private var isActive = false
    public init(service: any ForecastService, cache: ResearchReadCache? = nil) {
        model = .init(service: service, cache: cache)
    }
    public convenience init(client: APIClient) { self.init(service: client) }
    public func configure(settings: NativeAppSettings) { model.configure(settings: settings) }
    public func didAppear(route: NativeRoute? = nil) async { await load(force: false) }
    public func load(force: Bool = false) async {
        if !isActive {
            isActive = true
            model.beginVisit()
        }
        await model.load(force: force)
    }
    /// The parent calls this for a real route exit, never for a child sheet/popover.
    public func didDisappear() {
        guard isActive else { return }
        isActive = false
        model.didDisappear()
    }
    public func invalidate() { model.invalidate() }
    public func portfolioDataDidChange() { model.invalidate() }
}
