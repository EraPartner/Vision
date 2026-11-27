import Foundation
import Testing
import VisionNativeCore

@testable import VisionBackend

/// Regression tests for the backend findings of Astra bug report 2 (2026-11-27), each against a
/// freshly migrated database where it needs one.
@Suite struct AstraReport2BackendTests {
    static let stamp = AstraReportBackendTests.stamp

    static func database(_ seed: [String]) throws -> BackendDatabase {
        try AstraReportBackendTests.database(seed)
    }

    static func transaction(id: Int, date: String, amount: String, account: Int = 1) -> String {
        "INSERT INTO transactions (id, date, amount, currency, recipient_id, account_id, is_active, created_at,"
            + " updated_at) VALUES (\(id), '\(date)', vision_numeric('\(amount)', 18, 4), 'EUR', 1, \(account), 1,"
            + " \(stamp), \(stamp))"
    }

    static let secondAccount =
        "INSERT INTO accounts (id, name, currency, type, created_at, updated_at, import_identity) VALUES"
        + " (2, 'Savings', 'EUR', 'savings', \(stamp), \(stamp), '00000000-0000-4000-8000-000000000002')"

    static func request(_ operationId: String, _ method: HTTPMethod, body: String?, headers: [String: String] = [:])
        -> InProcessRequest
    {
        InProcessRequest(
            operationId: operationId, method: method, pathParameters: [:], queryItems: [], headers: headers,
            body: body.map { Data($0.utf8) })
    }

    static func status(_ call: () throws -> Void) -> Int? { AstraReportBackendTests.status(call) }

    static func message(_ call: () throws -> Void) -> String? {
        do {
            try call()
            return nil
        } catch let error as BackendHTTPError {
            return error.message
        } catch {
            return "\(error)"
        }
    }

    /// Finding 4: an export past one chunk ends, with every row once.
    @Test func bulkExportPastOneChunkEnds() async throws {
        let rows = TransactionExportArea.chunkSize + 5
        let database = try Self.database([
            """
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < \(rows))
            INSERT INTO transactions (id, date, amount, currency, recipient_id, account_id, is_active, created_at,
              updated_at)
            SELECT i, '2026-01-05', vision_numeric('1', 18, 4), 'EUR', 1, 1, 1, \(Self.stamp), \(Self.stamp) FROM n
            """
        ])
        let result = try await database.run { session throws in
            try TransactionExportArea.bulkExport(
                session, request: Self.request("bulkExportTransactions", .post, body: #"{"filter":{"account_id":1},"expected_count":\#(rows)}"#))
        }
        let text = String(decoding: try #require(result.file), as: UTF8.self)
        #expect(text.split(separator: "\n").count == rows + 1)
    }

    /// Finding 11: a huge or non-finite page size saturates instead of trapping.
    @Test func hugeIntegersSaturate() {
        #expect(JavaScriptInteger.saturating(1e300) == Int.max)
        #expect(JavaScriptInteger.saturating(-1e300) == Int.min)
        #expect(JavaScriptInteger.saturating(.infinity) == Int.max)
        #expect(JavaScriptInteger.saturating(.nan) == 0)
        #expect(JavaScriptInteger.saturating(42) == 42)
    }

    /// Finding 1: the import fingerprints are the ones Bun computes (importIdentity.ts, run on
    /// the same rows with `bun`), so a re-import after the switch is still recognised.
    @Test func importFingerprintsMatchTheTypeScriptBackend() {
        func row(sourceId: String? = nil, date: String, amount: String, currency: String, recipient: String?,
                 account: String?, memo: String?) -> ImportUploadsArea.StagedValidateRow {
            ImportUploadsArea.StagedValidateRow(
                id: 1, status: "matched", txDate: date, amountText: amount, amountNumber: nil, recipientRaw: recipient,
                memo: memo, currency: currency, rawData: nil, bankAccount: "Main", recipientAccount: account,
                sourceId: sourceId, adapterName: "generic")
        }
        let shop = row(date: "2026-01-05", amount: "-12.50", currency: "EUR", recipient: "Shop", account: "BE01",
                       memo: "Bread")
        let sourced = row(sourceId: "ABC-1", date: "2026-01-06", amount: "3", currency: "", recipient: nil,
                          account: nil, memo: nil)
        let fingerprints = ImportIdentity.assignIdentities(rows: [shop, shop, sourced]).map(\.fingerprint)
        #expect(fingerprints == [
            "99eae9802c27ad4202a36f39793f7e36f038353de3c3d3a6a1ca43c7f54f13cd",
            "cf4fdca15f88cfe20fb365824a9063a8e79fdbac822dfa43739b971168110f63",
            "ad50b3d69f67f351f20bd8e5654f0bf6e9fa760da2f2d019784dcc8cdd4e518e",
        ])
    }

    /// Findings 2 and 3: an omitted memo and currency, and a half-up tie at the fifth decimal,
    /// give Bun's manual identity (`createManualTransactionHash`, run with `bun`), so a retry is
    /// a duplicate.
    @Test func manualIdentityMatchesTheTypeScriptBackend() async throws {
        let expected = "b3208f10b21f501db52405b341c2826f10b5b5431c7e613d49677d18ad2e04c6"
        let bare = JSObject([("amount", .string("12.34565")), ("recipient_id", .number(1))])
        let spelled = JSObject([
            ("amount", .number(12.3457)), ("recipient_id", .number(1)), ("memo", .string("")),
            ("currency", .string("eur")),
        ])
        #expect(try TransactionsArea.manualHash(bare, date: "2026-01-05", accountId: 1) == expected)
        #expect(try TransactionsArea.manualHash(spelled, date: "2026-01-05", accountId: 1) == expected)

        let database = try Self.database([])
        try await database.run { session throws in
            func fields(_ base: JSObject) -> JSObject {
                var fields = base
                fields["date"] = .string("2026-01-05")
                fields["account_id"] = .number(1)
                return fields
            }
            #expect(try TransactionsArea.create(session, fields: fields(bare)).status == 201)
            #expect(Self.status { _ = try TransactionsArea.create(session, fields: fields(spelled)) } == 409)
        }
    }

    /// Finding 5: a closed account's row cannot be deleted.
    @Test func aClosedAccountRowIsNotDeleted() async throws {
        let database = try Self.database([
            Self.transaction(id: 1, date: "2026-01-05", amount: "-5"),
            "UPDATE accounts SET is_active = 0, closed_at = \(Self.stamp) WHERE id = 1",
        ])
        try await database.run { session throws in
            #expect(Self.status { _ = try TransactionsArea.delete(session, id: TransactionID(rawValue: 1), root: nil) } == 400)
            #expect(try session.row("SELECT id FROM transactions WHERE id = 1") != nil)
        }
    }

    /// One reviewable batch whose rows all carry the versioned identity.
    static func stagedBatch(_ rows: [(amount: String, sequence: String?)]) -> [String] {
        let values = rows.enumerated().map { index, row in
            let fingerprint = String(repeating: String(index + 1), count: 64).prefix(64)
            return "(\(index + 1), 30, \(index), 'matched', '2026-01-0\(index + 1)', 'Main', 'Seeded', 'Row \(index)',"
                + " vision_numeric('\(row.amount)', 20, 4), 'EUR', 1, 'exact', '\(fingerprint)', 1, 1,"
                + " \(row.sequence.map { "vision_numeric('\($0)', 18, 0)" } ?? "NULL"), \(stamp), \(stamp))"
        }
        return [
            "INSERT INTO import_batches (id, adapter_name, source_filename, status, rows_total, rows_imported,"
                + " started_at) VALUES (30, 'generic', 'g.csv', 'awaiting_review', \(rows.count), 0, \(stamp))",
            "INSERT INTO import_staging_rows (id, batch_id, row_index, status, tx_date, bank_account, recipient_raw,"
                + " memo, amount, currency, resolved_recipient_id, match_source, dedup_fingerprint,"
                + " dedup_fingerprint_version, dedup_occurrence, bank_sequence, created_at, updated_at) VALUES "
                + values.joined(separator: ", "),
        ]
    }

    /// Findings 6 and 12: a row that fits staging but not the ledger fails alone; the rest of the
    /// chunk commits row by row and keeps its bank sequence.
    @Test func anOverflowingRowFailsAloneAndTheRestKeepTheirSequence() async throws {
        let database = try Self.database(Self.stagedBatch([
            (amount: "-12.5", sequence: "7"), (amount: "1234567890123456", sequence: nil),
        ]))
        let result = try await database.run { session throws in
            try ImportCommitArea.commit(session, batch: 30)
        }
        let body = result.data.objectValue
        #expect(body?["imported"] == .int(1))
        #expect(body?["errors"] == .int(1))
        try await database.run { session throws in
            let row = try #require(try session.row("SELECT bank_sequence FROM transactions"))
            #expect(try row.optionalText("bank_sequence") == "7")
        }
    }

    /// Finding 13: a failing auto-link after the rows are written does not fail the commit.
    @Test func aFailingAutoLinkKeepsTheCommit() async throws {
        let database = try Self.database(
            Self.stagedBatch([(amount: "-12.5", sequence: nil)])
                + ["ALTER TABLE planned_transactions RENAME TO planned_transactions_gone"])
        let result = try await database.run { session throws in
            try ImportCommitArea.commit(session, batch: 30)
        }
        #expect(result.data.objectValue?["imported"] == .int(1))
        #expect(result.data.objectValue?["auto_linked_count"] == .int(0))
    }

    /// Finding 7: `import_batch_id` is the decimal string the client schema requires.
    @Test func importBatchIdIsAString() async throws {
        let database = try Self.database([
            "INSERT INTO portfolio_import_batches (id, adapter_name) VALUES (9, 'generic')",
            "INSERT INTO investments (id, name, asset_class, currency, is_active, price_provider, created_at, updated_at)"
                + " VALUES (1, 'Fund', 'etf', 'EUR', 1, 'manual', \(Self.stamp), \(Self.stamp))",
            "INSERT INTO portfolio_transactions (id, investment_id, type, date, amount, currency, import_batch_id,"
                + " created_at, updated_at) VALUES (1, 1, 'dividend', '2026-01-05', vision_numeric('3', 18, 4), 'EUR',"
                + " 9, \(Self.stamp), \(Self.stamp))",
        ])
        let json = try await database.run { session throws in
            try PortfolioTxRow(try #require(try session.row("SELECT * FROM portfolio_transactions WHERE id = 1"))).json
        }
        #expect(json["import_batch_id"] == .string("9"))
    }

    static func multipart(_ parts: [(name: String, filename: String?, type: String, content: String)]) -> InProcessRequest {
        var body = ""
        for part in parts {
            body += "--XYZ\r\nContent-Disposition: form-data; name=\"\(part.name)\""
            if let filename = part.filename { body += "; filename=\"\(filename)\"" }
            body += "\r\nContent-Type: \(part.type)\r\n\r\n\(part.content)\r\n"
        }
        body += "--XYZ--\r\n"
        return request(
            "importCsv", .post, body: body, headers: ["Content-Type": "multipart/form-data; boundary=XYZ"])
    }

    /// Finding 8: the boundary text inside a line is content, not a delimiter.
    @Test func boundaryTextInsideALineIsContent() throws {
        let request = Self.multipart([(name: "file", filename: "a.csv", type: "text/csv", content: "a,b\nx --XYZ y\n")])
        let parts = try #require(MultipartParts.parse(headers: request.headers, body: request.body))
        #expect(parts.count == 1)
        #expect(String(decoding: parts[0].data, as: UTF8.self) == "a,b\nx --XYZ y\n")
    }

    /// Finding 21: multer's `single("file")` limits: a second file and an oversized file.
    @Test func uploadsKeepMulterLimits() {
        let two = Self.multipart([
            (name: "file", filename: "a.csv", type: "text/csv", content: "a"),
            (name: "file", filename: "b.csv", type: "text/csv", content: "b"),
        ])
        #expect(Self.message { _ = try ImportUploadsArea.form(two) } == "Upload error: Unexpected field")
        let other = Self.multipart([(name: "attachment", filename: "a.csv", type: "text/csv", content: "a")])
        #expect(Self.message { _ = try ImportUploadsArea.form(other) } == "Upload error: Unexpected field")
        let big = Self.multipart([
            (name: "file", filename: "a.csv", type: "text/csv", content: String(repeating: "a", count: 50 * 1024 * 1024 + 1))
        ])
        #expect(Self.message { _ = try ImportUploadsArea.form(big) } == "File size exceeds maximum of 50MB")
        let fits = Self.multipart([(name: "file", filename: "a.csv", type: "text/csv", content: "a,b\n")])
        #expect(Self.status { _ = try ImportUploadsArea.form(fits) } == nil)
    }

    /// Finding 10: an edited amount is stored at the ledger's four decimals, half up.
    @Test func anEditedAmountIsRounded() async throws {
        let database = try Self.database([Self.transaction(id: 1, date: "2026-01-05", amount: "-5")])
        try await database.run { session throws in
            _ = try TransactionsArea.update(
                session, id: TransactionID(rawValue: 1),
                request: Self.request("updateTransaction", .patch, body: #"{"amount":"12.34565"}"#))
            #expect(try session.row("SELECT amount FROM transactions WHERE id = 1")?.text("amount") == "12.3457")
        }
    }

    /// Finding 16: deleting a row unlinks its stored attachment files.
    @Test func deletingARowRemovesItsFiles() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("receipt.pdf")
        try Data("pdf".utf8).write(to: file)
        let outside = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data("keep".utf8).write(to: outside)
        #expect(AttachmentsArea.storedFile("../\(outside.lastPathComponent)", root: root.path) == nil)
        AttachmentsArea.removeStoredFiles(["receipt.pdf", "../\(outside.lastPathComponent)"], root: root.path)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        #expect(FileManager.default.fileExists(atPath: outside.path))
    }

    /// Finding 17: one planned row inside the amount tolerance links, although a second
    /// planned row of the same payee and day is outside it.
    @Test func theOnePlannedRowWithinToleranceLinks() async throws {
        let database = try Self.database([
            Self.transaction(id: 1, date: "2026-01-05", amount: "-50"),
            "INSERT INTO planned_transactions (id, planned_date, amount, currency, memo, recipient_id, is_recurring,"
                + " is_executed, is_active, created_at, updated_at) VALUES"
                + " (1, '2026-01-05', vision_numeric('-50', 18, 4), 'EUR', 'Rent', 1, 0, 0, 1, \(Self.stamp), \(Self.stamp)),"
                + " (2, '2026-01-05', vision_numeric('-80', 18, 4), 'EUR', 'Other', 1, 0, 0, 1, \(Self.stamp), \(Self.stamp))",
        ])
        let linked = try await database.run { session throws in
            try PlannedArea.autoLink(
                session, transaction: TransactionID(rawValue: 1), fields: JSObject([("amount", .number(-50))]),
                txDate: "2026-01-05", accountId: 1)
        }
        #expect(linked == 1)
    }

    /// Finding 18: `every` and the digits need whitespace between them, as the regex does.
    @Test func everyNDaysNeedsItsSpaces() {
        #expect(Recurrence.parseStep(.string("every 2 days")) != nil)
        #expect(Recurrence.parseStep(.string("every2days")) == nil)
        #expect(Recurrence.parseStep(.string("every 2days")) == nil)
        #expect(Recurrence.parseStep(.string("every2 days")) == nil)
    }

    /// Finding 22: a failing detection answers the empty result.
    @Test func aFailingRecurringDetectionIsEmpty() async throws {
        let database = try Self.database(["ALTER TABLE transactions RENAME TO transactions_gone"])
        let result = try await database.run { session throws in
            try InfoArea.recurringPatterns(
                session,
                request: InProcessRequest(
                    operationId: "getRecurringPatterns", method: .get, pathParameters: [:], queryItems: [], headers: [:],
                    body: nil))
        }
        #expect(result.data == .object(["patterns": .array([]), "total": .int(0)]))
    }

    /// Finding 25: a transfer fee keeps the per-lot history the transfer service stores.
    @Test func transferFeesKeepTheirLots() throws {
        let rows = [
            PortfolioCore.Txn(id: 1, type: "buy", date: "2026-01-01", units: .number(5), amount: .number(50), accountId: 1),
            PortfolioCore.Txn(id: 2, type: "buy", date: "2026-01-02", units: .number(5), amount: .number(100), accountId: 1),
            PortfolioCore.Txn(
                id: 3, type: "asset_transfer", date: "2026-01-03", units: .number(10), sourceAccountId: 1,
                destinationAccountId: 2, feeUnits: .number(2)),
        ]
        let streams = try PortfolioCustody.projectAssetTransferPartitions(rows, method: "fifo")
        let out = try #require(streams.rows(of: 1).first { $0.type == "transfer_out" })
        let lots = try #require(out.assetFeeLots)
        #expect(lots.map(\.acquiredDate) == ["2026-01-01", "2026-01-02"])
        #expect(lots.map(\.units.description) == ["1", "1"])
        let basis = lots.reduce(DecimalJS.zero) { $0.plus($1.costBasis) }
        #expect(basis == out.assetFeeBasis)
    }

    /// Findings 9 and 14: opposite legs in two accounts pair up; a leg with two candidates waits.
    @Test func reconcilePairsUniqueOppositeLegs() async throws {
        let database = try Self.database([
            Self.secondAccount,
            Self.transaction(id: 1, date: "2026-01-05", amount: "-100"),
            Self.transaction(id: 2, date: "2026-01-06", amount: "100", account: 2),
            Self.transaction(id: 3, date: "2026-02-05", amount: "-40"),
            Self.transaction(id: 4, date: "2026-02-05", amount: "40", account: 2),
            Self.transaction(id: 5, date: "2026-02-06", amount: "40", account: 2),
        ])
        try await database.run { session throws in
            #expect(try TransferReconciliation.reconcile(session) == 1)
            let paired = try session.rows(
                "SELECT id, transfer_peer_id FROM transactions WHERE is_transfer = 1 AND transfer_source = 'auto' ORDER BY id")
            #expect(try paired.map { try $0.integerId("id") } == [1, 2])
            #expect(try paired.map { try $0.optionalInt64("transfer_peer_id") } == [2, 1])
            // Idempotent.
            #expect(try TransferReconciliation.reconcile(session) == 0)
        }
    }

    /// Findings 9, 14 and 15: the scheduled reconcile runs after its debounce, then the
    /// aggregation refresh clears the forecast caches.
    @Test func scheduledFollowUpsReconcileAndClearTheCaches() async throws {
        let database = try Self.database([
            Self.secondAccount,
            Self.transaction(id: 1, date: "2026-01-05", amount: "-100"),
            Self.transaction(id: 2, date: "2026-01-05", amount: "100", account: 2),
            "INSERT INTO cashflow_forecast_mc_rolling (today_iso, days_back, days_forward, filter_hash, payload)"
                + " VALUES ('2026-01-05', 30, 30, 'k', '{}')",
        ])
        let followUps = LedgerFollowUps(
            database: database, views: MaterializedViewRefresher(database: database),
            timing: .init(
                reconcileDebounce: .milliseconds(20), reconcileMaxWait: .milliseconds(50),
                cacheClearDebounce: .milliseconds(20)))
        followUps.scheduleReconcile()
        followUps.scheduleReconcile()
        var settled = false
        for _ in 0..<100 where !settled {
            try await Task.sleep(for: .milliseconds(20))
            settled = try await database.run { session throws in
                let pairs = try session.rows("SELECT id FROM transactions WHERE is_transfer = 1").count
                let cached = try session.rows("SELECT 1 FROM cashflow_forecast_mc_rolling").count
                return pairs == 2 && cached == 0
            }
        }
        #expect(settled)
    }
}
