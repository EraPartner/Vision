import Foundation
import Testing
import VisionNativeCore

@testable import VisionBackend

/// Regression tests for Astra bug report 4 (2026-11-28, audited commit 3d1d9c976), each against a
/// freshly migrated and populated database, through the routes of the live backend where the
/// finding is about a route.
@Suite struct AstraReport4BackendTests {
    static let stamp = "'2025-03-01T09:00:00.000000Z'"

    static let recipients =
        "INSERT INTO recipients (id, name, normalized_name, is_active, created_at, updated_at) VALUES"
        + " (1, 'Seeded', 'SEEDED', 1, \(stamp), \(stamp)), (2, 'Friend', 'FRIEND', 1, \(stamp), \(stamp))"

    static func account(_ id: Int, type: String = "checking") -> String {
        "INSERT INTO accounts (id, name, currency, type, created_at, updated_at, import_identity) VALUES"
            + " (\(id), 'Account \(id)', 'EUR', '\(type)', \(stamp), \(stamp),"
            + " '00000000-0000-4000-8000-00000000000\(id)')"
    }

    static func transaction(
        id: Int, date: String, amount: String, account: Int = 1, active: Bool = true, peer: Int? = nil,
        source: String? = nil
    ) -> String {
        "INSERT INTO transactions (id, date, amount, currency, recipient_id, account_id, is_active, is_transfer,"
            + " transfer_peer_id, transfer_source, created_at, updated_at) VALUES (\(id), '\(date)',"
            + " vision_numeric('\(amount)', 18, 4), 'EUR', 1, \(account), \(active ? 1 : 0), \(peer == nil ? 0 : 1),"
            + " \(peer.map(String.init) ?? "NULL"), \(source.map { "'\($0)'" } ?? "NULL"), \(stamp), \(stamp))"
    }

    static func trade(
        id: Int, type: String, date: String, amount: String, units: String, price: String,
        currency: String = "EUR", fx: String? = nil
    ) -> String {
        "INSERT INTO portfolio_transactions (id, investment_id, type, date, amount, units, price_per_unit,"
            + " currency, fx_rate_to_eur, account_id, created_at, updated_at) VALUES (\(id), 1, '\(type)', '\(date)',"
            + " vision_numeric('\(amount)', 18, 4), vision_numeric('\(units)', 18, 8),"
            + " vision_numeric('\(price)', 18, 6), '\(currency)',"
            + " \(fx.map { "vision_numeric('\($0)', 20, 10)" } ?? "NULL"), NULL, \(stamp), \(stamp))"
    }

    /// A migrated database with the seed, and the live routes over it.
    struct Live {
        let database: BackendDatabase
        let transport: RoutingAPITransport

        init(_ seed: [String]) throws {
            let file = try ParityTests.migratedDatabase(seed: seed)
            database = BackendDatabase(
                path: file.path, attachmentsDirectory: file.deletingLastPathComponent().path + "/attachments")
            transport = RoutingAPITransport(
                backend: .live(database: database, fetcher: ParityTests.StubFetcher(stubs: [:])),
                fallback: ParityTests.NoFallback(), streamFallback: ParityTests.NoFallback())
        }

        /// The status and the envelope's `data` of one request.
        func send(_ method: HTTPMethod, _ path: String, _ body: String? = nil) async throws -> (Int, JSValue?) {
            let url = try #require(URL(string: "http://127.0.0.1:3001" + path))
            let request = APIRequest(
                method: method, url: url, headers: body == nil ? [:] : ["Content-Type": "application/json"],
                body: body.map { Data($0.utf8) }, timeout: 30)
            let response = try await transport.send(request)
            return (response.status, JSValue.parse(response.body)?.objectValue?["data"])
        }

        /// One column of the first row of a query, as stored text (nil for NULL or no row).
        func text(_ sql: String, _ column: String = "v") async throws -> String? {
            try await database.run { session in try session.row(sql)?.optionalText(column) }
        }

        func count(_ sql: String) async throws -> Int64 {
            try await database.run { session in try session.row(sql)?.int64("n") ?? -1 }
        }
    }

    static let stock =
        "INSERT INTO investments (id, name, symbol, asset_class, currency, current_price, is_active, price_provider,"
        + " created_at, updated_at) VALUES (1, 'Holding 1', 'H1', 'stock', 'EUR', vision_numeric('10', 18, 6), 1,"
        + " 'manual', \(stamp), \(stamp))"

    // MARK: - Portfolio transactions

    /// Finding 1: deleting the only purchase behind an unassigned sale is refused, and both
    /// trades stay; deleting the sale still works.
    @Test func deletingThePurchaseBehindASaleIsRefused() async throws {
        let live = try Live([
            Self.stock,
            Self.trade(id: 1, type: "buy", date: "2026-01-05", amount: "100", units: "10", price: "10"),
            Self.trade(id: 2, type: "sell", date: "2026-01-10", amount: "120", units: "10", price: "12"),
        ])
        let (refused, _) = try await live.send(.delete, "/api/investments/transactions/1")
        #expect(refused == 400)
        #expect(try await live.count("SELECT count(*) AS n FROM portfolio_transactions") == 2)
        let (deleted, _) = try await live.send(.delete, "/api/investments/transactions/2")
        #expect(deleted == 204)
        let (purchase, _) = try await live.send(.delete, "/api/investments/transactions/1")
        #expect(purchase == 204)
        #expect(try await live.count("SELECT count(*) AS n FROM portfolio_transactions") == 0)
    }

    /// Finding 2: a currency change with no rate for the new currency clears the old rate
    /// instead of keeping it.
    @Test func aCurrencyChangeWithoutARateClearsTheOldRate() async throws {
        let live = try Live([
            Self.stock,
            Self.trade(
                id: 1, type: "buy", date: "2026-01-05", amount: "100", units: "10", price: "10", currency: "USD",
                fx: "0.9"),
        ])
        let (status, _) = try await live.send(.patch, "/api/investments/transactions/1", #"{"currency":"JPY"}"#)
        #expect(status == 200)
        #expect(try await live.text("SELECT currency AS v FROM portfolio_transactions WHERE id = 1") == "JPY")
        #expect(try await live.text("SELECT fx_rate_to_eur AS v FROM portfolio_transactions WHERE id = 1") == nil)
    }

    /// Finding 3: a buy whose price has more places than the column stores is priced as stored,
    /// so a later note-only edit passes the amount check.
    @Test func aStoredTradePassesItsNextNoteEdit() async throws {
        let live = try Live([Self.stock])
        let (created, data) = try await live.send(
            .post, "/api/investments/1/transactions",
            #"{"type":"buy","date":"2026-01-05","units":"100000","price_per_unit":"1.2345674"}"#)
        #expect(created == 201)
        let id = try #require(data?.objectValue?["id"]).javaScriptNumber
        #expect(try await live.text("SELECT amount AS v FROM portfolio_transactions") == "123456.7000")
        #expect(try await live.text("SELECT price_per_unit AS v FROM portfolio_transactions") == "1.234567")
        let (edited, _) = try await live.send(
            .patch, "/api/investments/transactions/\(Int(id))", #"{"note":"checked"}"#)
        #expect(edited == 200)
    }

    // MARK: - Loans and planned payments

    static func loanBody(term: Int, startDate: String = "2026-01-31", day: Int = 31) -> String {
        #"{"is_loan":true,"loan_type":"fixed_principal","loan_principal":1200,"loan_annual_interest_rate":12,"#
            + #""loan_term_months":\#(term),"loan_start_date":"\#(startDate)","loan_payment_day":\#(day),"account_id":1}"#
    }

    static func execute(_ live: Live, _ plan: Int, transaction: Int, on date: String) async throws -> Int {
        try await live.send(
            .post, "/api/planned-transactions/\(plan)/execute",
            #"{"executed_transaction_id":\#(transaction),"execution_date":"\#(date)"}"#
        ).0
    }

    static func createdId(_ data: JSValue?) throws -> Int {
        Int(try #require(data?.objectValue?["id"]).javaScriptNumber)
    }

    /// Findings 5 and 6: the planned amount is each installment's whole payment, and the due
    /// dates follow the schedule (March 31 after February 28, not March 28).
    @Test func loanExecutionFollowsTheSchedule() async throws {
        let live = try Live([
            Self.recipients, Self.account(1),
            Self.transaction(id: 101, date: "2026-01-31", amount: "-112"),
            Self.transaction(id: 102, date: "2026-02-28", amount: "-111"),
        ])
        let (created, data) = try await live.send(.post, "/api/planned-transactions", Self.loanBody(term: 12))
        #expect(created == 201 || created == 200)
        let plan = try Self.createdId(data)
        let row = "FROM planned_transactions WHERE id = \(plan)"
        #expect(try await live.text("SELECT planned_date AS v \(row)") == "2026-01-31")
        // 100 principal plus 1% of 1200.
        #expect(try await live.text("SELECT amount AS v \(row)") == "-112.0000")

        #expect(try await Self.execute(live, plan, transaction: 101, on: "2026-01-31") == 200)
        #expect(try await live.text("SELECT planned_date AS v \(row)") == "2026-02-28")
        #expect(try await live.text("SELECT amount AS v \(row)") == "-111.0000")

        #expect(try await Self.execute(live, plan, transaction: 102, on: "2026-02-28") == 200)
        #expect(try await live.text("SELECT planned_date AS v \(row)") == "2026-03-31")
        #expect(try await live.text("SELECT amount AS v \(row)") == "-110.0000")
        #expect(try await live.count("SELECT is_executed AS n \(row)") == 0)
    }

    /// Finding 4: executing the only installment of a one-month loan completes the plan.
    @Test func aLoanCompletesAfterItsLastInstallment() async throws {
        let live = try Live([
            Self.recipients, Self.account(1),
            Self.transaction(id: 101, date: "2026-01-31", amount: "-1212"),
        ])
        let (_, data) = try await live.send(.post, "/api/planned-transactions", Self.loanBody(term: 1))
        let plan = try Self.createdId(data)
        #expect(try await Self.execute(live, plan, transaction: 101, on: "2026-01-31") == 200)
        let row = "FROM planned_transactions WHERE id = \(plan)"
        #expect(try await live.count("SELECT is_executed AS n \(row)") == 1)
        #expect(try await live.text("SELECT planned_date AS v \(row)") == "2026-01-31")
    }

    /// Finding 7: an edit of the interest rate alone regenerates the schedule from the stored
    /// start date.
    @Test func aRateOnlyLoanEditRegeneratesTheSchedule() async throws {
        let live = try Live([Self.recipients, Self.account(1)])
        let (_, data) = try await live.send(.post, "/api/planned-transactions", Self.loanBody(term: 12))
        let plan = try Self.createdId(data)
        let (status, _) = try await live.send(
            .patch, "/api/planned-transactions/\(plan)", #"{"loan_annual_interest_rate":6}"#)
        #expect(status == 200)
        let schedule = "FROM planned_transaction_loan_schedule WHERE planned_transaction_id = \(plan)"
        #expect(try await live.text("SELECT interest_amount AS v \(schedule) AND installment_number = 1") == "6.0000")
        #expect(try await live.count("SELECT count(*) AS n \(schedule)") == 12)
        #expect(try await live.text("SELECT amount AS v FROM planned_transactions WHERE id = \(plan)") == "-106.0000")
    }

    /// Finding 8: an overdue unlimited daily plan still projects every day of the window.
    @Test func anOverdueUnlimitedPlanProjectsTheWindow() async throws {
        let live = try Live([
            "INSERT INTO planned_transactions (id, planned_date, amount, currency, is_recurring, recurrence_pattern,"
                + " is_active, created_at, updated_at) VALUES (1, '2023-01-01', vision_numeric('-5', 18, 4), 'EUR', 1,"
                + " 'daily', 1, \(Self.stamp), \(Self.stamp))"
        ])
        let occurrences = try await live.database.run { session in
            let rows = try PlannedArea.commitments(session, horizonEnd: "2025-01-07")
            return try rows.map { try PlannedArea.occurrencesBetween($0, "2025-01-01", "2025-01-07") }
        }
        #expect(occurrences == [[
            "2025-01-01", "2025-01-02", "2025-01-03", "2025-01-04", "2025-01-05", "2025-01-06", "2025-01-07",
        ]])
    }

    // MARK: - Splits and balances owed

    /// Finding 9: batch splits are checked in the form they are stored, so their stored sum
    /// cannot exceed the transaction.
    @Test func batchSplitsCannotExceedTheTransactionOnceStored() async throws {
        let live = try Live([Self.recipients, Self.account(1), Self.transaction(id: 1, date: "2026-01-05", amount: "-1.0001")])
        let (refused, _) = try await live.send(
            .post, "/api/splits/batch",
            #"{"transaction_id":1,"splits":[{"recipient_id":2,"amount":0.50006},{"recipient_id":2,"amount":0.50006}]}"#)
        #expect(refused == 400)
        #expect(try await live.count("SELECT count(*) AS n FROM transaction_splits") == 0)
        let (accepted, _) = try await live.send(
            .post, "/api/splits/batch",
            #"{"transaction_id":1,"splits":[{"recipient_id":2,"amount":0.50004},{"recipient_id":2,"amount":0.50006}]}"#)
        #expect(accepted == 201)
        #expect(try await live.text("SELECT dec_sum(amount) AS v FROM transaction_splits") == "1.0001")
    }

    /// Finding 10: a payment that rounds up past the outstanding balance on storage is refused.
    @Test func aPaymentCannotExceedTheSplitOnceStored() async throws {
        let live = try Live([
            Self.recipients, Self.account(1), Self.transaction(id: 1, date: "2026-01-05", amount: "-2"),
            "INSERT INTO transaction_splits (id, transaction_id, recipient_id, amount) VALUES"
                + " (1, 1, 2, vision_numeric('1', 18, 4))",
        ])
        let (refused, _) = try await live.send(.post, "/api/splits/1/pay", #"{"amount":1.00005}"#)
        #expect(refused == 400)
        #expect(try await live.count("SELECT count(*) AS n FROM split_payments") == 0)
        #expect(try await live.count("SELECT is_settled AS n FROM transaction_splits WHERE id = 1") == 0)
        let (paid, _) = try await live.send(.post, "/api/splits/1/pay", #"{"amount":1.00004}"#)
        #expect(paid == 201)
        #expect(try await live.count("SELECT is_settled AS n FROM transaction_splits WHERE id = 1") == 1)
    }

    /// Finding 11: the owed list keeps a recipient whose detail still shows a cent due.
    @Test func theOwedListKeepsARecipientWhoOwesACent() async throws {
        let live = try Live([
            Self.recipients, Self.account(1), Self.transaction(id: 1, date: "2026-01-05", amount: "-2"),
            "INSERT INTO transaction_splits (id, transaction_id, recipient_id, amount) VALUES"
                + " (1, 1, 2, vision_numeric('1.005', 18, 4))",
            "INSERT INTO split_payments (split_id, amount, paid_at) VALUES (1, vision_numeric('0.995', 18, 4), '2026-01-06')",
        ])
        let (status, data) = try await live.send(.get, "/api/splits/owed")
        #expect(status == 200)
        let items = data?.objectValue?["items"]?.arrayValue ?? []
        #expect(items.count == 1)
        #expect(items.first?.objectValue?["recipient_id"]?.javaScriptNumber == 2)
        #expect(items.first?.objectValue?["remaining"]?.javaScriptNumber == 0.01)
    }

    // MARK: - Imports, exchange rates and transfers

    /// Finding 12: a single-row override on a batch that is no longer reviewable is refused.
    @Test func aSingleRowOverrideRefusesAnAbortedBatch() async throws {
        let corpus = try JSONDecoder().decode(
            ParityTests.Corpus.self,
            from: Data(contentsOf: ParityTests.corpusDirectory.appendingPathComponent("portfolio-overrides-mutations.json")))
        let live = try Live(corpus.seed + ["UPDATE portfolio_import_batches SET status = 'aborted' WHERE id = 1"])
        let before = try await live.text(
            "SELECT CAST(user_override_investment_id AS TEXT) AS v FROM portfolio_import_staging_rows WHERE id = 1")
        let (status, _) = try await live.send(
            .post, "/api/portfolio/import/batches/1/rows/1/investment-override", #"{"investment_id":2}"#)
        #expect(status == 400)
        #expect(try await live.text(
            "SELECT CAST(user_override_investment_id AS TEXT) AS v FROM portfolio_import_staging_rows WHERE id = 1")
            == before)
    }

    /// Finding 14: deactivating more outflows than one cleanup batch holds still releases every
    /// inflow, so none stays excluded from income.
    @Test func reconciliationReleasesEveryInvalidPair() async throws {
        let pairs = 126
        let live = try Live([
            Self.recipients, Self.account(1), Self.account(2, type: "savings"),
            """
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < \(pairs))
            INSERT INTO transactions (id, date, amount, currency, recipient_id, account_id, is_active, is_transfer,
              transfer_peer_id, transfer_source, created_at, updated_at)
            SELECT 2 * i - 1, '2026-01-05', vision_numeric('-25', 18, 4), 'EUR', 1, 1, 0, 1, 2 * i, 'auto',
                   \(Self.stamp), \(Self.stamp) FROM n
            UNION ALL
            SELECT 2 * i, '2026-01-05', vision_numeric('25', 18, 4), 'EUR', 1, 2, 1, 1, 2 * i - 1, 'auto',
                   \(Self.stamp), \(Self.stamp) FROM n
            """,
        ])
        try await live.database.run { session in _ = try TransferReconciliation.reconcile(session) }
        #expect(try await live.count("SELECT count(*) AS n FROM transactions WHERE is_transfer = 1") == 0)
        #expect(try await live.count("SELECT count(*) AS n FROM transactions") == Int64(2 * pairs))
    }

    /// Finding 15: merging the two accounts of a transfer releases both legs.
    @Test func mergingATransfersAccountsReleasesItsLegs() async throws {
        let live = try Live([
            Self.recipients, Self.account(1), Self.account(2, type: "savings"),
            "PRAGMA foreign_keys = OFF",
            Self.transaction(id: 1, date: "2026-01-05", amount: "-50", account: 1, peer: 2, source: "manual"),
            Self.transaction(id: 2, date: "2026-01-05", amount: "50", account: 2, peer: 1, source: "manual"),
            "PRAGMA foreign_keys = ON",
        ])
        let (status, _) = try await live.send(.post, "/api/accounts/1/merge", #"{"source_ids":[2]}"#)
        #expect(status == 200)
        #expect(try await live.count("SELECT count(*) AS n FROM transactions WHERE account_id = 1") == 2)
        #expect(try await live.count(
            "SELECT count(*) AS n FROM transactions WHERE is_transfer = 1 OR transfer_peer_id IS NOT NULL") == 0)
    }
}
