import Foundation

@MainActor public protocol ResearchChartLayoutStore {
    /// nil denotes a successful read of a missing key. Transport failures throw.
    func read() async throws -> Data?
    func write(_ data: Data) async -> Bool
}
@MainActor public final class ResearchChartLayoutMemoryStore: ResearchChartLayoutStore {
    public var data: Data?
    public init(data: Data? = nil) { self.data = data }
    public func read() async throws -> Data? { data }
    public func write(_ data: Data) async -> Bool {
        self.data = data
        return true
    }
}
@MainActor public final class ResearchChartLayoutClosureStore: ResearchChartLayoutStore {
    private let reader: @MainActor () async throws -> Data?
    private let writer: @MainActor (Data) async -> Bool
    public init(read: @escaping @MainActor () async throws -> Data?, write: @escaping @MainActor (Data) async -> Bool) {
        reader = read
        writer = write
    }
    public func read() async throws -> Data? { try await reader() }
    public func write(_ data: Data) async -> Bool { await writer(data) }
}
public enum ResearchChartLayoutCodec {
    public static let storageKey = "vision.research.chartBuilder.layouts.v2"
    public static let maxLibraryBytes = 250_000
    public static let maxSharedLength = 20_000
    public static func load(_ data: Data?) -> ResearchChartBuilderLibrary {
        guard let data, let text = String(data: data, encoding: .utf8), text.utf16.count <= maxLibraryBytes,
            let value = try? JSONDecoder().decode(ResearchChartBuilderLibrary.self, from: data)
        else { return .empty }
        return value
    }
    public static func save(_ library: ResearchChartBuilderLibrary) throws -> Data {
        try library.validate()
        let data = try APIBody.encode(library)
        guard data.count <= maxLibraryBytes else {
            throw ResearchDecode.failure("Chart layout library exceeds the storage limit")
        }
        return data
    }
    public static func encodeShared(_ state: ResearchChartBuilderState) throws -> String {
        try state.validate()
        let data = try APIBody.encode(TaxValue.object(["version": .number(1), "state": state.raw]))
        let encoded = data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
            of: "/", with: "_"
        ).replacingOccurrences(of: "=", with: "")
        guard encoded.utf16.count <= maxSharedLength else { throw ResearchDecode.failure("Shared chart is too large") }
        return encoded
    }
    public static func decodeShared(_ encoded: String) -> ResearchChartBuilderState? {
        guard !encoded.isEmpty, encoded.utf16.count <= maxSharedLength else { return nil }
        var base64 = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.utf8.count % 4) % 4)
        guard let data = Data(base64Encoded: base64), let raw = try? JSONDecoder().decode(TaxValue.self, from: data),
            (try? ResearchChartValidation.keys(raw, required: ["version", "state"])) != nil,
            raw["version"] == .number(1),
            let state = try? ResearchDecode.required(raw["state"], ResearchChartBuilderState.self)
        else { return nil }
        return state
    }
}
