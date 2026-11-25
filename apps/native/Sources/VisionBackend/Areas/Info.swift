import Foundation
import VisionNativeCore

/// `routes/info/statistics.ts`'s three metadata the Import page reads: the adapter registry
/// (`listAdapters`), the account labels (`infoRepository.getBanks`) and the recurring-pattern
/// detector (`services/recurringDetectionService.ts`).
enum InfoArea {
    /// A JSON number printed as JavaScript prints it, for the route answer's figures.
    static func number(_ value: Double) -> JSONValue { JSValue.number(value).envelopeValue }

    // MARK: - Register

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.GetSupportedAdapters.self) { request in
            try await database.run { session in try InfoArea.supportedAdapters(session, request: request) }
        }
        backend.serve(OpenAPIOperations.GetInfoBanks.self) { request in
            try await database.run { session in try InfoArea.banks(session, request: request) }
        }
        backend.serve(OpenAPIOperations.GetRecurringPatterns.self) { request in
            try await database.run { session in try InfoArea.recurringPatterns(session, request: request) }
        }
    }

    // MARK: - The routes

    /// `GET /supported-adapters`: `{ key, name }` for every registered adapter but `generic`,
    /// in registry order.
    static func supportedAdapters(
        _ session: BackendSession, request: InProcessRequest
    ) throws -> HandlerResult {
        let items = BankAdapters.Bank.allCases.map { bank in
            JSONValue.object(["key": .string(bank.rawValue), "name": .string(bank.displayName)])
        }
        return HandlerResult(data: .object(["items": .array(items), "total": .int(items.count)]))
    }

    /// `GET /banks`: account names with at least one active transaction (the `info_get_banks`
    /// query), `a.name` ascending.
    static func banks(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let rows = try session.rows(
            "select \"a\".\"name\" as \"bank_account\" from \"accounts\" as \"a\" where \"a\".\"id\" in"
                + " (select \"t\".\"account_id\" from \"transactions\" as \"t\" where \"t\".\"is_active\" = ?"
                + " and \"t\".\"account_id\" is not null) order by \"a\".\"name\"",
            [.integer(1)])
        let items = rows.map { JSONValue.string(try $0.text("bank_account")) }
        return HandlerResult(data: .object(["items": .array(items), "total": .int(items.count)]))
    }

    // MARK: - The recurring-pattern detection

    /// One candidate row of `detectRecurringPatterns`' query (`recurringCandidateRowSchema`):
    /// the date is the stored calendar day, the amount its canonical text.
    struct Candidate: Sendable {
        let id: Int
        let date: String?
        let amountText: String
        let currency: String?
        let accountId: AccountID?
        let bankAccount: String?
        let recipientId: RecipientID
        let recipientName: String?
        let effectiveCategoryId: CategoryID?
        let categoryName: String?
    }

    /// One detected amount change of `detectAmountChanges`.
    struct AmountChange: Sendable {
        let date: String
        let previousAmount: Double
        let newAmount: Double
        let percentChange: Double
        let increased: Bool

        var json: JSONValue {
            .object([
                "date": .string(date),
                "previousAmount": number(previousAmount),
                "newAmount": number(newAmount),
                "percentChange": number(percentChange),
                "direction": .string(increased ? "increased" : "decreased"),
            ])
        }
    }

    /// The `INTERVAL_PATTERNS` table of `detectInterval`.
    static let intervalPatterns: [(name: String, days: Double, tolerance: Double)] = [
        ("weekly", 7, 2), ("biweekly", 14, 3), ("monthly", 30, 5), ("quarterly", 91, 10),
        ("yearly", 365, 20),
    ]

    /// `GET /recurring-patterns`: groups the last three years of transactions by resolved
    /// recipient and flow direction, detects the interval cadence, and answers the patterns
    /// the route's `graceful degradation` guards (a thrown error becomes `{patterns: [], total: 0}`)
    /// as the envelope's masked 500 — never seen by the corpus — so no error path is ported.
    static func recurringPatterns(
        _ session: BackendSession, request: InProcessRequest
    ) throws -> HandlerResult {
        // The compiled Kysely query: one big join, the effective category as the canonical
        // three-level resolution, bounded by `sub_interval(today(), '3 years')`.
        let rows = try session.rows(
            """
            select "t"."id", "t"."date", "t"."amount", "t"."currency", "t"."memo", "t"."account_id",
                   "acct"."name" as "bank_account",
                   coalesce("r"."primary_recipient_id", "t"."recipient_id") as "recipient_id",
                   coalesce("pr"."name", "r"."name") as "recipient_name",
                   coalesce("t"."category_id", "r"."default_category_id", "pr"."default_category_id") as "effective_category_id",
                   "c"."path_name" as "category_name"
            from "transactions" as "t"
            left join "accounts" as "acct" on "t"."account_id" = "acct"."id"
            left join "recipients" as "r" on "t"."recipient_id" = "r"."id"
            left join "recipients" as "pr" on "r"."primary_recipient_id" = "pr"."id"
            left join "categories" as "c" on coalesce("t"."category_id", "r"."default_category_id", "pr"."default_category_id") = "c"."id"
            where "t"."is_active" = ? and "t"."recipient_id" is not null and "t"."date" >= sub_interval(today(), '3 years')
            order by coalesce("r"."primary_recipient_id", "t"."recipient_id"), "t"."date"
            """,
            [.integer(1)])
        let candidates: [Candidate] = try rows.map { row in
            Candidate(
                id: Int(try row.int64("id")),
                date: try row.optionalText("date"),
                amountText: try row.text("amount"),
                currency: try row.optionalText("currency"),
                accountId: try row.optionalInt64("account_id").map { AccountID(rawValue: Int($0)) },
                bankAccount: try row.optionalText("bank_account"),
                recipientId: RecipientID(rawValue: Int(try row.int64("recipient_id"))),
                recipientName: try row.optionalText("recipient_name"),
                effectiveCategoryId: try row.optionalInt64("effective_category_id").map { CategoryID(rawValue: Int($0)) },
                categoryName: try row.optionalText("category_name"))
        }

        // Group by recipient AND flow direction, in first-seen order.
        struct Group: Sendable {
            var recipient: RecipientID
            var recipientName: String
            var income: Bool
            var transactions: [Candidate]
        }
        var groups: [String: Group] = [:]
        var groupOrder: [String] = []
        for candidate in candidates {
            let amount = (try? DecimalMoney.numericColumn(candidate.amountText)) ?? nil ?? 0
            let income = amount >= 0
            let key = "\(candidate.recipientId.rawValue):\(income ? "income" : "expense")"
            if groups[key] == nil {
                groups[key] = Group(
                    recipient: candidate.recipientId,
                    recipientName: candidate.recipientName ?? "Unknown",
                    income: income, transactions: [])
                groupOrder.append(key)
            }
            groups[key]?.transactions.append(candidate)
        }

        // The planned-recipient probe: which recipients an active planned payment already covers.
        var plannedIds = Set<RecipientID>()
        let existsRows = try session.rows(
            "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table'"
                + " AND name = 'planned_transactions') AS \"exists::bool\"")
        let plannedTableExists = existsRows.first.map { (try? $0.int64("exists::bool")) ?? 0 } == 1
        var uniqueIds: [RecipientID] = []
        for key in groupOrder {
            if let id = groups[key]?.recipient, !uniqueIds.contains(id) { uniqueIds.append(id) }
        }
        if plannedTableExists, !uniqueIds.isEmpty {
            let plannedRows = try session.rows(
                """
                select distinct coalesce("r"."primary_recipient_id", "pt"."recipient_id") as "recipient_id"
                from "planned_transactions" as "pt"
                left join "recipients" as "r" on "pt"."recipient_id" = "r"."id"
                where COALESCE(r.primary_recipient_id, pt.recipient_id) IN (SELECT value FROM json_each(?))
                  and "pt"."is_active" = ?
                """,
                [.text(JSONValue.array(uniqueIds.map { .int($0) }).jsonText), .integer(1)])
            for row in plannedRows {
                plannedIds.insert(RecipientID(rawValue: Int(try row.int64("recipient_id"))))
            }
        }

        var patterns: [JSONValue] = []
        for key in groupOrder {
            guard let group = groups[key] else { continue }
            let txns = group.transactions
            guard txns.count >= 3, let first = txns.first, let latest = txns.last else { continue }

            // The intervals between consecutive transactions, in days, positive only.
            var intervals: [Double] = []
            for pair in zip(txns, txns.dropFirst()) {
                let distance = (try? CalendarDays.difference(from: pair.0.date, to: pair.1.date)) ?? 0
                if distance > 0 { intervals.append(Double(distance)) }
            }
            guard intervals.count >= 2 else { continue }
            guard let detected = detectInterval(intervals) else { continue }

            // The amounts as decimals: the average then, the latest amount, in half-even.
            let amounts = try txns.map { try DecimalJS($0.amountText).abs }
            let average = DecimalMoney.roundMoney(
                try DecimalMoney.addAll(amounts).dividedBy(DecimalJS(Double(amounts.count))))
            let latestAmount = DecimalMoney.roundMoney(try DecimalJS(latest.amountText).abs)
            let currency = first.currency ?? "EUR"

            let amountChanges = detectAmountChanges(txns)
            guard let lastSeen = latest.date else { continue }
            let next = try CalendarDays.adding(detected.medianDays, to: lastSeen)

            let confidence: Int = Int(min(100, JavaScriptNumber.round(
                Double(detected.consistency) * 0.5
                    + (min(Double(txns.count), 12) / 12) * 30
                    + (amountChanges.isEmpty ? 20 : 10))))
            let item: [String: JSONValue] = [
                "recipientId": .int(group.recipient.rawValue),
                "recipientName": .string(group.recipientName),
                "direction": .string(group.income ? "income" : "expense"),
                "detectedPattern": .string(detected.pattern),
                "intervalDays": .int(detected.medianDays),
                "consistency": .int(detected.consistency),
                "occurrences": .int(txns.count),
                "averageAmount": number(average),
                "latestAmount": number(latestAmount),
                "currency": .string(currency),
                "categoryId": latest.effectiveCategoryId.map { JSONValue.int($0) } ?? .null,
                "categoryName": latest.categoryName.map { JSONValue.string($0) } ?? .null,
                "bankAccount": latest.bankAccount.map { JSONValue.string($0) } ?? .null,
                "accountId": latest.accountId.map { JSONValue.int($0) } ?? .null,
                "firstSeen": first.date.map { JSONValue.string($0) } ?? .null,
                "lastSeen": .string(lastSeen),
                "predictedNext": .string(next),
                "amountChanges": .array(amountChanges.map { $0.json }),
                "isAlreadyPlanned": .bool(plannedIds.contains(group.recipient)),
                "confidence": .int(confidence),
            ]
            patterns.append(.object(item))
        }

        // `patterns.sort((a, b) => b.confidence - a.confidence)`: a stable descending sort.
        patterns = Array(
            patterns
                .enumerated()
                .sorted { a, b in
                    let left = a.element.objectValue?["confidence"]?.intValue ?? 0
                    let right = b.element.objectValue?["confidence"]?.intValue ?? 0
                    return left == right ? a.offset < b.offset : left > right
                }
                .map { $0.element })

        return HandlerResult(data: .object([
            "patterns": .array(patterns), "total": .int(patterns.count),
        ]))
    }

    /// `detectInterval`: the most likely recurrence pattern of a series of intervals. The
    /// route reads `pattern`, `medianDays` (`Math.round(medianInterval)`) and `consistency`;
    /// `avgDays` and `customIntervalDays` never reach the answer.
    static func detectInterval(_ intervals: [Double]) -> (pattern: String, medianDays: Int, consistency: Int)? {
        let average = intervals.reduce(0, +) / Double(intervals.count)
        // `median` of `lib/math.ts`: the middle value, or the mean of the two middle ones.
        let sorted = intervals.sorted()
        let mid = sorted.count / 2
        let median: Double = sorted.count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2

        for pattern in intervalPatterns where abs(median - pattern.days) <= pattern.tolerance {
            let matching = intervals.filter { abs($0 - pattern.days) <= pattern.tolerance }
            let consistency = Double(matching.count) / Double(intervals.count)
            if consistency >= 0.6 {
                return (
                    pattern.name,
                    Int(JavaScriptNumber.round(median)),
                    Int(JavaScriptNumber.round(consistency * 100))
                )
            }
        }

        // The custom regular interval: a small coefficient of variation.
        let variance = intervals.reduce(0) { $0 + ($1 - average) * ($1 - average) } / Double(intervals.count)
        let standardDeviation = variance.squareRoot()
        let coefficient = standardDeviation / average
        if coefficient < 0.25 && average >= 5 {
            return (
                "custom",
                Int(JavaScriptNumber.round(median)),
                Int(JavaScriptNumber.round((1 - coefficient) * 100))
            )
        }
        return nil
    }

    /// `detectAmountChanges`: the last three consecutive pairs, reporting a change above 5 %.
    static func detectAmountChanges(_ transactions: [Candidate]) -> [AmountChange] {
        guard transactions.count >= 2 else { return [] }
        // The sort of the route: by date (both rows fail only on dates the corpus cannot
        // seed, which arrive as unparseable text and sort after everything else), then by id.
        let sorted = transactions.sorted { a, b in
            let aFirst = (try? CalendarDays.epochDay(a.date)) != nil
            let bFirst = (try? CalendarDays.epochDay(b.date)) != nil
            if !aFirst && !bFirst { return a.id < b.id }
            if !aFirst { return false }
            if !bFirst { return true }
            let distance = (try? CalendarDays.difference(from: a.date, b.date)) ?? 0
            return distance == 0 ? a.id < b.id : distance > 0
        }
        let pairs = Array(zip(sorted, sorted.dropFirst())).suffix(3)
        var changes: [AmountChange] = []
        for (previous, current) in pairs {
            guard let previousAmount = try? DecimalJS(previous.amountText).abs.toNumber,
                previousAmount.isFinite, previousAmount != 0
            else { continue }
            guard let newAmount = try? DecimalJS(current.amountText).abs.toNumber,
                newAmount.isFinite
            else { continue }
            let percentChange = ((newAmount - previousAmount) / previousAmount) * 100
            if abs(percentChange) > 5 {
                changes.append(
                    AmountChange(
                        date: (current.date ?? "") + "T00:00:00.000Z",
                        previousAmount: previousAmount,
                        newAmount: newAmount,
                        percentChange: JavaScriptNumber.round(percentChange * 100) / 100,
                        increased: percentChange > 0))
            }
        }
        return changes
    }
}
