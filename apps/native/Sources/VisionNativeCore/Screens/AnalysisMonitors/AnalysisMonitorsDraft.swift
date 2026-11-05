import Foundation

public enum AnalysisMonitorInput: String, Sendable { case title, target, field, threshold, interval, cooldown }
public struct AnalysisMonitorDraft: Equatable, Sendable {
    public var kind: AnalysisMonitorKind = .threshold
    public var title = ""
    public var savedAnalysisId: SavedAnalysisID?
    public var dossierId: ResearchDossierID?
    public var fieldId = ""
    public var `operator`: AnalysisMonitorOperator = .above
    public var threshold = ""
    public var enabled = true
    public var intervalMinutes = "1440"
    public var cooldownMinutes = "1440"
    public var scheduleExpanded = false
    public init() {}
    public init(rule: AnalysisMonitorRule) {
        kind = rule.kind
        title = rule.title
        savedAnalysisId = rule.savedAnalysisId
        dossierId = rule.dossierId
        fieldId = rule.fieldId ?? ""
        self.operator = rule.operator ?? .above
        threshold = rule.threshold ?? ""
        enabled = rule.enabled
        intervalMinutes = String(rule.intervalMinutes)
        cooldownMinutes = String(rule.cooldownMinutes)
    }
    public var interval: Int? { Self.minutes(intervalMinutes) }
    public var cooldown: Int? { Self.minutes(cooldownMinutes) }
    public var invalidSchedule: AnalysisMonitorInput? {
        if !(interval.map { (15...10080).contains($0) } ?? false) { return .interval }
        if !(cooldown.map { (0...10080).contains($0) } ?? false) { return .cooldown }
        return nil
    }
    public static func exactDecimal(_ raw: String) -> Bool {
        raw.utf16.count <= 100
            && raw.range(of: "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$", options: .regularExpression) != nil
    }
    private static func minutes(_ text: String) -> Int? {
        if text.isEmpty { return 0 }
        guard let number = JSInteger.number(text), let result = Int(VisionFormat.plain(number)) else { return nil }
        return result
    }
    public func createPayload() throws -> TaxValue {
        guard let interval, let cooldown, invalidSchedule == nil else {
            throw APIError.invalidRequest("Invalid monitor schedule")
        }
        var value: [String: TaxValue] = [
            "kind": .string(kind.rawValue), "title": .string(title.trimmingCharacters(in: .whitespacesAndNewlines)),
            "intervalMinutes": .number(Decimal(interval)), "cooldownMinutes": .number(Decimal(cooldown)),
        ]
        if kind == .threshold {
            value["savedAnalysisId"] = .string(savedAnalysisId?.rawValue ?? "")
            value["fieldId"] = .string(fieldId)
            value["operator"] = .string(self.operator.rawValue)
            value["threshold"] = .string(threshold)
        } else {
            value["dossierId"] = .string(dossierId?.rawValue ?? "")
        }
        return .object(value)
    }
    public func editPayload() throws -> TaxValue {
        guard let interval, let cooldown, invalidSchedule == nil else {
            throw APIError.invalidRequest("Invalid monitor schedule")
        }
        var value: [String: TaxValue] = [
            "title": .string(title), "enabled": .bool(enabled),
            "intervalMinutes": .number(Decimal(interval)), "cooldownMinutes": .number(Decimal(cooldown)),
        ]
        if kind == .threshold {
            value["fieldId"] = .string(fieldId)
            value["operator"] = .string(self.operator.rawValue)
            value["threshold"] = .string(threshold)
        }
        return .object(value)
    }
}

public enum AnalysisMonitorTargets {
    public static func numericColumns(_ analysis: AnalysisSaved) -> [String] {
        guard let raw = analysis.lastResultRaw, let rows = raw["rows"]?.arrayValue, rows.count == 1,
            let row = rows.first?.objectValue, let columns = raw["columns"]?.arrayValue
        else { return [] }
        return columns.compactMap { column in
            guard let id = column["id"]?.stringValue, let type = column["type"]?.stringValue,
                ["decimal", "number", "integer", "currency"].contains(type), let value = row[id]
            else { return nil }
            switch value {
            case .number: return id
            case .string(let value):
                return value.range(of: "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$", options: .regularExpression) != nil
                    ? id : nil
            default: return nil
            }
        }
    }
    public static func eligible(_ analysis: AnalysisSaved) -> Bool {
        analysis.refreshMode == .live && !numericColumns(analysis).isEmpty
    }
}
