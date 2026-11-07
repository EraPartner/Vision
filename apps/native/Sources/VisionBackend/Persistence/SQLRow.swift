import Foundation

/// The column names of a statement's result, shared by its rows.
public final class SQLColumns: Sendable {
    public let names: [String]
    let indexes: [String: Int]

    init(_ names: [String]) {
        self.names = names
        var indexes: [String: Int] = [:]
        // The first column of a name wins, as `row.name` does for node:sqlite rows.
        for (offset, name) in names.enumerated() where indexes[name] == nil { indexes[name] = offset }
        self.indexes = indexes
    }
}

/// A row read with a typed accessor whose column is missing, NULL where it may not be, or of
/// another storage type: a contract breach between the schema and the code reading it.
public struct SQLRowDecodingError: Error, Equatable, Sendable, CustomStringConvertible {
    public let column: String
    public let problem: String

    public var description: String { "\(column): \(problem)" }
}

/// One result row, read by column name into Swift types (typed row decoding, ADR-270 6b).
/// Every accessor checks the storage class, so a schema change that breaks a reader fails at
/// the read instead of producing a wrong value.
public struct SQLRow: Sendable, Equatable {
    public let columns: SQLColumns
    public let values: [SQLValue]

    public static func == (lhs: SQLRow, rhs: SQLRow) -> Bool {
        lhs.columns.names == rhs.columns.names && lhs.values == rhs.values
    }

    public func value(_ column: String) throws -> SQLValue {
        guard let index = columns.indexes[column], index < values.count else {
            throw SQLRowDecodingError(column: column, problem: "no such column")
        }
        return values[index]
    }

    private func present(_ column: String) throws -> SQLValue? {
        let value = try value(column)
        return value.isNull ? nil : value
    }

    private func mismatch(_ column: String, _ want: String, _ got: SQLValue) -> SQLRowDecodingError {
        SQLRowDecodingError(column: column, problem: "expected \(want), got \(Self.kind(got))")
    }

    private static func kind(_ value: SQLValue) -> String {
        switch value {
        case .null: return "NULL"
        case .integer: return "INTEGER"
        case .real: return "REAL"
        case .text: return "TEXT"
        case .blob: return "BLOB"
        }
    }

    private func required<T>(_ column: String, _ read: (String) throws -> T?) throws -> T {
        guard let value = try read(column) else { throw SQLRowDecodingError(column: column, problem: "is NULL") }
        return value
    }

    public func optionalInt64(_ column: String) throws -> Int64? {
        guard let value = try present(column) else { return nil }
        guard case .integer(let number) = value else { throw mismatch(column, "INTEGER", value) }
        return number
    }

    public func int64(_ column: String) throws -> Int64 { try required(column, optionalInt64) }

    public func optionalText(_ column: String) throws -> String? {
        guard let value = try present(column) else { return nil }
        guard case .text(let text) = value else { throw mismatch(column, "TEXT", value) }
        return text
    }

    public func text(_ column: String) throws -> String { try required(column, optionalText) }

    /// A REAL column; an INTEGER is widened, as SQLite's REAL affinity stores whole values.
    public func optionalDouble(_ column: String) throws -> Double? {
        guard let value = try present(column) else { return nil }
        switch value {
        case .real(let number): return number
        case .integer(let number): return Double(number)
        default: throw mismatch(column, "REAL", value)
        }
    }

    public func double(_ column: String) throws -> Double { try required(column, optionalDouble) }

    /// A BOOLEAN column: INTEGER 0 or 1.
    public func optionalBool(_ column: String) throws -> Bool? {
        guard let number = try optionalInt64(column) else { return nil }
        guard number == 0 || number == 1 else {
            throw SQLRowDecodingError(column: column, problem: "expected 0 or 1, got \(number)")
        }
        return number == 1
    }

    public func bool(_ column: String) throws -> Bool { try required(column, optionalBool) }

    /// A NUMERIC column: canonical decimal text (docs/reference/sqlite-sql-dialect.md).
    public func optionalDecimal(_ column: String) throws -> ExactDecimal? {
        guard let text = try optionalText(column) else { return nil }
        do {
            return try ExactDecimal.parse(text)
        } catch {
            throw SQLRowDecodingError(column: column, problem: "not a decimal: \(text.prefix(40))")
        }
    }

    public func decimal(_ column: String) throws -> ExactDecimal { try required(column, optionalDecimal) }

    /// A DATE column: `YYYY-MM-DD`.
    public func optionalDate(_ column: String) throws -> SQLTimestamps.CivilDate? {
        guard let text = try optionalText(column) else { return nil }
        do {
            return try SQLTimestamps.parseDate(text)
        } catch {
            throw SQLRowDecodingError(column: column, problem: "not a date: \(text.prefix(40))")
        }
    }

    public func date(_ column: String) throws -> SQLTimestamps.CivilDate { try required(column, optionalDate) }

    /// A jsonb column: canonical jsonb text.
    public func optionalJsonb(_ column: String) throws -> JsonbValue? {
        guard let text = try optionalText(column) else { return nil }
        do {
            return try SQLJsonb.parse(text)
        } catch {
            throw SQLRowDecodingError(column: column, problem: "not jsonb")
        }
    }

    public func jsonb(_ column: String) throws -> JsonbValue { try required(column, optionalJsonb) }
}
