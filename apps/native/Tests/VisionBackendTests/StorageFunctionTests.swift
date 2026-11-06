import Foundation
import Testing

@testable import VisionBackend

/// Boundary tests for the storage CHECK helpers, nextval() and the schema's own functions
/// (functions.test.ts and the schemaFunctions part of sqliteBaseline.test.ts).
@Suite struct StorageFunctionTests {
    @Test func uuidCheckAcceptsOnlyCanonicalText() throws {
        let db = try GoldenFixtures.connection()
        let ok = [
            "00000000-0000-0000-0000-000000000000", "123e4567-e89b-12d3-a456-426614174000",
            "ffffffff-ffff-ffff-ffff-ffffffffffff",
        ]
        let bad = [
            "123E4567-E89B-12D3-A456-426614174000", "123e4567e89b12d3a456426614174000",
            "{123e4567-e89b-12d3-a456-426614174000}", "123e4567-e89b-12d3-a456-42661417400",
            "123e4567-e89b-12d3-a456-4266141740000", "123e4567-e89b-12d3-a456-42661417400g",
            " 123e4567-e89b-12d3-a456-426614174000", "123e4567-e89b-12d3-a456-426614174000\n", "",
        ]
        for uuid in ok { #expect(try db.scalar("SELECT vision_uuid_ok(?)", [.text(uuid)]) == .integer(1), "\(uuid)") }
        for uuid in bad { #expect(try db.scalar("SELECT vision_uuid_ok(?)", [.text(uuid)]) == .integer(0), "\(uuid)") }
        #expect(try db.scalar("SELECT vision_uuid_ok(42)") == .integer(0))
        #expect(try db.scalar("SELECT vision_uuid_ok(NULL)") == .null)
        #expect(try db.scalar("SELECT typeof(vision_uuid_ok(gen_random_uuid()))") == .text("integer"))
        #expect(try db.scalar("SELECT vision_uuid_ok(gen_random_uuid())") == .integer(1))
    }

    @Test func arrayCheckAcceptsCanonicalArrays() throws {
        let db = try GoldenFixtures.connection()
        let ok = [
            "[]", #"["a","b"]"#, "[1,2,3]", "[null]", #"["a",null]"#, "[-1,null,0]", #"[""]"#, #"["é","😀"]"#,
            #"["a\"b"]"#, "[9007199254740991]",
        ]
        let bad = [
            #"["a",1]"#, "[1.5]", "[1.0]", "[1e2]", "[-0]", "[9007199254740993]", "[[1]]", #"[{"a":1}]"#, "[true]",
            "[1, 2]", " [1]", #"["é"]"#, #"{"a":1}"#, #""a""#, "1", "null", "", "not json",
        ]
        for array in ok { #expect(try db.scalar("SELECT vision_array_ok(?)", [.text(array)]) == .integer(1), "\(array)") }
        for array in bad { #expect(try db.scalar("SELECT vision_array_ok(?)", [.text(array)]) == .integer(0), "\(array)") }
        #expect(try db.scalar("SELECT vision_array_ok(NULL)") == .null)
        #expect(try db.scalar("SELECT vision_array_ok(1)") == .integer(0))
    }

    static func sequenceDb() throws -> SQLiteConnection {
        let db = try GoldenFixtures.connection()
        try db.execute(
            """
            CREATE TABLE vision_sequences (name TEXT PRIMARY KEY, last_value INTEGER NOT NULL);
            INSERT INTO vision_sequences VALUES ('s', 0), ('big', 9007199254740992);
            CREATE TABLE t (id BIGINT PRIMARY KEY NOT NULL DEFAULT (nextval('s')), label TEXT);
            """)
        return db
    }

    @Test func nextvalFillsKeysAndRollsBack() throws {
        let db = try Self.sequenceDb()
        try db.execute("INSERT INTO t (label) VALUES ('first')")
        try db.execute("INSERT INTO t (label) VALUES ('second'), ('third')")
        #expect(
            try db.query("SELECT id, label FROM t ORDER BY id")
                == [[.integer(1), .text("first")], [.integer(2), .text("second")], [.integer(3), .text("third")]])
        #expect(try db.scalar("SELECT last_value FROM vision_sequences WHERE name = 's'") == .integer(3))
        #expect(try db.scalar("SELECT typeof(nextval('s'))") == .text("integer"))

        let fresh = try Self.sequenceDb()
        try fresh.execute("BEGIN; INSERT INTO t (label) VALUES ('x'); ROLLBACK;")
        try fresh.execute("INSERT INTO t (label) VALUES ('y')")
        #expect(try fresh.scalar("SELECT id FROM t") == .integer(1))
        #expect(try fresh.scalar("SELECT CAST(nextval('big') AS TEXT)") == .text("9007199254740993"))
    }

    @Test func nextvalRefusesMissingSequencesAndIndexes() throws {
        let db = try Self.sequenceDb()
        #expect(GoldenFixtures.outcome { try db.scalar("SELECT nextval('missing')") } == .error("42P01"))
        #expect(try db.scalar("SELECT nextval(NULL)") == .null)
        #expect(try db.scalar("SELECT last_value FROM vision_sequences WHERE name = 's'") == .integer(0))
        #expect(throws: DatabaseError.self) { try db.execute("CREATE INDEX t_next ON t ((id + nextval('s')))") }
    }

    @Test func visionRaiseCarriesTheStateAndConstraint() throws {
        let db = try GoldenFixtures.connection()
        try db.registerSchemaFunctions()
        do {
            _ = try db.scalar("SELECT vision_raise('23514', 'some_check', 'it ' || 'failed')")
            Issue.record("vision_raise returned")
        } catch let error as DatabaseError {
            #expect(error.code == "23514")
            #expect(error.constraint == "some_check")
            #expect(error.message == "it failed")
        }
        do {
            _ = try db.scalar("SELECT vision_raise('bad', '', NULL)")
            Issue.record("vision_raise returned")
        } catch let error as DatabaseError {
            #expect(error.code == "P0001")
            #expect(error.constraint == nil)
            #expect(error.message.isEmpty)
        }
    }

    @Test func cashReceiptAndIncomeSnapshots() throws {
        let db = try GoldenFixtures.connection()
        try db.registerSchemaFunctions()
        let receipt =
            #"{"portfolioCashReceipt": {"version": 1, "proof": {"kind": "closed_kinesis_cash"}, "after": {}}}"#
        #expect(
            try db.scalar("SELECT portfolio_cash_receipt(?)", [.text(receipt)])
                == .text(#"{"after": {}, "proof": {"kind": "closed_kinesis_cash"}, "version": 1}"#))
        #expect(try db.scalar("SELECT portfolio_cash_receipt('not json')") == .null)
        #expect(try db.scalar(#"SELECT portfolio_cash_receipt('{"portfolioCashReceipt": {"version": 2}}')"#) == .null)
        #expect(
            try db.scalar(#"SELECT normalize_portfolio_income_snapshot('{"a": 1, "income_recognition_role": "standard"}')"#)
                == .text(#"{"a": 1}"#))
        #expect(
            try db.scalar(#"SELECT normalize_portfolio_income_snapshot('{"income_recognition_role": "return_of_capital"}')"#)
                == .text(#"{"income_recognition_role": "return_of_capital"}"#))
        #expect(SchemaFunctions.snapshotColumns.count == 22)
        let call = try SchemaFunctions.snapshotSQL(alias: "pt")
        #expect(call.hasPrefix("portfolio_income_transaction_snapshot(pt.id, pt.investment_id, pt.type"))
        let args = [SQLValue](repeating: .null, count: 22)
        let snapshot = try db.scalar(
            "SELECT portfolio_income_transaction_snapshot(\(args.map { _ in "?" }.joined(separator: ", ")))", args)
        guard case .text(let text)? = snapshot else {
            Issue.record("snapshot was \(String(describing: snapshot))")
            return
        }
        #expect(!text.contains("income_recognition_role"))
        #expect(text.hasPrefix(#"{"id": null, "date": null, "fees": null"#))
        #expect(GoldenFixtures.outcome { try db.scalar("SELECT portfolio_income_transaction_snapshot(1)") } == .error("42883"))
    }
}
