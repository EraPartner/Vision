import Foundation

public struct AnalysisSavedSource: Equatable, Sendable {
    public let mode: AnalysisMode
    public let plan: AnalysisPlan?
    public let sql: String?
    public let datasetIds: [String]
    public let visualOrigin: AnalysisPlan?
    public init(saved: AnalysisSaved) throws {
        let source = saved.definition["source"] ?? .object([:])
        if source["kind"] == .string("visual-plan") {
            mode = .visual
            plan = try Self.visualPlan(source)
            sql = nil
            datasetIds = []
            visualOrigin = nil
        } else {
            mode = .sql
            plan = nil
            sql = source["text"]?.stringValue ?? ""
            datasetIds = (source["datasetIds"]?.arrayValue ?? []).compactMap(\.stringValue)
            visualOrigin = try source["visualOrigin"].map { try Self.visualPlan($0) }
        }
    }
    public static func visualPlan(_ source: TaxValue) throws -> AnalysisPlan {
        guard let datasetId = source["datasetId"]?.stringValue else {
            throw AnalysisDecode.failure("Saved visual source has no dataset")
        }
        let select = source["select"]?.arrayValue ?? []
        let fields = select.filter { $0["source"]?["kind"] == .string("field") }.compactMap { $0["id"]?.stringValue }
        let measures = select.filter { $0["source"]?["kind"] == .string("metric") }.compactMap { $0["id"]?.stringValue }
        let filters = (source["filters"]?.arrayValue ?? []).map { filter in
            let left = filter["left"]
            let column = left?["columnId"]?.stringValue ?? "undefined"
            return AnalysisFilter(
                fieldId: left?["datasetId"] == .string("accounts") ? "account." + column : column,
                operator: filter["operator"]?.stringValue ?? "undefined", value: filter["right"]?["value"])
        }
        let order = (source["orderBy"]?.arrayValue ?? []).map {
            AnalysisOrder(
                id: $0["outputId"]?.stringValue ?? "undefined", direction: $0["direction"]?.stringValue ?? "asc")
        }
        let limit = (try? AnalysisDecode.count(source["limit"])) ?? 500
        return .init(
            datasetId: datasetId, fields: fields, filters: filters,
            groups: (source["groupBy"]?.arrayValue ?? []).compactMap(\.stringValue), measures: measures,
            joins: (source["joins"]?.arrayValue ?? []).compactMap { $0["pathId"]?.stringValue }, orderBy: order,
            limit: limit == 0 ? 500 : limit)
    }
}
