import Foundation
import Testing

@testable import VisionNativeCore

/// Answers each request with the next scripted outcome and records what it was sent.
actor FakeTransport: APITransport {
    enum Outcome: Sendable {
        case response(Int, String)
        case failure(APIError)
        case cancelled
    }

    private var outcomes: [Outcome]
    private(set) var requests: [APIRequest] = []

    init(_ outcomes: [Outcome]) {
        self.outcomes = outcomes
    }

    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        guard !outcomes.isEmpty else { return APIResponse(status: 500, body: Data()) }
        switch outcomes.removeFirst() {
        case .response(let status, let body): return APIResponse(status: status, body: Data(body.utf8))
        case .failure(let error): throw error
        case .cancelled: throw CancellationError()
        }
    }
}

/// Records the backoff delays instead of sleeping.
actor SleepRecorder {
    private(set) var delays: [Duration] = []
    func record(_ delay: Duration) { delays.append(delay) }
}

@Suite struct APIClientTests {
    static let base = URL(string: "http://127.0.0.1:54331")!
    static let ratesBody = #"""
        {"ok":true,"data":{"total_rates":2,"rates":[{"currency":"USD","rate_to_eur":0.92,"rate_date":"2026-10-09","fetched_at":"2026-10-09T15:05:00.000Z"}],"fallback_rates":{"EUR":1,"USD":0.9},"source":"database","is_stale":false,"last_fetched_at":"2026-10-09T15:05:00.000Z"}}
        """#

    func client(
        _ transport: FakeTransport, sleeper: SleepRecorder = SleepRecorder(),
        base: URL? = APIClientTests.base
    ) -> APIClient {
        APIClient(
            baseURL: { base }, transport: transport,
            sleep: { await sleeper.record($0) }, jitter: { 0.5 }, requestId: { "req-1" })
    }

    @Test func sendsTheHeadersOfApiRequestAndUnwrapsTheEnvelope() async throws {
        let transport = FakeTransport([.response(200, Self.ratesBody)])
        let rates = try await client(transport).send(
            OpenAPIOperations.GetExchangeRates(dbOnly: true))
        #expect(rates.totalRates == 2)
        #expect(rates.rates.first?.currency == "USD")
        #expect(rates.rates.first?.rateToEur == Decimal(string: "0.92"))
        #expect(rates.source == .database)
        #expect(rates.lastFetchedAt == "2026-10-09T15:05:00.000Z")
        let request = try #require(await transport.requests.first)
        #expect(request.method == .get)
        #expect(request.url.absoluteString == "http://127.0.0.1:54331/api/info/exchange-rates?db_only=true")
        #expect(request.headers["Content-Type"] == "application/json")
        #expect(request.headers["X-Request-Id"] == "req-1")
        #expect(request.headers["Authorization"] == nil)
        #expect(request.timeout == 30)
        #expect(request.body == nil)
    }

    @Test func metadataSurvivesAnIdempotentRetryWithoutChangingTheDataContract() async throws {
        let body =
            #"{"ok":true,"data":{"key":"synthetic","value":1,"expected":null},"meta":{"provider":null,"source":"cache","requestId":"r2","future":{"status":"partial","missing":["volume"]}}}"#
        let transport = FakeTransport([.response(503, ""), .response(200, body)])
        let sleeper = SleepRecorder()
        let snapshot = try await client(transport, sleeper: sleeper).sendWithMeta(
            OpenAPIOperations.GetSetting(key: "synthetic"))
        #expect(snapshot.data.key == "synthetic")
        #expect(snapshot.meta?["provider"] == .null)
        #expect(snapshot.meta?["source"] == .string("cache"))
        #expect(snapshot.meta?["requestId"] == .string("r2"))
        #expect(snapshot.meta?["future"]?["missing"] == .array([.string("volume")]))
        #expect(await transport.requests.count == 2)
        #expect(await sleeper.delays == [.milliseconds(600)])
        #expect(Set(await transport.requests.compactMap { $0.headers["X-Request-Id"] }) == ["req-1"])
    }

    @Test func rawResponsesHaveNoEnvelopeMetadataAndExplicitNullIsRetained() async throws {
        let raw = #"{"key":"synthetic","value":null,"expected":null}"#
        let transport = FakeTransport([
            .response(200, raw),
            .response(200, #"{"ok":true,"data":{"key":"synthetic","value":null,"expected":null},"meta":null}"#),
        ])
        let plain = try await client(transport).sendWithMeta(OpenAPIOperations.GetSetting(key: "synthetic"))
        #expect(plain.data.key == "synthetic")
        #expect(plain.meta == nil)
        let null = try await client(transport).sendWithMeta(OpenAPIOperations.GetSetting(key: "synthetic"))
        #expect(null.meta == .null)
    }

    @Test func requestingMetadataNeverRetriesAnAmbiguousMutation() async {
        let transport = FakeTransport([
            .failure(.timedOut), .response(200, #"{"ok":true,"data":{"message":"ok"},"meta":{"source":"live"}}"#),
        ])
        await #expect(throws: APIError.timedOut) {
            _ = try await client(transport).sendWithMeta(OpenAPIOperations.RefreshExchangeRates())
        }
        #expect(await transport.requests.count == 1)
    }

    @Test func pathParametersAreEscapedAsOneSegment() async throws {
        let transport = FakeTransport([.response(200, #"{"ok":true,"data":{"key":"a/b?c","value":1,"expected":null}}"#)]
        )
        _ = try await client(transport).send(OpenAPIOperations.GetSetting(key: "a/b?c"))
        let request = try #require(await transport.requests.first)
        #expect(request.url.absoluteString == "http://127.0.0.1:54331/api/settings/a%2Fb%3Fc")
    }

    @Test func aBaseURLPathIsKeptAndQueryValuesAreEscapedLikeURLSearchParams() {
        let url = APIClient.url(
            base: URL(string: "http://localhost:1/prefix/")!, path: "/api/x",
            queryItems: [URLQueryItem(name: "q", value: "a+b c&d")])
        #expect(url?.absoluteString == "http://localhost:1/prefix/api/x?q=a%2Bb%20c%26d")
    }

    @Test func failureEnvelopesBecomeClientErrors() async {
        let body =
            #"{"ok":false,"error":{"code":"NOT_FOUND","message":"No such setting","details":{"key":"x"}},"meta":{"requestId":"r9"}}"#
        let transport = FakeTransport([.response(404, body)])
        await #expect(
            throws: APIError.client(
                APIClientError(
                    status: 404, code: .notFound, message: "No such setting", details: .object(["key": .string("x")]),
                    requestId: "r9"))
        ) {
            _ = try await client(transport).send(OpenAPIOperations.GetSetting(key: "x"))
        }
        #expect(await transport.requests.count == 1)
    }

    @Test func bodiesWithoutAnEnvelopeFallBackToTheStatusCode() {
        let unauthorized = APIClient.envelopeError(status: 401, body: Data("<html>".utf8))
        #expect(unauthorized.code == .unauthorized)
        #expect(unauthorized.message == "Request failed (status 401)")
        #expect(APIClient.envelopeError(status: 500, body: Data()).code == .internalServerError)
        #expect(APIClient.envelopeError(status: 418, body: Data()).code == .appError)
        let blank = Data(#"{"ok":false,"error":{"code":" ","message":"x"}}"#.utf8)
        #expect(APIClient.envelopeError(status: 409, body: blank).code == .conflict)
        let unknown = Data(#"{"ok":false,"error":{"code":"WHATEVER","message":"Nope"}}"#.utf8)
        let parsed = APIClient.envelopeError(status: 400, body: unknown)
        #expect(parsed.code == .validationError && parsed.message == "Nope")
    }

    @Test func contractViolationsNameThePathButNotTheValue() async {
        let body =
            #"{"ok":true,"data":{"total_rates":"two","rates":[],"fallback_rates":{},"source":"database","is_stale":false}}"#
        let transport = FakeTransport([.response(200, body)])
        await #expect(
            throws: APIError.contract(
                APIContractError(endpoint: "GET /api/info/exchange-rates", issues: ["total_rates: Invalid type"]))
        ) {
            _ = try await client(transport).send(OpenAPIOperations.GetExchangeRates())
        }
        // A contract error is never retried.
        #expect(await transport.requests.count == 1)
    }

    @Test func aMissingFieldIsRequired() async {
        let body = #"{"ok":true,"data":{"rates":[],"fallback_rates":{},"source":"database","is_stale":false}}"#
        let transport = FakeTransport([.response(200, body)])
        await #expect(
            throws: APIError.contract(
                APIContractError(endpoint: "GET /api/info/exchange-rates", issues: ["total_rates: Required"]))
        ) {
            _ = try await client(transport).send(OpenAPIOperations.GetExchangeRates())
        }
    }

    @Test func idempotentRequestsRetryRetryableStatusesWithBackoff() async throws {
        let sleeper = SleepRecorder()
        let transport = FakeTransport([.response(503, ""), .response(502, ""), .response(200, Self.ratesBody)])
        let rates = try await client(transport, sleeper: sleeper).send(OpenAPIOperations.GetExchangeRates())
        #expect(rates.totalRates == 2)
        let requests = await transport.requests
        #expect(requests.count == 3)
        // One correlation id for every attempt.
        #expect(Set(requests.compactMap { $0.headers["X-Request-Id"] }) == ["req-1"])
        #expect(await sleeper.delays == [.milliseconds(600), .milliseconds(1100)])
    }

    @Test func retriesStopAfterMaxRetries() async {
        let transport = FakeTransport([.response(503, ""), .response(503, ""), .response(503, "")])
        await #expect(
            throws: APIError.client(
                APIClientError(status: 503, code: .serviceUnavailable, message: "Request failed (status 503)"))
        ) {
            _ = try await client(transport).send(OpenAPIOperations.GetExchangeRates())
        }
        #expect(await transport.requests.count == 3)
    }

    @Test func explicitZeroRetryDoesNotReplayAConditionalSettingsPut() async {
        let transport = FakeTransport([
            .response(503, ""),
            .response(200, #"{"ok":true,"data":{"key":"app_settings","value":{"language":"nl"}}}"#),
        ])
        let operation = OpenAPIOperations.SaveSetting(
            key: "app_settings",
            body: .init(value: .object(["language": .string("nl")]), expected: .object(["exists": .bool(false)])))
        await #expect(
            throws: APIError.client(
                APIClientError(status: 503, code: .serviceUnavailable, message: "Request failed (status 503)"))
        ) {
            _ = try await client(transport).send(operation, retries: 0)
        }
        let requests = await transport.requests
        #expect(requests.count == 1)
        #expect(requests.first?.method == .put)
        #expect(requests.first?.url.path == "/api/settings/app_settings")
    }

    @Test func nonIdempotentRequestsAreNotRetried() async {
        let transport = FakeTransport([.response(503, ""), .response(200, #"{"ok":true,"data":{"message":"ok"}}"#)])
        await #expect(throws: APIError.self) {
            _ = try await client(transport).send(OpenAPIOperations.RefreshExchangeRates())
        }
        #expect(await transport.requests.count == 1)
    }

    @Test func networkErrorsAndTimeoutsAreRetriedButNonRetryableCodesAreNot() async throws {
        let transport = FakeTransport([
            .failure(.timedOut), .failure(.network("offline")), .response(200, Self.ratesBody),
        ])
        _ = try await client(transport).send(OpenAPIOperations.GetExchangeRates())
        #expect(await transport.requests.count == 3)

        let forbidden = #"{"ok":false,"error":{"code":"FORBIDDEN","message":"Admin only"}}"#
        let refused = FakeTransport([.response(500, forbidden), .response(200, Self.ratesBody)])
        await #expect(throws: APIError.self) {
            _ = try await client(refused).send(OpenAPIOperations.GetExchangeRates())
        }
        #expect(await refused.requests.count == 1)
    }

    @Test func cancellationIsNotWrapped() async {
        let transport = FakeTransport([.cancelled])
        await #expect(throws: CancellationError.self) {
            _ = try await client(transport).send(OpenAPIOperations.GetExchangeRates())
        }
    }

    @Test func noBackendMeansUnavailable() async {
        let transport = FakeTransport([])
        await #expect(throws: APIError.backendUnavailable) {
            _ = try await client(transport, base: nil).send(OpenAPIOperations.GetExchangeRates())
        }
        #expect(await transport.requests.isEmpty)
    }

    @Test func backoffDoublesAddsJitterAndCaps() {
        #expect(APIClient.backoff(attempt: 0, jitter: 0) == .milliseconds(500))
        #expect(APIClient.backoff(attempt: 1, jitter: 1) == .milliseconds(1200))
        #expect(APIClient.backoff(attempt: 10, jitter: 1) == .milliseconds(30_000))
    }

    @Test func retryableErrorsFollowTheNonRetryableCodes() {
        for code in [APIErrorCode.validationError, .rateLimited, .unauthorized, .forbidden, .notFound, .conflict] {
            #expect(!APIError.client(APIClientError(status: 400, code: code, message: "x")).isRetryable)
        }
        #expect(APIError.client(APIClientError(status: 500, code: .internalServerError, message: "x")).isRetryable)
        #expect(APIError.timedOut.isRetryable)
        #expect(!APIError.contract(APIContractError(endpoint: "x", issues: [])).isRetryable)
    }

    @Test func appSettingsAreMigratedFieldByField() async throws {
        let body =
            #"{"ok":true,"data":{"key":"app_settings","value":{"dateFormat":"YYYY-MM-DD","numberFormat":"ch","showDecimalPlaces":42,"adminMode":true,"colorblindGainLoss":"yes"},"expected":null}}"#
        let transport = FakeTransport([.response(200, body)])
        let settings = try await client(transport).appSettings()
        #expect(settings.dateFormat == .isoDate)
        #expect(settings.numberFormat == .ch)
        #expect(settings.showDecimalPlaces == 2)
        #expect(settings.adminMode)
        #expect(!settings.colorblindGainLoss)
        #expect(await transport.requests.first?.url.path == "/api/settings/app_settings")
    }

    @Test func modelDefaultsRetainTheDistinctWebMigrationRules() {
        let raw = NativeAppSettings.migrate(.object(["aiDefaultModel": .string("")]))
        #expect(raw.aiDefaultModel == "")
        let invalid = NativeAppSettings.migrate(.object(["aiDefaultModel": .int(123)]))
        #expect(invalid.aiDefaultModel == nil)
        #expect(NativeAppSettings.defaults.aiDefaultModel == nil)
    }
}
