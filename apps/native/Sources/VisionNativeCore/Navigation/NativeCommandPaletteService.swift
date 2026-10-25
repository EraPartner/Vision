import Foundation

public protocol NativeCommandPaletteService: Sendable {
    func paletteRecipients(query: String) async throws -> [OpenAPI.Recipient]
    func paletteQuote(symbol: String) async throws -> ResearchQuote?
}

/// The fixed shared-TypeScript callback returns already formatted results. Native
/// code never evaluates an expression or derives a converted monetary amount.
public protocol NativeCommandPaletteAnswers: Sendable {
    func paletteAnswer(query: String, numberFormat: NumberFormat, currency: String, decimals: Int) async throws
        -> NativeCommandPaletteAnswer?
}

public struct NativeCommandPaletteAnswerProvider: NativeCommandPaletteAnswers {
    private let evaluate: @Sendable (String, NumberFormat, String, Int) async throws -> NativeCommandPaletteAnswer?
    public init(
        _ evaluate: @escaping @Sendable (String, NumberFormat, String, Int) async throws -> NativeCommandPaletteAnswer?
    ) { self.evaluate = evaluate }

    public func paletteAnswer(query: String, numberFormat: NumberFormat, currency: String, decimals: Int) async throws
        -> NativeCommandPaletteAnswer?
    { try await evaluate(query, numberFormat, currency, decimals) }
}

extension APIClient: NativeCommandPaletteService {
    public func paletteRecipients(query: String) async throws -> [OpenAPI.Recipient] {
        try await send(OpenAPIOperations.GetRecipients(limit: 5, search: query, active: true)).items
    }
    public func paletteQuote(symbol: String) async throws -> ResearchQuote? {
        try await marketQuotes(symbols: [symbol], detail: "basic").first
    }
}
