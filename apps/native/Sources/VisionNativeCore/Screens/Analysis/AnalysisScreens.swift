import Foundation
import Observation

@MainActor @Observable
public final class AnalysisScreens {
    public let workspace: AnalysisModel
    public let workbench: AnalysisWorkbenchModel
    public var model: AnalysisModel { workspace }
    public var didMutate: (@MainActor () async -> Void)?
    @ObservationIgnored private var isActive = false
    @ObservationIgnored private var visitRevision = UUID()
    public init(
        service: any AnalysisService, historyStore: any AnalysisSQLHistoryStore = AnalysisMemorySQLHistoryStore()
    ) {
        workspace = AnalysisModel(service: service, historyStore: historyStore)
        workbench = AnalysisWorkbenchModel(service: service)
        workspace.didChange = { [weak self] in self?.synchronizeWorkbench() }
        workspace.didMutate = { [weak self] in await self?.didMutate?() }
        workbench.didChangeDraft = { [weak self] draft in self?.workspace.updateWorkbenchDraft(draft) }
        workbench.didApply = { [weak self] output in self?.workspace.applyExtension(output) }
        synchronizeWorkbench()
    }
    public convenience init(
        client: APIClient, sqlRead: (@MainActor () async -> Data?)? = nil,
        sqlWrite: (@MainActor (Data) async -> Void)? = nil
    ) {
        let store: any AnalysisSQLHistoryStore
        if let sqlRead, let sqlWrite {
            store = AnalysisClosureSQLHistoryStore(read: sqlRead, write: sqlWrite)
        } else {
            store = AnalysisMemorySQLHistoryStore()
        }
        self.init(service: client, historyStore: store)
    }
    public func load(route: NativeRoute? = nil, force: Bool = false) async {
        let firstVisit = !isActive
        if firstVisit {
            isActive = true
            visitRevision = UUID()
            workspace.resetForVisit()
        }
        let revision = visitRevision
        if firstVisit { await workspace.refreshHistoryForVisit() }
        guard isActive, revision == visitRevision else { return }
        await workspace.load(force: force, route: route)
        guard isActive, revision == visitRevision else { return }
        synchronizeWorkbench()
    }
    public func didAppear(route: NativeRoute? = nil) async { await load(route: route) }
    public func didDisappear() {
        guard isActive else { return }
        isActive = false
        visitRevision = UUID()
        workbench.cancel()
        workspace.resetForVisit()
    }
    public func invalidate() {
        workbench.cancel()
        if isActive { workspace.invalidate() }
    }
    public func configure(settings: NativeAppSettings, timezone: String = TimeZone.current.identifier) {
        workspace.configure(settings: settings, timezone: timezone)
    }
    private func synchronizeWorkbench() {
        let result = workspace.displayedResult
        workbench.configure(
            result: result?.sourceResultData ?? result, workbench: workspace.workbench,
            formulasJson: workspace.formulasJson, assumptionsJson: workspace.assumptionsJson,
            assumptionValuesJson: workspace.assumptionValuesJson, sourceStale: workspace.workbenchSourceStale,
            attachments: workspace.scenarioModel["attachments"]?.arrayValue ?? [],
            context: workspace.workbenchContext)
    }
}
