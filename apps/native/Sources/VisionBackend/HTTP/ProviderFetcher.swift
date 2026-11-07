import Foundation

/// A provider's answer to a GET: the status and the body bytes.
public struct ProviderResponse: Sendable, Equatable {
    public let status: Int
    public let body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }

    /// `response.ok`.
    public var ok: Bool { (200...299).contains(status) }

    /// `response.text()`: UTF-8, invalid bytes replaced.
    public var text: String { String(decoding: body, as: UTF8.self) }
}

/// The outbound HTTP the TypeScript services make with `fetch` to data providers (ECB,
/// open.er-api): a GET that fails after `timeout` seconds in all, as
/// `AbortSignal.timeout` does. Tests and the parity replay pass recorded answers.
public protocol ProviderFetching: Sendable {
    func get(_ url: URL, timeout: TimeInterval) async throws -> ProviderResponse
}

/// The fetcher the app uses: an ephemeral `URLSession` with no cookies or cache, like
/// Bun's `fetch`.
public struct URLSessionProviderFetcher: ProviderFetching {
    struct TimedOut: Error {}

    private static let session = URLSession(configuration: .ephemeral)

    public init() {}

    public func get(_ url: URL, timeout: TimeInterval) async throws -> ProviderResponse {
        try await withThrowingTaskGroup(of: ProviderResponse.self) { group in
            group.addTask {
                let (data, response) = try await Self.session.data(for: URLRequest(url: url, timeoutInterval: timeout))
                return ProviderResponse(status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: data)
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                throw TimedOut()
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw TimedOut() }
            return first
        }
    }
}
