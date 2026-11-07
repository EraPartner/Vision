import Foundation
import SQLite3

/// A database failure as the PostgreSQL error Vision's services already handle: a port of
/// `apps/node-backend/src/database/sqlite/errors.ts`. `code` is the SQLSTATE (23505 unique,
/// 23503 foreign key, 23514 check, 23502 not null, 42P01 undefined table, 57014 cancelled, ...),
/// or empty when SQLite reported something with no counterpart.
///
/// Triggers raise `RAISE(ABORT, 'vision:<sqlstate>:<constraint>:<message>')` or call
/// `vision_raise()`, and the SQL functions report their `SQLStateError`s the same way; the
/// prefix becomes `code` and `constraint`.
public struct DatabaseError: Error, Equatable, Sendable, CustomStringConvertible {
    public var code: String
    public var message: String
    public var constraint: String?
    public var table: String?
    public var column: String?
    public var detail: String?
    /// SQLite's extended result code, for diagnostics.
    public var sqliteCode: Int32?

    public init(
        code: String, message: String, constraint: String? = nil, table: String? = nil, column: String? = nil,
        detail: String? = nil, sqliteCode: Int32? = nil
    ) {
        self.code = code
        self.message = message
        self.constraint = constraint
        self.table = table
        self.column = column
        self.detail = detail
        self.sqliteCode = sqliteCode
    }

    init(sqliteCode: Int32, message: String) {
        self.init(code: "", message: message, sqliteCode: sqliteCode)
    }

    public var description: String { code.isEmpty ? message : "\(code): \(message)" }

    /// Resolves a unique index name from a table and its columns (from the schema).
    public typealias UniqueIndexResolver = (_ table: String, _ columns: [String]) -> String?

    static func encode(code: String, constraint: String?, message: String) -> String {
        "vision:\(code):\(constraint ?? ""):\(message)"
    }

    /// `vision:<sqlstate>:<constraint>:<message>`, anywhere in an error message (SQLite may
    /// prefix it, as in "<function>: ...").
    private static func decode(_ message: String) -> (code: String, constraint: String?, message: String)? {
        guard let range = message.range(of: #"vision:[0-9A-Z]{5}:"#, options: .regularExpression) else { return nil }
        let rest = message[range.lowerBound...].dropFirst("vision:".count)
        let code = String(rest.prefix(5))
        let afterCode = rest.dropFirst(6)
        guard let colon = afterCode.firstIndex(of: ":") else { return nil }
        let constraint = String(afterCode[..<colon])
        return (code, constraint.isEmpty ? nil : constraint, String(afterCode[afterCode.index(after: colon)...]))
    }

    /// `translateSqliteError`.
    static func translate(
        sqliteCode: Int32, message: String, resolveUnique: UniqueIndexResolver? = nil
    ) -> DatabaseError {
        func make(
            _ code: String, constraint: String? = nil, table: String? = nil, column: String? = nil,
            detail: String? = nil, text: String? = nil
        ) -> DatabaseError {
            DatabaseError(
                code: code, message: text ?? message, constraint: constraint, table: table, column: column,
                detail: detail, sqliteCode: sqliteCode)
        }
        func capture(_ pattern: String, _ group: Int = 1) -> String? {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                let match = regex.firstMatch(in: message, range: NSRange(message.startIndex..., in: message)),
                let range = Range(match.range(at: group), in: message)
            else { return nil }
            return String(message[range])
        }
        switch sqliteCode {
        case 2067, 1555:  // SQLITE_CONSTRAINT_UNIQUE, SQLITE_CONSTRAINT_PRIMARYKEY
            let target = capture(#"constraint failed: (.+)$"#) ?? ""
            // An expression index is reported by name: "index 'idx_x'".
            let indexName: String? = {
                guard target.hasPrefix("index '"), target.hasSuffix("'") else { return nil }
                return String(target.dropFirst("index '".count).dropLast())
            }()
            let parts = indexName == nil ? target.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } : []
            let table = parts.first.flatMap { $0.split(separator: ".").first.map(String.init) }
            let columns = parts.map { $0.split(separator: ".").dropFirst().joined(separator: ".") }
            let resolved = table.flatMap { resolveUnique?($0, columns) }
            let constraint = indexName ?? resolved ?? (sqliteCode == 1555 ? table.map { "\($0)_pkey" } : nil)
            return make(
                "23505", constraint: constraint, table: table,
                detail: "Key (\(columns.joined(separator: ", "))) already exists.",
                text: "duplicate key value violates unique constraint" + (constraint.map { " \"\($0)\"" } ?? ""))
        case 787:  // SQLITE_CONSTRAINT_FOREIGNKEY
            return make("23503", text: "insert or update violates a foreign key constraint")
        case 275:  // SQLITE_CONSTRAINT_CHECK
            let constraint = capture(#"CHECK constraint failed: (.+)$"#)?.trimmingCharacters(in: .whitespaces)
            return make(
                "23514", constraint: constraint,
                text: "new row violates check constraint" + (constraint.map { " \"\($0)\"" } ?? ""))
        case 1299:  // SQLITE_CONSTRAINT_NOTNULL
            let table = capture(#"NOT NULL constraint failed: ([^.]+)\.(.+)$"#, 1)
            let column = capture(#"NOT NULL constraint failed: ([^.]+)\.(.+)$"#, 2)
            return make(
                "23502", table: table, column: column,
                text: "null value in column \"\(column ?? "?")\" violates not-null constraint")
        case 3091:  // SQLITE_CONSTRAINT_DATATYPE
            return make("22P02")
        case 1811:  // SQLITE_CONSTRAINT_TRIGGER
            if let decoded = decode(message) {
                return make(decoded.code, constraint: decoded.constraint, text: decoded.message)
            }
            // ON DELETE/UPDATE RESTRICT fails inside SQLite's FK trigger code.
            if message.contains("FOREIGN KEY constraint failed") {
                return make("23001", text: "update or delete violates a RESTRICT foreign key constraint")
            }
            return make("P0001")
        case SQLITE_BUSY:
            return make("55P03")
        case SQLITE_INTERRUPT:
            return make("57014", text: "canceling statement due to statement timeout")
        default:
            break
        }
        // A SQL function's own error (vision_raise, NUMERIC, dates).
        if let decoded = decode(message) {
            return make(decoded.code, constraint: decoded.constraint, text: decoded.message)
        }
        if message.hasPrefix("no such table: ") { return make("42P01") }
        if message.hasPrefix("no such column: ") { return make("42703") }
        if message.hasPrefix("no such function: ") { return make("42883") }
        if message.contains("syntax error") { return make("42601") }
        return make("")
    }
}
