import Foundation
import VisionNativeCore

/// The Swift backend's connection to the live database file (ADR-270 decision 4). One actor
/// runs every statement, reads and writes alike, so a handler's body is never interleaved
/// with another's. The runtime suspends it while Bun is stopped and resumes it on the live
/// file; it opens lazily on the first use after `resume`, because Bun applies pending
/// migrations at boot and the ledger check refuses a file that is not at this build's head.
public actor BackendDatabase: InProcessDatabaseHolder {
    private var path: String?
    private var suspended = true
    private var session: BackendSession?
    private let time: SQLTimestamps
    private let wall: @Sendable () -> SQLTimestamps.Instant

    public init(time: SQLTimestamps = SQLTimestamps()) {
        self.time = time
        wall = SQLConnectionClock.systemNow
    }

    /// Opens `path` straight away, for tests and tools that own the file. `wall` replaces the
    /// system clock, for a replay recorded at a fixed instant.
    public init(
        path: String, time: SQLTimestamps = SQLTimestamps(),
        wall: @escaping @Sendable () -> SQLTimestamps.Instant = SQLConnectionClock.systemNow
    ) {
        self.time = time
        self.wall = wall
        self.path = path
        suspended = false
    }

    /// Whether the runtime has handed this connection a database file. Without one (a debug
    /// build pointed at another backend), ported operations go to that backend instead.
    public var isConfigured: Bool { path != nil }

    public func suspend() {
        session = nil
        suspended = true
    }

    public func resume(databasePath: String) {
        if databasePath != path { session = nil }
        path = databasePath
        suspended = false
    }

    /// Runs `body` on the connection. Throws `APIError.backendUnavailable` while suspended,
    /// as a request to the stopped Bun backend fails.
    public func run<T: Sendable>(_ body: @Sendable (BackendSession) throws -> T) throws -> T {
        try body(try openSession())
    }

    private func openSession() throws -> BackendSession {
        guard !suspended, let path else { throw APIError.backendUnavailable }
        if let session { return session }
        let clock = SQLConnectionClock(wall: wall)
        let connection = try VisionDatabase.open(path: path, role: .writer, time: time, clock: clock)
        let opened = BackendSession(connection: connection, clock: clock, time: time)
        session = opened
        return opened
    }
}

/// One open connection and its SQL clock, as `connection.ts` keeps them: each statement
/// outside a transaction reads `now()` as its own start, and a transaction's statements
/// read the transaction's start.
public final class BackendSession {
    let connection: SQLiteConnection
    let clock: SQLConnectionClock
    /// The session's time zone, the backend's `APP_TIMEZONE`.
    let time: SQLTimestamps
    private var savepoints = 0

    init(connection: SQLiteConnection, clock: SQLConnectionClock, time: SQLTimestamps) {
        self.connection = connection
        self.clock = clock
        self.time = time
    }

    /// `todayAppDateString()`: today's calendar day in the session's zone, `YYYY-MM-DD`.
    func today() -> String {
        SQLTimestamps.formatDate(time.localDate(of: currentInstant()))
    }

    /// `new Date()`: the wall clock in milliseconds.
    func currentInstant() -> SQLTimestamps.Instant { clock.wall() }

    private func statement<T>(_ body: () throws -> T) rethrows -> T {
        let inTransaction = clock.transactionStart != nil
        if !inTransaction { clock.statementStart = currentInstant() }
        defer { if !inTransaction { clock.statementStart = nil } }
        return try body()
    }

    /// The rows of one statement.
    public func rows(_ sql: String, _ arguments: [SQLValue] = []) throws -> [SQLRow] {
        try statement { try connection.rows(sql, arguments) }
    }

    /// The first row of one statement, or nil.
    public func row(_ sql: String, _ arguments: [SQLValue] = []) throws -> SQLRow? {
        try rows(sql, arguments).first
    }

    /// `withTransaction`: BEGIN IMMEDIATE, COMMIT on success, ROLLBACK on a throw. Inside a
    /// transaction it nests as connection.ts does: a savepoint, rolled back to on a throw.
    public func transaction<T>(_ body: () throws -> T) throws -> T {
        if clock.transactionStart != nil {
            savepoints += 1
            let name = "vision_nested_tx_\(savepoints)"
            try connection.execute("SAVEPOINT \(name)")
            do {
                let result = try body()
                try connection.execute("RELEASE SAVEPOINT \(name)")
                return result
            } catch {
                try? connection.execute("ROLLBACK TO SAVEPOINT \(name)")
                try? connection.execute("RELEASE SAVEPOINT \(name)")
                throw error
            }
        }
        try connection.execute("BEGIN IMMEDIATE")
        clock.transactionStart = currentInstant()
        defer { clock.transactionStart = nil }
        do {
            let result = try body()
            try connection.execute("COMMIT")
            return result
        } catch {
            if !connection.isAutocommit { try? connection.execute("ROLLBACK") }
            throw error
        }
    }
}
