import Foundation

/// Only pending, typed AI-status requests are shared. Completed values live in source-scoped model receipts.
public actor NativeSettingsAIReadFlights {
    private final class Flight {
        let token: UUID
        let task: Task<Data, Error>
        var retired = false
        init(token: UUID, task: Task<Data, Error>) {
            self.token = token
            self.task = task
        }
    }
    private var flights: [String: Flight] = [:]
    public init() {}
    public func value<Value: Codable & Sendable>(
        origin: String, key: String, load: @escaping @Sendable () async throws -> Value
    ) async throws -> Value {
        let identity = try JSONEncoder().encode([origin, key, String(reflecting: Value.self)]).base64EncodedString()
        let flight: Flight
        if let pending = flights[identity] {
            flight = pending
        } else {
            flight = .init(token: UUID(), task: Task { try APIBody.encode(try await load()) })
            flights[identity] = flight
        }
        do {
            let bytes = try await flight.task.value
            guard !flight.retired else { throw CancellationError() }
            if flights[identity]?.token == flight.token { flights[identity] = nil }
            return try JSONDecoder().decode(Value.self, from: bytes)
        } catch {
            if flights[identity]?.token == flight.token { flights[identity] = nil }
            throw error
        }
    }
    public func invalidate(origin: String, keys: [String]) {
        for identity in Array(flights.keys) {
            guard let bytes = Data(base64Encoded: identity),
                let scope = try? JSONDecoder().decode([String].self, from: bytes),
                scope.count == 3, scope[0] == origin, keys.contains(scope[1])
            else { continue }
            flights[identity]?.retired = true
            flights[identity] = nil
        }
    }
}
