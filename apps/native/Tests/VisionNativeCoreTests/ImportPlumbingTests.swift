import Foundation
import Testing
@testable import VisionNativeCore

/// Hands each scripted chunk of a 2xx answer to the reader, or returns a failure body; with
/// `hangAfterChunks`, waits (until cancelled) once those chunks are delivered.
final class FakeStreamTransport: APIStreamTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let status: Int
    private let chunks: [Data]
    private let failureBody: Data
    private let hangAfterChunks: Bool
    private var recorded: [APIRequest] = []

    init(status: Int = 200, chunks: [String] = [], failureBody: String = "", hangAfterChunks: Bool = false) {
        self.status = status
        self.chunks = chunks.map { Data($0.utf8) }
        self.failureBody = Data(failureBody.utf8)
        self.hangAfterChunks = hangAfterChunks
    }

    var requests: [APIRequest] {
        lock.withLock { recorded }
    }

    func stream(_ request: APIRequest, receive: (Data) async throws -> Void) async throws -> APIResponse {
        lock.withLock { recorded.append(request) }
        let scripted = chunks
        guard (200..<300).contains(status) else { return APIResponse(status: status, body: failureBody) }
        for chunk in scripted {
            try Task.checkCancellation()
            try await receive(chunk)
        }
        if hangAfterChunks { try await Task.sleep(for: .seconds(60)) }
        return APIResponse(status: status, body: Data())
    }
}

/// Collects what a `@Sendable` progress callback received.
actor ProgressLog {
    private(set) var items: [ImportProgress] = []
    func append(_ item: ImportProgress) { items.append(item) }
}

enum PlumbingFixture {
    static let base = URL(string: "http://127.0.0.1:54331")!

    static func client(
        stream: FakeStreamTransport = FakeStreamTransport(), transport: FakeTransport = FakeTransport([]),
        token: String? = "secret"
    ) -> APIClient {
        APIClient(
            baseURL: { base }, adminToken: { token }, transport: transport, sleep: { _ in }, jitter: { 0 },
            requestId: { "req-1" }, streamTransport: stream)
    }

    static let file = ImportFile(name: "bank.csv", data: Data("Date,Payee,Amount\n".utf8), mimeType: "text/csv")

    static func progressFrame(_ phase: String, current: Int, total: Int, percent: Int) -> String {
        "event: progress\ndata: {\"phase\":\"\(phase)\",\"current\":\(current),\"total\":\(total),\"imported\":0,\"duplicates\":0,\"errors\":0,\"percent\":\(percent)}\n\n"
    }
}

@Suite struct MultipartFormDataTests {
    @Test func encodesFieldsAndFilesInOrderBetweenOneBoundary() {
        var form = MultipartFormData(boundary: "XYZ")
        form.append(file: "file", filename: "bank.csv", contentType: "text/csv", data: Data("a,b\n1,2\n".utf8))
        form.append("bank_name", "kbc")
        #expect(form.contentType == "multipart/form-data; boundary=XYZ")
        let expected =
            "--XYZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"bank.csv\"\r\nContent-Type: text/csv\r\n\r\na,b\n1,2\n\r\n"
            + "--XYZ\r\nContent-Disposition: form-data; name=\"bank_name\"\r\n\r\nkbc\r\n" + "--XYZ--\r\n"
        #expect(String(decoding: form.encoded(), as: UTF8.self) == expected)
    }

    @Test func anEmptyFormIsOnlyTheClosingBoundary() {
        let form = MultipartFormData(boundary: "B")
        #expect(String(decoding: form.encoded(), as: UTF8.self) == "--B--\r\n")
    }

    @Test func quotesAndLineBreaksInNamesCannotEndTheHeader() {
        #expect(MultipartFormData.escape("a\"b\r\nc.csv") == "a%22b%0D%0Ac.csv")
        var form = MultipartFormData(boundary: "B")
        form.append(file: "file", filename: "my \"bank\".csv", contentType: "text/csv", data: Data())
        let text = String(decoding: form.encoded(), as: UTF8.self)
        #expect(text.contains("filename=\"my %22bank%22.csv\""))
    }

    @Test func theDefaultBoundaryIsRandomAndHasNoDashes() {
        let first = MultipartFormData()
        let second = MultipartFormData()
        #expect(first.boundary != second.boundary)
        #expect(first.boundary.hasPrefix("VisionNativeBoundary"))
        #expect(!first.boundary.contains("-"))
    }

    @Test func binaryFileBytesPassThroughUnchanged() {
        var form = MultipartFormData(boundary: "B")
        let bytes = Data([0xE9, 0x00, 0xFF, 0x0D, 0x0A])
        form.append(file: "file", filename: "x.csv", contentType: "text/csv", data: bytes)
        let body = form.encoded()
        #expect(body.range(of: bytes) != nil)
    }
}

@Suite struct ServerSentEventParserTests {
    @Test func oneChunkWithTwoFramesYieldsBothEvents() {
        var parser = ServerSentEventParser()
        let events = parser.feed(Data("event: progress\ndata: {\"a\":1}\n\nevent: complete\ndata: {}\n\n".utf8))
        #expect(events == [ServerSentEvent(event: "progress", data: "{\"a\":1}"), ServerSentEvent(event: "complete", data: "{}")])
        #expect(parser.finish().isEmpty)
    }

    @Test func aFrameSplitAcrossChunksWaitsForItsBlankLine() {
        var parser = ServerSentEventParser()
        #expect(parser.feed(Data("event: prog".utf8)).isEmpty)
        #expect(parser.feed(Data("ress\ndata: x\n".utf8)).isEmpty)
        #expect(parser.feed(Data("\n".utf8)) == [ServerSentEvent(event: "progress", data: "x")])
    }

    @Test func aCharacterSplitAcrossChunksStaysWhole() {
        var parser = ServerSentEventParser()
        let bytes = Array("data: café\n\n".utf8)
        // "é" is two bytes; cut between them.
        let cut = bytes.firstIndex(of: 0xC3)! + 1
        #expect(parser.feed(Data(bytes[..<cut])).isEmpty)
        #expect(parser.feed(Data(bytes[cut...])) == [ServerSentEvent(event: "message", data: "café")])
    }

    @Test func carriageReturnLineEndsAreAccepted() {
        var parser = ServerSentEventParser()
        let events = parser.feed(Data("event: error\r\ndata: {\"detail\":\"x\"}\r\n\r\ndata: y\r\n\n".utf8))
        #expect(events == [ServerSentEvent(event: "error", data: "{\"detail\":\"x\"}"), ServerSentEvent(event: "message", data: "y")])
    }

    @Test func commentsAndKeepAlivesYieldNothing() {
        var parser = ServerSentEventParser()
        #expect(parser.feed(Data(": keep-alive\n\nevent: progress\n\n".utf8)).isEmpty)
    }

    @Test func dataLinesJoinWithLineBreaksAndLoseLeadingSpace() {
        #expect(ServerSentEventParser.parseFrame("data:  one\ndata:two") == ServerSentEvent(event: "message", data: "one\ntwo"))
        #expect(ServerSentEventParser.parseFrame("event:   \ndata: x") == ServerSentEvent(event: "message", data: "x"))
    }

    @Test func theLastFrameWithoutItsBlankLineCountsAtTheEnd() {
        var parser = ServerSentEventParser()
        #expect(parser.feed(Data("event: complete\ndata: {}\n".utf8)).isEmpty)
        #expect(parser.finish() == [ServerSentEvent(event: "complete", data: "{}")])
        #expect(parser.finish().isEmpty)
    }
}

@Suite struct ImportStreamTests {
    @Test func streamEventsPostsTheFormAndHandsOverEachEvent() async throws {
        let stream = FakeStreamTransport(chunks: ["data: one\n", "\n", "event: two\ndata: 2\n\n"])
        var form = MultipartFormData(boundary: "B")
        form.append("bank_name", "kbc")
        let collected = EventLog()
        try await PlumbingFixture.client(stream: stream).streamEvents(
            path: "/api/import/csv/stream", body: form, fallbackMessage: "Import failed"
        ) { event in await collected.append(event) }
        #expect(await collected.items == [ServerSentEvent(event: "message", data: "one"), ServerSentEvent(event: "two", data: "2")])
        let request = try #require(stream.requests.first)
        #expect(request.method == .post)
        #expect(request.url.absoluteString == "http://127.0.0.1:54331/api/import/csv/stream")
        #expect(request.headers["Content-Type"] == "multipart/form-data; boundary=B")
        #expect(request.headers["Accept"] == "text/event-stream")
        #expect(request.headers["Authorization"] == "Bearer secret")
        #expect(request.headers["X-Request-Id"] == "req-1")
        #expect(request.body == form.encoded())
        #expect(request.timeout == APIClient.streamTimeout)
    }

    @Test func aFailedAnswerThrowsItsEnvelope() async {
        let stream = FakeStreamTransport(
            status: 400, failureBody: #"{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"Unknown bank"}}"#)
        await #expect(throws: APIError.client(APIClientError(status: 400, code: .validationError, message: "Unknown bank"))) {
            try await PlumbingFixture.client(stream: stream).streamEvents(
                path: "/api/import/csv/stream", body: MultipartFormData(boundary: "B"), fallbackMessage: "Import failed"
            ) { _ in }
        }
        let plain = FakeStreamTransport(status: 502, failureBody: "Bad gateway")
        await #expect(throws: APIError.client(APIClientError(status: 502, code: .badGateway, message: "Import failed (status 502)"))) {
            try await PlumbingFixture.client(stream: plain).streamEvents(
                path: "/api/import/csv/stream", body: MultipartFormData(boundary: "B"), fallbackMessage: "Import failed"
            ) { _ in }
        }
    }

    @Test func importStreamReportsProgressAndTheCompletion() async throws {
        let stream = FakeStreamTransport(chunks: [
            PlumbingFixture.progressFrame("parsing", current: 0, total: 0, percent: 5),
            PlumbingFixture.progressFrame("importing", current: 4, total: 10, percent: 40),
            "event: complete\ndata: {\"total_processed\":10,\"imported\":8,\"duplicates\":2,\"errors\":0,\"batch_id\":5}\n\n",
            "data: [DONE]\n\n",
        ])
        let log = ProgressLog()
        let outcome = try await PlumbingFixture.client(stream: stream).importStream(
            file: PlumbingFixture.file, bankName: "kbc"
        ) { progress in await log.append(progress) }
        #expect(outcome == .completed(ImportCompletion(total: 10, imported: 8, duplicates: 2, errors: 0, batchId: 5)))
        let phases = await log.items.map { item in item.phase }
        #expect(phases == ["parsing", "importing", "complete"])
        #expect(await log.items.last?.percent == 100)
        let body = String(decoding: try #require(stream.requests.first?.body), as: UTF8.self)
        #expect(body.contains("name=\"file\"; filename=\"bank.csv\"\r\nContent-Type: text/csv"))
        #expect(body.contains("name=\"bank_name\"\r\n\r\nkbc\r\n"))
    }

    @Test func aParkedImportEndsInItsReview() async throws {
        let review = FakeStreamTransport(chunks: ["event: review_required\ndata: {\"batch_id\":42,\"rows\":3}\n\n"])
        let first = try await PlumbingFixture.client(stream: review).importStream(
            file: PlumbingFixture.file, bankName: "kbc") { _ in }
        #expect(first == .reviewRequired(batchId: 42))
        let flagged = FakeStreamTransport(chunks: [
            "event: complete\ndata: {\"total_processed\":3,\"imported\":0,\"duplicates\":0,\"errors\":0,\"batch_id\":9,\"requires_review\":true}\n\n"
        ])
        let second = try await PlumbingFixture.client(stream: flagged).importStream(
            file: PlumbingFixture.file, bankName: "kbc") { _ in }
        #expect(second == .reviewRequired(batchId: 9))
    }

    @Test func anErrorEventFailsTheImportWithItsDetail() async {
        let stream = FakeStreamTransport(chunks: [
            PlumbingFixture.progressFrame("parsing", current: 0, total: 0, percent: 5),
            "event: error\ndata: {\"detail\":\"No rows found\"}\n\n",
            PlumbingFixture.progressFrame("importing", current: 1, total: 2, percent: 50),
        ])
        let log = ProgressLog()
        await #expect(throws: ImportStreamFailure(detail: "No rows found")) {
            _ = try await PlumbingFixture.client(stream: stream).importStream(
                file: PlumbingFixture.file, bankName: "kbc"
            ) { progress in await log.append(progress) }
        }
        #expect(await log.items.count == 1)
    }

    @Test func cancellingTheTaskAbortsTheStream() async throws {
        let stream = FakeStreamTransport(
            chunks: [PlumbingFixture.progressFrame("parsing", current: 0, total: 0, percent: 5)], hangAfterChunks: true)
        let log = ProgressLog()
        let client = PlumbingFixture.client(stream: stream)
        let task = Task {
            try await client.importStream(file: PlumbingFixture.file, bankName: "kbc") { progress in
                await log.append(progress)
            }
        }
        while await log.items.isEmpty { await Task.yield() }
        task.cancel()
        let result = await task.result
        #expect(throws: CancellationError.self) { try result.get() }
    }

    @Test func eachEventIsCheckedAgainstItsShape() throws {
        #expect(try ImportStreamEvents.handle(ServerSentEvent(event: "progress", data: "[DONE]")) == nil)
        #expect(try ImportStreamEvents.handle(ServerSentEvent(event: "ping", data: "{}")) == nil)
        #expect(throws: ImportStreamFailure(detail: "Invalid SSE payload")) {
            try ImportStreamEvents.handle(ServerSentEvent(event: "progress", data: "{oops"))
        }
        #expect(throws: ImportStreamFailure(detail: "Invalid SSE payload for \"progress\" event")) {
            try ImportStreamEvents.handle(ServerSentEvent(event: "progress", data: "{\"phase\":\"parsing\"}"))
        }
        #expect(throws: ImportStreamFailure(detail: "Import failed")) {
            try ImportStreamEvents.handle(ServerSentEvent(event: "error", data: "{\"detail\":\"  \"}"))
        }
        let progress = try ImportStreamEvents.handle(
            ServerSentEvent(
                event: "progress",
                data: "{\"phase\":\"importing\",\"current\":2.0,\"total\":4,\"imported\":1,\"duplicates\":1,\"errors\":0,\"percent\":50}"))
        #expect(
            progress == .progress(ImportProgress(phase: "importing", current: 2, total: 4, imported: 1, duplicates: 1, percent: 50)))
    }
}

/// Collects events handed to a stream callback.
actor EventLog {
    private(set) var items: [ServerSentEvent] = []
    func append(_ item: ServerSentEvent) { items.append(item) }
}

@Suite struct ImportCustomRequestTests {
    static let config: CSVParserConfig = {
        var config = CSVParserConfig()
        config.dateColumn = "Datum"
        config.recipientColumn = "Naam"
        config.amountColumn = "Bedrag"
        config.separator = ";"
        config.dateFormat = "%d/%m/%Y"
        config.encoding = "latin1"
        config.skipRows = 2
        config.numberFormat = .decimalComma
        return config
    }()

    @Test func sendsTheFileAndTheSetupAsFlatFieldsInTheWebOrder() throws {
        let request = ImportCsvCustomRequest(
            file: ImportFile(name: "export.csv", data: Data("x".utf8)), bankName: "My bank", config: Self.config,
            boundary: "B")
        #expect(request.contentType == "multipart/form-data; boundary=B")
        #expect(request.form.parts.map { part in part.name } == [
            "file", "bank_name", "date_format", "date_column", "recipient_column", "amount_column", "separator",
            "encoding", "skip_rows", "number_format",
        ])
        let values = request.form.parts.dropFirst().map { part in String(decoding: part.data, as: UTF8.self) }
        #expect(values == ["My bank", "%d/%m/%Y", "Datum", "Naam", "Bedrag", ";", "latin1", "2", "decimal_comma"])
        #expect(request.form.parts.first?.contentType == "application/octet-stream")
        #expect(try request.encodedBody() == request.form.encoded())
        var withMemo = Self.config
        withMemo.memoColumn = "Omschrijving"
        let memo = ImportCsvCustomRequest(file: PlumbingFixture.file, bankName: "generic", config: withMemo)
        #expect(memo.form.parts.map { part in part.name }.contains("memo_column"))
        #expect(memo.form.parts.first?.contentType == "text/csv")
    }

    @Test func theAnswerIsACommitOrAParkedBatch() async throws {
        let transport = FakeTransport([
            .response(201, #"{"ok":true,"data":{"total":5,"imported":4,"duplicates":1,"errors":0,"batch_id":3}}"#),
            .response(202, #"{"ok":true,"data":{"requires_review":true,"batch_id":8,"rows":5}}"#),
        ])
        let client = PlumbingFixture.client(transport: transport)
        let committed = try await client.importCustom(file: PlumbingFixture.file, bankName: "generic", config: Self.config)
        #expect(committed == .completed(ImportCompletion(total: 5, imported: 4, duplicates: 1, errors: 0, batchId: 3)))
        let parked = try await client.importCustom(file: PlumbingFixture.file, bankName: "generic", config: Self.config)
        #expect(parked == .reviewRequired(batchId: 8))
        let request = try #require(await transport.requests.first)
        #expect(request.method == .post)
        #expect(request.url.path == "/api/import/csv/custom")
        #expect(request.headers["Content-Type"]?.hasPrefix("multipart/form-data; boundary=") == true)
    }

    @Test func theTypedOperationsUseTheirPaths() async throws {
        let transport = FakeTransport([
            .response(200, #"{"ok":true,"data":{"items":[{"key":"kbc","name":"KBC","adapter_class":"KbcAdapter"}],"total":1}}"#),
            .response(200, #"{"ok":true,"data":{"deleted":4,"recipientsRemoved":1}}"#),
            .response(200, #"{"ok":true,"data":{"total":0,"limit":10,"offset":20,"items":[]}}"#),
        ])
        let client = PlumbingFixture.client(transport: transport)
        #expect(try await client.supportedAdapters() == [ImportAdapter(key: "kbc", name: "KBC", adapterClass: "KbcAdapter")])
        #expect(try await client.rollbackImportBatch(id: 12) == 4)
        let page: ImportBatchPage = try await client.importBatches(limit: 10, offset: 20)
        #expect(page.offset == 20)
        let urls = await transport.requests.map { request in request.method.rawValue + " " + request.url.absoluteString }
        #expect(urls == [
            "GET http://127.0.0.1:54331/api/info/supported-adapters",
            "DELETE http://127.0.0.1:54331/api/import/batches/12",
            "GET http://127.0.0.1:54331/api/import/batches?limit=10&offset=20",
        ])
    }
}
