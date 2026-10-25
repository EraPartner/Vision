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
            service: service, database: database, token: FakeTokenStorage().access,
            now: { PlannedFixture.today })
    }

    static let auth = APIError.client(APIClientError(status: 401, code: .unauthorized, message: "Admin token required"))
}

@MainActor
@Suite struct AdminOverviewModelTests {
    let strings = DictionaryStrings(language: .en, table: [:])

    @Test func tilesLoadAndLinkToTheirPages() async {
        let service = FakeAdminService()
        let model = AdminOverviewModel(
            service: service, token: FakeTokenStorage().access)
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
            service: FakeAdminService(), token: storage.access)
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
            service: FakeAdminService(), token: storage.access)
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
        let model = AdminOverviewModel(service: FakeAdminService(), token: FakeTokenStorage().access)
        model.tokenDraft = "half-typed-token"
        model.disappear()
        #expect(model.tokenDraft.isEmpty)
    }

    @Test func anExistingTokenEnablesClear() async {
        let model = AdminOverviewModel(
            service: FakeAdminService(), token: FakeTokenStorage("abc").access)
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

@MainActor
@Suite struct AdminRoutesTests {
    @Test func theAdminPagesAreNativeInAdminMode() async throws {
        let model = NativeShellModel(
            strings: DictionaryStrings(language: .en, table: [:]), theme: ThemeSelection(appearance: .light),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()), admin: AdminFixture.screens(),
            planned: PlannedFixture.idleModel(), imports: ImportFixture.idleModel(),
            transactions: TransactionsFixture.idleModel(), accounts: AccountsFixture.idleModel(),
            categories: CategoriesFixture.idleModel(), recipients: RecipientsFixture.idleModel(),
            loadSettings: { NativeAppSettings(adminMode: true) })
        model.show(try #require(NativeRoute("/admin")))
        #expect(model.detail == .loading)
        await model.settingsSettled()
        #expect(model.detail == .native(.adminOverview))
        model.show(try #require(NativeRoute("/admin/providers")))
        #expect(model.detail == .native(.providerHealth))
        model.show(try #require(NativeRoute("/admin/endpoints")))
        #expect(model.detail == .native(.endpointLiveness))
        model.show(try #require(NativeRoute("/admin/db")))
        #expect(model.detail == .native(.databaseMaintenance))
        model.show(try #require(NativeRoute("/admin/db/transactions")))
        #expect(model.detail == .native(.tableEditor(table: "transactions")))
        #expect(model.admin.database.editor?.table == "transactions")
        // A tile or the auth error link moves the shell.
        model.navigate(to: AdminErrorState.tokenRoute)
        #expect(model.nativeNavigationLocation.raw == AdminErrorState.tokenRoute)
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
