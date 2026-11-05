import Foundation
import Observation

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

/// The state of `/admin` (`AdminOverviewPage`): the three `useAdminOverviewQueries` queries.
@MainActor
@Observable
public final class AdminOverviewModel {
    /// `useDbStats(60_000)`.
    public let dbStats: ScreenQuery<OpenAPI.DbStats>
    /// `adminKeys.providerHealth`, `QUERY_STALE_TIME_MS.FREQUENT`.
    public let providers: ScreenQuery<[OpenAPI.ProviderHealth]>
    /// `adminKeys.requestMetrics`, 15 s.
    public let metrics: ScreenQuery<[OpenAPI.RouteMetric]>

    public init(service: any AdminService, now: @escaping @Sendable () -> Date = { Date() }) {
        dbStats = ScreenQuery(staleAfter: 60, now: now) { try await service.databaseStats() }
        providers = ScreenQuery(staleAfter: 30, now: now) { try await service.providerHealth() }
        metrics = ScreenQuery(staleAfter: 15, now: now) { try await service.requestMetrics() }
    }

    /// The skeleton tiles show while the database stats load.
    public var showsTileSkeleton: Bool { dbStats.isLoading }

    public func tiles(settings: NativeAppSettings, strings: any Localizing) -> [AdminOverviewTile] {
        AdminOverviewPresentation.tiles(
            dbStats: dbStats.data, providers: providers.data, providersLoading: providers.isLoading,
            metrics: metrics.data, metricsLoading: metrics.isLoading, settings: settings, strings: strings)
    }

    /// The page mounted: the queries, unless fresh.
    public func appear() async {
        let dbStats = dbStats
        let providers = providers
        let metrics = metrics
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await dbStats.appear() }
            group.addTask { await providers.appear() }
            group.addTask { await metrics.appear() }
        }
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
        service: any AdminService, database: any DatabaseAdminService,
        now: @escaping @Sendable () -> Date = { Date() }
    ) -> AdminScreens {
        let overview = AdminOverviewModel(service: service, now: now)
        let providers = ProviderHealthModel(
            service: service, now: now, onProvidersChanged: { [weak overview] in overview?.providers.invalidate() })
        let databaseScreens = DatabaseScreens(
            service: database, onStatsChanged: { [weak overview] in overview?.dbStats.invalidate() })
        return AdminScreens(
            overview: overview, providers: providers, endpoints: EndpointLivenessModel(service: service),
            database: databaseScreens)
    }
}
