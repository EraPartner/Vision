import Foundation
import VisionNativeCore

/// `transactionExport.ts`: the streaming CSV/NDJSON export pipeline of `GET /export/csv`,
/// `GET /export/json` and `POST /bulk-export` — the keyset-paginated chunks over the export
/// joins, the probe 404, the byte-exact CSV row and NDJSON line, the per-account running
/// balance of `include_balance`, and the selector resolution of the bulk form.
enum TransactionExportArea {
    static let chunkSize = 1000

    // MARK: - Register

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.ExportTransactionsCsv.self) { request in
            try await database.run { session in
                try TransactionExportArea.export(session, request: request, format: "csv")
            }
        }
        backend.serve(OpenAPIOperations.ExportTransactionsJson.self) { request in
            try await database.run { session in
                try TransactionExportArea.export(session, request: request, format: "json")
            }
        }
        backend.serve(OpenAPIOperations.BulkExportTransactions.self) { request in
            try await database.run { session in try TransactionExportArea.bulkExport(session, request: request) }
        }
    }

    // MARK: - CSV escaping (`@vision/shared-utils/csv` with safe numeric strings)

    static func neutralizeFormula(_ value: String) -> String {
        var scalars = Substring(value).unicodeScalars
        while let first = scalars.first, first == " " || first == "\u{00A0}" { scalars.removeFirst() }  // lint:allow string-literal-compare the formula prefix characters, as the shared csv utility reads them
        guard let head = scalars.first else { return value }
        switch head {
        // lint:allow string-literal-compare the formula prefix characters, as the shared csv utility reads them
        case "=", "+", "-", "@", "\t", "\r": return "'" + value
        default: return value
        }
    }

    /// `escapeCsvValue(_, { treatNumericStringsAsSafe: true })` over a stored column's text.
    static func escape(_ value: String?) -> String {
        guard let value else { return "" }
        let strictNumeric: Bool
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        strictNumeric = parts.count <= 2 && parts.enumerated().allSatisfy { offset, part in
            let digits = offset == 0 && part.hasPrefix("-") ? part.dropFirst() : part
            return !digits.isEmpty
                && digits.unicodeScalars.allSatisfy { $0.value >= 0x30 && $0.value <= 0x39 }
        }
        let guarded = strictNumeric ? value : neutralizeFormula(value)
        if guarded.unicodeScalars.contains(where: { $0 == "\"" || $0 == "," || $0 == "\n" || $0 == "\r" }) {  // lint:allow string-literal-compare the quoting characters, as the shared csv utility reads them
            return "\"" + guarded.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        return guarded
    }

    // MARK: - The query

    /// The export query: the list's filter shape plus the multi-value `account_ids` and
    /// `bank_accounts` spellings the export schema adds.
    static func exportQuery(_ request: InProcessRequest) throws -> (filters: TransactionWhere, includeBalance: Bool) {
        var issues: [String] = []
        let (filters, query) = TransactionsArea.filterFields(request, &issues)
        var selection = filters
        let accountIds = TransactionsArea.idList(TransactionsArea.raw(request, "account_ids"), "account_ids", &issues)
        if let accountIds { selection.accountIds = Array(accountIds.prefix(TransactionsWhere.maxListSize)) }
        if let raw = TransactionsArea.raw(request, "bank_accounts"), raw != .null {
            let list = AccountsArea.looseText(raw).split(separator: ",")
                .map { JavaScriptWhitespace.trim(String($0)) }
                .filter { !$0.isEmpty }
            selection.bankAccounts = list.isEmpty ? nil : Array(list.prefix(TransactionsWhere.maxListSize))
        }
        guard issues.isEmpty else { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        return (selection, query.includeBalance)
    }

    // MARK: - The chunks

    /// One export row as the chunk SQL selects it.
    struct ExportRow: Sendable {
        let id: Int
        let date: String
        let bankAccount: String?
        // lint:allow raw-id the export row carries the account row id as a plain number
        let accountId: Int?
        let recipientName: String?
        let memo: String?
        let amount: String
        let currency: String?
        let balance: String?
        let categoryName: String
        let comment: String?
        let tags: String

        init(_ row: SQLRow) throws {
            id = try row.integerId("id")
            date = try row.text("date")
            bankAccount = try row.optionalText("bank_account")
            accountId = try row.optionalInt64("account_id").map { Int($0) }
            recipientName = try row.optionalText("recipient_name")
            memo = try row.optionalText("memo")
            amount = try row.text("amount")
            currency = try row.optionalText("currency")
            balance = try row.optionalText("balance")
            categoryName = try row.text("category_name")
            comment = try row.optionalText("comment")
            tags = (try? row.optionalText("tags::json")) ?? "[]"
        }

        /// The tag slugs of the `json_group_array` column.
        var tagSlugs: [String] {
            guard case .array(let items)? = JSValue.parse(tags) else { return [] }
            return items.map { $0.javaScriptString }
        }

        /// `buildCsvRow`.
        func csvRow(runningBalance: String?) -> String {
            var cols = [
                Self.escape(date),
                Self.escape(bankAccount),
                Self.escape(recipientName),
                Self.escape(memo),
                Self.escape(amount),
                Self.escape(currency),
                Self.escape(balance),
                Self.escape(categoryName),
                Self.escape(comment),
                Self.escape(tagSlugs.joined(separator: ";")),
            ]
            if let runningBalance { cols.append(Self.escape(runningBalance)) }
            return cols.joined(separator: ",")
        }

        /// `buildNdjsonRow`, key order and value shapes as `JSON.stringify` wrote them.
        func ndjsonLine() -> String {
            let fields: [(String, JSValue)] = [
                ("id", .int(id)),
                ("date", .string(date)),
                ("bank_account", bankAccount.map { .string($0) } ?? .null),
                ("recipient", recipientName.map { .string($0) } ?? .null),
                ("memo", memo.map { .string($0) } ?? .null),
                ("amount", .string(amount)),
                ("currency", currency.map { .string($0) } ?? .null),
                ("balance", balance.map { .string($0) } ?? .null),
                ("category", categoryName.isEmpty ? .null : .string(categoryName)),
                ("comment", comment.map { .string($0) } ?? .null),
                ("tags", .array(tagSlugs.map { .string($0) })),
            ]
            return JSValue.object(JSObject(fields)).jsonText
        }
    }

    /// `streamExport`'s loop over the keyset chunks, collecting the whole answer.
    static func stream(
        _ session: BackendSession, selection: TransactionWhere, format: String, includeBalance: Bool
    ) throws -> (body: String, rowCount: Int) {
        let clause = selection.clause
        let probe = try session.row(
            "SELECT 1 \(BulkSelection.exportJoins) WHERE \(clause.sql) LIMIT 1", clause.arguments)
        if probe == nil {
            throw BackendHTTPError.notFound("No transactions found matching filters")
        }
        var body = ""
        var rowCount = 0
        var runningBalances: [Int?: ExactDecimal] = [:]
        var cursorDate: String?
        // lint:allow raw-id the keyset cursor rows are identified by their plain row id
        var cursorId: Int?
        let csvHeader = includeBalance
            ? "Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Tags,Running Balance"
            : "Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Tags"
        if format == "csv" { body += "\(csvHeader)\n" }  // lint:allow string-literal-compare the export format name is a fixed literal
        while true {
            var sql = """
                SELECT t.id, t.date, acct.name AS bank_account, t.account_id, \
                COALESCE(pr.name, r.name) AS recipient_name, t.memo, t.amount, t.currency, t.balance, \
                CASE WHEN c.id IS NOT NULL THEN c.path_name \
                     WHEN rc.id IS NOT NULL THEN rc.path_name \
                     WHEN pc.id IS NOT NULL THEN pc.path_name ELSE '' END AS category_name, \
                t.comment, \
                (SELECT json_group_array(tag_slugs.slug) FROM ( \
                   SELECT tg.slug FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id \
                   WHERE tt.transaction_id = t.id AND tg.is_active = 1 ORDER BY tg.slug) tag_slugs) AS "tags::json"
                \(BulkSelection.exportJoins)
                WHERE \(clause.sql)
                """
            var arguments = clause.arguments
            if let cursorDate, let cursorId {
                sql += " AND (t.date, t.id) > (?, ?)"
                arguments += [.text(cursorDate), .integer(Int64(cursorId))]
            }
            sql += " ORDER BY t.date ASC, t.id ASC LIMIT \(chunkSize)"
            let rows = try session.rows(sql, arguments).map { try ExportRow($0) }
            guard let last = rows.last else { break }
            for row in rows {
                if format == "csv" {
                    var running: String?
                    if includeBalance {
                        let key = row.accountId
                        let amount = try ExactDecimal.parse(row.amount)
                        let next = (runningBalances[key] ?? ExactDecimal.zero).adding(amount)
                        runningBalances[key] = next
                        running = next.description
                    }
                    body += "\(row.csvRow(runningBalance: running))\n"
                } else {
                    body += "\(row.ndjsonLine())\n"
                }
                rowCount += 1
            }
            cursorDate = last.date
            cursorId = last.id
            if rows.count < chunkSize { break }
        }
        return (body, rowCount)
    }

    /// The file answer's filename: the timestamped export name of the TS route.
    static func filename(format: String) -> String {
        let stamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        return "transactions_export_\(String(stamp.prefix(19))).\(format == "csv" ? "csv" : "ndjson")"
    }

    // MARK: - The routes

    static func export(
        _ session: BackendSession, request: InProcessRequest, format: String
    ) throws -> HandlerResult {
        let (selection, includeBalance) = try exportQuery(request)
        let (body, _) = try stream(session, selection: selection, format: format, includeBalance: includeBalance)
        return HandlerResult.fileAnswer(Data(body.utf8), headers: [
            "Content-Type": format == "csv" ? "text/csv" : "application/x-ndjson",  // lint:allow string-literal-compare the export format name is a fixed literal
            "Content-Disposition": "attachment; filename=\(filename(format: format))",
        ])
    }

    /// `bulk-export`: the body of the bulk actions, the `format` shape and the selector
    /// resolution, answering with the `X-Exported-Count` of the selection.
    static func bulkExport(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let body = try TransactionBulkArea.bulkBody(request)
        let raw = body.raw
        var format = "csv"
        if let value = raw["format"], value != .null {
            guard value == .string("csv") || value == .string("json") else {
                throw BackendHTTPError.validation("`format` must be 'csv' or 'json'")
            }
            format = value == .string("csv") ? "csv" : "json"
        }
        let expected = try BulkSelection.expectedCount(body.expected, filter: body.filter)
        let txIds = try BulkSelection.resolve(
            session, ids: body.ids, filter: body.filter, allowEmpty: expected != nil)
        let txText = JSValue.array(txIds.map { .int($0) }).jsonText
        let countRows = try session.rows(
            "SELECT COUNT(*) AS \"count\" FROM transactions WHERE id IN (SELECT value FROM json_each(?))",
            [.text(txText)])
        let count = Int(try countRows[0].int64("count"))
        let includeBalance = raw["include_balance"] == .bool(true)
        let probe = try session.row(
            "SELECT 1 \(BulkSelection.exportJoins) WHERE t.id IN (SELECT value FROM json_each(?)) LIMIT 1",
            [.text(txText)])
        if probe == nil {
            throw BackendHTTPError.notFound("No transactions found matching filters")
        }
        var body2 = ""
        var rowCount = 0
        var runningBalances: [Int?: ExactDecimal] = [:]
        let csvHeader = includeBalance
            ? "Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Tags,Running Balance"
            : "Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Tags"
        if format == "csv" { body2 += "\(csvHeader)\n" }  // lint:allow string-literal-compare the export format name is a fixed literal
        while true {
            let sql = """
                SELECT t.id, t.date, acct.name AS bank_account, t.account_id, \
                COALESCE(pr.name, r.name) AS recipient_name, t.memo, t.amount, t.currency, t.balance, \
                CASE WHEN c.id IS NOT NULL THEN c.path_name \
                     WHEN rc.id IS NOT NULL THEN rc.path_name \
                     WHEN pc.id IS NOT NULL THEN pc.path_name ELSE '' END AS category_name, \
                t.comment, \
                (SELECT json_group_array(tag_slugs.slug) FROM ( \
                   SELECT tg.slug FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id \
                   WHERE tt.transaction_id = t.id AND tg.is_active = 1 ORDER BY tg.slug) tag_slugs) AS "tags::json"
                \(BulkSelection.exportJoins)
                WHERE t.id IN (SELECT value FROM json_each(?))
                ORDER BY t.date ASC, t.id ASC LIMIT \(chunkSize)
                """
            let rows = try session.rows(sql, [.text(txText)]).map { try ExportRow($0) }
            guard let last = rows.last else { break }
            for row in rows {
                if format == "csv" {
                    var running: String?
                    if includeBalance {
                        let key = row.accountId
                        let amount = try ExactDecimal.parse(row.amount)
                        let next = (runningBalances[key] ?? ExactDecimal.zero).adding(amount)
                        runningBalances[key] = next
                        running = next.description
                    }
                    body2 += "\(row.csvRow(runningBalance: running))\n"
                } else {
                    body2 += "\(row.ndjsonLine())\n"
                }
                rowCount += 1
            }
            if rows.count < chunkSize { break }
        }
        return HandlerResult.fileAnswer(Data(body2.utf8), headers: [
            "Content-Type": format == "csv" ? "text/csv" : "application/x-ndjson",  // lint:allow string-literal-compare the export format name is a fixed literal
            "Content-Disposition": "attachment; filename=\(filename(format: format))",
            "X-Exported-Count": String(count),
        ])
    }
}
