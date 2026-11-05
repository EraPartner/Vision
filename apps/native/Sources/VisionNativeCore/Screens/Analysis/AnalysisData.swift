import Foundation

public typealias AnalysisValue = TaxValue
public typealias AnalysisRow = [String: AnalysisValue]
public enum AnalysisWorkspace: String, Codable, CaseIterable, Sendable {
    case budgeting, portfolio, research
    case crossWorkspace = "cross-workspace"
}
public enum AnalysisMode: String, Codable, CaseIterable, Sendable { case visual, sql }

public struct AnalysisUnit: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let kind: String
    public let currency: String?
    public let currencyColumn: String?
    public let instrumentColumn: String?
    public let instrumentId: String?
    public let percentageBasis: String?
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        self.raw = raw
        kind = try AnalysisDecode.string(raw["kind"])
        currency = try AnalysisDecode.optionalString(raw["currency"])
        currencyColumn = try AnalysisDecode.optionalString(raw["currencyColumn"])
        instrumentColumn = try AnalysisDecode.optionalString(raw["instrumentColumn"])
        instrumentId = try AnalysisDecode.optionalString(raw["instrumentId"])
        percentageBasis = try AnalysisDecode.optionalString(raw["percentageBasis"])
    }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AnalysisColumn: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: String
    public let label: String?
    public let type: String
    public let nullable: Bool?
    public let unit: AnalysisUnit?
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        self.raw = raw
        id = try AnalysisDecode.string(raw["id"])
        type = try AnalysisDecode.string(raw["type"])
        label = try AnalysisDecode.optionalString(raw["label"])
        nullable = try AnalysisDecode.optionalBool(raw["nullable"])
        unit = try raw["unit"].map { try $0.decode(AnalysisUnit.self) }
    }
    public init(id: String, type: String, label: String? = nil, nullable: Bool? = nil, unit: AnalysisUnit? = nil) {
        self.id = id
        self.type = type
        self.label = label
        self.nullable = nullable
        self.unit = unit
        var raw: TaxValue = .object(["id": .string(id), "type": .string(type)])
        if let label { raw["label"] = .string(label) }
        if let nullable { raw["nullable"] = .bool(nullable) }
        if let unit { raw["unit"] = unit.raw }
        self.raw = raw
    }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AnalysisDataset: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let relation: String
    public let fields: [AnalysisColumn]
    public let measures: [AnalysisColumn]
    public let joins: [Join]
    public struct Join: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let datasetId: String
        public let cardinality: String
        public let duplicationSafe: Bool
    }
}
public struct AnalysisCatalog: Decodable, Equatable, Sendable {
    public let version: Int
    public let datasets: [AnalysisDataset]
}

public struct AnalysisFilter: Codable, Equatable, Sendable {
    public var fieldId: String
    public var `operator`: String
    public var value: TaxValue?
    public init(fieldId: String, operator: String = "eq", value: TaxValue? = nil) {
        self.fieldId = fieldId
        self.operator = `operator`
        self.value = value
    }
}
public struct AnalysisOrder: Codable, Equatable, Sendable {
    public var id: String
    public var direction: String
    public init(id: String, direction: String = "asc") {
        self.id = id
        self.direction = direction
    }
}
public struct AnalysisPlan: Codable, Equatable, Sendable {
    public var datasetId: String
    public var fields: [String]
    public var filters: [AnalysisFilter]
    public var groups: [String]
    public var measures: [String]
    public var joins: [String]
    public var orderBy: [AnalysisOrder]
    public var limit: Int
    public var reportingCurrency: String?
    public var from: String?
    public var to: String?
    public var symbol: String?
    public var range: String?
    public var costBasisMethod: String?
    public init(
        datasetId: String = "cash-flows", fields: [String] = [], filters: [AnalysisFilter] = [], groups: [String] = [],
        measures: [String] = [], joins: [String] = [], orderBy: [AnalysisOrder] = [], limit: Int = 500
    ) {
        self.datasetId = datasetId
        self.fields = fields
        self.filters = filters
        self.groups = groups
        self.measures = measures
        self.joins = joins
        self.orderBy = orderBy
        self.limit = limit
    }
    public static var example: Self {
        .init(
            fields: ["month", "category_general", "currency"],
            filters: [
                .init(fieldId: "is_transfer", value: .bool(false)), .init(fieldId: "is_active", value: .bool(true)),
            ], groups: ["month", "category_general", "currency"], measures: ["sum_spending"],
            orderBy: [.init(id: "month")])
    }
}
public struct AnalysisTemplate: Identifiable, Sendable {
    public let id: String
    public let workspace: AnalysisWorkspace
    public let titleKey: String
    public let descriptionKey: String
    public let plan: AnalysisPlan
    public static let all: [Self] = [
        .init(
            id: "monthly-category-spending", workspace: .budgeting, titleKey: "analysis.template.monthlyCategory.title",
            descriptionKey: "analysis.template.monthlyCategory.description", plan: .example),
        .init(
            id: "monthly-cash-flow", workspace: .budgeting, titleKey: "analysis.template.cashFlow.title",
            descriptionKey: "analysis.template.cashFlow.description",
            plan: .init(
                fields: ["month", "currency"],
                filters: [
                    .init(fieldId: "is_transfer", value: .bool(false)), .init(fieldId: "is_active", value: .bool(true)),
                ], groups: ["month", "currency"], measures: ["sum_spending", "sum_positive_flow", "sum_amount"],
                orderBy: [.init(id: "month")])),
        .init(
            id: "portfolio-activity", workspace: .portfolio, titleKey: "analysis.template.portfolioActivity.title",
            descriptionKey: "analysis.template.portfolioActivity.description",
            plan: .init(
                datasetId: "holdings", fields: ["month", "asset_class", "currency"],
                groups: ["month", "asset_class", "currency"], measures: ["count", "sum_amount"],
                orderBy: [.init(id: "month")])),
    ]
}
public struct AnalysisWindow: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let kind: String
    public let offset: Int?
    public let limit: Int?
    public let hasMore: Bool?
    public let returnedRows: Int
    public let enforcedLimit: Int?
    public let reason: String?
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        self.raw = raw
        kind = try AnalysisDecode.string(raw["kind"])
        returnedRows = try AnalysisDecode.count(raw["returnedRows"])
        guard ["page", "truncated"].contains(kind) else { throw AnalysisDecode.failure("Unknown analysis window") }
        offset = kind == "page" ? try AnalysisDecode.count(raw["offset"]) : nil
        limit = kind == "page" ? try AnalysisDecode.count(raw["limit"]) : nil
        hasMore = kind == "page" ? try AnalysisDecode.bool(raw["hasMore"]) : nil
        enforcedLimit = kind == "truncated" ? try AnalysisDecode.count(raw["enforcedLimit"]) : nil
        reason = kind == "truncated" ? try AnalysisDecode.string(raw["reason"]) : nil
    }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AnalysisResult: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let requestId: String?
    public let startedAt: String
    public let completedAt: String
    public let executor: String
    public let rows: [AnalysisRow]
    public let columns: [AnalysisColumn]
    public let declaredColumns: [AnalysisColumn]?
    public let window: AnalysisWindow
    public let byteLength: Int
    public let generatedSql: String
    public let complete: Bool?
    public let coverage: TaxValue?
    public let provenance: TaxValue?
    public let formulaErrors: [TaxValue]?
    public let formulaSummaries: TaxValue?
    public let transformationErrors: [TaxValue]?
    public let transformationCoverage: [TaxValue]?
    public let preparationLineage: [TaxValue]?
    public let sourceResult: TaxValue?
    public var effectiveColumns: [AnalysisColumn] { declaredColumns?.isEmpty == false ? declaredColumns! : columns }
    public var isComplete: Bool { AnalysisPresentation.isComplete(raw) }
    public var sourceResultData: AnalysisResult? { try? sourceResult?.decode(AnalysisResult.self) }
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        self.raw = raw
        requestId = try AnalysisDecode.optionalString(raw["requestId"])
        startedAt = try AnalysisDecode.string(raw["startedAt"])
        completedAt = try AnalysisDecode.string(raw["completedAt"])
        executor = try AnalysisDecode.string(raw["executor"])
        rows = try AnalysisDecode.required(raw["rows"], [AnalysisRow].self)
        columns = try AnalysisDecode.required(raw["columns"], [AnalysisColumn].self)
        declaredColumns = try raw["declaredColumns"].map { try $0.decode([AnalysisColumn].self) }
        window = try AnalysisDecode.required(raw["window"], AnalysisWindow.self)
        byteLength = try AnalysisDecode.count(raw["byteLength"])
        generatedSql = try AnalysisDecode.string(raw["generatedSql"])
        complete = try AnalysisDecode.optionalBool(raw["complete"])
        coverage = raw["coverage"]
        provenance = raw["provenance"]
        formulaErrors = try raw["formulaErrors"].map { try $0.decode([TaxValue].self) }
        formulaSummaries = raw["formulaSummaries"]
        transformationErrors = try raw["transformationErrors"].map { try $0.decode([TaxValue].self) }
        transformationCoverage = try raw["transformationCoverage"].map { try $0.decode([TaxValue].self) }
        preparationLineage = try raw["preparationLineage"].map { try $0.decode([TaxValue].self) }
        sourceResult = raw["sourceResult"]
    }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AnalysisPivotConfig: Codable, Equatable, Sendable {
    public var rows: [String]
    public var columns: [String]
    public var values: [String]
    public var filters: [AnalysisFilter]
    public init(
        rows: [String] = ["category_general"], columns: [String] = ["month"], values: [String] = ["sum_spending"],
        filters: [AnalysisFilter] = []
    ) {
        self.rows = rows
        self.columns = columns
        self.values = values
        self.filters = filters
    }
}
public struct AnalysisPivotResult: Decodable, Equatable, Sendable {
    public let levels: [Level]
    public let partitions: [String]
    public let config: AnalysisPivotConfig
    public let coverage: Coverage
    public struct Level: Decodable, Equatable, Sendable {
        public let rowDepth: Int
        public let columnDepth: Int
        public let groups: [String]
        public let rows: [AnalysisRow]
        public let columns: [AnalysisColumn]
    }
    public struct Coverage: Decodable, Equatable, Sendable {
        public let complete: Bool
        public let rows: Int
        public let financialComplete: Bool?
        public let unavailableRows: Int?
    }
}
public struct AnalysisExtensionOutput: Decodable, Equatable, Sendable {
    public let raw: TaxValue
    public let rows: [AnalysisRow]?
    public let columns: [AnalysisColumn]?
    public let complete: Bool?
    public let coverage: TaxValue?
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        guard raw.objectValue != nil else { throw AnalysisDecode.failure("Invalid extension response") }
        self.raw = raw
        rows = try raw["rows"].map { try $0.decode([AnalysisRow].self) }
        columns = try raw["columns"].map { try $0.decode([AnalysisColumn].self) }
        complete = try AnalysisDecode.optionalBool(raw["complete"])
        coverage = raw["coverage"]
    }
}
public struct AnalysisSaved: Decodable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: SavedAnalysisID
    public let definitionId: String
    public let name: String
    public let workspace: AnalysisWorkspace
    public let version: Int
    public let refreshMode: AnalysisRefreshMode
    public let parameters: TaxValue
    public let charts: [TaxValue]
    public let sourceReferences: [TaxValue]
    public let refreshStatus: AnalysisRefreshStatus
    public let lastSuccessfulRunId: AnalysisRunID?
    public let lastError: TaxValue?
    public let definition: TaxValue
    public let lastResult: AnalysisResult?
    public let lastResultRaw: TaxValue?
    public let createdAt: String
    public let updatedAt: String
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        self.raw = raw
        id = SavedAnalysisID(try AnalysisDecode.string(raw["id"]))
        definitionId = try AnalysisDecode.string(raw["definitionId"])
        name = try AnalysisDecode.string(raw["name"])
        workspace = try AnalysisDecode.required(raw["workspace"], AnalysisWorkspace.self)
        version = try AnalysisDecode.count(raw["version"])
        guard version > 0 else { throw AnalysisDecode.failure("Invalid analysis definition version") }
        refreshMode = AnalysisRefreshMode(rawValue: try AnalysisDecode.string(raw["refreshMode"]))
        refreshStatus = AnalysisRefreshStatus(rawValue: try AnalysisDecode.string(raw["refreshStatus"]))
        guard AnalysisRefreshMode.allCases.contains(refreshMode),
            AnalysisRefreshStatus.allCases.contains(refreshStatus)
        else { throw AnalysisDecode.failure("Invalid saved analysis status") }
        parameters = try AnalysisDecode.object(raw["parameters"])
        definition = try AnalysisDecode.object(raw["definition"])
        charts = try AnalysisDecode.required(raw["charts"], [TaxValue].self)
        sourceReferences = try AnalysisDecode.required(raw["sourceReferences"], [TaxValue].self)
        guard raw["lastResult"] != nil, raw["lastError"] != nil, raw["lastSuccessfulRunId"] != nil else {
            throw AnalysisDecode.failure("Missing saved result metadata")
        }
        lastSuccessfulRunId = try AnalysisDecode.optionalString(raw["lastSuccessfulRunId"]).map { AnalysisRunID($0) }
        lastError = raw["lastError"] == .null ? nil : raw["lastError"]
        lastResultRaw = raw["lastResult"] == .null ? nil : raw["lastResult"]
        lastResult = try? lastResultRaw?.decode(AnalysisResult.self)
        createdAt = try AnalysisDecode.string(raw["createdAt"])
        updatedAt = try AnalysisDecode.string(raw["updatedAt"])
    }
}
public struct AnalysisSavedVersion: Decodable, Equatable, Sendable {
    public let version: Int
    public let definition: TaxValue
    public let state: TaxValue?
    public let createdAt: String
}
public struct AnalysisEditProposal: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let savedAnalysisId: SavedAnalysisID
    public let baseVersion: Int
    public let rationale: String
    public let operations: [Operation]
    public struct Operation: Codable, Equatable, Sendable {
        public let op: String
        public let path: String
        public let value: TaxValue?
    }
}
public struct AnalysisProposalPreview: Decodable, Equatable, Sendable {
    public let proposal: AnalysisEditProposal
    public let before: TaxValue
    public let after: TaxValue
    public let baseVersion: Int
}
public struct AnalysisFeedback: Equatable, Sendable {
    public let error: Bool
    public let message: String
    public init(error: Bool, message: String) {
        self.error = error
        self.message = message
    }
}
public struct AnalysisResultInputs: Equatable, Sendable {
    public var formulasJson: String
    public var assumptionsJson: String
    public var assumptionValuesJson: String
    public var workbench: TaxValue
    public var scenarioModel: TaxValue
}
public struct AnalysisExportContext: Codable, Equatable, Sendable {
    public var name: String
    public var timezone: String
    public var workspace: AnalysisWorkspace
    public var definitionId: String?
    public var definitionVersion: Int?
    public var datasetIds: [String]
    public var sourceReferences: [String]
}

public enum AnalysisDecode {
    public static func failure(_ message: String) -> APIError {
        .contract(.init(endpoint: "analysis", issues: [message]))
    }
    static func string(_ value: TaxValue?) throws -> String {
        guard let string = value?.stringValue else { throw failure("Expected analysis string") }
        return string
    }
    static func optionalString(_ value: TaxValue?) throws -> String? {
        guard let value, value != .null else { return nil }
        return try string(value)
    }
    static func bool(_ value: TaxValue?) throws -> Bool {
        guard let bool = value?.boolValue else { throw failure("Expected analysis boolean") }
        return bool
    }
    static func optionalBool(_ value: TaxValue?) throws -> Bool? {
        guard let value, value != .null else { return nil }
        return try bool(value)
    }
    static func count(_ value: TaxValue?) throws -> Int {
        guard let number = value?.decimalValue, number >= 0, number <= 9_007_199_254_740_991 else {
            throw failure("Invalid analysis count")
        }
        let integer = NSDecimalNumber(decimal: number).intValue
        guard Decimal(integer) == number else { throw failure("Invalid analysis count") }
        return integer
    }
    static func required<T: Decodable>(_ value: TaxValue?, _ type: T.Type) throws -> T {
        guard let value else { throw failure("Missing analysis data") }
        return try value.decode(type)
    }
    static func object(_ value: TaxValue?) throws -> TaxValue {
        guard let value, value.objectValue != nil else { throw failure("Expected analysis object") }
        return value
    }
}
