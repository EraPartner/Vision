import Foundation

public protocol NativeOnboardingService: Sendable {
    func onboardingAdapters() async throws -> [ImportAdapter]
    func onboardingCreateCategory(_ category: NativeOnboardingCategory) async throws
    func onboardingImport(file: ImportFile, bank: String) async throws -> NativeOnboardingImportReceipt
}
/// Reuses the existing import outcome decoder and preserves the nonstreaming review counts.
public struct NativeOnboardingImportReceipt: Decodable, Sendable, Equatable {
    public let outcome: ImportOutcome
    public let reviewRows: Int
    public init(outcome: ImportOutcome, reviewRows: Int = 0) {
        self.outcome = outcome
        self.reviewRows = reviewRows
    }
    public init(from decoder: any Decoder) throws {
        outcome = try ImportCsvResponse(from: decoder).outcome
        let raw = try TaxValue(from: decoder)
        let counts = raw["match_source_counts"]?.objectValue ?? [:]
        var rows = 0
        for value in counts.values {
            if value == .null { continue }
            guard let count = NativeOnboardingDraft.safeCount(value), rows <= 9_007_199_254_740_991 - count else {
                throw APIError.invalidRequest("Invalid onboarding import count")
            }
            rows += count
        }
        reviewRows = rows
    }
}
extension APIClient: NativeOnboardingService {
    public func onboardingAdapters() async throws -> [ImportAdapter] { try await supportedAdapters() }
    public func onboardingCreateCategory(_ category: NativeOnboardingCategory) async throws {
        _ = try await send(NativeOnboardingCategoryRequest(category: category))
    }
    public func onboardingImport(file: ImportFile, bank: String) async throws -> NativeOnboardingImportReceipt {
        try await send(NativeOnboardingImportRequest(file: file, bank: bank))
    }
}
public struct NativeOnboardingCategoryRequest: APIOperation {
    public typealias Response = TaxValue
    public static let operationId = "createCategory"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/categories"
    public var path: String { Self.pathTemplate }
    public let category: NativeOnboardingCategory
    public init(category: NativeOnboardingCategory) { self.category = category }
    public func encodedBody() throws -> Data? {
        try JSONEncoder().encode(
            TaxValue.object(["general": .string(category.general), "detail": .string(category.detail)]))
    }
}
public struct NativeOnboardingImportRequest: APIOperation {
    public typealias Response = NativeOnboardingImportReceipt
    public static let operationId = "importCsv"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/import/csv"
    public let form: MultipartFormData
    public var path: String { Self.pathTemplate }
    public var contentType: String { form.contentType }
    public init(file: ImportFile, bank: String, boundary: String? = nil) {
        var form = boundary.map { MultipartFormData(boundary: $0) } ?? MultipartFormData()
        form.append(
            file: "file", filename: file.name, contentType: file.mimeType ?? "application/octet-stream", data: file.data
        )
        form.append(name: "bank_name", value: bank)
        self.form = form
    }
    public func encodedBody() throws -> Data? { form.data }
}
