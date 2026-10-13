import Foundation

public enum NativeOnboardingStep: String, Codable, CaseIterable, Sendable {
    case welcome, overview, categories, bank
    case importData = "import"
    case tour, backup
}

/// The exact v1 local draft. Uploaded bytes and transient requests never belong here.
public struct NativeOnboardingDraft: Equatable, Sendable, Codable {
    public static let storageKey = "vision.onboarding.draft.v1"
    public var version = 1
    public var step: NativeOnboardingStep = .welcome
    public var selectedBank = ""
    public var selectedCategoryIndexes: [Int]
    public var categoriesCreated = false
    public var importResult: Counts?
    public var reviewBatch: Review?
    public struct Counts: Codable, Equatable, Sendable {
        public var imported: Int
        public var duplicates: Int
        public init(imported: Int, duplicates: Int) { self.imported = imported; self.duplicates = duplicates }
    }
    public struct Review: Codable, Equatable, Sendable {
        public var batchId: Int
        public var rows: Int
        public init(batchId: Int, rows: Int) { self.batchId = batchId; self.rows = rows }
    }
    public init(categoryCount: Int = NativeOnboardingPreset.categories.count) {
        selectedCategoryIndexes = Array(0..<max(0, categoryCount))
    }
    /// Strict source validation, safe integers, then de-duplication and stale-index filtering.
    public static func read(_ data: Data?, categoryCount: Int = NativeOnboardingPreset.categories.count) -> Self {
        let fallback = Self(categoryCount: categoryCount)
        guard let data, let raw = try? JSONDecoder().decode(TaxValue.self, from: data), valid(raw),
            var draft = try? JSONDecoder().decode(Self.self, from: data)
        else { return fallback }
        draft.selectedBank = draft.selectedBank.trimmingCharacters(in: .whitespacesAndNewlines)
        var seen: Set<Int> = []
        draft.selectedCategoryIndexes = draft.selectedCategoryIndexes.filter { $0 < categoryCount && seen.insert($0).inserted }
        return draft
    }
    public func encoded() throws -> Data {
        var copy = self
        copy.selectedBank = copy.selectedBank.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.selectedCategoryIndexes.sort()
        // Codable's nil defaults omit keys, while the source v1 schema requires explicit nulls.
        var raw = try JSONDecoder().decode(TaxValue.self, from: JSONEncoder().encode(copy)).objectValue!
        if copy.importResult == nil { raw["importResult"] = .null }
        if copy.reviewBatch == nil { raw["reviewBatch"] = .null }
        let value = TaxValue.object(raw)
        guard Self.valid(value) else { throw APIError.invalidRequest("Invalid onboarding draft") }
        return try JSONEncoder().encode(value)
    }
    private static func valid(_ value: TaxValue) -> Bool {
        guard let object = value.objectValue,
            Set(object.keys) == ["version", "step", "selectedBank", "selectedCategoryIndexes", "categoriesCreated", "importResult", "reviewBatch"],
            value["version"] == .number(1), let step = value["step"]?.stringValue, NativeOnboardingStep(rawValue: step) != nil,
            let bank = value["selectedBank"]?.stringValue, bank.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count <= 128,
            let indexes = value["selectedCategoryIndexes"]?.arrayValue, indexes.count <= 100,
            indexes.allSatisfy({ safeCount($0) != nil }), value["categoriesCreated"]?.boolValue != nil
        else { return false }
        if let result = value["importResult"], result != .null {
            guard let fields = result.objectValue, Set(fields.keys) == ["imported", "duplicates"],
                safeCount(result["imported"]) != nil, safeCount(result["duplicates"]) != nil
            else { return false }
        }
        if let review = value["reviewBatch"], review != .null {
            guard let fields = review.objectValue, Set(fields.keys) == ["batchId", "rows"],
                let id = safeCount(review["batchId"]), id > 0, safeCount(review["rows"]) != nil
            else { return false }
        }
        return true
    }
    static func safeCount(_ value: TaxValue?) -> Int? {
        guard case .number(let number) = value, number >= 0, number <= 9_007_199_254_740_991 else { return nil }
        let count = NSDecimalNumber(decimal: number).int64Value
        return Decimal(count) == number ? Int(exactly: count) : nil
    }
}

@MainActor public protocol NativeOnboardingDraftStore {
    func read() async throws -> Data?
    func write(_ data: Data) async throws
    func remove() async throws
}
@MainActor public struct NativeOnboardingDraftCallbacks: NativeOnboardingDraftStore {
    private let reader: () async throws -> Data?
    private let writer: (Data) async throws -> Void
    private let remover: () async throws -> Void
    public init(read: @escaping () async throws -> Data?, write: @escaping (Data) async throws -> Void, remove: @escaping () async throws -> Void) {
        reader = read; writer = write; remover = remove
    }
    public func read() async throws -> Data? { try await reader() }
    public func write(_ data: Data) async throws { try await writer(data) }
    public func remove() async throws { try await remover() }
}

public struct NativeOnboardingCategory: Equatable, Sendable {
    public let general: String
    public let detail: String
    public let detailKey: String
    public let emoji: String
}
public enum NativeOnboardingPreset {
    public static let categories: [NativeOnboardingCategory] = [
        .init(general: "FOOD", detail: "Groceries", detailKey: "onboarding.cat.groceries", emoji: "🛒"),
        .init(general: "FOOD", detail: "Restaurants", detailKey: "onboarding.cat.restaurants", emoji: "🍽️"),
        .init(general: "HOUSING", detail: "Rent", detailKey: "onboarding.cat.rent", emoji: "🏠"),
        .init(general: "HOUSING", detail: "Utilities", detailKey: "onboarding.cat.utilities", emoji: "💡"),
        .init(general: "TRANSPORT", detail: "Fuel", detailKey: "onboarding.cat.fuel", emoji: "⛽"),
        .init(general: "TRANSPORT", detail: "Public Transport", detailKey: "onboarding.cat.publicTransport", emoji: "🚌"),
        .init(general: "ENTERTAINMENT", detail: "Subscriptions", detailKey: "onboarding.cat.subscriptions", emoji: "📺"),
        .init(general: "ENTERTAINMENT", detail: "Hobbies", detailKey: "onboarding.cat.hobbies", emoji: "🎮"),
        .init(general: "HEALTH", detail: "Insurance", detailKey: "onboarding.cat.insurance", emoji: "🏥"),
        .init(general: "HEALTH", detail: "Pharmacy", detailKey: "onboarding.cat.pharmacy", emoji: "💊"),
        .init(general: "INCOME", detail: "Salary", detailKey: "onboarding.cat.salary", emoji: "💰"),
        .init(general: "INCOME", detail: "Freelance", detailKey: "onboarding.cat.freelance", emoji: "💻"),
        .init(general: "SAVINGS", detail: "Investments", detailKey: "onboarding.cat.investments", emoji: "📈"),
        .init(general: "PERSONAL", detail: "Clothing", detailKey: "onboarding.cat.clothing", emoji: "👕"),
        .init(general: "PERSONAL", detail: "Gifts", detailKey: "onboarding.cat.gifts", emoji: "🎁"),
    ]
}
