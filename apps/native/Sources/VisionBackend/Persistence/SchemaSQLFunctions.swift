import Foundation

extension SQLiteConnection {
    /// Full-text search and nextval of functions.ts.
    public func registerSearchFunctions() throws {
        typealias A = SQLArguments
        // to_tsvector('simple', doc) @@ websearch_to_tsquery('simple', query)
        try defineFunction("vision_fts_match", argumentCount: 2) { args in
            if args[0].isNull || args[1].isNull { return .null }
            return A.bool(
                try SQLFullText.match(A.text(args[0], "vision_fts_match"), A.text(args[1], "vision_fts_match")))
        }
        // ts_rank_cd(..., 0) as a REAL.
        try defineFunction("vision_fts_rank", argumentCount: 2) { args in
            if args[0].isNull || args[1].isNull { return .null }
            return .real(try SQLFullText.rank(A.text(args[0], "vision_fts_rank"), A.text(args[1], "vision_fts_rank")))
        }
        // The UPDATE runs inside the calling statement, so it joins its transaction.
        try defineFunction("nextval", argumentCount: 1, deterministic: false) { [unowned self] args in
            if args[0].isNull { return .null }
            let sequence = try A.text(args[0], "nextval")
            let rows = try self.query(
                "UPDATE vision_sequences SET last_value = last_value + 1 WHERE name = ? RETURNING last_value",
                [.text(sequence)])
            guard let value = rows.first?.first else {
                throw SQLStateError("sequence \"\(sequence)\" does not exist", code: "42P01")
            }
            return value
        }
    }

    /// The functions the PostgreSQL schema defined for Vision's own tables
    /// (`registerSchemaFunctions` of schemaFunctions.ts), after `registerVisionFunctions`.
    public func registerSchemaFunctions() throws {
        // Not deterministic, so SQLite never evaluates it ahead of its WHERE clause.
        try defineFunction("vision_raise", argumentCount: 3, deterministic: false) { args in
            throw SchemaFunctions.raise(args[0], args[1], args[2])
        }
        try defineFunction("portfolio_cash_receipt", argumentCount: 1) { args in
            try SchemaFunctions.portfolioCashReceipt(args[0]).map(SQLValue.text) ?? .null
        }
        try defineFunction("normalize_portfolio_income_snapshot", argumentCount: 1) { args in
            guard let text = SchemaFunctions.sqlText(args[0]) else { return .null }
            return .text(SQLJsonb.format(SchemaFunctions.normalizeSnapshot(try SQLJsonb.parse(text))))
        }
        try defineFunction("portfolio_income_transaction_snapshot", argumentCount: -1) { args in
            .text(try SchemaFunctions.portfolioIncomeTransactionSnapshot(args))
        }
    }
}

/// schemaFunctions.ts: vision_raise, portfolio_cash_receipt and the income snapshots.
public enum SchemaFunctions {
    /// A value as the TypeScript functions read it: text, a number's text, a blob as UTF-8.
    static func sqlText(_ value: SQLValue) -> String? {
        switch value {
        case .null: return nil
        case .text(let text): return text
        case .integer(let number): return String(number)
        case .real(let number): return SQLArguments.javaScriptText(number)
        case .blob(let bytes): return String(decoding: bytes, as: UTF8.self)
        }
    }

    /// `RAISE EXCEPTION ... USING ERRCODE = sqlstate, CONSTRAINT = constraint`.
    static func raise(_ sqlstate: SQLValue, _ constraint: SQLValue, _ message: SQLValue) -> DatabaseError {
        var code = "P0001"
        if case .text(let text) = sqlstate, text.utf8.count == 5,
            text.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) })
        {
            code = text
        }
        let name = sqlText(constraint)
        return DatabaseError(
            code: code, message: sqlText(message) ?? "", constraint: name?.isEmpty == false ? name : nil)
    }

    /// `value -> key` on an object; nil for any other value or a missing key.
    static func member(_ value: JsonbValue?, _ key: String) -> JsonbValue? {
        guard case .object(let entries)? = value else { return nil }
        return entries.first { $0.key == key }?.value
    }

    /// `->>`: the text of a jsonb value; JSON null and a missing value are NULL.
    static func asText(_ value: JsonbValue?) -> String? {
        switch value {
        case nil, .null?: return nil
        case .string(let text)?: return text
        case .number(let number)?: return number.description
        case .bool(let flag)?: return flag ? "true" : "false"
        case let other?: return SQLJsonb.format(other)
        }
    }

    /// PostgreSQL's portfolio_cash_receipt(text): text that is not JSON gives NULL (the
    /// function caught invalid_text_representation); a \u0000 escape or a number out of
    /// numeric range still fails, as there.
    static func portfolioCashReceipt(_ data: SQLValue) throws -> String? {
        guard let text = sqlText(data) else { return nil }
        let envelope: JsonbValue
        do {
            envelope = try SQLJsonb.parse(text)
        } catch let error as SQLStateError where error.code == "22P02" {
            return nil
        }
        guard let receipt = member(envelope, "portfolioCashReceipt") else { return nil }
        guard asText(member(receipt, "version")) == "1" else { return nil }
        guard asText(member(member(receipt, "proof"), "kind")) == "closed_kinesis_cash" else { return nil }
        guard case .object? = member(receipt, "after") else { return nil }
        return SQLJsonb.format(receipt)
    }

    static let role = "income_recognition_role"

    /// Drops income_recognition_role when it is 'standard' or absent.
    static func normalizeSnapshot(_ value: JsonbValue) -> JsonbValue {
        guard (asText(member(value, role)) ?? "standard") == "standard" else { return value }
        switch value {
        case .object(let entries): return .object(entries.filter { $0.key != role })
        case .array(let items):
            return .array(items.filter { if case .string(role) = $0 { return false } else { return true } })
        default: return value
        }
    }

    public enum SnapshotKind: Sendable {
        case int, text, date, bool
    }

    /// The portfolio_transactions columns portfolio_income_transaction_snapshot takes, in order,
    /// and how each enters the snapshot.
    public static let snapshotColumns: [(name: String, kind: SnapshotKind)] = [
        ("id", .int), ("investment_id", .int), ("type", .text), ("date", .date), ("amount", .text),
        ("units", .text), ("price_per_unit", .text), ("fees", .text), ("taxes", .text), ("currency", .text),
        ("fx_rate_to_eur", .text), ("account_id", .int), ("note", .text), ("dividend_amount_convention", .text),
        ("is_recurring", .bool), ("recurrence_interval", .text), ("recurrence_end_date", .date),
        ("import_batch_id", .text), ("source_record_hash", .text), ("dedup_fingerprint", .text),
        ("dedup_fingerprint_version", .int), ("income_recognition_role", .text),
    ]

    /// `portfolio_income_transaction_snapshot(alias.id, alias.investment_id, ...)`.
    public static func snapshotSQL(alias: String) throws -> String {
        let bytes = Array(alias.utf8)
        func letter(_ b: UInt8) -> Bool { (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || b == 0x5F }
        guard let first = bytes.first, letter(first), bytes.allSatisfy({ letter($0) || ($0 >= 0x30 && $0 <= 0x39) })
        else { throw SQLFunctionArgumentError("invalid table alias: \(alias)") }
        let columns = snapshotColumns.map { "\(alias).\($0.name)" }.joined(separator: ", ")
        return "portfolio_income_transaction_snapshot(\(columns))"
    }

    static func snapshotValue(_ kind: SnapshotKind, _ value: SQLValue) throws -> JsonbValue {
        if value.isNull { return .null }
        switch kind {
        case .int: return .number(try ExactDecimal.parse(sqlText(value) ?? ""))
        case .bool:
            switch value {
            case .integer(1), .real(1): return .bool(true)
            default: return .bool(false)
            }
        case .date:
            // to_char(date, 'YYYY-MM-DD') prints a BC year without its suffix.
            var text = sqlText(value) ?? ""
            if text.hasSuffix(" BC") { text.removeLast(3) }
            return .string(text)
        case .text: return .string(sqlText(value) ?? "")
        }
    }

    /// PostgreSQL's portfolio_income_transaction_snapshot(portfolio_transactions).
    static func portfolioIncomeTransactionSnapshot(_ values: [SQLValue]) throws -> String {
        guard values.count == snapshotColumns.count else {
            throw SQLStateError(
                "portfolio_income_transaction_snapshot takes \(snapshotColumns.count) arguments, got \(values.count)",
                code: "42883")
        }
        let entries = try zip(snapshotColumns, values).map { column, value in
            (key: column.name, value: try snapshotValue(column.kind, value))
        }.sorted { SQLJsonb.compareKeys($0.key, $1.key) < 0 }
        return SQLJsonb.format(normalizeSnapshot(.object(entries)))
    }
}
