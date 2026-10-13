import Foundation

/// One Server-Sent Event: its `event:` name (`message` when the frame names none) and its
/// `data:` lines joined with line breaks.
public struct ServerSentEvent: Equatable, Sendable {
    public let event: String
    public let data: String

    public init(event: String, data: String) {
        self.event = event
        self.data = data
    }
}

/// `readSseFrames` and `parseSseFrame` of apps/frontend/src/lib/api/sse.ts over bytes that
/// arrive in chunks: a frame ends at a blank line (`\r?\n\r?\n`), bytes after the last
/// separator wait for the next chunk (so a character split across chunks stays whole), and a
/// frame with no `data:` line (a comment or keep-alive) yields nothing.
public struct ServerSentEventParser: Sendable {
    private var buffer: [UInt8] = []

    public init() {}

    private static let lineFeed: UInt8 = 0x0A
    private static let carriageReturn: UInt8 = 0x0D

    /// The events the chunk completes.
    public mutating func feed(_ chunk: Data) -> [ServerSentEvent] {
        buffer.append(contentsOf: chunk)
        var events: [ServerSentEvent] = []
        while let found = Self.separator(in: buffer) {
            let block = String(decoding: buffer[..<found.end], as: UTF8.self)
            buffer.removeSubrange(..<found.next)
            if let event = Self.parseFrame(block) { events.append(event) }
        }
        return events
    }

    /// The stream ended: a last frame without its blank line still counts.
    public mutating func finish() -> [ServerSentEvent] {
        let rest = String(decoding: buffer, as: UTF8.self)
        buffer.removeAll()
        guard !rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        var trimmed = rest
        while let last = trimmed.unicodeScalars.last, CharacterSet.whitespacesAndNewlines.contains(last) {
            trimmed.unicodeScalars.removeLast()
        }
        return Self.parseFrame(trimmed).map { [$0] } ?? []
    }

    /// The first `\r?\n\r?\n`: where the frame before it ends and where the next one starts.
    static func separator(in bytes: [UInt8]) -> (end: Int, next: Int)? {
        var index = 0
        while index < bytes.count {
            if bytes[index] == lineFeed {
                var cursor = index + 1
                if cursor < bytes.count, bytes[cursor] == carriageReturn { cursor += 1 }
                if cursor < bytes.count, bytes[cursor] == lineFeed {
                    let end = index > 0 && bytes[index - 1] == carriageReturn ? index - 1 : index
                    return (end, cursor + 1)
                }
            }
            index += 1
        }
        return nil
    }

    /// `parseSseFrame`: `event:` sets the name (trimmed; empty means `message`), each
    /// `data:` line adds its text without leading whitespace, and `:` lines are comments.
    static func parseFrame(_ block: String) -> ServerSentEvent? {
        var name = "message"
        var dataLines: [String] = []
        // "\r\n" is one Character in Swift, so split on either line end, not on "\n" alone.
        for rawLine in block.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" }) {
            var line = Substring(rawLine)
            if line.hasSuffix("\r") { line = line.dropLast() }
            if line.isEmpty || line.hasPrefix(":") { continue }
            if line.hasPrefix("event:") {
                let parsed = line.dropFirst("event:".count).trimmingCharacters(in: .whitespacesAndNewlines)
                name = parsed.isEmpty ? "message" : parsed
                continue
            }
            if line.hasPrefix("data:") {
                let value = line.dropFirst("data:".count)
                dataLines.append(String(value.drop(while: { $0.isWhitespace })))
            }
        }
        guard !dataLines.isEmpty else { return nil }
        return ServerSentEvent(event: name, data: dataLines.joined(separator: "\n"))
    }
}

/// Sends one request whose answer is read as it arrives (an event stream). Tests use a fake
/// that hands over scripted chunks; the app uses `URLSessionAPITransport`.
public protocol APIStreamTransport: Sendable {
    /// For a 2xx answer, hands each chunk of the body to `receive` as it arrives and returns
    /// the status with an empty body; for any other status, returns the whole body unread.
    /// Throws `APIError.timedOut`, `APIError.network`, `CancellationError`, or what `receive`
    /// throws.
    func stream(_ request: APIRequest, receive: (Data) async throws -> Void) async throws -> APIResponse
}

extension URLSessionAPITransport: APIStreamTransport {
    public func stream(_ request: APIRequest, receive: (Data) async throws -> Void) async throws -> APIResponse {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method.rawValue
        urlRequest.timeoutInterval = request.timeout
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        for (field, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: field)
        }
        urlRequest.httpBody = request.body
        do {
            let (bytes, response) = try await session.bytes(for: urlRequest)
            guard let http = response as? HTTPURLResponse else { throw APIError.network("Invalid response") }
            var pending = Data()
            guard (200..<300).contains(http.statusCode) else {
                for try await byte in bytes { pending.append(byte) }
                return APIResponse(status: http.statusCode, body: pending)
            }
            // One chunk per line keeps the parser's work small and the events prompt.
            for try await byte in bytes {
                pending.append(byte)
                if byte == 0x0A {
                    try await receive(pending)
                    pending.removeAll(keepingCapacity: true)
                }
            }
            if !pending.isEmpty { try await receive(pending) }
            return APIResponse(status: http.statusCode, body: Data())
        } catch let error as URLError {
            switch error.code {
            case .timedOut: throw APIError.timedOut
            case .cancelled: throw CancellationError()
            default: throw APIError.network(error.localizedDescription)
            }
        }
    }
}
