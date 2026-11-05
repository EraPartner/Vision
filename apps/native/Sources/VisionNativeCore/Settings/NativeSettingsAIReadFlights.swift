import Foundation

/// Only pending, typed AI-status requests are shared. Completed values live in source-scoped model receipts.
public actor NativeSettingsAIReadFlights {
    private final class Flight {
        let token: UUID
        let task: Task<Data, Error>
        var retired = false
        var waiters = 0
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
        flight.waiters += 1
        defer { flight.waiters -= 1 }
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
    // Pending subscriber count is internal diagnostic state; completed values are never retained.
    func pendingWaiterCount(origin: String, key: String) -> Int {
        flights.reduce(0) { result, entry in
            guard let bytes = Data(base64Encoded: entry.key),
                let scope = try? JSONDecoder().decode([String].self, from: bytes),
                scope.count == 3, scope[0] == origin, scope[1] == key
            else { return result }
            return result + entry.value.waiters
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
