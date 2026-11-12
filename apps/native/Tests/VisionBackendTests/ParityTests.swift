import Foundation
import Synchronization
import Testing
import VisionNativeCore

@testable import VisionBackend

/// Replays the parity corpus `bun run native:parity` recorded from the TypeScript backend
/// (ADR-270 decision 5): the same migrated database and seed, the same requests in order,
/// through `RoutingAPITransport`, and the JSON compared semantically. `meta.requestId` is left
/// out, and a timestamp the run created (one not written in the seed) is compared by form.
@Suite struct ParityTests {
    struct Step: Decodable {
        // lint:allow raw-id an OpenAPI operationId, not an entity identifier
        let operationId: String
        let method: String
        let path: String
        let hasBody: Bool
        let status: Int
        let response: JSONValue
        /// Provider answers from this step on, replacing the corpus's.
        let fetch: [String: Stub]?

        enum CodingKeys: String, CodingKey { case operationId, method, path, body, status, response, fetch }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            operationId = try container.decode(String.self, forKey: .operationId)
            method = try container.decode(String.self, forKey: .method)
            path = try container.decode(String.self, forKey: .path)
            hasBody = container.contains(.body)
            status = try container.decode(Int.self, forKey: .status)
            response = try container.decode(JSONValue.self, forKey: .response)
            fetch = try container.decodeIfPresent([String: Stub].self, forKey: .fetch)
        }
    }

    struct Corpus: Decodable {
        let seed: [String]
        let fetch: [String: Stub]?
        let steps: [Step]
    }

    /// A recorded provider answer.
    struct Stub: Decodable, Sendable {
        let status: Int
        let body: String
    }

    /// The recorder's `fetch`: a recorded answer by URL, anything else unreachable. A step can
    /// replace the answers for the steps from it on.
    final class StubFetcher: ProviderFetching {
        struct Unreachable: Error { let url: URL }
        private let stubs: Mutex<[String: Stub]>

        init(stubs: [String: Stub]) { self.stubs = Mutex(stubs) }

        func replace(_ next: [String: Stub]) { stubs.withLock { $0 = next } }

        func get(_ url: URL, timeout: TimeInterval) async throws -> ProviderResponse {
            guard let stub = stubs.withLock({ $0[url.absoluteString] }) else { throw Unreachable(url: url) }
            return ProviderResponse(status: stub.status, body: Data(stub.body.utf8))
        }
    }

    /// The recorder's `APP_TIMEZONE`; `{{today}}` in a response is that zone's today.
    static let recorderTime = SQLTimestamps(timeZone: TimeZone(identifier: "Europe/Brussels") ?? .current)
    static let todayToken = "{{today}}"

    struct NoFallback: APITransport, APIStreamTransport {
        struct Unrouted: Error { let path: String }
        func send(_ request: APIRequest) async throws -> APIResponse { throw Unrouted(path: request.url.path) }
        func stream(_ request: APIRequest, receive: (Data) async throws -> Void) async throws -> APIResponse {
            throw Unrouted(path: request.url.path)
        }
    }

    static let corpusDirectory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("parity")

    /// A database file as `runMigrations` leaves it, plus the area's seed.
    static func migratedDatabase(seed: [String]) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("vision-parity-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("vision.sqlite3")
        let db = try SQLiteConnection(path: file.path)
        try db.registerVisionFunctions()
        try db.registerSchemaFunctions()
        try db.execute("PRAGMA foreign_keys = OFF")
        try db.execute("BEGIN IMMEDIATE")
        try db.execute(
            "CREATE TABLE vision_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)"
        )
        for entry in MigrationLedger.expected {
            let sql = try String(
                contentsOf: PersistenceTests.migrations.appendingPathComponent("\(entry.name).sql"), encoding: .utf8)
            try db.execute(sql)
            _ = try db.query(
                "INSERT INTO vision_migrations VALUES (?, ?, ?, '2026-11-07T00:00:00.000Z')",
                [.integer(entry.version), .text(entry.name), .text(entry.sha256)])
        }
        try db.execute("PRAGMA user_version = \(MigrationLedger.expected.count)")
        try db.execute("COMMIT")
        try db.execute("PRAGMA foreign_keys = ON")
        for statement in seed { try db.execute(statement) }
        return file
    }

    /// The `YYYY-MM-DDTHH:mm:ss.sssZ` form of every canonical timestamp the seed writes.
    static func seedTimestamps(_ seed: [String]) -> Set<String> {
        var found: Set<String> = []
        for statement in seed {
            let bytes = Array(statement.utf8)
            guard bytes.count >= 27 else { continue }
            for start in 0...(bytes.count - 27) {
                let candidate = String(decoding: bytes[start..<(start + 27)], as: UTF8.self)
                if let iso = SQLRow.isoMilliseconds(fromCanonical: candidate) { found.insert(iso) }
            }
        }
        return found
    }

    static func isTimestampForm(_ text: String) -> Bool {
        text.count == 24 && text.hasSuffix("Z") && Instant(text) != nil
            && SQLRow.isoMilliseconds(fromCanonical: String(text.dropLast()) + "000Z") != nil
    }

    /// The first difference between `expected` and `actual`, or nil when they match.
    static func difference(
        _ expected: JSONValue, _ actual: JSONValue, at path: String, seedTimes: Set<String>, today: String = ""
    ) -> String? {
        switch (expected, actual) {
        case (.object(let want), .object(let got)):
            if Set(want.keys) != Set(got.keys) {
                return "\(path): keys \(want.keys.sorted()) != \(got.keys.sorted())"
            }
            for key in want.keys.sorted() {
                if let found = difference(
                    want[key]!, got[key]!, at: "\(path).\(key)", seedTimes: seedTimes, today: today)
                {
                    return found
                }
            }
            return nil
        case (.array(let want), .array(let got)):
            if want.count != got.count { return "\(path): \(want.count) items != \(got.count)" }
            for (index, pair) in zip(want, got).enumerated() {
                if let found = difference(
                    pair.0, pair.1, at: "\(path)[\(index)]", seedTimes: seedTimes, today: today)
                {
                    return found
                }
            }
            return nil
        case (.string(let want), .string(let got)) where want == todayToken:
            return got == today ? nil : "\(path): \(got) is not today (\(today))"
        case (.string(let want), .string(let got)) where isTimestampForm(want) && !seedTimes.contains(want):
            return isTimestampForm(got) ? nil : "\(path): \(got) is not a timestamp"
        case (.int(let want), .double(let got)), (.double(let got), .int(let want)):
            return Double(want) == got ? nil : "\(path): \(want) != \(got)"
        default:
            return expected == actual ? nil : "\(path): \(expected) != \(actual)"
        }
    }

    /// The body without `meta.requestId`, and without `meta` when nothing else is in it.
    static func withoutRequestId(_ body: JSONValue) -> JSONValue {
        guard case .object(var fields) = body, case .object(var meta)? = fields["meta"] else { return body }
        meta["requestId"] = nil
        fields["meta"] = meta.isEmpty ? nil : .object(meta)
        return .object(fields)
    }

    static func replay(_ area: String) async throws {
        let data = try Data(contentsOf: corpusDirectory.appendingPathComponent("\(area).json"))
        let corpus = try JSONDecoder().decode(Corpus.self, from: data)
        let file = try migratedDatabase(seed: corpus.seed)
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let database = BackendDatabase(path: file.path, time: recorderTime)
        let fetcher = StubFetcher(stubs: corpus.fetch ?? [:])
        let backend = InProcessBackend.live(database: database, fetcher: fetcher)
        let transport = RoutingAPITransport(backend: backend, fallback: NoFallback(), streamFallback: NoFallback())
        let seedTimes = seedTimestamps(corpus.seed)
        // The bodies go out as `JSON.stringify` wrote them: key order decides issue order.
        guard case .array(let rawSteps)? = JSValue.parse(data)?.objectValue?["steps"] else {
            Issue.record("\(area): the corpus has no steps")
            return
        }
        for (index, step) in corpus.steps.enumerated() {
            let label = "\(area) step \(index): \(step.method) \(step.path)"
            if let next = step.fetch { fetcher.replace(next) }
            let url = try #require(URL(string: "http://127.0.0.1:3001\(step.path)"))
            let method = try #require(HTTPMethod(rawValue: step.method), "\(label)")
            let request = APIRequest(
                method: method, url: url, headers: step.hasBody ? ["Content-Type": "application/json"] : [:],
                body: step.hasBody ? rawSteps[index].objectValue?["body"].map { Data($0.jsonText.utf8) } : nil,
                timeout: 30)
            let matched = try #require(backend.match(request), "\(label) is not ported")
            #expect(matched.0.operationId == step.operationId, "\(label)")
            let response = try await transport.send(request)
            #expect(response.status == step.status, "\(label)")
            let body = try JSONDecoder().decode(JSONValue.self, from: response.body)
            let today = SQLTimestamps.formatDate(recorderTime.localDate(of: .init(ms: Int64(Date().timeIntervalSince1970 * 1000))))
            let found = difference(
                step.response, withoutRequestId(body), at: "response", seedTimes: seedTimes, today: today)
            #expect(found == nil, "\(label): \(found ?? "")")
            if case .object(let fields) = body, case .object(let meta)? = fields["meta"] {
                #expect(meta["requestId"] != nil, "\(label)")
                #expect(response.headers["x-request-id"] != nil, "\(label)")
            }
        }
    }

    @Test func tags() async throws {
        try await Self.replay("tags")
    }

    @Test func settings() async throws {
        try await Self.replay("settings")
    }

    @Test func exchangeRates() async throws {
        try await Self.replay("exchange-rates")
        try await Self.replay("exchange-rates-empty")
    }

    /// The seeded mutations of each area's requests and provider answers (scripts/lib/nativeParityMutations.ts).
    @Test(arguments: ["tags-mutations", "settings-mutations", "exchange-rates-mutations"])
    func mutations(_ area: String) async throws {
        try await Self.replay(area)
    }

    /// A stale list without `db_only` starts `warmCache` in the background, which the corpus
    /// cannot record in order: the rates appear once the refresh has run.
    @Test func staleListRefreshesInTheBackground() async throws {
        let file = try Self.migratedDatabase(seed: [])
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let corpus = try JSONDecoder().decode(
            Corpus.self, from: Data(contentsOf: Self.corpusDirectory.appendingPathComponent("exchange-rates.json")))
        let database = BackendDatabase(path: file.path, time: Self.recorderTime)
        let backend = InProcessBackend.live(database: database, fetcher: StubFetcher(stubs: corpus.fetch ?? [:]))
        let transport = RoutingAPITransport(backend: backend, fallback: NoFallback(), streamFallback: NoFallback())
        let url = try #require(URL(string: "http://127.0.0.1:3001/api/info/exchange-rates"))
        let response = try await transport.send(APIRequest(method: .get, url: url, headers: [:], body: nil, timeout: 30))
        #expect(response.status == 200)
        var stored = 0
        for _ in 0..<200 {
            stored = try await database.run { session in
                try session.rows("SELECT currency_code FROM exchange_rates WHERE is_latest = 1").count
            }
            if stored > 0 { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        // The recorded ECB and open.er-api answers hold seven usable quotes besides EUR.
        #expect(stored == 7)
    }

    @Test func everyPortedOperationHasACorpus() throws {
        let files = try FileManager.default.contentsOfDirectory(atPath: Self.corpusDirectory.path)
            .filter { $0.hasSuffix(".json") }
        var covered: Set<String> = []
        for file in files {
            let data = try Data(contentsOf: Self.corpusDirectory.appendingPathComponent(file))
            covered.formUnion(try JSONDecoder().decode(Corpus.self, from: data).steps.map(\.operationId))
        }
        #expect(PortedOperations.ids.isSubset(of: covered))
    }
}

/// The helpers whose JavaScript semantics the corpus only samples, against values Bun gave.
@Suite struct BackendInputTests {
    @Test func slugifyMatchesTheSharedUtility() {
        let cases: [(String, String)] = [
            ("  Groceries   Weekly!! ", "groceries-weekly"), ("Café İstanbul", "caf-istanbul"), ("a - b", "a-b"),
            ("--x--", "x"), ("a\u{00A0}\u{2028}b", "a-b"), ("-!-a-!-", "a"), ("KELVIN \u{212A}", "kelvin-k"),
            ("x\u{0085}y", "xy"), ("ÀÉÎ", ""), ("a_b.c", "abc"), ("\tTab\nNew\r", "tab-new"), ("", ""), ("  ", ""),
            ("a—b", "ab"), ("ŞİŞLİ 2020", "ili-2020"), ("--", ""), ("a!-!b", "a-b"),
        ]
        for (input, slug) in cases { #expect(slugify(input) == slug, "\(input)") }
    }

    @Test func parseIntMatchesJavaScript() {
        let cases: [(String, Double?)] = [
            ("12", 12), (" +7x", 7), ("-0", 0), ("1e3", 1), ("0x10", 0), ("abc", nil), ("", nil), ("\u{00A0} 42", 42),
            ("99999999999999999999", 1e20), ("9007199254740993", 9_007_199_254_740_992), ("-5", -5),
        ]
        for (input, value) in cases { #expect(JavaScriptInteger.parse(input) == value, "\(input)") }
    }

    @Test func parseFloatMatchesJavaScript() {
        let cases: [(String, String)] = [
            ("1.2.3", "1.2"), (".", "NaN"), (".5", "0.5"), ("5.", "5"), ("007", "7"), ("..5", "NaN"), ("162.2.5", "162.2"),
        ]
        for (input, text) in cases {
            #expect(SQLArguments.javaScriptText(ExchangeRatesArea.parseFloat(input)) == text, "\(input)")
        }
    }

    @Test func numberCoercionMatchesJavaScript() {
        let cases: [(String, String)] = [
            (" 0x1F ", "31"), ("1e", "NaN"), (".5", "0.5"), ("5.", "5"), ("+.e1", "NaN"), ("-Infinity", "-Infinity"),
            ("infinity", "NaN"), ("1_000", "NaN"), ("\u{00A0}12\n", "12"), ("0b101", "5"), ("-0b1", "NaN"),
            ("00012", "12"), ("1e1000", "Infinity"), ("0x", "NaN"), ("1e+2", "100"), ("-.5e-1", "-0.05"), ("+5", "5"),
            (" ", "0"),
        ]
        for (input, text) in cases {
            #expect(SQLArguments.javaScriptText(JavaScriptNumber.fromString(input)) == text, "\(input)")
        }
    }

    @Test func jsonTextMatchesJavaScript() throws {
        let parsed = try #require(
            JSValue.parse(
                #"{"b":1,"2":2,"a":{"1":0,"x":[1e21,-0,0.1,1e-7,123456789012345680000]},"10":3,"4294967295":4,"4294967294":5}"#
            ))
        #expect(
            parsed.jsonText
                == #"{"2":2,"10":3,"4294967294":5,"b":1,"a":{"1":0,"x":[1e+21,0,0.1,1e-7,123456789012345680000]},"4294967295":4}"#
        )
        #expect(JSValue.parse(#"{"a":1,"b":2,"a":3}"#)?.jsonText == #"{"a":3,"b":2}"#)
        #expect(JSValue.string("\u{01}\u{2028}\"\\\u{08}\u{7F}/").jsonText == "\"\\u0001\u{2028}\\\"\\\\\\b\u{7F}/\"")
        for text in [#"[1,]"#, #"{"a":1,}"#, "01", "1.", "-", #""\x""#, "[1] x", "tru", "\"\t\""] {
            #expect(JSValue.parse(text) == nil, "\(text)")
        }
        #expect(JSValue.parse("1E5") == .number(100_000))
    }
}
