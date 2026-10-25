import Foundation
import Observation

/// The page's admin token (`sessionStorage["vision.adminToken"]`, apps/frontend/src/lib/adminToken.ts).
/// The native card reads and writes the page's own storage, so the web admin pages and the
/// native API client see the same token, and nothing else stores it.
public struct AdminTokenAccess: Sendable {
    /// `getAdminToken()` before trimming; `nil` when unset or the page cannot answer.
    public let read: @Sendable () async -> String?
    /// `setAdminToken(value)`: stores the trimmed value; a blank value removes it. `false` when
    /// the page is not ready or did not answer, so the storage is unchanged.
    public let write: @Sendable (String) async -> Bool

    public init(read: @escaping @Sendable () async -> String?, write: @escaping @Sendable (String) async -> Bool) {
        self.read = read
        self.write = write
    }
}

/// The page scripts behind `AdminTokenAccess`, run with `callAsyncJavaScript`.
public enum AdminTokenScript {
    /// `vision.adminToken`.
    public static let storageKey = "vision.adminToken"
    /// The stored token, or an empty string.
    public static let read = """
        try { return String(window.sessionStorage.getItem("vision.adminToken") || ""); } catch { return ""; }
        """
    /// `setAdminToken(token)`, with `token` passed as an argument (never spliced into the
    /// script). Returns "ok", or an empty string when `sessionStorage` is unavailable.
    public static let write = """
        try {
            const value = String(token ?? "").trim();
            if (value) window.sessionStorage.setItem("vision.adminToken", value);
            else window.sessionStorage.removeItem("vision.adminToken");
            return "ok";
        } catch { return ""; }
        """
    /// The argument name `write` reads.
    public static let argument = "token"
}

/// A summary tile of the overview (`OverviewCard`).
public struct AdminOverviewTile: Equatable, Sendable, Identifiable {
    /// The ring: none for `ok`, `ring-warning/40` for `warn`, `ring-destructive/40` for `error`.
    public enum Status: Equatable, Sendable {
        case ok
        case warn
        case error
    }

    public let id: String
    public let symbol: String
    public let title: String
    public let value: String
    public let subtext: String?
    /// Where the whole card links to.
    public let route: String
    public let status: Status

    public init(
        id: String, symbol: String, title: String, value: String, subtext: String?, route: String, status: Status
    ) {
        self.id = id
        self.symbol = symbol
        self.title = title
        self.value = value
        self.subtext = subtext
        self.route = route
        self.status = status
    }
}

/// The three tiles of `AdminOverviewPage`, with its thresholds.
public enum AdminOverviewPresentation {
    /// Error from three failing providers, warn from one.
    public static func providerStatus(failing: Int) -> AdminOverviewTile.Status {
        failing >= 3 ? .error : failing > 0 ? .warn : .ok
    }

    /// Error at 10 % or more, warn above 2 %.
    public static func metricsStatus(errorRatePercent: Decimal) -> AdminOverviewTile.Status {
        errorRatePercent >= 10 ? .error : errorRatePercent > 2 ? .warn : .ok
    }

    /// `totalErrors / totalRequests * 100`, or 0 without requests.
    public static func errorRatePercent(_ metrics: [OpenAPI.RouteMetric]) -> Decimal {
        let requests = metrics.reduce(0) { $0 + $1.count }
        let errors = metrics.reduce(0) { $0 + $1.errors }
        guard requests > 0 else { return 0 }
        return Decimal(errors) / Decimal(requests) * 100
    }

    public static func tiles(
        dbStats: OpenAPI.DbStats?, providers: [OpenAPI.ProviderHealth]?, providersLoading: Bool,
        metrics: [OpenAPI.RouteMetric]?, metricsLoading: Bool, settings: NativeAppSettings, strings: any Localizing
    ) -> [AdminOverviewTile] {
        let failing = providers?.filter { $0.consecutiveFailures > 0 }.count ?? 0
        let total = providers?.count ?? 0
        let rate = errorRatePercent(metrics ?? [])
        let requests = metrics?.reduce(0) { $0 + $1.count } ?? 0
        let percent = VisionFormat.percent(rate, digits: 1, locale: settings.numberFormat.locale)
        return [
            AdminOverviewTile(
                id: "database", symbol: "cylinder.split.1x2", title: strings.t("admin.overview.dbSize"),
                value: dbStats?.dbSize ?? "—",
                subtext: "\(dbStats?.tables.count ?? 0) \(strings.t("admin.overview.tables"))", route: "/admin/db",
                status: .ok),
            AdminOverviewTile(
                id: "providers", symbol: "server.rack", title: strings.t("admin.overview.dataSources"),
                value: providersLoading ? "…" : "\(total - failing) / \(total)",
                subtext: failing > 0
                    ? "\(failing) \(strings.t("admin.overview.failing"))" : strings.t("admin.overview.allHealthy"),
                route: "/admin/providers", status: providerStatus(failing: failing)),
            AdminOverviewTile(
                id: "endpoints", symbol: "waveform.path.ecg", title: strings.t("admin.overview.endpoints"),
                value: metricsLoading ? "…" : "\(percent) \(strings.t("admin.overview.errorRate"))",
                subtext: "\(requests) \(strings.t("admin.overview.requests"))", route: "/admin/endpoints",
                status: metricsStatus(errorRatePercent: rate)),
        ]
    }
}

/// The state of `/admin` (`AdminOverviewPage`): the three `useAdminOverviewQueries`
/// queries and the admin token card.
@MainActor
@Observable
public final class AdminOverviewModel {
    /// `useDbStats(60_000)`.
    public let dbStats: ScreenQuery<OpenAPI.DbStats>
    /// `adminKeys.providerHealth`, `QUERY_STALE_TIME_MS.FREQUENT`.
    public let providers: ScreenQuery<[OpenAPI.ProviderHealth]>
    /// `adminKeys.requestMetrics`, 15 s.
    public let metrics: ScreenQuery<[OpenAPI.RouteMetric]>
    /// The token input's draft.
    public var tokenDraft = ""
    /// `hasAdminToken()`: the "token is set" line and the Clear button.
    public private(set) var hasToken = false
    public private(set) var notice: ScreenNotice?

    @ObservationIgnored private let token: AdminTokenAccess
    @ObservationIgnored private var notices = NoticeCounter()

    public init(
        service: any AdminService, token: AdminTokenAccess,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        dbStats = ScreenQuery(staleAfter: 60, now: now) { try await service.databaseStats() }
        providers = ScreenQuery(staleAfter: 30, now: now) { try await service.providerHealth() }
        metrics = ScreenQuery(staleAfter: 15, now: now) { try await service.requestMetrics() }
        self.token = token
    }

    /// The skeleton tiles show while the database stats load.
    public var showsTileSkeleton: Bool { dbStats.isLoading }

    public func tiles(settings: NativeAppSettings, strings: any Localizing) -> [AdminOverviewTile] {
        AdminOverviewPresentation.tiles(
            dbStats: dbStats.data, providers: providers.data, providersLoading: providers.isLoading,
            metrics: metrics.data, metricsLoading: metrics.isLoading, settings: settings, strings: strings)
    }

    /// The page went away: the typed token does not outlive it.
    public func disappear() {
        tokenDraft = ""
    }

    /// The page mounted: the queries (unless fresh) and the token state.
    public func appear() async {
        let dbStats = dbStats
        let providers = providers
        let metrics = metrics
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.refreshTokenState() }
            group.addTask { await dbStats.appear() }
            group.addTask { await providers.appear() }
            group.addTask { await metrics.appear() }
        }
    }

    // MARK: Admin token

    /// Save is disabled for a blank draft; Enter does nothing then.
    public var canSaveToken: Bool { !tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    public var canClearToken: Bool { hasToken }

    public func refreshTokenState() async {
        hasToken = Self.isSet(await token.read())
    }

    /// `save()`: store the trimmed token, clear the input, toast `admin.token.saved`, or
    /// `apiError.unknown` when the page could not store it.
    public func saveToken() async {
        guard canSaveToken else { return }
        let value = tokenDraft
        tokenDraft = ""
        let stored = await token.write(value)
        hasToken = Self.isSet(await token.read())
        notice = notices.make(stored ? .success : .error, stored ? "admin.token.saved" : "apiError.unknown")
    }

    /// `clear()`: remove the token, toast `admin.token.cleared`, or `apiError.unknown` when the
    /// page could not remove it.
    public func clearToken() async {
        guard canClearToken else { return }
        if await token.write("") {
            hasToken = false
            notice = notices.make(.success, "admin.token.cleared")
        } else {
            hasToken = Self.isSet(await token.read())
            notice = notices.make(.error, "apiError.unknown")
        }
    }

    /// The toast was shown.
    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }

    public func clearNotice(_ id: Int) {
        if notice?.id == id { notice = nil }
    }

    private static func isSet(_ value: String?) -> Bool {
        !(value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// The native admin screens of phases 3a and 3b, sharing one admin service.
public struct AdminScreens: Sendable {
    public let overview: AdminOverviewModel
    public let providers: ProviderHealthModel
    public let endpoints: EndpointLivenessModel
    /// `/admin/db` and `/admin/db/:table`.
    public let database: DatabaseScreens

    public init(
        overview: AdminOverviewModel, providers: ProviderHealthModel, endpoints: EndpointLivenessModel,
        database: DatabaseScreens
    ) {
        self.overview = overview
        self.providers = providers
        self.endpoints = endpoints
        self.database = database
    }

    /// The models over one service; a probe on the Data sources page marks the overview's
    /// provider query stale, as `invalidateQueries(adminKeys.providerHealth)` does, and a
    /// vacuum or a refresh on Database maintenance marks its database query stale
    /// (`adminKeys.dbStats`).
    @MainActor
    public static func make(
        service: any AdminService, database: any DatabaseAdminService, token: AdminTokenAccess,
        now: @escaping @Sendable () -> Date = { Date() }
    ) -> AdminScreens {
        let overview = AdminOverviewModel(
            service: service, token: token, now: now)
        let providers = ProviderHealthModel(
            service: service, now: now, onProvidersChanged: { [weak overview] in overview?.providers.invalidate() })
        let databaseScreens = DatabaseScreens(
            service: database, onStatsChanged: { [weak overview] in overview?.dbStats.invalidate() })
        return AdminScreens(
            overview: overview, providers: providers, endpoints: EndpointLivenessModel(service: service),
            database: databaseScreens)
    }
}
