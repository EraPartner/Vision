import Foundation

public enum AnalysisMonitorKind: String, Codable, CaseIterable, Sendable {
    case threshold = "analysis-threshold"
    case evidence = "dossier-evidence"
    public var labelKey: String { self == .threshold ? "monitors.kind.threshold" : "monitors.kind.evidence" }
}
public enum AnalysisMonitorOperator: String, Codable, CaseIterable, Sendable { case above, below }
public enum AnalysisMonitorStatus: String, Codable, Sendable {
    case baseline, unchanged, triggered, partial, stale, failed
    case cooldownPending = "cooldown-pending"
}

/// Thresholds and observed numeric values remain exact wire strings. Evaluating a
/// condition, its completeness and its notification episode belongs to TypeScript.
public struct AnalysisMonitorRule: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: AnalysisMonitorID
    public let kind: AnalysisMonitorKind
    public let title: String
    public let enabled: Bool
    public let savedAnalysisId: SavedAnalysisID?
    public let dossierId: ResearchDossierID?
    public let historicalTargetId: String
    public let targetLabel: String
    public let targetAvailable: Bool
    public let fieldId: String?
    public let `operator`: AnalysisMonitorOperator?
    public let threshold: String?
    public let intervalMinutes: Int
    public let cooldownMinutes: Int
    public let nextDueAt: String
    public let lastCheckedAt: String?
    public let lastStatus: String?
    public let lastObservation: AnalysisMonitorObservation?
    public let createdAt: String
    public let updatedAt: String

    public init(from decoder: any Decoder) throws {
        let v = try TaxValue(from: decoder)
        raw = v
        id = try MonitorWire.id(v, "id", AnalysisMonitorID.self)
        kind = try MonitorWire.enumeration(v, "kind", AnalysisMonitorKind.self)
        title = try MonitorWire.string(v, "title")
        enabled = try MonitorWire.bool(v, "enabled")
        savedAnalysisId = try MonitorWire.nullableString(v, "savedAnalysisId").map { SavedAnalysisID($0) }
        dossierId = try MonitorWire.nullableString(v, "dossierId").map { ResearchDossierID($0) }
        historicalTargetId = try MonitorWire.string(v, "historicalTargetId")
        targetLabel = try MonitorWire.string(v, "targetLabel")
        targetAvailable = try MonitorWire.bool(v, "targetAvailable")
        fieldId = try MonitorWire.nullableString(v, "fieldId")
        let op = try MonitorWire.nullableString(v, "operator")
        if let op {
            guard let parsed = AnalysisMonitorOperator(rawValue: op) else { throw MonitorWire.invalid("operator") }
            self.operator = parsed
        } else {
            self.operator = nil
        }
        threshold = try MonitorWire.nullableString(v, "threshold")
        intervalMinutes = try MonitorWire.integer(v, "intervalMinutes")
        cooldownMinutes = try MonitorWire.integer(v, "cooldownMinutes")
        nextDueAt = try MonitorWire.timestamp(v, "nextDueAt")
        lastCheckedAt = try MonitorWire.nullableTimestamp(v, "lastCheckedAt")
        lastStatus = try MonitorWire.nullableString(v, "lastStatus")
        guard let observation = v["lastObservation"] else { throw MonitorWire.invalid("lastObservation") }
        lastObservation = observation == .null ? nil : try observation.decode(AnalysisMonitorObservation.self)
        createdAt = try MonitorWire.timestamp(v, "createdAt")
        updatedAt = try MonitorWire.timestamp(v, "updatedAt")
        guard (15...10080).contains(intervalMinutes), (0...10080).contains(cooldownMinutes),
            lastObservation == nil || lastObservation?.monitorId == id,
            kind != .threshold || (fieldId?.isEmpty == false && self.operator != nil && threshold != nil),
            kind != .evidence || (fieldId == nil && self.operator == nil && threshold == nil)
        else { throw MonitorWire.invalid("condition/schedule") }
    }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AnalysisMonitorObservation: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: AnalysisMonitorObservationID
    public let monitorId: AnalysisMonitorID
    public let status: AnalysisMonitorStatus
    public let previousValue: String?
    public let currentValue: String?
    public let previousEvidenceVersion: Int?
    public let currentEvidenceVersion: Int?
    public let analysisDefinitionVersion: Int?
    public let analysisRunId: AnalysisRunID?
    public let historicalAnalysisRunId: AnalysisRunID?
    public let analysisRunStatus: String?
    public let analysisWindow: TaxValue?
    public let coverage: TaxValue
    public let reasonCode: String
    public let reason: String
    public let checkedAt: String
    public init(from decoder: any Decoder) throws {
        let v = try TaxValue(from: decoder)
        raw = v
        id = try MonitorWire.id(v, "id", AnalysisMonitorObservationID.self)
        monitorId = try MonitorWire.id(v, "monitorId", AnalysisMonitorID.self)
        status = try MonitorWire.enumeration(v, "status", AnalysisMonitorStatus.self)
        previousValue = try MonitorWire.nullableString(v, "previousValue")
        currentValue = try MonitorWire.nullableString(v, "currentValue")
        previousEvidenceVersion = try MonitorWire.nullableInteger(v, "previousEvidenceVersion")
        currentEvidenceVersion = try MonitorWire.nullableInteger(v, "currentEvidenceVersion")
        analysisDefinitionVersion = try MonitorWire.nullableInteger(v, "analysisDefinitionVersion")
        analysisRunId = try MonitorWire.nullableString(v, "analysisRunId").map { AnalysisRunID($0) }
        historicalAnalysisRunId = try MonitorWire.nullableString(v, "historicalAnalysisRunId").map { AnalysisRunID($0) }
        analysisRunStatus = try MonitorWire.nullableString(v, "analysisRunStatus")
        analysisWindow = v["analysisWindow"]
        guard let coverage = v["coverage"], coverage.objectValue != nil else { throw MonitorWire.invalid("coverage") }
        self.coverage = coverage
        reasonCode = try MonitorWire.string(v, "reasonCode")
        reason = try MonitorWire.string(v, "reason")
        checkedAt = try MonitorWire.timestamp(v, "checkedAt")
    }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AnalysisMonitorNotification: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: AnalysisMonitorNotificationID
    public let monitorId: AnalysisMonitorID
    public let observationId: AnalysisMonitorObservationID
    public let kind: AnalysisMonitorKind
    public let title: String
    public let reasonCode: String
    public let reason: String
    public let previousValue: String?
    public let currentValue: String?
    public let createdAt: String
    public let readAt: String?
    public init(from decoder: any Decoder) throws {
        let v = try TaxValue(from: decoder)
        raw = v
        id = try MonitorWire.id(v, "id", AnalysisMonitorNotificationID.self)
        monitorId = try MonitorWire.id(v, "monitorId", AnalysisMonitorID.self)
        observationId = try MonitorWire.id(v, "observationId", AnalysisMonitorObservationID.self)
        kind = try MonitorWire.enumeration(v, "kind", AnalysisMonitorKind.self)
        title = try MonitorWire.string(v, "title")
        reasonCode = try MonitorWire.string(v, "reasonCode")
        reason = try MonitorWire.string(v, "reason")
        previousValue = try MonitorWire.nullableString(v, "previousValue")
        currentValue = try MonitorWire.nullableString(v, "currentValue")
        createdAt = try MonitorWire.timestamp(v, "createdAt")
        readAt = try MonitorWire.nullableTimestamp(v, "readAt")
    }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AnalysisMonitorPage<Item: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public let items: [Item]
    public let total: Int
    public let limit: Int
    public let offset: Int
    public let unreadCount: Int?
    public init(items: [Item], total: Int, limit: Int, offset: Int, unreadCount: Int? = nil) {
        self.items = items
        self.total = total
        self.limit = limit
        self.offset = offset
        self.unreadCount = unreadCount
    }
    public func validate(offset: Int, limit: Int, notifications: Bool = false) throws {
        guard self.offset == offset, self.limit == limit, total >= 0, items.count <= limit,
            items.isEmpty || total >= offset + items.count,
            unreadCount == nil || unreadCount! >= 0,
            !notifications || unreadCount != nil
        else { throw MonitorWire.invalid("pagination/unreadCount") }
    }
}
public struct AnalysisMonitorDossier: Codable, Equatable, Sendable, Identifiable {
    public let id: ResearchDossierID
    public let title: String
}

public enum AnalysisMonitorPresentation {
    public static let reasonCodes: Set<String> = [
        "baseline", "threshold-not-met", "threshold-crossed", "threshold-cooldown", "threshold-already-met",
        "evidence-changed", "evidence-cooldown", "evidence-unchanged", "analysis-deleted", "analysis-unavailable",
        "analysis-frozen", "analysis-execution-failed", "analysis-run-missing", "analysis-definition-changed",
        "analysis-field-changed", "analysis-run-incomplete", "analysis-window-incomplete",
        "analysis-formula-incomplete",
        "analysis-nonnumeric", "dossier-deleted", "dossier-unavailable", "dossier-evidence-invalid",
        "monitor-check-failed",
    ]
    public static func reason(_ code: String?, fallback: String, strings: any Localizing) -> String {
        code.flatMap { reasonCodes.contains($0) ? strings.t("monitors.reason.\($0)") : nil } ?? fallback
    }
    public static func dateTime(_ raw: String?) -> String {
        guard let raw, let date = VisionFormat.parseTimestamp(raw) else { return "—" }
        let format = DateFormatter()
        format.locale = .autoupdatingCurrent
        format.timeZone = .autoupdatingCurrent
        format.dateStyle = .short
        format.timeStyle = .medium
        return format.string(from: date)
    }
}

enum MonitorWire {
    static func invalid(_ field: String) -> DecodingError {
        .dataCorrupted(.init(codingPath: [], debugDescription: "\(field): incomplete or invalid monitor contract"))
    }
    static func string(_ v: TaxValue, _ key: String) throws -> String {
        guard let value = v[key]?.stringValue else { throw invalid(key) }
        return value
    }
    static func nullableString(_ v: TaxValue, _ key: String) throws -> String? {
        guard let value = v[key] else { throw invalid(key) }
        if value == .null { return nil }
        return try string(v, key)
    }
    static func bool(_ v: TaxValue, _ key: String) throws -> Bool {
        guard let value = v[key]?.boolValue else { throw invalid(key) }
        return value
    }
    static func integer(_ v: TaxValue, _ key: String) throws -> Int {
        guard let value = v[key]?.decimalValue, let result = Int(VisionFormat.plain(value)) else { throw invalid(key) }
        return result
    }
    static func nullableInteger(_ v: TaxValue, _ key: String) throws -> Int? {
        guard let value = v[key] else { throw invalid(key) }
        return value == .null ? nil : try integer(v, key)
    }
    static func id<Tag: IdentifierTag>(
        _ v: TaxValue, _ key: String, _: StringIdentifier<Tag>.Type
    ) throws -> StringIdentifier<Tag> {
        let value = try string(v, key)
        guard UUID(uuidString: value) != nil else { throw invalid(key) }
        return StringIdentifier<Tag>(value)
    }
    static func enumeration<T: RawRepresentable>(_ v: TaxValue, _ key: String, _: T.Type) throws -> T
    where T.RawValue == String {
        let text = try string(v, key)
        guard let value = T(rawValue: text) else { throw invalid(key) }
        return value
    }
    static func timestamp(_ v: TaxValue, _ key: String) throws -> String {
        let text = try string(v, key)
        guard VisionFormat.parseTimestamp(text) != nil else { throw invalid(key) }
        return text
    }
    static func nullableTimestamp(_ v: TaxValue, _ key: String) throws -> String? {
        guard let text = try nullableString(v, key) else { return nil }
        guard VisionFormat.parseTimestamp(text) != nil else { throw invalid(key) }
        return text
    }
}
