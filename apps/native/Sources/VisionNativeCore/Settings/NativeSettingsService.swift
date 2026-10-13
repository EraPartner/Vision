import Foundation

/// Raw values and opaque compare-and-swap baselines are deliberately separate from display defaults.
public struct NativeSettingsRecord: Codable, Equatable, Sendable {
    public let key: String
    public let value: TaxValue
    public let expected: TaxValue
    public init(key: String, value: TaxValue, expected: TaxValue) {
        self.key = key
        self.value = value
        self.expected = expected
    }
    private enum CodingKeys: String, CodingKey { case key, value, expected }
    public init(from decoder: any Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        key = try fields.decode(String.self, forKey: .key)
        value = try fields.decode(TaxValue.self, forKey: .value)
        expected = try fields.decode(TaxValue.self, forKey: .expected)
        guard expected["exists"]?.boolValue != nil else {
            throw DecodingError.dataCorruptedError(
                forKey: .expected, in: fields, debugDescription: "Setting baseline requires boolean exists")
        }
    }
}
public struct NativeSettingsSnapshot: Codable, Equatable, Sendable {
    public let settings: [String: TaxValue]
    public let expected: [String: TaxValue]
    public init(settings: [String: TaxValue], expected: [String: TaxValue]) {
        self.settings = settings
        self.expected = expected
    }
    private enum CodingKeys: String, CodingKey { case settings, expected }
    public init(from decoder: any Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        settings = try fields.decode([String: TaxValue].self, forKey: .settings)
        expected = try fields.decode([String: TaxValue].self, forKey: .expected)
        guard expected.values.allSatisfy({ $0["exists"]?.boolValue != nil }) else {
            throw DecodingError.dataCorruptedError(
                forKey: .expected, in: fields, debugDescription: "Setting baselines require boolean exists")
        }
    }
}
public protocol NativeSettingsService: Sendable {
    func readNativeSettings() async throws -> NativeSettingsSnapshot
    func readNativeSetting(_ key: String) async throws -> NativeSettingsRecord
    func saveNativeSetting(_ key: String, value: TaxValue, expected: TaxValue) async throws -> NativeSettingsRecord
    func nativeSettingsCategories() async throws -> [OpenAPI.CategoryNode]
    func nativeSettingsRecipients() async throws -> [OpenAPI.Recipient]
}
extension APIClient: NativeSettingsService {
    public func readNativeSettings() async throws -> NativeSettingsSnapshot {
        try await send(
            ResearchRequest<OpenAPIOperations.GetSettings, NativeSettingsSnapshot>(
                OpenAPIOperations.GetSettings.self, query: [.init(name: "withBaselines", value: "true")]))
    }
    public func readNativeSetting(_ key: String) async throws -> NativeSettingsRecord {
        try await send(
            ResearchRequest<OpenAPIOperations.GetSetting, NativeSettingsRecord>(
                OpenAPIOperations.GetSetting.self, parameters: ["key": key]))
    }
    public func saveNativeSetting(_ key: String, value: TaxValue, expected: TaxValue) async throws
        -> NativeSettingsRecord
    {
        try await send(
            ResearchRequest<OpenAPIOperations.SaveSetting, NativeSettingsRecord>(
                OpenAPIOperations.SaveSetting.self, parameters: ["key": key],
                body: .object(["value": value, "expected": expected])), retries: 0)
    }
    public func nativeSettingsCategories() async throws -> [OpenAPI.CategoryNode] {
        try await send(CategoryTreeRequest()).items
    }
    public func nativeSettingsRecipients() async throws -> [OpenAPI.Recipient] {
        try await send(OpenAPIOperations.GetRecipients(limit: 1000)).items
    }
}

/// Mirrors lib/api/settings.ts: first-read authority, per-key serialization and sticky failed queues.
public actor NativeSettingsPersistence {
    private let service: any NativeSettingsService
    private var baselines: [String: TaxValue] = [:]
    private var allRead = false
    private var suspended = false
    private var retired = false
    private var tails: [String: Task<NativeSettingsRecord, Error>] = [:]
    public init(service: any NativeSettingsService) { self.service = service }
    public func readAll() async throws -> NativeSettingsSnapshot {
        guard !retired, !suspended else { throw CancellationError() }
        let snapshot = try await service.readNativeSettings()
        guard !retired else { throw CancellationError() }
        if !allRead {
            for (key, baseline) in snapshot.expected where baselines[key] == nil { baselines[key] = baseline }
            allRead = true
        }
        return snapshot
    }
    public func read(_ key: String) async throws -> NativeSettingsRecord {
        guard !retired, !suspended else { throw CancellationError() }
        let record = try await service.readNativeSetting(key)
        guard !retired else { throw CancellationError() }
        if baselines[key] == nil { baselines[key] = record.expected }
        return record
    }
    public func baseline(_ key: String) -> TaxValue? {
        baselines[key] ?? (allRead ? .object(["exists": .bool(false)]) : nil)
    }
    public func save(_ key: String, value: TaxValue) async throws -> NativeSettingsRecord {
        guard !suspended, !retired else { throw CancellationError() }
        let previous = tails[key]
        let task = Task {
            _ = try await previous?.value
            return try await self.write(key, value: value)
        }
        tails[key] = task
        return try await task.value
    }
    /// Stop accepting writes, then settle every already accepted per-key queue before a database switch.
    public func suspendForRestore() async {
        suspended = true
        for task in Array(tails.values) { _ = try? await task.value }
    }
    public func resumeAfterFailedRestore() { if !retired { suspended = false } }
    public func retireForReload() {
        retired = true
        suspended = true
    }
    private func write(_ key: String, value: TaxValue) async throws -> NativeSettingsRecord {
        guard !retired else { throw CancellationError() }
        guard let expected = baseline(key) else {
            throw SettingsWriteError("Settings were not loaded. Reload before saving.")
        }
        let result = try await service.saveNativeSetting(key, value: value, expected: expected)
        guard !retired else { throw CancellationError() }
        baselines[key] = .object(["exists": .bool(true), "value": result.value])
        return result
    }
}
