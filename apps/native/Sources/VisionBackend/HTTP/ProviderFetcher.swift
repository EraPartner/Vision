import Foundation

/// A provider's answer to a GET: the status and the body bytes.
public struct ProviderResponse: Sendable, Equatable {
    public let status: Int
    public let body: Data
    /// The answer's headers, as a redirect's `Location` read needs.
    public let headers: [String: String]

    public init(status: Int, body: Data, headers: [String: String] = [:]) {
        self.status = status
        self.body = body
        self.headers = headers
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
    /// Throws when a request may not be made at all (Settings › Privacy), before the caller
    /// resolves a host name: `assertNetworkAllowed` ahead of `assertPublicHttpUrl`.
    func preflight() async throws
}

extension ProviderFetching {
    public func preflight() async throws {}
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
                let http = response as? HTTPURLResponse
                var headers: [String: String] = [:]
                for (key, value) in http?.allHeaderFields ?? [:] {
                    if let name = key as? String, let text = value as? String {
                        headers[name.lowercased()] = text
                    }
                }
                return ProviderResponse(
                    status: http?.statusCode ?? 0, body: data, headers: headers)
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

extension ProviderFetching {
    /// `dns.lookup(host, { all: true })`, the resolution `assertPublicHttpUrl` checks: every
    /// address the host resolves to. Tests can answer recorded addresses.
    public func resolve(_ host: String) throws -> [String] {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        var info: UnsafeMutablePointer<addrinfo>?
        let code = getaddrinfo(host, nil, &hints, &info)
        guard code == 0, let first = info else { throw URLError(.cannotFindHost) }
        defer { freeaddrinfo(info) }
        var addresses: [String] = []
        var node = info
        while let current = node {
            if let text = Self.addressText(of: current.pointee) { addresses.append(text) }
            node = current.pointee.ai_next
        }
        return addresses
    }

    /// One entry's address in `getaddrinfo`'s dotted or colon-hex text form.
    private static func addressText(of info: addrinfo) -> String? {
        var address = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let result = getnameinfo(
            info.ai_addr, info.ai_addrlen, &address, socklen_t(address.count), nil, 0, NI_NUMERICHOST)
        guard result == 0 else { return nil }
        return String(cString: address)
    }
}
