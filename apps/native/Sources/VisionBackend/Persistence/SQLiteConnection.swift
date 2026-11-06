import Foundation
import SQLite3

/// A SQLite value as a statement returns it or a function receives it.
public enum SQLValue: Sendable, Equatable, CustomStringConvertible {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob([UInt8])

    public var description: String {
        switch self {
        case .null: return "NULL"
        case .integer(let value): return String(value)
        case .real(let value): return String(value)
        case .text(let value): return value
        case .blob(let bytes): return "<blob \(bytes.count) bytes>"
        }
    }

    public var isNull: Bool { self == .null }
}

/// `SQLITE_TRANSIENT`: SQLite copies the bytes before the call returns.
private var transientDestructor: sqlite3_destructor_type { unsafeBitCast(-1, to: sqlite3_destructor_type.self) }

/// One SQLite connection to a Vision database file, opened like `openDatabase` in
/// `apps/node-backend/src/database/connection.ts`: the same pragmas and, once
/// `registerVisionFunctions` has run, the same SQL functions (ADR-263, ADR-270).
///
/// Not thread-safe: one owner (an actor or a serial queue) uses it at a time.
public final class SQLiteConnection {
    /// The roles of `connection.ts`. `inspect` opens the file read-only.
    public enum Role: Sendable {
        case writer
        case reader
        case snapshot
        case inspect
    }

    /// SQLite 3.39.0, the minimum ADR-263 requires (RIGHT and FULL OUTER JOIN, `unixepoch`).
    public static let minimumVersionNumber: Int32 = 3_039_000

    let handle: OpaquePointer
    public let role: Role

    public static var libraryVersion: String { String(cString: sqlite3_libversion()) }

    public init(path: String, role: Role = .writer) throws {
        guard sqlite3_libversion_number() >= Self.minimumVersionNumber else {
            throw DatabaseError(
                code: "58000", message: "SQLite \(Self.libraryVersion) is older than the 3.39.0 Vision requires")
        }
        if role == .writer, path != ":memory:" {
            let directory = (path as NSString).deletingLastPathComponent
            if !directory.isEmpty {
                try FileManager.default.createDirectory(
                    atPath: directory, withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700])
            }
        }
        var opened: OpaquePointer?
        let flags =
            (role == .inspect ? SQLITE_OPEN_READONLY : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE))
            | SQLITE_OPEN_NOMUTEX
        let status = sqlite3_open_v2(path, &opened, flags, nil)
        guard status == SQLITE_OK, let opened else {
            let message = opened.map { String(cString: sqlite3_errmsg($0)) } ?? "out of memory"
            if let opened { sqlite3_close_v2(opened) }
            throw DatabaseError(sqliteCode: status, message: message)
        }
        handle = opened
        self.role = role
        sqlite3_extended_result_codes(handle, 1)
        sqlite3_busy_timeout(handle, 10_000)
        do {
            try applyPragmas()
        } catch {
            sqlite3_close_v2(handle)
            throw error
        }
    }

    deinit {
        sqlite3_close_v2(handle)
    }

    /// `applyPragmas` of connection.ts.
    private func applyPragmas() throws {
        if role == .writer { try execute("PRAGMA journal_mode = WAL") }
        try execute(
            """
            PRAGMA foreign_keys = ON;
            PRAGMA synchronous = FULL;
            PRAGMA fullfsync = ON;
            PRAGMA checkpoint_fullfsync = ON;
            PRAGMA busy_timeout = 10000;
            PRAGMA recursive_triggers = OFF;
            PRAGMA trusted_schema = ON;
            PRAGMA cache_size = -16384;
            PRAGMA temp_store = MEMORY;
            """)
        if role != .writer { try execute("PRAGMA query_only = ON") }
    }

    // MARK: Statements

    /// Runs one or more statements that take no arguments.
    public func execute(_ sql: String) throws {
        var errorMessage: UnsafeMutablePointer<CChar>?
        let status = sqlite3_exec(handle, sql, nil, nil, &errorMessage)
        if status != SQLITE_OK {
            let message = errorMessage.map { String(cString: $0) } ?? String(cString: sqlite3_errmsg(handle))
            sqlite3_free(errorMessage)
            throw DatabaseError.translate(sqliteCode: sqlite3_extended_errcode(handle), message: message)
        }
    }

    /// Runs one statement and returns every row.
    @discardableResult
    public func query(_ sql: String, _ arguments: [SQLValue] = []) throws -> [[SQLValue]] {
        var statement: OpaquePointer?
        let prepared = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
        guard prepared == SQLITE_OK, let statement else {
            throw DatabaseError.translate(
                sqliteCode: sqlite3_extended_errcode(handle), message: String(cString: sqlite3_errmsg(handle)))
        }
        defer { sqlite3_finalize(statement) }
        for (offset, argument) in arguments.enumerated() {
            let status = Self.bind(argument, to: statement, at: Int32(offset + 1))
            guard status == SQLITE_OK else {
                throw DatabaseError.translate(sqliteCode: status, message: String(cString: sqlite3_errmsg(handle)))
            }
        }
        var rows: [[SQLValue]] = []
        let columns = sqlite3_column_count(statement)
        while true {
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { break }
            guard status == SQLITE_ROW else {
                throw DatabaseError.translate(
                    sqliteCode: sqlite3_extended_errcode(handle), message: String(cString: sqlite3_errmsg(handle)))
            }
            var row: [SQLValue] = []
            row.reserveCapacity(Int(columns))
            for column in 0..<columns { row.append(Self.columnValue(statement, column)) }
            rows.append(row)
        }
        return rows
    }

    /// The first column of the first row, or `nil` without a row.
    public func scalar(_ sql: String, _ arguments: [SQLValue] = []) throws -> SQLValue? {
        try query(sql, arguments).first?.first
    }

    private static func bind(_ value: SQLValue, to statement: OpaquePointer, at index: Int32) -> Int32 {
        switch value {
        case .null:
            return sqlite3_bind_null(statement, index)
        case .integer(let number):
            return sqlite3_bind_int64(statement, index, number)
        case .real(let number):
            return sqlite3_bind_double(statement, index, number)
        case .text(let text):
            var text = text
            return text.withUTF8 { bytes in
                guard let base = bytes.baseAddress, !bytes.isEmpty else {
                    return sqlite3_bind_text(statement, index, "", 0, transientDestructor)
                }
                return base.withMemoryRebound(to: CChar.self, capacity: bytes.count) { pointer in
                    sqlite3_bind_text(statement, index, pointer, Int32(bytes.count), transientDestructor)
                }
            }
        case .blob(let bytes):
            return bytes.withUnsafeBytes { raw in
                sqlite3_bind_blob(statement, index, raw.baseAddress, Int32(raw.count), transientDestructor)
            }
        }
    }

    private static func columnValue(_ statement: OpaquePointer, _ column: Int32) -> SQLValue {
        switch sqlite3_column_type(statement, column) {
        case SQLITE_INTEGER:
            return .integer(sqlite3_column_int64(statement, column))
        case SQLITE_FLOAT:
            return .real(sqlite3_column_double(statement, column))
        case SQLITE_TEXT:
            let count = Int(sqlite3_column_bytes(statement, column))
            guard let pointer = sqlite3_column_text(statement, column) else { return .text("") }
            return .text(String(decoding: UnsafeBufferPointer(start: pointer, count: count), as: UTF8.self))
        case SQLITE_BLOB:
            let count = Int(sqlite3_column_bytes(statement, column))
            guard count > 0, let pointer = sqlite3_column_blob(statement, column) else { return .blob([]) }
            return .blob(Array(UnsafeRawBufferPointer(start: pointer, count: count)))
        default:
            return .null
        }
    }

    // MARK: Functions

    /// A scalar SQL function. `argumentCount` -1 takes any number of arguments.
    public func defineFunction(
        _ name: String, argumentCount: Int32, deterministic: Bool = true,
        _ body: @escaping ([SQLValue]) throws -> SQLValue
    ) throws {
        let box = Unmanaged.passRetained(ScalarFunctionBox(body)).toOpaque()
        let flags = SQLITE_UTF8 | (deterministic ? SQLITE_DETERMINISTIC : 0)
        let status = sqlite3_create_function_v2(
            handle, name, argumentCount, flags, box,
            { context, count, values in
                guard let context else { return }
                let box = Unmanaged<ScalarFunctionBox>.fromOpaque(sqlite3_user_data(context)).takeUnretainedValue()
                let arguments = SQLiteConnection.arguments(count, values)
                do {
                    SQLiteConnection.setResult(try box.body(arguments), on: context)
                } catch {
                    SQLiteConnection.setError(error, on: context)
                }
            },
            nil, nil,
            { pointer in
                guard let pointer else { return }
                Unmanaged<ScalarFunctionBox>.fromOpaque(pointer).release()
            })
        guard status == SQLITE_OK else {
            throw DatabaseError.translate(sqliteCode: status, message: String(cString: sqlite3_errmsg(handle)))
        }
    }

    /// An aggregate. With `inverse`, it is also a window function whose `inverse` removes a
    /// value from the frame; without, SQLite recomputes each window frame (PostgreSQL's
    /// max/min have no inverse transition either).
    public func defineAggregate(
        _ name: String, argumentCount: Int32, inverse: Bool = true,
        makeAccumulator: @escaping () -> any SQLAggregateAccumulator
    ) throws {
        let box = Unmanaged.passRetained(AggregateFunctionBox(makeAccumulator)).toOpaque()
        guard inverse else {
            let status = sqlite3_create_function_v2(
                handle, name, argumentCount, SQLITE_UTF8 | SQLITE_DETERMINISTIC, box, nil,
                { context, count, values in
                    guard let context else { return }
                    SQLiteConnection.aggregateStep(context, count, values, inverse: false)
                },
                { context in
                    guard let context else { return }
                    SQLiteConnection.aggregateResult(context, final: true)
                },
                { pointer in
                    guard let pointer else { return }
                    Unmanaged<AggregateFunctionBox>.fromOpaque(pointer).release()
                })
            guard status == SQLITE_OK else {
                throw DatabaseError.translate(sqliteCode: status, message: String(cString: sqlite3_errmsg(handle)))
            }
            return
        }
        let status = sqlite3_create_window_function(
            handle, name, argumentCount, SQLITE_UTF8 | SQLITE_DETERMINISTIC, box,
            { context, count, values in
                guard let context else { return }
                SQLiteConnection.aggregateStep(context, count, values, inverse: false)
            },
            { context in
                guard let context else { return }
                SQLiteConnection.aggregateResult(context, final: true)
            },
            { context in
                guard let context else { return }
                SQLiteConnection.aggregateResult(context, final: false)
            },
            { context, count, values in
                guard let context else { return }
                SQLiteConnection.aggregateStep(context, count, values, inverse: true)
            },
            { pointer in
                guard let pointer else { return }
                Unmanaged<AggregateFunctionBox>.fromOpaque(pointer).release()
            })
        guard status == SQLITE_OK else {
            throw DatabaseError.translate(sqliteCode: status, message: String(cString: sqlite3_errmsg(handle)))
        }
    }

    /// The accumulator stored in the aggregate context, created on first use.
    private static func accumulator(_ context: OpaquePointer, create: Bool) -> (any SQLAggregateAccumulator)? {
        let size = Int32(MemoryLayout<UnsafeMutableRawPointer?>.size)
        guard let raw = sqlite3_aggregate_context(context, create ? size : 0) else { return nil }
        let slot = raw.assumingMemoryBound(to: UnsafeMutableRawPointer?.self)
        if let existing = slot.pointee {
            return Unmanaged<AccumulatorBox>.fromOpaque(existing).takeUnretainedValue().accumulator
        }
        guard create else { return nil }
        let box = Unmanaged<AggregateFunctionBox>.fromOpaque(sqlite3_user_data(context)).takeUnretainedValue()
        let holder = AccumulatorBox(box.make())
        slot.pointee = Unmanaged.passRetained(holder).toOpaque()
        return holder.accumulator
    }

    private static func aggregateStep(
        _ context: OpaquePointer, _ count: Int32, _ values: UnsafeMutablePointer<OpaquePointer?>?, inverse: Bool
    ) {
        guard let accumulator = accumulator(context, create: true) else {
            sqlite3_result_error_nomem(context)
            return
        }
        do {
            let arguments = arguments(count, values)
            if inverse { try accumulator.inverse(arguments) } else { try accumulator.step(arguments) }
        } catch {
            setError(error, on: context)
        }
    }

    private static func aggregateResult(_ context: OpaquePointer, final: Bool) {
        let accumulator: any SQLAggregateAccumulator
        if let existing = Self.accumulator(context, create: false) {
            accumulator = existing
        } else {
            let box = Unmanaged<AggregateFunctionBox>.fromOpaque(sqlite3_user_data(context)).takeUnretainedValue()
            accumulator = box.make()
        }
        do {
            setResult(try accumulator.result(), on: context)
        } catch {
            setError(error, on: context)
        }
        if final, let raw = sqlite3_aggregate_context(context, 0) {
            let slot = raw.assumingMemoryBound(to: UnsafeMutableRawPointer?.self)
            if let existing = slot.pointee {
                Unmanaged<AccumulatorBox>.fromOpaque(existing).release()
                slot.pointee = nil
            }
        }
    }

    static func arguments(_ count: Int32, _ values: UnsafeMutablePointer<OpaquePointer?>?) -> [SQLValue] {
        guard let values, count > 0 else { return [] }
        return (0..<Int(count)).map { index in
            guard let value = values[index] else { return .null }
            switch sqlite3_value_type(value) {
            case SQLITE_INTEGER:
                return .integer(sqlite3_value_int64(value))
            case SQLITE_FLOAT:
                return .real(sqlite3_value_double(value))
            case SQLITE_TEXT:
                let length = Int(sqlite3_value_bytes(value))
                guard let pointer = sqlite3_value_text(value) else { return .text("") }
                return .text(String(decoding: UnsafeBufferPointer(start: pointer, count: length), as: UTF8.self))
            case SQLITE_BLOB:
                let length = Int(sqlite3_value_bytes(value))
                guard length > 0, let pointer = sqlite3_value_blob(value) else { return .blob([]) }
                return .blob(Array(UnsafeRawBufferPointer(start: pointer, count: length)))
            default:
                return .null
            }
        }
    }

    static func setResult(_ value: SQLValue, on context: OpaquePointer) {
        switch value {
        case .null:
            sqlite3_result_null(context)
        case .integer(let number):
            sqlite3_result_int64(context, number)
        case .real(let number):
            sqlite3_result_double(context, number)
        case .text(let text):
            var text = text
            text.withUTF8 { bytes in
                guard let base = bytes.baseAddress, !bytes.isEmpty else {
                    sqlite3_result_text(context, "", 0, transientDestructor)
                    return
                }
                base.withMemoryRebound(to: CChar.self, capacity: bytes.count) { pointer in
                    sqlite3_result_text(context, pointer, Int32(bytes.count), transientDestructor)
                }
            }
        case .blob(let bytes):
            bytes.withUnsafeBytes { raw in
                sqlite3_result_blob(context, raw.baseAddress, Int32(raw.count), transientDestructor)
            }
        }
    }

    /// A function error crosses SQLite as text; `DatabaseError.translate` reads the SQLSTATE back.
    static func setError(_ error: any Error, on context: OpaquePointer) {
        let message: String
        if let stateError = error as? SQLStateError {
            message = DatabaseError.encode(code: stateError.code, constraint: nil, message: stateError.message)
        } else if let databaseError = error as? DatabaseError, !databaseError.code.isEmpty {
            message = DatabaseError.encode(
                code: databaseError.code, constraint: databaseError.constraint, message: databaseError.message)
        } else {
            message = String(describing: error)
        }
        sqlite3_result_error(context, message, -1)
    }
}

/// The state of one aggregate group or window frame.
public protocol SQLAggregateAccumulator: AnyObject {
    func step(_ arguments: [SQLValue]) throws
    /// Removes a value that left the window frame.
    func inverse(_ arguments: [SQLValue]) throws
    func result() throws -> SQLValue
}

private final class ScalarFunctionBox {
    let body: ([SQLValue]) throws -> SQLValue
    init(_ body: @escaping ([SQLValue]) throws -> SQLValue) { self.body = body }
}

private final class AggregateFunctionBox {
    let make: () -> any SQLAggregateAccumulator
    init(_ make: @escaping () -> any SQLAggregateAccumulator) { self.make = make }
}

private final class AccumulatorBox {
    let accumulator: any SQLAggregateAccumulator
    init(_ accumulator: any SQLAggregateAccumulator) { self.accumulator = accumulator }
}
