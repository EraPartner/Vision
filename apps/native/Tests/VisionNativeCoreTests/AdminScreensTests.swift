import Foundation
import Testing
@testable import VisionNativeCore

/// An admin service that answers from scripts (the last answer repeats) and counts calls.
actor FakeAdminService: AdminService {
    var stats: [Result<OpenAPI.DbStats, APIError>]
    var health: [Result<[OpenAPI.ProviderHealth], APIError>]
    var probes: [String: Result<OpenAPI.ProbeResult, APIError>]
    var metrics: [Result<[OpenAPI.RouteMetric], APIError>]
    var manifest: [Result<[OpenAPI.EndpointEntry], APIError>]
    private(set) var healthCalls = 0
    private(set) var statsCalls = 0
    private(set) var probeCalls: [String] = []
    /// Probes wait here until `release` when set.
    private var gate: CheckedContinuation<Void, Never>?
    private var holdProbes: Bool
    /// The next provider health call waits here until `releaseHealth` when set.
    private var healthGate: CheckedContinuation<Void, Never>?
    private var holdHealth: Bool

    init(
        stats: [Result<OpenAPI.DbStats, APIError>] = [.success(AdminFixture.stats)],
        health: [Result<[OpenAPI.ProviderHealth], APIError>] = [.success(AdminFixture.providers)],
        probes: [String: Result<OpenAPI.ProbeResult, APIError>] = [:],
        metrics: [Result<[OpenAPI.RouteMetric], APIError>] = [.success(AdminFixture.metrics)],
        manifest: [Result<[OpenAPI.EndpointEntry], APIError>] = [.success(AdminFixture.manifest)],
        holdProbes: Bool = false,
        holdHealth: Bool = false
    ) {
        self.stats = stats
        self.health = health
        self.probes = probes
        self.metrics = metrics
        self.manifest = manifest
        self.holdProbes = holdProbes
        self.holdHealth = holdHealth
    }

    private static func next<Value>(_ script: inout [Result<Value, APIError>]) throws -> Value {
        guard !script.isEmpty else { throw APIError.network("no script") }
        return try (script.count > 1 ? script.removeFirst() : script[0]).get()
    }

    func databaseStats() async throws -> OpenAPI.DbStats {
        statsCalls += 1
        return try Self.next(&stats)
    }

    func providerHealth() async throws -> [OpenAPI.ProviderHealth] {
        healthCalls += 1
        let result = try Self.next(&health)
        if holdHealth {
            holdHealth = false
            await withCheckedContinuation { healthGate = $0 }
        }
        return result
    }

    func probeProvider(_ provider: String) async throws -> OpenAPI.ProbeResult {
        probeCalls.append(provider)
        if holdProbes { await withCheckedContinuation { gate = $0 } }
        guard let result = probes[provider] else { throw APIError.network("no script") }
        return try result.get()
    }

    func requestMetrics() async throws -> [OpenAPI.RouteMetric] { try Self.next(&metrics) }
    func endpointManifest() async throws -> [OpenAPI.EndpointEntry] { try Self.next(&manifest) }

    func setHealth(_ value: [Result<[OpenAPI.ProviderHealth], APIError>]) { health = value }

    /// Lets a held probe finish.
    func release() {
        holdProbes = false
        gate?.resume()
        gate = nil
    }

    var isHoldingProbe: Bool { gate != nil }

    /// Lets a held provider health call answer.
    func releaseHealth() {
        healthGate?.resume()
        healthGate = nil
    }

    var isHoldingHealth: Bool { healthGate != nil }
}

/// The page's `sessionStorage` token.
actor FakeTokenStorage {
    private(set) var value: String?
    private(set) var writes: [String] = []
    /// A page that is not ready or does not answer: writes change nothing.
    private let failWrites: Bool

    init(_ value: String? = nil, failWrites: Bool = false) {
        self.value = value
        self.failWrites = failWrites
    }

    func write(_ token: String) -> Bool {
        writes.append(token)
        guard !failWrites else { return false }
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        value = trimmed.isEmpty ? nil : trimmed
        return true
    }

    nonisolated var access: AdminTokenAccess {
        AdminTokenAccess(read: { await self.value }, write: { await self.write($0) })
    }
}

/// The audit channels with scripted answers.
@MainActor
final class FakeAuditHistory: AuditHistoryService {
    var reads: [JSONValue] = []
    var enrollResult = JSONValue.object(["success": .bool(true)])
    var exportResult = JSONValue.object(["success": .bool(true), "file": .string("/tmp/x.json")])
    var transferResult = JSONValue.object(["success": .bool(true)])
    var rotateResult = JSONValue.object(["success": .bool(true), "sequence": .int(3)])
    private(set) var ranges: [AuditViewer.ReadRange] = []
    private(set) var passwords: [String] = []
    private(set) var calls: [String] = []

    func read(_ range: AuditViewer.ReadRange) async -> JSONValue {
        ranges.append(range)
        guard !reads.isEmpty else { return .object(["success": .bool(false), "status": .string("unavailable")]) }
        return reads.count > 1 ? reads.removeFirst() : reads[0]
    }

    func enroll() async -> JSONValue {
        calls.append("enroll")
        return enrollResult
    }

    func exportSnapshot() async -> JSONValue {
        calls.append("export")
        return exportResult
    }

    func exportTransfer(password: String) async -> JSONValue {
        calls.append("exportTransfer")
        passwords.append(password)
        return transferResult
    }

    func importTransfer(password: String) async -> JSONValue {
        calls.append("importTransfer")
        passwords.append(password)
        return transferResult
    }

    func rotateKey() async -> JSONValue {
        calls.append("rotate")
        return rotateResult
    }
}

enum AdminFixture {
    static let stats = OpenAPI.DbStats(
        tables: [
            OpenAPI.DbTableStat(
                schemaname: "public", tableName: "transactions", liveRows: "2453", deadRows: "127",
                lastAutovacuum: nil, lastAutoanalyze: nil, size: "3200 kB", sizeBytes: "3276800"),
            OpenAPI.DbTableStat(
                schemaname: "public", tableName: "categories", liveRows: "45", deadRows: "2", lastAutovacuum: nil,
                lastAutoanalyze: nil, size: "64 kB", sizeBytes: "65536"),
        ],
        dbSize: "12 MB")

    static func provider(_ key: String, failures: Int = 0, error: String? = nil) -> OpenAPI.ProviderHealth {
        OpenAPI.ProviderHealth(
            provider: key, kind: "price", label: key.capitalized, lastSuccessAt: "2026-10-09T08:05:00.000Z",
            lastErrorAt: error == nil ? nil : "2026-10-09T09:30:00.000Z", lastError: error,
            consecutiveFailures: failures, updatedAt: "2026-10-09T09:30:00.000Z")
    }

    static let providers = [provider("binance"), provider("ecb", failures: 1, error: "Fetch timeout after 5000ms")]

    static func metric(_ method: String, _ path: String, count: Int, errors: Int, p50: Decimal? = 18)
        -> OpenAPI.RouteMetric
    {
        OpenAPI.RouteMetric(
            route: "\(method):\(path)", method: method, path: path, count: count, errors: errors,
            errorRate: count == 0 ? 0 : Decimal(errors) / Decimal(count), p50Ms: p50, p95Ms: p50.map { $0 * 4 },
            windowMinutes: 15)
    }

    static let metrics = [
        metric("GET", "/api/transactions", count: 140, errors: 3),
        metric("POST", "/api/transactions", count: 10, errors: 1, p50: nil),
    ]

    static let manifest = [
        OpenAPI.EndpointEntry(method: "GET", path: "/api/transactions"),
        OpenAPI.EndpointEntry(method: "POST", path: "/api/transactions"),
        OpenAPI.EndpointEntry(method: "DELETE", path: "/api/transactions/:id"),
    ]

    @MainActor
    static func screens(
        service: FakeAdminService = FakeAdminService(), database: FakeDatabaseService = FakeDatabaseService()
    ) -> AdminScreens {
        AdminScreens.make(
            service: service, database: database, token: FakeTokenStorage().access, audit: FakeAuditHistory())
    }

    static let auth = APIError.client(APIClientError(status: 401, code: .unauthorized, message: "Admin token required"))
}

@MainActor
@Suite struct AdminOverviewModelTests {
    let strings = DictionaryStrings(language: .en, table: [:])

    @Test func tilesLoadAndLinkToTheirPages() async {
        let service = FakeAdminService()
        let model = AdminOverviewModel(
            service: service, token: FakeTokenStorage().access, audit: AuditHistoryModel(service: FakeAuditHistory()))
        #expect(model.showsTileSkeleton)
        await model.appear()
        #expect(!model.showsTileSkeleton)
        let tiles = model.tiles(settings: NativeAppSettings(numberFormat: .us), strings: strings)
        #expect(tiles.map(\.route) == ["/admin/db", "/admin/providers", "/admin/endpoints"])
        #expect(tiles[0].value == "12 MB")
        #expect(tiles[0].subtext == "2 admin.overview.tables")
        #expect(tiles[1].value == "1 / 2")
        #expect(tiles[1].subtext == "1 admin.overview.failing")
        #expect(tiles[1].status == .warn)
        // 4 errors in 150 requests.
        #expect(tiles[2].value == "2.7% admin.overview.errorRate")
        #expect(tiles[2].subtext == "150 admin.overview.requests")
        #expect(tiles[2].status == .warn)
        // Fresh queries are not fetched again.
        await model.appear()
        #expect(await service.statsCalls == 1)
    }

    @Test func tileThresholdsMatchThePage() {
        #expect(AdminOverviewPresentation.providerStatus(failing: 0) == .ok)
        #expect(AdminOverviewPresentation.providerStatus(failing: 2) == .warn)
        #expect(AdminOverviewPresentation.providerStatus(failing: 3) == .error)
        #expect(AdminOverviewPresentation.metricsStatus(errorRatePercent: 2) == .ok)
        #expect(AdminOverviewPresentation.metricsStatus(errorRatePercent: Decimal(string: "2.01")!) == .warn)
        #expect(AdminOverviewPresentation.metricsStatus(errorRatePercent: Decimal(string: "9.99")!) == .warn)
        #expect(AdminOverviewPresentation.metricsStatus(errorRatePercent: 10) == .error)
        #expect(AdminOverviewPresentation.errorRatePercent([]) == 0)
    }

    @Test func loadingAndFailedQueriesShowThePlaceholders() {
        let tiles = AdminOverviewPresentation.tiles(
            dbStats: nil, providers: nil, providersLoading: true, metrics: nil, metricsLoading: true,
            settings: NativeAppSettings(numberFormat: .eu), strings: strings)
        #expect(tiles.map(\.value) == ["—", "…", "…"])
        #expect(tiles[1].subtext == "admin.overview.allHealthy")
        #expect(tiles.map(\.status) == [.ok, .ok, .ok])
        let failed = AdminOverviewPresentation.tiles(
            dbStats: nil, providers: nil, providersLoading: false, metrics: nil, metricsLoading: false,
            settings: NativeAppSettings(numberFormat: .eu), strings: strings)
        #expect(failed.map(\.value) == ["—", "0 / 0", "0,0% admin.overview.errorRate"])
    }

    @Test func threeFailingProvidersAndTenPercentErrorsAreErrors() {
        let providers = (1...3).map { AdminFixture.provider("p\($0)", failures: 4, error: "down") }
        let metrics = [AdminFixture.metric("GET", "/x", count: 10, errors: 1)]
        let tiles = AdminOverviewPresentation.tiles(
            dbStats: AdminFixture.stats, providers: providers, providersLoading: false, metrics: metrics,
            metricsLoading: false, settings: .defaults, strings: strings)
        #expect(tiles[1].status == .error)
        #expect(tiles[2].status == .error)
    }

    @Test func savingAndClearingTheTokenWritesThePageStorage() async {
        let storage = FakeTokenStorage()
        let model = AdminOverviewModel(
            service: FakeAdminService(), token: storage.access, audit: AuditHistoryModel(service: FakeAuditHistory()))
        await model.refreshTokenState()
        #expect(!model.hasToken && !model.canClearToken)
        model.tokenDraft = "   "
        #expect(!model.canSaveToken)
        await model.saveToken()
        #expect(await storage.writes.isEmpty)
        model.tokenDraft = "  secret-token "
        #expect(model.canSaveToken)
        await model.saveToken()
        #expect(await storage.value == "secret-token")
        #expect(model.hasToken && model.canClearToken)
        #expect(model.tokenDraft.isEmpty)
        #expect(model.notice?.key == "admin.token.saved")
        #expect(model.notice?.kind == .success)
        await model.clearToken()
        #expect(await storage.value == nil)
        #expect(!model.hasToken)
        #expect(model.notice?.key == "admin.token.cleared")
        let id = model.notice?.id ?? -1
        model.clearNotice(id)
        #expect(model.notice == nil)
    }

    @Test func aWriteThePageDidNotTakeToastsAnError() async {
        let storage = FakeTokenStorage("abc", failWrites: true)
        let model = AdminOverviewModel(
            service: FakeAdminService(), token: storage.access, audit: AuditHistoryModel(service: FakeAuditHistory()))
        await model.refreshTokenState()
        model.tokenDraft = "new-token"
        await model.saveToken()
        #expect(await storage.value == "abc")
        #expect(model.notice?.kind == .error)
        #expect(model.notice?.key == "apiError.unknown")
        #expect(model.tokenDraft.isEmpty)
        #expect(model.hasToken)
        await model.clearToken()
        #expect(await storage.writes == ["new-token", ""])
        #expect(model.notice?.kind == .error)
        #expect(model.notice?.key == "apiError.unknown")
        #expect(model.hasToken)
    }

    @Test func leavingThePageForgetsTheTypedSecrets() {
        let audit = AuditHistoryModel(service: FakeAuditHistory())
        let model = AdminOverviewModel(service: FakeAdminService(), token: FakeTokenStorage().access, audit: audit)
        model.tokenDraft = "half-typed-token"
        audit.setTransferPassword("sixteen chars ok")
        model.disappear()
        #expect(model.tokenDraft.isEmpty)
        #expect(audit.transferPassword.isEmpty)
    }

    @Test func anExistingTokenEnablesClear() async {
        let model = AdminOverviewModel(
            service: FakeAdminService(), token: FakeTokenStorage("abc").access,
            audit: AuditHistoryModel(service: FakeAuditHistory()))
        await model.appear()
        #expect(model.hasToken)
    }

    @Test func theTokenScriptsUseTheSessionKeyAndAnArgument() {
        #expect(AdminTokenScript.read.contains(AdminTokenScript.storageKey))
        #expect(AdminTokenScript.write.contains("sessionStorage.setItem(\"vision.adminToken\", value)"))
        #expect(AdminTokenScript.write.contains("removeItem(\"vision.adminToken\")"))
        #expect(AdminTokenScript.write.contains("String(\(AdminTokenScript.argument) ?? \"\").trim()"))
    }
}

@MainActor
@Suite struct ScreenQueryTests {
    @Test func aFailedRefetchKeepsTheDataAndASuccessClearsTheError() async {
        let script = FakeAdminService(stats: [.success(AdminFixture.stats), .failure(.timedOut), .success(AdminFixture.stats)])
        let clock = TestClock()
        let query = ScreenQuery<OpenAPI.DbStats>(staleAfter: 60, now: { clock.now }) { try await script.databaseStats() }
        #expect(query.isLoading)
        await query.appear()
        #expect(query.data == AdminFixture.stats && query.error == nil)
        await query.appear()
        #expect(await script.statsCalls == 1)
        clock.advance(61)
        await query.appear()
        #expect(query.error == .timedOut)
        #expect(query.data == AdminFixture.stats)
        #expect(!query.isLoading)
        // An error is always refetched.
        await query.appear()
        #expect(query.error == nil)
        #expect(await script.statsCalls == 3)
    }

    @Test func invalidateMakesTheNextAppearFetch() async {
        let script = FakeAdminService()
        let query = ScreenQuery<OpenAPI.DbStats>(staleAfter: 60) { try await script.databaseStats() }
        await query.appear()
        query.invalidate()
        await query.appear()
        #expect(await script.statsCalls == 2)
    }
}

@MainActor
@Suite struct ProviderHealthModelTests {
    let strings = DictionaryStrings(language: .en, table: ["admin.providers.loadError": "Failed to load"])
    let utc = TimeZone(identifier: "UTC")!

    @Test func rowsFormatTheTimestampsAndTones() throws {
        let settings = NativeAppSettings(dateFormat: .isoDate, numberFormat: .eu)
        let ok = ProviderHealthRow(AdminFixture.providers[0], settings: settings, strings: strings, timeZone: utc)
        #expect(ok.lastSuccess == "2026-10-09 08:05")
        #expect(ok.tone == .success && ok.lastError == nil && ok.failures == "0")
        let failing = ProviderHealthRow(AdminFixture.providers[1], settings: settings, strings: strings, timeZone: utc)
        #expect(failing.tone == .warning)
        #expect(failing.lastError == "Fetch timeout after 5000ms")
        #expect(failing.lastErrorAt == "2026-10-09 09:30")
        let never = OpenAPI.ProviderHealth(
            provider: "x", kind: "fx", label: "X", lastSuccessAt: nil, lastErrorAt: nil, lastError: "old",
            consecutiveFailures: 0, updatedAt: nil)
        let row = ProviderHealthRow(never, settings: settings, strings: strings, timeZone: utc)
        #expect(row.lastSuccess == "admin.providers.never")
        // An error is shown only while the provider is failing.
        #expect(row.lastError == nil)
        #expect(ProviderHealthRow.Tone(failures: 2) == .warning)
        #expect(ProviderHealthRow.Tone(failures: 3) == .destructive)
    }

    @Test func authenticationFailuresPointToTheTokenCard() async {
        let model = ProviderHealthModel(service: FakeAdminService(health: [.failure(AdminFixture.auth)]))
        await model.appear()
        #expect(model.errorState(strings: strings) == .authentication)
        let forbidden = ProviderHealthModel(
            service: FakeAdminService(
                health: [.failure(.client(APIClientError(status: 403, code: .forbidden, message: "Forbidden")))]))
        await forbidden.appear()
        #expect(forbidden.errorState(strings: strings) == .authentication)
        #expect(AdminErrorState.tokenRoute == "/admin")
    }

    @Test func otherFailuresShowTheHumanizedMessage() async {
        let model = ProviderHealthModel(service: FakeAdminService(health: [.failure(.timedOut)]))
        await model.appear()
        #expect(model.errorState(strings: strings) == .message(title: "Failed to load", body: "apiError.timeout"))
        #expect(model.rows(settings: .defaults, strings: strings).isEmpty)
    }

    @Test func aSuccessfulProbeToastsAndRefetches() async {
        let fixed = AdminFixture.provider("ecb")
        let service = FakeAdminService(
            health: [.success(AdminFixture.providers), .success([AdminFixture.providers[0], fixed])],
            probes: ["ecb": .success(OpenAPI.ProbeResult(ok: true, provider: fixed))])
        var invalidated = 0
        let model = ProviderHealthModel(service: service, onProvidersChanged: { invalidated += 1 })
        await model.appear()
        await model.probe("ecb")
        #expect(model.notice?.kind == .success)
        #expect(model.notice?.key == "admin.providers.probeOk")
        #expect(model.notice?.variables == ["provider": "Ecb"])
        #expect(model.providers.data?.last == fixed)
        #expect(await service.healthCalls == 2)
        #expect(invalidated == 1)
        #expect(!model.isProbing("ecb"))
    }

    @Test func aFailedProbeToastsTheErrorAsTheDescription() async {
        let failing = AdminFixture.provider("ecb", failures: 2, error: "HTTP 500")
        let service = FakeAdminService(
            probes: ["ecb": .success(OpenAPI.ProbeResult(ok: false, provider: failing, error: "HTTP 500"))])
        let model = ProviderHealthModel(service: service)
        await model.appear()
        await model.probe("ecb")
        #expect(model.notice?.kind == .error)
        #expect(model.notice?.key == "admin.providers.probeFail")
        #expect(model.notice?.detail == "HTTP 500")
        #expect(await service.healthCalls == 2)
    }

    @Test func aProbeRequestFailureNamesTheProviderKey() async {
        let service = FakeAdminService(probes: ["ecb": .failure(.network("down"))])
        let model = ProviderHealthModel(service: service)
        await model.appear()
        await model.probe("ecb")
        #expect(model.notice?.key == "admin.providers.probeError")
        #expect(model.notice?.variables == ["provider": "ecb"])
        #expect(await service.healthCalls == 1)
        #expect(!model.isProbing("ecb"))
    }

    @Test func probesRunPerRowAndBlockOnlyTheirOwnButton() async {
        let service = FakeAdminService(
            probes: ["ecb": .success(OpenAPI.ProbeResult(ok: true, provider: AdminFixture.provider("ecb")))],
            holdProbes: true)
        let model = ProviderHealthModel(service: service)
        await model.appear()
        let first = Task { await model.probe("ecb") }
        while !(await service.isHoldingProbe) { await Task.yield() }
        #expect(model.isProbing("ecb"))
        #expect(!model.isProbing("binance"))
        // A second click on the same row does nothing while its probe runs.
        await model.probe("ecb")
        #expect(await service.probeCalls == ["ecb"])
        await service.release()
        await first.value
        #expect(!model.isProbing("ecb"))
    }

    @Test func aProbeDuringARunningFetchShowsThePostProbeRows() async {
        let fixed = AdminFixture.provider("ecb")
        let service = FakeAdminService(
            health: [.success(AdminFixture.providers), .success([AdminFixture.providers[0], fixed])],
            probes: ["ecb": .success(OpenAPI.ProbeResult(ok: true, provider: fixed))], holdHealth: true)
        let model = ProviderHealthModel(service: service)
        let loading = Task { await model.appear() }
        while !(await service.isHoldingHealth) { await Task.yield() }
        await model.probe("ecb")
        #expect(model.providers.data?.last == fixed)
        // The pre-probe answer of the cancelled fetch arrives late and is dropped.
        await service.releaseHealth()
        await loading.value
        #expect(model.providers.data?.last == fixed)
        #expect(!model.providers.isFetching)
        #expect(await service.healthCalls == 2)
    }

    @Test func theErrorLinkTogglesTheFullRow() {
        let model = ProviderHealthModel(service: FakeAdminService())
        #expect(!model.isExpanded("ecb"))
        model.toggleExpanded("ecb")
        #expect(model.isExpanded("ecb"))
        model.toggleExpanded("ecb")
        #expect(!model.isExpanded("ecb"))
    }
}

@MainActor
@Suite struct EndpointLivenessModelTests {
    @Test func rowsMergeByMethodAndPath() async {
        let model = EndpointLivenessModel(service: FakeAdminService())
        #expect(model.isLoading)
        await model.appear()
        let rows = model.rows
        #expect(rows.map(\.id) == ["GET:/api/transactions", "POST:/api/transactions", "DELETE:/api/transactions/:id"])
        let locale = NumberFormat.us.locale
        #expect(rows[0].requests == "140" && rows[0].errors == "3")
        #expect(rows[0].errorRate(locale: locale) == "2.1%")
        #expect(rows[0].rateTone == .warning)
        #expect(rows[0].p50 == "18ms" && rows[0].p95 == "72ms")
        #expect(rows[1].errorRate(locale: locale) == "10.0%")
        #expect(rows[1].rateTone == .destructive)
        #expect(rows[1].p50 == "—")
        #expect(rows[2].requests == "—" && rows[2].errorRate(locale: locale) == "—" && rows[2].p95 == "—")
        #expect(rows[2].rateTone == .secondary)
        #expect(rows.map(\.methodTone) == [.info, .success, .destructive])
        #expect(EndpointRow.MethodTone(method: "PATCH") == .warning)
        #expect(EndpointRow.MethodTone(method: "PUT") == .warning)
        #expect(EndpointRow.MethodTone(method: "HEAD") == .neutral)
    }

    @Test func theFilterMatchesPathOrMethodIgnoringCase() async {
        let model = EndpointLivenessModel(service: FakeAdminService())
        await model.appear()
        model.filter = "delete"
        #expect(model.filteredRows.map(\.method) == ["DELETE"])
        model.filter = "API/TRANS"
        #expect(model.filteredRows.count == 3)
        model.filter = "nothing"
        #expect(model.filteredRows.isEmpty)
        model.filter = ""
        #expect(model.filteredRows.count == 3)
    }

    @Test func withoutMetricsEveryRouteShowsDashes() {
        let rows = EndpointLivenessModel.merge(manifest: AdminFixture.manifest, metrics: nil)
        #expect(rows.allSatisfy { $0.metric == nil })
        #expect(EndpointLivenessModel.merge(manifest: nil, metrics: AdminFixture.metrics).isEmpty)
        #expect(EndpointRow.RateTone(percent: 2) == .secondary)
    }

    @Test func aFailedManifestIsTheEmptyState() async {
        let model = EndpointLivenessModel(service: FakeAdminService(manifest: [.failure(AdminFixture.auth)]))
        await model.appear()
        #expect(!model.isLoading)
        #expect(model.filteredRows.isEmpty)
    }
}

@Suite struct APIErrorMessageTests {
    let strings = DictionaryStrings(language: .en, table: ["apiError.rateLimitedIn": "Try again in {seconds} seconds."])

    @Test func authoredClientMessagesPassThroughAndTransportNoiseDoesNot() {
        let authored = APIError.client(APIClientError(status: 404, code: .notFound, message: " Unknown provider: x "))
        #expect(APIErrorMessage.text(authored, strings: strings) == "Unknown provider: x")
        let machine = APIError.client(APIClientError(status: 404, code: .notFound, message: "Request failed (status 404)"))
        #expect(APIErrorMessage.text(machine, strings: strings) == "apiError.notFound")
        let server = APIError.client(APIClientError(status: 500, code: .internalServerError, message: "stack trace"))
        #expect(APIErrorMessage.text(server, strings: strings) == "apiError.server")
        let limited = APIError.client(
            APIClientError(
                status: 429, code: .rateLimited, message: "Too many", details: .object(["retry_after": .double(2.2)])))
        #expect(APIErrorMessage.text(limited, strings: strings) == "Try again in 3 seconds.")
        #expect(APIErrorMessage.text(.timedOut, strings: strings) == "apiError.timeout")
        #expect(APIErrorMessage.text(.network("offline"), strings: strings) == "apiError.network")
        #expect(APIErrorMessage.text(.network("Server returned 503"), strings: strings) == "apiError.server")
        #expect(APIErrorMessage.text(.contract(APIContractError(endpoint: "x", issues: [])), strings: strings) == "apiError.server")
        #expect(!APIErrorMessage.isAuthored("Failed to fetch"))
        #expect(APIErrorMessage.isAuthored("Pick an account"))
    }
}

/// Audit pages in the shape `AuditChannels.read` returns.
enum AuditCardFixture {
    static func entry(_ sequence: Int, anchored: Bool = true, payload: JSONValue? = nil) -> JSONValue {
        .object([
            "sequence": .int(sequence), "previousHash": .string(auditHash("entry \(sequence - 1)")),
            "hash": .string(auditHash("entry \(sequence)")), "version": .int(1),
            "payload": payload ?? .object(["stream": .string("transactions"), "event": .string("update")]),
            "createdAt": .string("2026-01-01T00:00:00.000Z"),
            "anchorStatus": .string(anchored ? "anchored" : "pending_anchor"),
        ])
    }

    static func page(
        head: Int, anchored: Int? = nil, from first: Int = 1, through last: Int? = nil, hasMore: Bool = false,
        extra: [String: JSONValue] = [:]
    ) -> JSONValue {
        let anchoredThrough = anchored ?? head
        var verification: [String: JSONValue] = [
            "status": .string(anchoredThrough == head ? "verified" : "partially_verified"), "sequence": .int(head),
            "hash": .string(auditHash("head \(head)")), "anchoredThrough": .int(anchoredThrough),
        ]
        for (key, value) in extra { verification[key] = value }
        let end = last ?? head
        let entries = first <= end ? (first...end).map { entry($0, anchored: $0 <= anchoredThrough) } : []
        return .object([
            "success": .bool(true), "verification": .object(verification), "entries": .array(entries),
            "hasMore": .bool(hasMore),
        ])
    }
}

@MainActor
@Suite struct AuditHistoryModelTests {
    @Test func theFirstPageShowsTheVerificationSummary() async {
        let audit = FakeAuditHistory()
        audit.reads = [
            AuditCardFixture.page(
                head: 4, anchored: 3,
                extra: [
                    "enrollmentSequence": .int(1),
                    "legacyUnverified": .object(["dbEditor": .string("2"), "split": .string("0")]),
                ])
        ]
        let model = AuditHistoryModel(service: audit)
        await model.load()
        #expect(audit.ranges == [AuditViewer.ReadRange(afterSequence: 0, limit: 100)])
        #expect(model.status == nil && !model.busy && !model.showsLoading)
        #expect(model.page?.entries.count == 4)
        #expect(model.pendingCount == 1)
        #expect(
            model.summaryLines() == [
                AuditSummaryLine(key: "admin.audit.partial", variables: ["anchored": "3"]),
                AuditSummaryLine(key: "admin.audit.pending", variables: ["count": "1"]),
                AuditSummaryLine(key: "admin.audit.enrollmentCaveat", variables: ["sequence": "1"]),
                AuditSummaryLine(
                    key: "admin.audit.legacy", variables: ["dbEditor": "2", "split": "0", "portfolioRetag": "0"]),
            ])
        let entries = model.page?.entries ?? []
        #expect(entries.map { model.badge(for: $0) } == [.enrollmentBaseline, .anchored, .anchored, .pending])
        #expect(entries.first?.label == "transactions · update")
        #expect(entries.first?.detailsJSON.hasPrefix("{\n  \"hash\": \"") == true)
        #expect(entries.first?.detailsJSON.contains("\"payload\": {\n    \"event\": \"update\",") == true)
    }

    @Test func anEntryWithoutStreamOrEventIsLabelledBySequence() throws {
        let row = try #require(AuditEntryRow(AuditCardFixture.entry(7, payload: .object([:]))))
        #expect(row.label == "#7")
    }

    @Test func unavailableAndNoAnchorStatusesShowTheirLines() async {
        let audit = FakeAuditHistory()
        let model = AuditHistoryModel(service: audit)
        await model.load()
        #expect(model.statusKey == "admin.audit.unavailable")
        #expect(!model.showsEnroll)
        audit.reads = [.object(["success": .bool(false), "status": .string("unavailable"), "reason": .string("no_trusted_anchor")])]
        await model.load()
        #expect(model.statusKey == "admin.audit.noTrustedAnchor")
        #expect(model.showsEnroll)
        audit.reads = [.object(["success": .bool(false), "status": .string("failed"), "error": .string("x")])]
        await model.load()
        #expect(model.statusKey == "admin.audit.failed")
        #expect(model.page == nil)
    }

    @Test func loadMoreAppendsTheNextPage() async {
        let audit = FakeAuditHistory()
        audit.reads = [
            AuditCardFixture.page(head: 150, through: 100, hasMore: true),
            AuditCardFixture.page(head: 150, from: 101),
        ]
        let model = AuditHistoryModel(service: audit)
        await model.load()
        #expect(model.page?.hasMore == true)
        await model.loadMore()
        #expect(audit.ranges.last == AuditViewer.ReadRange(afterSequence: 100, limit: 100))
        #expect(model.page?.entries.count == 150)
        #expect(model.page?.hasMore == false)
        #expect(!model.changed)
    }

    @Test func aMovedHeadDropsThePageAndShowsTheChangeNotice() async {
        let audit = FakeAuditHistory()
        audit.reads = [
            AuditCardFixture.page(head: 150, through: 100, hasMore: true),
            AuditCardFixture.page(head: 151, from: 101),
        ]
        let model = AuditHistoryModel(service: audit)
        await model.load()
        await model.loadMore()
        #expect(model.page == nil)
        #expect(model.changed)
        audit.reads = [AuditCardFixture.page(head: 3)]
        await model.load()
        #expect(!model.changed)
    }

    @Test func exportIsLimitedTo500Entries() async {
        let audit = FakeAuditHistory()
        audit.reads = [AuditCardFixture.page(head: 501, through: 100, hasMore: true)]
        let model = AuditHistoryModel(service: audit)
        await model.load()
        #expect(model.exportTooLarge && model.isExportDisabled)
        // A retained 500 entries fit.
        audit.reads = [AuditCardFixture.page(head: 600, from: 101, through: 200, hasMore: true, extra: ["retentionThrough": .int(100)])]
        await model.load()
        #expect(!model.exportTooLarge)
    }

    @Test func exportReportsSuccessFailureAndIgnoresCancel() async {
        let audit = FakeAuditHistory()
        audit.reads = [AuditCardFixture.page(head: 2)]
        let model = AuditHistoryModel(service: audit)
        await model.exportSnapshot()
        #expect(audit.calls.isEmpty)
        await model.load()
        await model.exportSnapshot()
        #expect(model.exportMessage == .success)
        audit.exportResult = .object(["success": .bool(false), "cancelled": .bool(true)])
        await model.exportSnapshot()
        #expect(model.exportMessage == nil)
        audit.exportResult = .object(["success": .bool(false), "status": .string("failed")])
        await model.exportSnapshot()
        #expect(model.exportMessage == .failed)
        // A reload clears the note.
        await model.load()
        #expect(model.exportMessage == nil)
    }

    @Test func enrollReloadsOnSuccessAndReportsAFailure() async {
        let audit = FakeAuditHistory()
        audit.reads = [.object(["success": .bool(false), "status": .string("unavailable"), "reason": .string("no_trusted_anchor")])]
        let model = AuditHistoryModel(service: audit)
        await model.load()
        audit.enrollResult = .object(["success": .bool(false), "cancelled": .bool(true)])
        await model.enroll()
        #expect(!model.enrollFailed)
        audit.enrollResult = .object(["success": .bool(false), "status": .string("failed")])
        await model.enroll()
        #expect(model.enrollFailed)
        audit.enrollResult = .object(["success": .bool(true), "enrollmentSequence": .int(2)])
        audit.reads = [AuditCardFixture.page(head: 2, extra: ["enrollmentSequence": .int(2)])]
        await model.enroll()
        #expect(!model.enrollFailed)
        #expect(model.status == nil && model.page != nil)
        #expect(!model.enrollBusy)
    }

    @Test func transfersNeedSixteenCharactersAndClearThePassword() async {
        let audit = FakeAuditHistory()
        let model = AuditHistoryModel(service: audit)
        model.setTransferPassword("short")
        #expect(model.isTransferImportDisabled && model.isTransferExportDisabled)
        await model.transfer(.importTransfer)
        #expect(audit.calls.isEmpty)
        model.setTransferPassword("sixteen chars ok")
        #expect(!model.isTransferImportDisabled)
        // Export needs a loaded page too.
        #expect(model.isTransferExportDisabled)
        audit.reads = [AuditCardFixture.page(head: 1)]
        audit.transferResult = .object(["success": .bool(true)])
        await model.transfer(.importTransfer)
        #expect(audit.passwords == ["sixteen chars ok"])
        #expect(model.transferMessage == .success)
        #expect(model.transferPassword.isEmpty)
        #expect(model.page != nil)
        model.setTransferPassword("sixteen chars ok")
        audit.transferResult = .object(["success": .bool(false), "status": .string("failed"), "reason": .string("transfer_invalid")])
        await model.transfer(.exportTransfer)
        #expect(model.transferMessage == .failed)
        #expect(model.transferPassword.isEmpty)
        model.setTransferPassword("sixteen chars ok")
        audit.transferResult = .object(["success": .bool(false), "cancelled": .bool(true)])
        await model.transfer(.exportTransfer)
        #expect(model.transferMessage == nil)
        #expect(model.transferPassword.isEmpty)
    }

    @Test func leavingTheCardClearsThePassword() {
        let model = AuditHistoryModel(service: FakeAuditHistory())
        model.setTransferPassword("sixteen chars ok")
        model.disappear()
        #expect(model.transferPassword.isEmpty)
        #expect(model.isTransferImportDisabled)
    }

    @Test func thePasswordIsCutAt1024UTF16Units() {
        let model = AuditHistoryModel(service: FakeAuditHistory())
        model.setTransferPassword(String(repeating: "a", count: 1030))
        #expect(model.transferPassword.utf16.count == 1024)
        model.setTransferPassword(String(repeating: "a", count: 1023) + "😀")
        #expect(model.transferPassword.utf16.count == 1023)
    }

    @Test func rotationReloadsOnSuccess() async {
        let audit = FakeAuditHistory()
        audit.reads = [AuditCardFixture.page(head: 2)]
        let model = AuditHistoryModel(service: audit)
        await model.load()
        await model.rotateKey()
        #expect(model.rotationMessage == .success)
        #expect(audit.ranges.count == 2)
        audit.rotateResult = .object(["success": .bool(false), "cancelled": .bool(true)])
        await model.rotateKey()
        #expect(model.rotationMessage == nil)
        audit.rotateResult = .object(["success": .bool(false), "status": .string("failed")])
        await model.rotateKey()
        #expect(model.rotationMessage == .failed)
        #expect(!model.isRotateDisabled)
    }

    @Test func theCardReadsTheNativeChannelsDirectly() async {
        // Without an audit runtime the channels answer `unavailable`.
        let shell = FakeAuditShell()
        let channels = AuditChannels(runtimeProvider: { nil }, shell: shell, log: { _ in })
        let model = AuditHistoryModel(service: channels)
        await model.load()
        #expect(model.statusKey == "admin.audit.unavailable")
        model.setTransferPassword("sixteen chars ok")
        await model.transfer(.importTransfer)
        #expect(model.transferMessage == .failed)
        await model.rotateKey()
        #expect(model.rotationMessage == .failed)
    }
}

@MainActor
@Suite struct AdminRoutesTests {
    @Test func theAdminPagesAreNativeInAdminMode() async throws {
        let recorder = ShellRecorder()
        let model = NativeShellModel(
            strings: DictionaryStrings(language: .en, table: [:]), theme: ThemeSelection(appearance: .light),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()), admin: AdminFixture.screens(),
            planned: PlannedFixture.idleModel(), imports: ImportFixture.idleModel(), loadSettings: { NativeAppSettings(adminMode: true) },
            onNavigate: { recorder.actions.append($0) })
        model.routeDidChange(try #require(NativeRoute("/admin")))
        #expect(model.detail == .web)
        await model.settingsSettled()
        #expect(model.detail == .native(.adminOverview))
        model.routeDidChange(try #require(NativeRoute("/admin/providers")))
        #expect(model.detail == .native(.providerHealth))
        model.routeDidChange(try #require(NativeRoute("/admin/endpoints")))
        #expect(model.detail == .native(.endpointLiveness))
        model.routeDidChange(try #require(NativeRoute("/admin/db")))
        #expect(model.detail == .native(.databaseMaintenance))
        model.routeDidChange(try #require(NativeRoute("/admin/db/transactions")))
        #expect(model.detail == .native(.tableEditor(table: "transactions")))
        #expect(model.admin.database.editor?.table == "transactions")
        // A tile or the auth error link asks the page to move.
        model.navigate(to: AdminErrorState.tokenRoute)
        #expect(recorder.actions.last == .navigate("/admin"))
        await model.settingsSettled()
    }

    @Test func aProbeMarksTheOverviewProvidersStale() async {
        let service = FakeAdminService(
            probes: ["ecb": .success(OpenAPI.ProbeResult(ok: true, provider: AdminFixture.provider("ecb")))])
        let screens = AdminFixture.screens(service: service)
        await screens.overview.providers.appear()
        await screens.overview.providers.appear()
        #expect(await service.healthCalls == 1)
        await screens.providers.probe("ecb")
        // The probe refetched the Data sources rows and invalidated the overview's copy.
        #expect(await service.healthCalls == 2)
        await screens.overview.providers.appear()
        #expect(await service.healthCalls == 3)
    }
}

@Suite struct ShellGlassTests {
    @Test func theSidebarGlassFollowsTheWebChrome() {
        let light = ShellGlass(selection: ThemeSelection(appearance: .light))
        let palette = DesignTokens.palette(.default, .light)
        #expect(light.sidebarTop == palette.sidebarBackground)
        #expect(light.sidebarTopOpacity == 0.55 && light.sidebarBottomOpacity == 0.72)
        #expect(light.border == palette.sidebarBorder && light.borderOpacity == 0.5)
        #expect(light.selection == palette.primary && light.selectionOpacity == 0.12)
        #expect(light.icon == palette.primary)
        #expect(light.detailTint == palette.background)
        let dark = ShellGlass(selection: ThemeSelection(variant: .nord, appearance: .dark))
        #expect(dark.sidebarTop == DesignTokens.palette(.nord, .dark).sidebarBackground)
        #expect(dark.sidebarBottomOpacity == 0.74 && dark.borderOpacity == 0.6 && dark.selectionOpacity == 0.16)
        #expect(dark.detailTintOpacity > 0.5 && dark.detailTintOpacity < 1)
    }
}
