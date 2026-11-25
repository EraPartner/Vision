import Foundation
import VisionNativeCore

/// `routes/splits.ts` over `splitService.ts` and `splitRepository.ts`: transaction
/// splitting and debt tracking. The validation math is `lib/calculations/splits.ts`
/// (`validateSplitAllocation` at the NUMERIC(18,4) storage precision, the bulk
/// presets, the owed-summary projection), and the owed views collapse alias
/// recipients into their primary through `recipient_group`.
enum SplitsArea {
    static let maxBulkIds = 500
    static let bulkModes = ["equal", "full"]

    // MARK: - Rows

    /// The `transaction_splits` columns of the `ts` alias, in the table's order.
    static let splitColumns =
        "ts.id, ts.transaction_id, ts.recipient_id, ts.amount, ts.note, ts.is_settled, ts.created_at, ts.updated_at"

    /// A `transaction_splits` row shaped as `formatSplit` wires it.
    static func splitFields(_ row: SQLRow) throws -> [String: JSONValue] {
        [
            "id": .int(try row.integerId("id")),
            "transaction_id": .int(try row.integerId("transaction_id")),
            "recipient_id": .int(try row.integerId("recipient_id")),
            "recipient_name": try row.optionalText("recipient_name").flatMap {
                $0.isEmpty ? nil : JSONValue.string($0)
            } ?? .null,
            "amount": AccountsArea.number(try DecimalJS.from(try row.text("amount")).toNumber),
            "amount_paid": AccountsArea.number(
                try DecimalJS.from(try row.text("amount_paid")).toNumber),
            "note": try row.optionalText("note").map(JSONValue.string) ?? .null,
            "is_settled": .bool(try row.bool("is_settled")),
            "created_at": .string(try row.instant("created_at").text),
            "updated_at": .string(try row.instant("updated_at").text),
        ]
    }

    /// A `split_payments` row shaped as `formatPayment` wires it.
    static func paymentJSON(_ row: SQLRow) throws -> JSONValue {
        .object([
            "id": .int(try row.integerId("id")),
            "split_id": .int(try row.integerId("split_id")),
            "amount": AccountsArea.number(try DecimalJS.from(try row.text("amount")).toNumber),
            "paid_at": .string(try row.text("paid_at")),
            "note": try row.optionalText("note").map(JSONValue.string) ?? .null,
            "created_at": .string(try row.instant("created_at").text),
        ])
    }

    // MARK: - Validation helpers

    /// zod's "expected a value of type" message for an unparseable body.
    static func expectedObject(_ body: JSValue?) -> String {
        "Invalid input: expected object, received \(body?.zodTypeName ?? "undefined")"
    }

    /// A value is falsy the way the loose schemas read it: null, absent, false, 0 or "".
    static func isFalsy(_ value: JSValue?) -> Bool {
        guard let value else { return true }
        switch value {
        case .null: return true
        case .bool(let flag): return !flag
        case .number(let number): return number == 0 || !number.isFinite
        case .string(let text): return text.isEmpty
        default: return false
        }
    }

    /// `note || null`: an empty or absent note reads as null.
    static func rawNote(_ value: JSValue?) -> String? {
        guard let value, value != .null, let text = value.stringValue, !text.isEmpty else { return nil }
        return text
    }

    /// `entityIdParamsSchema`'s 400: the path id, a strict positive integer.
    static func pathId(_ request: InProcessRequest, _ name: String = "id") throws -> Int {
        guard let raw = request.pathParameters[name], let id = TransactionsArea.validId(.string(raw)) else {
            throw BackendHTTPError.validation("id must be a positive integer")
        }
        return id
    }

    static func page(_ request: InProcessRequest) -> PageParams? {
        PageParams.optional(
            limit: request.query("limit"), offset: request.query("offset"), maxLimit: 1000)
    }

    /// `?currency=` for the converted owed figures; EUR when absent.
    static func owedCurrency(_ request: InProcessRequest) throws -> String {
        guard let raw = request.query("currency"), !raw.isEmpty else { return "EUR" }
        let code = JavaScriptWhitespace.trim(raw.uppercased())
        guard AccountsArea.isCurrencyCode(code) else {
            throw BackendHTTPError.validation("currency must be a 3-letter ISO code")
        }
        return code
    }

    // MARK: - Shared SQL

    /// `recipientGroupCte`: the recipient, its aliases, its primary and the primary's
    /// aliases — one group collapsed per ADR-014.
    static func recipientGroup() -> String {
        """
        WITH recipient_group AS (
          SELECT id FROM recipients
          WHERE id = ?1
             OR primary_recipient_id = ?1
             OR id = (SELECT primary_recipient_id FROM recipients WHERE id = ?1 AND primary_recipient_id IS NOT NULL)
             OR primary_recipient_id = (SELECT primary_recipient_id FROM recipients WHERE id = ?1 AND primary_recipient_id IS NOT NULL)
        )
        """
    }

    /// `paidSql`: the split's summed payments, a decimal string scalar over the `ts` alias.
    static let paid =
        "(SELECT dec_sum(sp_paid.amount) FROM split_payments sp_paid WHERE sp_paid.split_id = ts.id)"

    /// `lockAndGetTotals`: the transaction's absolute amount and its current split sum.
    static func splitTotals(
        _ session: BackendSession, _ transaction: TransactionID
    ) throws -> (total: DecimalJS, splits: DecimalJS)? {
        guard
            try session.row("SELECT id FROM transactions WHERE id = ?", [.integer(Int64(transaction.rawValue))]) != nil
        else { return nil }
        guard
            let row = try session.row(
                """
                SELECT dec_abs(t.amount) AS transaction_total,
                       COALESCE(dec_sum(ts.amount), '0') AS current_split_total
                  FROM transactions t
                LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
                 WHERE t.id = ?
                 GROUP BY t.id, t.amount
                """,
                [.integer(Int64(transaction.rawValue))])
        else { throw SQLRowDecodingError(column: "transactions", problem: "split totals returned no row") }
        return (
            try DecimalJS.from(try row.text("transaction_total")),
            try DecimalJS.from(try row.text("current_split_total"))
        )
    }

    /// `validateSplitAllocation` at the NUMERIC(18,4) storage precision.
    static func validateAllocation(new: DecimalJS, transactionTotal: DecimalJS, currentSplitTotal: DecimalJS) throws {
        guard new.gt(.zero) else { throw BackendHTTPError.validation("Split amount must be a positive number") }
        let projected = currentSplitTotal.plus(new).toDecimalPlaces(4)
        if projected.gt(transactionTotal.toDecimalPlaces(4)) {
            throw BackendHTTPError.validation("Split amount exceeds transaction total")
        }
    }

    /// The split's writer: INSERT, then the re-read with `amount_paid` of `'0'` and the
    /// recipient's name — the same re-select idiom `insertSplitInTransaction` uses.
    static func insertSplit(
        _ session: BackendSession, transaction: TransactionID, recipient: RecipientID, amount: Double, note: String?
    ) throws -> JSONValue {
        guard
            let key = try session.row(
                """
                INSERT INTO transaction_splits (transaction_id, recipient_id, amount, note)
                VALUES (?, ?, vision_numeric(?, 18, 4), ?) RETURNING id
                """,
                [
                    .integer(Int64(transaction.rawValue)), .integer(Int64(recipient.rawValue)),
                    .text(SQLArguments.javaScriptText(amount)), note.map { SQLValue.text($0) } ?? .null,
                ])
        else { throw SQLRowDecodingError(column: "transaction_splits", problem: "split INSERT returned no row") }
        guard
            let row = try session.row(
                """
                SELECT \(splitColumns), '0' AS amount_paid, r.name AS recipient_name
                  FROM transaction_splits ts
                LEFT JOIN recipients r ON ts.recipient_id = r.id
                 WHERE ts.id = ?
                """,
                [.integer(Int64(try key.integerId("id")))])
        else { throw SQLRowDecodingError(column: "transaction_splits", problem: "inserted split not found") }
        return .object(try splitFields(row))
    }

    // MARK: - The owed reads

    /// One owed-summary aggregate row, as `getOwedSummaryRows` emits it.
    struct OwedRow {
        let recipientId: RecipientID
        let name: String
        let currency: String
        let totalOwed: DecimalJS
        let totalPaid: DecimalJS
        let splitCount: Int
    }

    /// `getOwedSummary`: per-recipient sums in the target currency; currencies without
    /// a rate are counted per recipient, never added 1:1.
    static func owedSummary(_ session: BackendSession, target: String) throws -> (items: [[String: JSONValue]], summary: JSONValue) {
        let rows = try session.rows(
            """
            SELECT COALESCE(r.primary_recipient_id, r.id) AS recipient_id,
                   COALESCE(pr.name, r.name) AS recipient_name,
                   t.currency,
                   dec_sum(a.original_amount) AS total_owed,
                   dec_sum(a.paid_amount) AS total_paid,
                   CAST(COUNT(a.split_id) AS TEXT) AS split_count
              FROM agg_split_outstanding a
              JOIN recipients r ON r.id = a.recipient_id
            LEFT JOIN recipients pr ON pr.id = r.primary_recipient_id
              JOIN transaction_splits ts ON ts.id = a.split_id
              JOIN transactions t ON t.id = ts.transaction_id
             WHERE ts.is_settled = 0
             GROUP BY COALESCE(r.primary_recipient_id, r.id), COALESCE(pr.name, r.name), t.currency
            """
        ).map { row throws -> OwedRow in
            OwedRow(
                recipientId: RecipientID(rawValue: try row.integerId("recipient_id")),
                name: try row.text("recipient_name"),
                currency: AccountsArea.storedCurrencyCode(try row.optionalText("currency")),
                totalOwed: try DecimalJS.from(try row.text("total_owed")),
                totalPaid: try DecimalJS.from(try row.text("total_paid")),
                splitCount: Int(try row.text("split_count")) ?? 0)
        }
        let rates = try AccountsArea.latestRatesToEur(session)
        struct Entry {
            var name = ""
            var owed: [DecimalJS] = []
            var paid: [DecimalJS] = []
            var splitCount = 0
            var unconvertedCount = 0
            var unconvertedCurrencies: Set<String> = []
        }
        var recipients: [Entry] = []
        var order: [RecipientID] = []
        var position: [RecipientID: Int] = [:]
        for row in rows {
            if position[row.recipientId] == nil {
                position[row.recipientId] = recipients.count
                order.append(row.recipientId)
                recipients.append(Entry(name: row.name))
            }
            let index = position[row.recipientId] ?? 0
            recipients[index].splitCount += row.splitCount
            let convertedOwed = try AccountsArea.convert(row.totalOwed, from: row.currency, to: target, rates: rates)
            let convertedPaid = try AccountsArea.convert(row.totalPaid, from: row.currency, to: target, rates: rates)
            if let convertedOwed, let convertedPaid {
                recipients[index].owed.append(convertedOwed)
                recipients[index].paid.append(convertedPaid)
            } else if row.totalOwed.gt(row.totalPaid) {
                recipients[index].unconvertedCount += row.splitCount
                recipients[index].unconvertedCurrencies.insert(row.currency)
            }
        }
        // `computeOwedSummary`: cents-rounded figures, zero-remaining groups dropped,
        // remaining descending (JS sort is stable — the SQL order breaks ties).
        var projected: [(recipientId: RecipientID, fields: [String: JSONValue], remaining: Double)] = []
        for (offset, id) in order.enumerated() {
            let entry = recipients[offset]
            let totalOwed = DecimalMoney.roundToCents(entry.owed.reduce(DecimalJS.zero) { $0.plus($1) }).toNumber
            let totalPaid = DecimalMoney.roundToCents(entry.paid.reduce(DecimalJS.zero) { $0.plus($1) }).toNumber
            let remaining = DecimalMoney.roundToCents(
                try DecimalJS.from(SQLArguments.javaScriptText(max(0, totalOwed - totalPaid)))).toNumber
            guard remaining > 0 else { continue }
            projected.append((
                id,
                [
                    "recipient_id": .int(id.rawValue), "recipient_name": .string(entry.name),
                    "total_owed": AccountsArea.number(totalOwed),
                    "total_paid": AccountsArea.number(totalPaid),
                    "remaining": AccountsArea.number(remaining),
                    "split_count": .int(entry.splitCount),
                ],
                remaining
            ))
        }
        // A recipient whose only open splits lack a rate still owes money: keep the row
        // (with zero converted figures) after the convertible ones.
        for (offset, id) in order.enumerated() where !projected.contains(where: { $0.recipientId == id }) {
            let entry = recipients[offset]
            guard entry.unconvertedCount > 0 else { continue }
            projected.append((
                id,
                [
                    "recipient_id": .int(id.rawValue), "recipient_name": .string(entry.name),
                    "total_owed": AccountsArea.number(0), "total_paid": AccountsArea.number(0),
                    "remaining": AccountsArea.number(0), "split_count": .int(entry.splitCount),
                ],
                0
            ))
        }
        let sorted = projected.enumerated().sorted {
            $0.element.remaining == $1.element.remaining
                ? $0.offset < $1.offset : $0.element.remaining > $1.element.remaining
        }
        var allUnconvertedCount = 0
        var allUnconvertedCurrencies: Set<String> = []
        for entry in recipients {
            allUnconvertedCount += entry.unconvertedCount
            allUnconvertedCurrencies.formUnion(entry.unconvertedCurrencies)
        }
        let items: [[String: JSONValue]] = sorted.map { pair in
            let entry = recipients[position[pair.element.recipientId] ?? 0]
            return pair.element.fields.merging([
                "unconverted_count": .int(entry.unconvertedCount),
                "unconverted_currencies": .array(entry.unconvertedCurrencies.sorted().map(JSONValue.string)),
            ]) { _, new in new }
        }
        let remaining = DecimalMoney.roundToCents(
            try sorted.map { try DecimalJS.from(SQLArguments.javaScriptText($0.element.remaining)) }
                .reduce(DecimalJS.zero) { $0.plus($1) })
        let summary = JSONValue.object([
            "currency": .string(target), "remaining": AccountsArea.number(remaining.toNumber),
            "unconverted_count": .int(allUnconvertedCount),
            "unconverted_currencies": .array(allUnconvertedCurrencies.sorted().map(JSONValue.string)),
        ])
        return (items, summary)
    }

    /// `getOwedRecipientSummary`: the group's outstanding per currency, converted.
    static func owedRecipientSummary(_ session: BackendSession, recipient: RecipientID, target: String) throws -> JSONValue {
        let rows = try session.rows(
            """
            \(recipientGroup())
            SELECT t.currency,
                   dec_sum(dec_greatest(dec_sub(ts.amount, COALESCE(\(paid), '0')), '0')) AS remaining,
                   COUNT(ts.id) AS split_count
              FROM transaction_splits ts
              JOIN transactions t ON ts.transaction_id = t.id
             WHERE ts.recipient_id IN (SELECT id FROM recipient_group) AND ts.is_settled = 0
             GROUP BY t.currency
            """,
            [.integer(Int64(recipient.rawValue))])
        let rates = try AccountsArea.latestRatesToEur(session)
        var amounts: [DecimalJS] = []
        var unconvertedCount = 0
        var unconvertedCurrencies: Set<String> = []
        for row in rows {
            let from = AccountsArea.storedCurrencyCode(try row.optionalText("currency"))
            let remaining = try DecimalJS.from(try row.text("remaining"))
            let count = Int(try row.int64("split_count"))
            if let converted = try AccountsArea.convert(remaining, from: from, to: target, rates: rates) {
                amounts.append(converted)
            } else if !remaining.isZero {
                unconvertedCount += count
                unconvertedCurrencies.insert(from)
            }
        }
        let remaining = DecimalMoney.roundToCents(amounts.reduce(DecimalJS.zero) { $0.plus($1) })
        return .object([
            "currency": .string(target), "remaining": AccountsArea.number(remaining.toNumber),
            "unconverted_count": .int(unconvertedCount),
            "unconverted_currencies": .array(unconvertedCurrencies.sorted().map(JSONValue.string)),
        ])
    }

    /// `getOwedByRecipient`: the group's unsettled splits, newest transaction first.
    static func owedByRecipient(
        _ session: BackendSession, recipient: RecipientID, page: PageParams?
    ) throws -> [[String: JSONValue]] {
        var pageClause = ""
        var arguments: [SQLValue] = [.integer(Int64(recipient.rawValue))]
        if let page {
            pageClause = " LIMIT ?2 OFFSET ?3"
            arguments += [page.limit.sqlValue, page.offset.sqlValue]
        }
        let rows = try session.rows(
            """
            \(recipientGroup())
            SELECT \(splitColumns),
                   t.date AS transaction_date, t.memo AS transaction_memo,
                   t.amount AS transaction_amount, t.currency AS transaction_currency,
                   acct.name AS bank_account,
                   COALESCE(pr.name, r.name) AS transaction_recipient_name,
                   COALESCE(\(paid), '0') AS amount_paid
              FROM transaction_splits ts
              JOIN transactions t ON ts.transaction_id = t.id
            LEFT JOIN recipients r ON t.recipient_id = r.id
            LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
            LEFT JOIN accounts acct ON t.account_id = acct.id
             WHERE ts.recipient_id IN (SELECT id FROM recipient_group) AND ts.is_settled = 0
             ORDER BY t.date DESC\(pageClause)
            """,
            arguments)
        return try rows.map { row in
            var fields = try splitFields(row)
            let owed = try DecimalJS.from(try row.text("amount"))
            let paidAmount = try DecimalJS.from(try row.text("amount_paid"))
            let remaining = owed.minus(paidAmount)
            fields["transaction_date"] = .string(try row.text("transaction_date"))
            fields["transaction_memo"] = try row.optionalText("transaction_memo").map(JSONValue.string) ?? .null
            fields["transaction_amount"] = AccountsArea.number(
                try DecimalJS.from(try row.text("transaction_amount")).toNumber)
            fields["transaction_currency"] = .string(try row.text("transaction_currency"))
            fields["bank_account"] = try row.optionalText("bank_account").map(JSONValue.string) ?? .null
            fields["transaction_recipient_name"] =
                try row.optionalText("transaction_recipient_name").map(JSONValue.string) ?? .null
            fields["remaining"] = AccountsArea.number(
                DecimalMoney.roundToCents(remaining.lt(.zero) ? DecimalJS.zero : remaining).toNumber)
            return fields
        }
    }

    static func countOwed(_ session: BackendSession, recipient: RecipientID) throws -> Int {
        let row = try session.row(
            """
            \(recipientGroup())
            SELECT COUNT(*) AS n FROM transaction_splits ts
             WHERE ts.recipient_id IN (SELECT id FROM recipient_group) AND ts.is_settled = 0
            """,
            [.integer(Int64(recipient.rawValue))])
        return (try row.map { try Int($0.int64("n")) }) ?? 0
    }

    // MARK: - Read handlers

    static func owedSummaryResult(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let target = try owedCurrency(request)
        let page = page(request)
        let (all, summary) = try owedSummary(session, target: target)
        let items = page.map { page -> [[String: JSONValue]] in
            let first = min(Int(page.offset.value), all.count)
            let last = min(first + Int(page.limit.value), all.count)
            return Array(all[first..<last])
        } ?? all
        var body = listBody(items.map(JSONValue.object), total: all.count, page: page)
        body["summary"] = summary
        return HandlerResult(data: .object(body))
    }

    static func owedByRecipientResult(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let recipient = RecipientID(rawValue: try pathId(request))
        let target = try owedCurrency(request)
        let page = page(request)
        let splits = try owedByRecipient(session, recipient: recipient, page: page)
        let total = (try page.map { _ in try countOwed(session, recipient: recipient) }) ?? splits.count
        var body: [String: JSONValue] = ["items": .array(splits.map(JSONValue.object)), "total": .int(total)]
        if let page {
            body["limit"] = page.limit.json
            body["offset"] = page.offset.json
        }
        body["summary"] = try owedRecipientSummary(session, recipient: recipient, target: target)
        return HandlerResult(data: .object(body))
    }

    static func splitsByTransaction(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let transaction = TransactionID(rawValue: try pathId(request))
        let page = page(request)
        var pageClause = ""
        var arguments: [SQLValue] = [.integer(Int64(transaction.rawValue))]
        if let page {
            pageClause = " LIMIT ?2 OFFSET ?3"
            arguments += [page.limit.sqlValue, page.offset.sqlValue]
        }
        let rows = try session.rows(
            """
            SELECT \(splitColumns), r.name AS recipient_name,
                   COALESCE(dec_sum(sp.amount), '0') AS amount_paid
              FROM transaction_splits ts
            LEFT JOIN recipients r ON r.id = ts.recipient_id
            LEFT JOIN split_payments sp ON sp.split_id = ts.id
             WHERE ts.transaction_id = ?
             GROUP BY ts.id, r.name
             ORDER BY ts.created_at\(pageClause)
            """,
            arguments)
        let items = try rows.map { JSONValue.object(try splitFields($0)) }
        let total = try page.map { _ -> Int in
            guard
                let count = try session.row(
                    "SELECT CAST(COUNT(*) AS TEXT) AS n FROM transaction_splits WHERE transaction_id = ?",
                    [.integer(Int64(transaction.rawValue))])
            else { return 0 }
            return Int(try count.text("n")) ?? 0
        } ?? items.count
        return HandlerResult(data: .object(listBody(items, total: total, page: page)))
    }

    static func payments(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let split = SplitID(rawValue: try pathId(request))
        let page = page(request)
        var pageClause = ""
        var arguments: [SQLValue] = [.integer(Int64(split.rawValue))]
        if let page {
            pageClause = " LIMIT ?2 OFFSET ?3"
            arguments += [page.limit.sqlValue, page.offset.sqlValue]
        }
        let rows = try session.rows(
            """
            SELECT id, split_id, amount, paid_at, note, created_at
              FROM split_payments
             WHERE split_id = ?
             ORDER BY paid_at DESC\(pageClause)
            """,
            arguments)
        let items = try rows.map(paymentJSON)
        let total = try page.map { _ -> Int in
            guard
                let count = try session.row(
                    "SELECT CAST(COUNT(*) AS TEXT) AS n FROM split_payments WHERE split_id = ?",
                    [.integer(Int64(split.rawValue))])
            else { return 0 }
            return Int(try count.text("n")) ?? 0
        } ?? items.count
        return HandlerResult(data: .object(listBody(items, total: total, page: page)))
    }

    /// `getOwedExportRowsByRecipient` + the route's CSV grid: only `amount` is recomputed
    /// (the split remaining), everything else is the stored column's text.
    static func owedExport(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let recipient = RecipientID(rawValue: try pathId(request))
        let rows = try session.rows(
            """
            \(recipientGroup())
            SELECT t.date, acct.name AS bank_account,
                   COALESCE(pr.name, tr.name) AS recipient_name,
                   t.memo, dec_sub(ts.amount, COALESCE(\(paid), '0')) AS amount,
                   t.currency, t.balance,
                   CASE
                     WHEN c.id IS NOT NULL THEN c.path_name
                     WHEN rc.id IS NOT NULL THEN rc.path_name
                     WHEN pc.id IS NOT NULL THEN pc.path_name
                     ELSE ''
                   END AS category_name,
                   t.comment
              FROM transaction_splits ts
              JOIN transactions t ON ts.transaction_id = t.id
            LEFT JOIN accounts acct ON t.account_id = acct.id
            LEFT JOIN recipients tr ON t.recipient_id = tr.id
            LEFT JOIN recipients pr ON tr.primary_recipient_id = pr.id
            LEFT JOIN categories c ON t.category_id = c.id
            LEFT JOIN categories rc ON tr.default_category_id = rc.id
            LEFT JOIN categories pc ON pr.default_category_id = pc.id
             WHERE ts.recipient_id IN (SELECT id FROM recipient_group)
               AND ts.is_settled = 0
               AND dec_sign(dec_sub(ts.amount, COALESCE(\(paid), '0'))) > 0
             ORDER BY t.date ASC
            """,
            [.integer(Int64(recipient.rawValue))])
        guard !rows.isEmpty else {
            throw BackendHTTPError.notFound("No unsettled owed transactions found for recipient")
        }
        let header = "Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment"
        let lines = try rows.map { row -> String in
            [
                TransactionExportArea.escape(try row.optionalText("date")),
                TransactionExportArea.escape(try row.optionalText("bank_account")),
                TransactionExportArea.escape(try row.optionalText("recipient_name")),
                TransactionExportArea.escape(try row.optionalText("memo")),
                TransactionExportArea.escape(
                    SQLArguments.javaScriptText(
                        try DecimalJS.from(try row.text("amount")).toNumber)),
                TransactionExportArea.escape(try row.optionalText("currency")),
                TransactionExportArea.escape(try row.optionalText("balance")),
                TransactionExportArea.escape(try row.optionalText("category_name")),
                TransactionExportArea.escape(try row.optionalText("comment")),
            ].joined(separator: ",")
        }
        let csv = ([header] + lines).joined(separator: "\n")
        let stamp = try SQLTimestamps.formatInstant(session.currentInstant())
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: ".", with: "-")
        let filename = "owed_transactions_recipient_\(recipient.rawValue)_\(String(stamp.prefix(19))).csv"
        return HandlerResult.fileAnswer(
            Data(csv.utf8),
            headers: [
                "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=\(filename)",
            ])
    }

    // MARK: - Writes

    /// `createSplitSchema`: presence, id and amount checks, loose over the raw body.
    static func createSplitFields(
        _ body: JSValue?
    ) throws -> (transaction: TransactionID, recipient: RecipientID, amount: Double, note: String?) {
        guard let object = body?.objectValue else {
            throw BackendHTTPError.validation(expectedObject(body))
        }
        let rawTransaction = object["transaction_id"]
        let rawRecipient = object["recipient_id"]
        let rawAmount = object["amount"]
        // `!data.transaction_id || !data.recipient_id || data.amount == null` — the falsy
        // 0 hits the missing-fields message before validateId runs.
        if isFalsy(rawTransaction) || isFalsy(rawRecipient) || rawAmount == nil || rawAmount == .null {
            throw BackendHTTPError.validation(
                "Missing required fields: transaction_id, recipient_id, amount")
        }
        guard let transaction = TransactionsArea.validId(rawTransaction) else {
            throw BackendHTTPError.validation("transaction_id must be a positive integer")
        }
        guard let recipient = TransactionsArea.validId(rawRecipient) else {
            throw BackendHTTPError.validation("recipient_id must be a positive integer")
        }
        let number = rawAmount?.javaScriptNumber ?? .nan
        guard number.isFinite else {
            throw BackendHTTPError.validation("amount must be a finite number")
        }
        return (
            TransactionID(rawValue: transaction), RecipientID(rawValue: recipient), number,
            rawNote(object["note"])
        )
    }

    static func createSplit(_ session: BackendSession, body: JSValue?) throws -> HandlerResult {
        let split = try session.transaction { () throws -> JSONValue in
            let input = try createSplitFields(body)
            guard let totals = try splitTotals(session, input.transaction) else {
                throw BackendHTTPError.notFound("Transaction not found")
            }
            try validateAllocation(
                new: try DecimalJS.from(SQLArguments.javaScriptText(input.amount)),
                transactionTotal: totals.total, currentSplitTotal: totals.splits)
            return try insertSplit(
                session, transaction: input.transaction, recipient: input.recipient,
                amount: input.amount, note: input.note)
        }
        return HandlerResult(status: 201, data: split)
    }

    /// A candidate split row, prepared for the batch writer.
    struct PreparedSplit {
        let recipient: RecipientID
        let amount: Double
        let note: String?
    }

    /// `batchSplitsSchema`: every row parses or the request refuses before writing, and
    /// the 400 names every offending row.
    static func batchFields(_ body: JSValue?) throws -> (transaction: TransactionID, splits: [PreparedSplit]) {
        guard let object = body?.objectValue else {
            throw BackendHTTPError.validation(expectedObject(body))
        }
        let rawTransaction = object["transaction_id"]
        guard !isFalsy(rawTransaction), case .array(let rawSplits)? = object["splits"], !rawSplits.isEmpty
        else {
            throw BackendHTTPError.validation("Missing required fields: transaction_id, splits[]")
        }
        guard let transaction = TransactionsArea.validId(rawTransaction) else {
            throw BackendHTTPError.validation("transaction_id must be a positive integer")
        }
        var prepared: [PreparedSplit] = []
        var rejected: [String] = []
        for (index, raw) in rawSplits.enumerated() {
            guard let row = raw.objectValue else {
                rejected.append("splits[\(index)] (\(expectedObject(raw)))")
                continue
            }
            var issues: [String] = []
            let recipient = TransactionsArea.validId(row["recipient_id"])
            if recipient == nil { issues.append("recipient_id: recipient_id must be a positive integer") }
            let amount = row["amount"]?.javaScriptNumber ?? .nan
            if row["amount"] == nil || row["amount"] == .null || !amount.isFinite {
                issues.append("amount: amount must be a finite number")
            }
            guard issues.isEmpty, let recipient else {
                rejected.append("splits[\(index)] (\(issues.joined(separator: ", ")))")
                continue
            }
            prepared.append(
                PreparedSplit(
                    recipient: RecipientID(rawValue: recipient), amount: amount, note: rawNote(row["note"])))
        }
        if !rejected.isEmpty {
            throw BackendHTTPError.validation(
                "Invalid splits, no splits were created: \(rejected.joined(separator: "; "))")
        }
        return (TransactionID(rawValue: transaction), prepared)
    }

    static func createBatch(_ session: BackendSession, body: JSValue?) throws -> HandlerResult {
        let (transaction, prepared) = try batchFields(body)
        let items = try session.transaction { () throws -> [JSONValue] in
            guard let totals = try splitTotals(session, transaction) else {
                throw BackendHTTPError.notFound("Transaction not found")
            }
            for split in prepared {
                guard split.amount > 0 else {
                    throw BackendHTTPError.validation("Split amount must be a positive number")
                }
            }
            let sum = try prepared.reduce(DecimalJS.zero) {
                $0.plus(try DecimalJS.from(SQLArguments.javaScriptText($1.amount)))
            }
            try validateAllocation(new: sum, transactionTotal: totals.total, currentSplitTotal: totals.splits)
            var marks: [String] = []
            var arguments: [SQLValue] = []
            for split in prepared {
                marks.append("(?, ?, vision_numeric(?, 18, 4), ?)")
                arguments += [
                    .integer(Int64(transaction.rawValue)), .integer(Int64(split.recipient.rawValue)),
                    .text(SQLArguments.javaScriptText(split.amount)),
                    split.note.map { SQLValue.text($0) } ?? .null,
                ]
            }
            let keys = try session.rows(
                """
                INSERT INTO transaction_splits (transaction_id, recipient_id, amount, note)
                VALUES \(marks.joined(separator: ", ")) RETURNING id
                """,
                arguments)
            let ids = JSValue.array(try keys.map { .int(try $0.integerId("id")) }).jsonText
            let rows = try session.rows(
                """
                SELECT \(splitColumns), '0' AS amount_paid, r.name AS recipient_name
                  FROM transaction_splits ts
                LEFT JOIN recipients r ON ts.recipient_id = r.id
                 WHERE ts.id IN (SELECT value FROM json_each(?))
                 ORDER BY ts.id
                """,
                [.text(ids)])
            return try rows.map { .object(try splitFields($0)) }
        }
        return HandlerResult(
            status: 201,
            data: .object(["items": .array(items), "total": .int(items.count)]))
    }

    /// `bulkSplitSchema`: ids all-or-nothing (each entry named), the mode a fixed
    /// preset, the note at most 500 characters.
    static func bulkFields(_ body: JSValue?) throws -> (
        transactions: [TransactionID], recipient: RecipientID, mode: String, note: String?
    ) {
        guard let object = body?.objectValue else {
            throw BackendHTTPError.validation(expectedObject(body))
        }
        var issues: [String] = []
        var rawIds: [JSValue]? = nil
        if case .array(let ids)? = object["transaction_ids"], !ids.isEmpty, ids.count <= maxBulkIds {
            rawIds = ids
        } else {
            issues.append("transaction_ids: transaction_ids must be a non-empty array of up to \(maxBulkIds) IDs")
        }
        let recipient = TransactionsArea.validId(object["recipient_id"])
        if recipient == nil {
            issues.append("recipient_id: recipient_id must be a positive integer")
        }
        let mode = AccountsArea.looseText(object["mode"] ?? .string(""))
        if !bulkModes.contains(mode) {
            issues.append("mode: mode must be one of: equal, full")
        }
        var note: String?
        if let rawNote = object["note"], rawNote != .null {
            if let text = rawNote.stringValue {
                note = text
                guard text.count <= 500 else {
                    issues.append("note: Too big: expected string to have <=500 characters")
                }
            } else {
                issues.append("note: Invalid input: expected string, received \(rawNote.zodTypeName)")
            }
        }
        guard issues.isEmpty, let ids = rawIds, let recipient else {
            throw BackendHTTPError.validation(issues.joined(separator: "; "))
        }
        var transactions: [TransactionID] = []
        var rejected: [String] = []
        for raw in ids {
            if let id = TransactionsArea.validId(raw) {
                transactions.append(TransactionID(rawValue: id))
            } else {
                rejected.append("transaction_ids[\(rejected.count)] must be a positive integer")
            }
        }
        if !rejected.isEmpty {
            throw BackendHTTPError.validation("transaction_ids: \(rejected.joined(separator: ", "))")
        }
        return (transactions, RecipientID(rawValue: recipient), mode, note)
    }

    static func createBulk(_ session: BackendSession, body: JSValue?) throws -> HandlerResult {
        let (ids, recipient, mode, note) = try bulkFields(body)
        let result = try session.transaction { () throws -> [String: JSONValue] in
            guard
                try session.row("SELECT id FROM recipients WHERE id = ?", [.integer(Int64(recipient.rawValue))]) != nil
            else { throw BackendHTTPError.notFound("Recipient not found") }
            var seen: Set<TransactionID> = []
            let ordered = ids.filter { seen.insert($0).inserted }.sorted { $0.rawValue < $1.rawValue }
            var items: [JSONValue] = []
            var split = 0
            var skippedAlready = 0
            var skippedZero = 0
            var skippedMissing = 0
            for transaction in ordered {
                guard let totals = try splitTotals(session, transaction) else {
                    skippedMissing += 1
                    continue
                }
                if totals.splits.gt(.zero) {
                    skippedAlready += 1
                    continue
                }
                // `computeBulkSplitAmount`: half or the whole absolute total, on cents.
                let share = DecimalMoney.roundToCents(
                    // lint:allow string-literal-compare the two bulk preset labels of lib/calculations/splits.ts
                    mode == "full" ? totals.total.abs : try totals.total.abs.dividedBy(DecimalJS.from("2")))
                if share.isZero || !share.toNumber.isFinite {
                    skippedZero += 1
                    continue
                }
                try validateAllocation(new: share, transactionTotal: totals.total, currentSplitTotal: totals.splits)
                items.append(
                    try insertSplit(
                        session, transaction: transaction, recipient: recipient,
                        amount: share.toNumber, note: note))
                split += 1
            }
            return [
                "requested": .int(ids.count), "split": .int(split),
                "skipped_already_split": .int(skippedAlready), "skipped_zero_amount": .int(skippedZero),
                "skipped_missing": .int(skippedMissing), "items": .array(items),
            ]
        }
        return HandlerResult(status: 201, data: .object(result))
    }

    /// `payBodySchema`: a positive amount; `paid_at` forwarded raw, today's day when unset.
    static func payFields(_ body: JSValue?) throws -> (amount: Double, note: String?, paidAt: String?) {
        guard let object = body?.objectValue else {
            throw BackendHTTPError.validation(expectedObject(body))
        }
        let number = object["amount"]?.javaScriptNumber ?? .nan
        guard object["amount"] != nil, object["amount"] != .null, number.isFinite, number > 0 else {
            throw BackendHTTPError.validation("Payment amount must be a positive number")
        }
        return (number, rawNote(object["note"]), rawNote(object["paid_at"]))
    }

    static func pay(_ session: BackendSession, id: SplitID, body: JSValue?) throws -> HandlerResult {
        let input = try payFields(body)
        let payment = try session.transaction { () throws -> JSONValue in
            guard
                let split = try session.row(
                    "SELECT id, amount, is_settled FROM transaction_splits WHERE id = ?",
                    [.integer(Int64(id.rawValue))])
            else { throw BackendHTTPError.notFound("Split not found") }
            if try split.bool("is_settled") {
                throw BackendHTTPError.validation("Split is already settled")
            }
            let amount = try DecimalJS.from(SQLArguments.javaScriptText(input.amount)).toDecimalPlaces(4)
            let paidRow = try session.row(
                "SELECT COALESCE(dec_sum(amount), '0') AS paid FROM split_payments WHERE split_id = ?",
                [.integer(Int64(id.rawValue))])
            let alreadyPaid = try DecimalJS.from(try (paidRow?.text("paid")) ?? "0")
            if alreadyPaid.plus(amount).gt(try DecimalJS.from(try split.text("amount")).toDecimalPlaces(4)) {
                throw BackendHTTPError.validation("Payment would exceed split outstanding balance")
            }
            let paidAt = input.paidAt ?? session.today()
            guard
                let row = try session.row(
                    """
                    INSERT INTO split_payments (split_id, amount, note, paid_at)
                    VALUES (?, vision_numeric(?, 18, 4), ?, ?)
                    RETURNING id, split_id, amount, paid_at, note, created_at
                    """,
                    [
                        .integer(Int64(id.rawValue)), .text(SQLArguments.javaScriptText(input.amount)),
                        input.note.map { SQLValue.text($0) } ?? .null, .text(paidAt),
                    ])
            else { throw SQLRowDecodingError(column: "split_payments", problem: "payment INSERT returned no row") }
            _ = try session.rows(
                """
                UPDATE transaction_splits SET is_settled = 1
                 WHERE id = ? AND is_settled = 0
                   AND dec_ge(
                     (SELECT COALESCE(dec_sum(sp.amount), '0') FROM split_payments sp
                       WHERE sp.split_id = transaction_splits.id), amount)
                 RETURNING id
                """,
                [.integer(Int64(id.rawValue))])
            return try paymentJSON(row)
        }
        return HandlerResult(status: 201, data: payment)
    }

    static func settle(_ session: BackendSession, id: SplitID) throws -> HandlerResult {
        let split = try session.transaction { () throws -> JSONValue? in
            guard
                try session.row(
                    "UPDATE transaction_splits SET is_settled = 1 WHERE id = ? RETURNING id",
                    [.integer(Int64(id.rawValue))]) != nil
            else { return nil }
            guard
                let row = try session.row(
                    """
                    SELECT \(splitColumns), COALESCE(\(paid), '0') AS amount_paid,
                           r.name AS recipient_name
                      FROM transaction_splits ts
                    LEFT JOIN recipients r ON ts.recipient_id = r.id
                     WHERE ts.id = ?
                    """,
                    [.integer(Int64(id.rawValue))])
            else { return nil }
            return .object(try splitFields(row))
        }
        guard let split else { throw BackendHTTPError.notFound("Split not found") }
        return HandlerResult(data: split)
    }

    static func settleAll(_ session: BackendSession, recipient: RecipientID) throws -> HandlerResult {
        let settled = try session.rows(
            """
            \(recipientGroup())
            UPDATE transaction_splits SET is_settled = 1
             WHERE recipient_id IN (SELECT id FROM recipient_group) AND is_settled = 0
             RETURNING id
            """,
            [.integer(Int64(recipient.rawValue))]).count
        return HandlerResult(data: .object(["settled_count": .int(settled)]))
    }

    static func delete(_ session: BackendSession, id: SplitID) throws -> HandlerResult {
        guard
            try session.rows(
                "DELETE FROM transaction_splits WHERE id = ? RETURNING id", [.integer(Int64(id.rawValue))])
            .count > 0
        else { throw BackendHTTPError.notFound("Split not found") }
        return HandlerResult.noContent
    }

    // MARK: - Registration

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.GetSplitsOwed.self) { request in
            try await database.run { session in try SplitsArea.owedSummaryResult(session, request: request) }
        }
        backend.serve(OpenAPIOperations.GetSplitOwedByRecipient.self) { request in
            try await database.run { session in try SplitsArea.owedByRecipientResult(session, request: request) }
        }
        backend.serve(OpenAPIOperations.ExportSplitsOwedCsv.self) { request in
            try await database.run { session in try SplitsArea.owedExport(session, request: request) }
        }
        backend.serve(OpenAPIOperations.GetSplitsByTransaction.self) { request in
            try await database.run { session in try SplitsArea.splitsByTransaction(session, request: request) }
        }
        backend.serve(OpenAPIOperations.CreateSplit.self) { request in
            let body = try RequestBody.parseJavaScript(request.body)
            return try await database.run { session in try SplitsArea.createSplit(session, body: body) }
        }
        backend.serve(OpenAPIOperations.CreateSplitBatch.self) { request in
            let body = try RequestBody.parseJavaScript(request.body)
            return try await database.run { session in try SplitsArea.createBatch(session, body: body) }
        }
        backend.serve(OpenAPIOperations.CreateBulkSplits.self) { request in
            let body = try RequestBody.parseJavaScript(request.body)
            return try await database.run { session in try SplitsArea.createBulk(session, body: body) }
        }
        backend.serve(OpenAPIOperations.PaySplit.self) { request in
            let id = SplitID(rawValue: try SplitsArea.pathId(request))
            let body = try RequestBody.parseJavaScript(request.body)
            return try await database.run { session in try SplitsArea.pay(session, id: id, body: body) }
        }
        backend.serve(OpenAPIOperations.GetSplitPayments.self) { request in
            try await database.run { session in try SplitsArea.payments(session, request: request) }
        }
        backend.serve(OpenAPIOperations.SettleSplit.self) { request in
            let id = SplitID(rawValue: try SplitsArea.pathId(request))
            return try await database.run { session in try SplitsArea.settle(session, id: id) }
        }
        backend.serve(OpenAPIOperations.SettleAllSplitsForRecipient.self) { request in
            let recipient = RecipientID(rawValue: try SplitsArea.pathId(request))
            return try await database.run { session in try SplitsArea.settleAll(session, recipient: recipient) }
        }
        backend.serve(OpenAPIOperations.DeleteSplit.self) { request in
            let id = SplitID(rawValue: try SplitsArea.pathId(request))
            return try await database.run { session in try SplitsArea.delete(session, id: id) }
        }
    }
}
