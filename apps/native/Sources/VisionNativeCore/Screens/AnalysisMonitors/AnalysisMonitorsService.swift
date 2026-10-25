import Foundation

public protocol AnalysisMonitorsService: Sendable {
    func monitorRules(offset: Int) async throws -> AnalysisMonitorPage<AnalysisMonitorRule>
    func monitorAnalyses() async throws -> [AnalysisSaved]
    func monitorDossiers(offset: Int) async throws -> AnalysisMonitorPage<AnalysisMonitorDossier>
    func monitorObservations(id: String, offset: Int) async throws -> AnalysisMonitorPage<AnalysisMonitorObservation>
    func monitorNotifications(offset: Int) async throws -> AnalysisMonitorPage<AnalysisMonitorNotification>
    func monitorCreate(_ input: TaxValue) async throws -> AnalysisMonitorRule
    func monitorUpdate(id: String, patch: TaxValue) async throws -> AnalysisMonitorRule
    func monitorDelete(id: String) async throws
    func monitorCheck(id: String) async throws -> AnalysisMonitorObservation
    func monitorReadNotification(id: String) async throws -> AnalysisMonitorNotification
}
extension APIClient: AnalysisMonitorsService {
    public func monitorRules(offset: Int) async throws -> AnalysisMonitorPage<AnalysisMonitorRule> {
        let op = OpenAPIOperations.ListAnalysisMonitors(limit: 200, offset: offset)
        let value: AnalysisMonitorPage<AnalysisMonitorRule> = try await send(InsightRequest(op, query: op.queryItems))
        try value.validate(offset: offset, limit: 200)
        try Self.monitorUnique(value.items.map(\.id))
        return value
    }
    public func monitorAnalyses() async throws -> [AnalysisSaved] { try await analysisSaved(workspace: nil) }
    public func monitorDossiers(offset: Int) async throws -> AnalysisMonitorPage<AnalysisMonitorDossier> {
        let op = OpenAPIOperations.ListResearchDossiers(limit: 500, offset: offset)
        let value: AnalysisMonitorPage<AnalysisMonitorDossier> = try await send(
            InsightRequest(op, query: op.queryItems))
        try value.validate(offset: offset, limit: 500)
        try Self.monitorUnique(value.items.map(\.id))
        return value
    }
    public func monitorObservations(id: String, offset: Int) async throws -> AnalysisMonitorPage<
        AnalysisMonitorObservation
    > {
        let op = OpenAPIOperations.ListAnalysisMonitorObservations(id: id, limit: 200, offset: offset)
        let value: AnalysisMonitorPage<AnalysisMonitorObservation> = try await send(
            InsightRequest(op, query: op.queryItems))
        try value.validate(offset: offset, limit: 200)
        try Self.monitorUnique(value.items.map(\.id))
        guard value.items.allSatisfy({ $0.monitorId == id }) else { throw MonitorWire.invalid("monitorId") }
        return value
    }
    public func monitorNotifications(offset: Int) async throws -> AnalysisMonitorPage<AnalysisMonitorNotification> {
        let op = OpenAPIOperations.ListAnalysisMonitorNotifications(limit: 200, offset: offset)
        let value: AnalysisMonitorPage<AnalysisMonitorNotification> = try await send(
            InsightRequest(op, query: op.queryItems))
        try value.validate(offset: offset, limit: 200, notifications: true)
        try Self.monitorUnique(value.items.map(\.id))
        return value
    }
    public func monitorCreate(_ input: TaxValue) async throws -> AnalysisMonitorRule {
        try await send(
            InsightRequest<OpenAPIOperations.CreateAnalysisMonitor, AnalysisMonitorRule>(
                .init(body: .object([:])), query: [], bodyOverride: APIBody.encode(input)))
    }
    public func monitorUpdate(id: String, patch: TaxValue) async throws -> AnalysisMonitorRule {
        let value: AnalysisMonitorRule = try await send(
            InsightRequest(
                OpenAPIOperations.PatchAnalysisMonitor(id: id, body: .init()),
                query: [], bodyOverride: APIBody.encode(patch)))
        guard value.id == id else { throw MonitorWire.invalid("id") }
        return value
    }
    public func monitorDelete(id: String) async throws {
        _ = try await send(OpenAPIOperations.DeleteAnalysisMonitor(id: id))
    }
    public func monitorCheck(id: String) async throws -> AnalysisMonitorObservation {
        let value: AnalysisMonitorObservation = try await send(
            InsightRequest(OpenAPIOperations.CheckAnalysisMonitor(id: id), query: []))
        guard value.monitorId == id else { throw MonitorWire.invalid("monitorId") }
        return value
    }
    public func monitorReadNotification(id: String) async throws -> AnalysisMonitorNotification {
        let value: AnalysisMonitorNotification = try await send(
            InsightRequest(OpenAPIOperations.ReadAnalysisMonitorNotification(id: id), query: []))
        guard value.id == id, value.readAt != nil else { throw MonitorWire.invalid("id/readAt") }
        return value
    }
    private static func monitorUnique(_ ids: [String]) throws {
        guard Set(ids).count == ids.count, ids.allSatisfy({ UUID(uuidString: $0) != nil }) else {
            throw MonitorWire.invalid("ids")
        }
    }
}
