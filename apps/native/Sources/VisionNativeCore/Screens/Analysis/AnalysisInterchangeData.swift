import Foundation

public struct AnalysisInterchangeFile: Equatable, Sendable {
    public let name: String
    public let data: Data
    public init(name: String, data: Data) {
        self.name = name
        self.data = data
    }
}
public struct AnalysisExportFile: Equatable, Sendable {
    public let filename: String
    public let data: Data
    public let contentType: String
    public init(filename: String, data: Data, contentType: String) {
        self.filename = filename
        self.data = data
        self.contentType = contentType
    }
}
public struct AnalysisAttachmentColumn: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let type: String
    public let raw: TaxValue
}
/// Imported values are opaque scalar values: numeric-looking strings remain strings.
public struct AnalysisAttachment: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: String
    public let fileName: String
    public let importedAt: String
    public let sha256: String
    public let columns: [AnalysisAttachmentColumn]
    public let rows: [[String: TaxValue]]
    public init(raw: TaxValue) throws {
        guard let id = raw["id"]?.stringValue, !id.isEmpty,
            let name = raw["fileName"]?.stringValue, let date = raw["importedAt"]?.stringValue,
            let hash = raw["sha256"]?.stringValue,
            hash.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil,
            let columnValues = raw["columns"]?.arrayValue, (1...32).contains(columnValues.count),
            let rowValues = raw["rows"]?.arrayValue, rowValues.count <= 1000
        else { throw Self.invalid() }
        self.raw = raw
        self.id = id
        fileName = name
        importedAt = date
        sha256 = hash
        columns = try columnValues.map { column in
            guard let id = column["id"]?.stringValue, !id.isEmpty, let label = column["label"]?.stringValue,
                let type = column["type"]?.stringValue,
                ["string", "integer", "decimal", "boolean", "date"].contains(type)
            else { throw Self.invalid() }
            return AnalysisAttachmentColumn(id: id, label: label, type: type, raw: column)
        }
        guard Set(columns.map(\.id)).count == columns.count else { throw Self.invalid() }
        rows = try rowValues.map { value in
            guard let row = value.objectValue,
                row.values.allSatisfy({ cell in
                    switch cell {
                    case .null, .string, .number, .bool: true
                    default: false
                    }
                })
            else { throw Self.invalid() }
            return row
        }
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
    static func invalid() -> APIError {
        .contract(.init(endpoint: "/api/analysis/interchange/import", issues: ["Unverified scenario attachment"]))
    }
}
