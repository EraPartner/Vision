import Foundation
import Testing
import VisionNativeCore

@testable import VisionBackend

/// Regression tests for the new findings (C1-C14) of Astra's consolidated Swift backend audit
/// (2026-11-27), each against a freshly migrated database.
@Suite struct AstraConsolidatedBackendTests {
    static let stamp = AstraReportBackendTests.stamp

    static func database(_ seed: [String]) throws -> BackendDatabase {
        try AstraReportBackendTests.database(seed)
    }

    static func patch(_ body: String) -> InProcessRequest {
        InProcessRequest(
            operationId: "updateTransaction", method: .patch, pathParameters: [:], queryItems: [], headers: [:],
            body: Data(body.utf8))
    }

    /// C2: a legacy transaction with no account accepts a ledger edit instead of answering 404,
    /// and a missing transaction still answers 404.
    @Test func anUnassignedTransactionAcceptsALedgerEdit() async throws {
        let database = try Self.database([
            "INSERT INTO transactions (id, date, amount, currency, recipient_id, account_id, is_active, created_at,"
                + " updated_at) VALUES (1, '2026-01-05', vision_numeric('-5', 18, 4), 'EUR', 1, NULL, 1,"
                + " \(Self.stamp), \(Self.stamp))"
        ])
        try await database.run { session throws in
            _ = try TransactionsArea.update(
                session, id: TransactionID(rawValue: 1),
                request: Self.patch(#"{"amount":"-7.5","date":"2026-01-06","is_active":false}"#))
            let row = try #require(try session.row(
                "SELECT amount, date, is_active, account_id FROM transactions WHERE id = 1"))
            #expect(try row.text("amount") == "-7.5000")
            #expect(try row.text("date") == "2026-01-06")
            #expect(try row.int64("is_active") == 0)
            #expect(try row.optionalInt64("account_id") == nil)
            #expect(AstraReportBackendTests.status {
                _ = try TransactionsArea.update(
                    session, id: TransactionID(rawValue: 99), request: Self.patch(#"{"amount":"1"}"#))
            } == 404)
        }
    }

    /// C2: the closed-account guard still refuses a ledger edit on an owned row.
    @Test func aClosedAccountStillRefusesALedgerEdit() async throws {
        let database = try Self.database([
            AstraReportBackendTests.transaction(id: 1, date: "2026-01-05", amount: "-5"),
            "UPDATE accounts SET is_active = 0 WHERE id = 1",
        ])
        try await database.run { session throws in
            #expect(AstraReportBackendTests.status {
                _ = try TransactionsArea.update(
                    session, id: TransactionID(rawValue: 1), request: Self.patch(#"{"amount":"-6"}"#))
            } == 400)
            #expect(try session.row("SELECT amount FROM transactions WHERE id = 1")?.text("amount") == "-5.0000")
        }
    }

    /// C14: one large holding groups every row once, in staging order, alongside the cash group.
    @Test func oneLargeHoldingGroupsEveryRowInOrder() async throws {
        let database = try Self.database([])
        let rows = 4_000
        let groups = try await database.run { session throws in
            let staged = try session.rows(
                """
                WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < \(rows))
                SELECT i AS id, i AS row_index,
                       CASE WHEN i % 1000 = 0 THEN 'cash' ELSE 'trade' END AS route,
                       CASE WHEN i % 1000 = 0 THEN NULL ELSE 7 END AS effective_investment_id,
                       'H7' AS symbol_raw, 'Holding 7' AS name_raw
                  FROM n ORDER BY i
                """)
            return PortfolioImportBatchesArea.groups(staged)
        }
        #expect(groups.count == 2)
        guard case .object(let holding)? = groups.first, case .object(let cash)? = groups.last else {
            Issue.record("groups answered \(groups)")
            return
        }
        #expect(holding["investment_id"] == .int(7))
        #expect(holding["row_count"] == .int(rows - rows / 1000))
        #expect(cash["is_cash"] == .bool(true))
        #expect(cash["row_count"] == .int(rows / 1000))
        guard case .array(let holdingRows)? = holding["rows"] else {
            Issue.record("holding rows missing")
            return
        }
        let ids = holdingRows.compactMap { row -> Int? in
            if case .object(let fields) = row, case .int(let index)? = fields["row_index"] { return index }
            return nil
        }
        #expect(ids == (1...rows).filter { $0 % 1000 != 0 })
    }

    // MARK: - Accounts

    /// C1: a EUR statement against a ledger funded only in USD refuses instead of posting the
    /// drift in USD; an explicit currency still reconciles that currency.
    @Test func reconcileRefusesAStatementInAnotherCurrency() async throws {
        let database = try Self.database([
            "INSERT INTO transactions (id, date, amount, currency, recipient_id, account_id, is_active, created_at,"
                + " updated_at) VALUES (1, '2026-01-05', vision_numeric('80', 18, 4), 'USD', 1, 1, 1,"
                + " \(Self.stamp), \(Self.stamp))",
            "INSERT INTO account_statement_balances (account_id, currency, balance, balance_date) VALUES"
                + " (1, 'EUR', vision_numeric('100', 18, 4), '2026-01-06')",
        ])
        let body = try #require(JSValue.parse(Data(#"{"mode":"adjustment"}"#.utf8)))
        let explicit = try #require(JSValue.parse(Data(#"{"mode":"adjustment","currency":"EUR"}"#.utf8)))
        try await database.run { session throws in
            #expect(AstraReportBackendTests.status {
                _ = try AccountsArea.reconcile(session, id: AccountID(rawValue: 1), body: body)
            } == 400)
            #expect(try session.row("SELECT count(*) AS n FROM transactions")?.int64("n") == 1)
            _ = try AccountsArea.reconcile(session, id: AccountID(rawValue: 1), body: explicit)
            let posted = try #require(try session.row(
                "SELECT amount, currency FROM transactions WHERE transfer_source = 'adjustment'"))
            #expect(try posted.text("currency") == "EUR")
            #expect(try posted.text("amount") == "100.0000")
        }
    }

    /// C3: a source account with imported custody history refuses the merge before any write,
    /// and every row keeps its account.
    @Test func mergeRefusesAccountsWithCustodyHistory() async throws {
        let database = try AstraReport3BackendTests.database([
            "PRAGMA foreign_keys = OFF",
            AstraReport3BackendTests.brokerage(id: 1),
            AstraReport3BackendTests.brokerage(id: 2),
            AstraReport3BackendTests.brokerage(id: 3),
            AstraReport3BackendTests.investment(id: 1),
            "INSERT INTO portfolio_transactions (id, investment_id, type, date, amount, units, price_per_unit,"
                + " currency, account_id, created_at, updated_at) VALUES (1, 1, 'buy', '2026-01-10',"
                + " vision_numeric('1000', 18, 4), vision_numeric('10', 18, 8), vision_numeric('100', 18, 6), 'EUR', 1,"
                + " \(Self.stamp), \(Self.stamp))",
            "INSERT INTO portfolio_asset_transfers (id, investment_id, source_account_id, destination_account_id,"
                + " date, units, fee_units, fee_basis_allocations, import_batch_id, staging_row_id, source_record_hash,"
                + " dedup_fingerprint, dedup_fingerprint_version, created_at) VALUES (100, 1, 1, 3, '2026-01-15',"
                + " vision_numeric('10', 18, 8), vision_numeric('0', 18, 8), vision_jsonb('{}'), 9, 90,"
                + " '\(String(repeating: "a", count: 64))', '\(String(repeating: "b", count: 64))', 1, \(Self.stamp))",
            "PRAGMA foreign_keys = ON",
        ])
        try await database.run { session throws in
            #expect(AstraReportBackendTests.status {
                _ = try AccountsArea.merge(session, target: AccountID(rawValue: 2), sources: [1])
            } == 400)
            #expect(try session.row("SELECT count(*) AS n FROM accounts WHERE id = 1")?.int64("n") == 1)
            #expect(try session.row("SELECT account_id FROM portfolio_transactions WHERE id = 1")?.int64("account_id") == 1)
            #expect(try session.row(
                "SELECT source_account_id FROM portfolio_asset_transfers WHERE id = 100")?.int64("source_account_id") == 1)
            // The account without custody history still merges.
            _ = try AccountsArea.merge(session, target: AccountID(rawValue: 1), sources: [2])
            #expect(try session.row("SELECT count(*) AS n FROM accounts WHERE id = 2")?.int64("n") == 0)
        }
    }
}
