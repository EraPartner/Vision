import Foundation
import Observation

/// Both workflows remain mounted through mode changes; only a real route exit retires page reads.
@MainActor @Observable public final class AIChatScreens {
    public let chat: AIChatModel
    public let investigation: AIInvestigationModel
    public var isOnline = true { didSet { chat.isOnline = isOnline } }
    @ObservationIgnored private var isActive = false
    @ObservationIgnored private var visitRevision = UUID()
    public init(client: APIClient) {
        chat = AIChatModel(client: client)
        investigation = AIInvestigationModel(service: client)
    }
    public init(chat: AIChatModel, investigation: AIInvestigationModel) {
        self.chat = chat
        self.investigation = investigation
    }
    public func configure(settings: NativeAppSettings) {
        chat.configure(settings: settings)
        investigation.configure(settings: settings)
    }
    public func load(route: NativeRoute, force: Bool = false) async {
        guard route.path == "/ai-chat", !Task.isCancelled else { return }
        if !isActive {
            isActive = true
            visitRevision = UUID()
        }
        let visit = visitRevision
        async let transcript: Void = loadChat(route: route, visit: visit, force: force)
        async let research: Void = loadInvestigation(visit: visit)
        _ = await (transcript, research)
    }
    public func refresh(route: NativeRoute) async {
        guard route.path == "/ai-chat", isActive, !Task.isCancelled else { return }
        let visit = visitRevision
        await loadChat(route: route, visit: visit, force: false)
        async let transcript: Void = refreshChat(visit: visit)
        async let research: Void = loadInvestigation(visit: visit)
        _ = await (transcript, research)
    }
    private func loadChat(route: NativeRoute, visit: UUID, force: Bool) async {
        guard isActive, visit == visitRevision, !Task.isCancelled else { return }
        await chat.load(route: route, force: force)
    }
    private func refreshChat(visit: UUID) async {
        guard isActive, visit == visitRevision, !Task.isCancelled else { return }
        await chat.refreshPageReads()
    }
    private func loadInvestigation(visit: UUID) async {
        guard isActive, visit == visitRevision, !Task.isCancelled else { return }
        await investigation.load()
    }
    public func didAppear(route: NativeRoute) async { await load(route: route) }
    public func didDisappear() {
        isActive = false
        visitRevision = UUID()
        chat.didDisappear()
        investigation.didDisappear()
    }
    public func invalidate() { chat.invalidate() }
}
