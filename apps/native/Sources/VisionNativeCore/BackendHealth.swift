import Foundation

/// Probes the backend's `/health` endpoint so the app can say when it is not running.
public enum BackendHealth {
    public static func healthURL(baseURL: URL) -> URL {
        baseURL.appendingPathComponent("health", isDirectory: false)
    }

    /// Sends `GET <base>/health` and returns the HTTP status code. Throws when the
    /// request fails, for example because nothing listens on the port.
    public static func status(
        baseURL: URL,
        session: URLSession = .shared,
        timeout: TimeInterval = 5
    ) async throws -> Int {
        var request = URLRequest(url: healthURL(baseURL: baseURL))
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return http.statusCode
    }
}
