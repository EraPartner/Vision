import Foundation
import Observation

@MainActor @Observable public final class ResearchForecastScreens {
    public let model: ResearchForecastModel
    public let life: ResearchLifeScenarioModel
    public var isOnline = true {
        didSet {
            model.isOnline = isOnline
            life.isOnline = isOnline
        }
    }
    @ObservationIgnored private var isActive = false
    @ObservationIgnored private var visitRevision = UUID()
    public init(service: any ForecastService, cache: ResearchReadCache? = nil) {
        model = .init(service: service, cache: cache)
        life = .init(service: service)
        model.didChangeInput = { [weak self] in self?.synchronizeLife() }
        synchronizeLife()
    }
    public convenience init(client: APIClient) { self.init(service: client) }
    public func configure(settings: NativeAppSettings) {
        model.configure(settings: settings)
        synchronizeLife()
    }
    public func didAppear(route: NativeRoute? = nil) async { await load(force: false) }
    public func load(force: Bool = false) async {
        if !isActive {
            isActive = true
            visitRevision = UUID()
            model.beginVisit()
            life.beginVisit()
        }
        let visit = visitRevision
        async let forecast: Void = loadForecast(visit: visit, force: force)
        async let scenarios: Void = loadScenarios(visit: visit, force: force)
        _ = await (forecast, scenarios)
    }
    /// The parent calls this for a real route exit, never for a child sheet/popover.
    public func didDisappear() {
        guard isActive else { return }
        isActive = false
        visitRevision = UUID()
        model.didDisappear()
        life.didDisappear()
    }
    public func invalidate() { model.invalidate() }
    public func portfolioDataDidChange() { model.invalidate() }
    private func loadForecast(visit: UUID, force: Bool) async {
        guard isActive, visit == visitRevision else { return }
        await model.load(force: force)
    }
    private func loadScenarios(visit: UUID, force: Bool) async {
        guard isActive, visit == visitRevision else { return }
        await life.loadSaved(force: force)
    }
    private func synchronizeLife() { life.configure(settings: model.settings, forecastInput: model.currentInput) }
}
