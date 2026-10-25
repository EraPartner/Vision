import Foundation
import Observation

/// A route of the matrix: the manifest entry merged with its metrics by `method:path`.
public struct EndpointRow: Equatable, Sendable, Identifiable {
    /// `methodBadgeClass`.
    public enum MethodTone: Equatable, Sendable {
        case info
        case success
        case warning
        case destructive
        case neutral

        public init(method: String) {
            switch method {
            case "GET": self = .info
            case "POST": self = .success
            case "PATCH", "PUT": self = .warning
            case "DELETE": self = .destructive
            default: self = .neutral
            }
        }
    }

    /// `errorRateClass`: destructive (medium weight) from 10 %, warning above 2 %, else
    /// secondary; secondary without metrics.
    public enum RateTone: Equatable, Sendable {
        case secondary
        case warning
        case destructive

        public init(percent: Decimal) {
            self = percent >= 10 ? .destructive : percent > 2 ? .warning : .secondary
        }
    }

    public let method: String
    public let path: String
    public let metric: OpenAPI.RouteMetric?

    public var id: String { "\(method):\(path)" }
    public var methodTone: MethodTone { MethodTone(method: method) }

    public init(method: String, path: String, metric: OpenAPI.RouteMetric?) {
        self.method = method
        self.path = path
        self.metric = metric
    }

    public var requests: String { metric.map { String($0.count) } ?? "—" }
    public var errors: String { metric.map { String($0.errors) } ?? "—" }

    public func errorRate(locale: Locale) -> String {
        metric.map { VisionFormat.percent($0.errorRate * 100, digits: 1, locale: locale) } ?? "—"
    }

    public var rateTone: RateTone {
        metric.map { RateTone(percent: $0.errorRate * 100) } ?? .secondary
    }

    /// `${p50_ms}ms`, or "—" without metrics or a latency sample.
    public var p50: String { Self.milliseconds(metric?.p50Ms) }
    public var p95: String { Self.milliseconds(metric?.p95Ms) }

    static func milliseconds(_ value: Decimal?) -> String {
        value.map { "\(VisionFormat.plain($0))ms" } ?? "—"
    }
}

/// The state of `/admin/endpoints` (`EndpointLivenessPage`): the route manifest, the
/// request metrics and the client-side filter.
@MainActor
@Observable
public final class EndpointLivenessModel {
    /// `adminKeys.endpoints`, 5 minutes.
    public let manifest: ScreenQuery<[OpenAPI.EndpointEntry]>
    /// `adminKeys.requestMetrics`, 15 s.
    public let metrics: ScreenQuery<[OpenAPI.RouteMetric]>
    /// The filter field.
    public var filter = ""

    public init(service: any AdminService, now: @escaping @Sendable () -> Date = { Date() }) {
        manifest = ScreenQuery(staleAfter: 300, now: now) { try await service.endpointManifest() }
        metrics = ScreenQuery(staleAfter: 15, now: now) { try await service.requestMetrics() }
    }

    public func appear() async {
        let manifest = manifest
        let metrics = metrics
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await manifest.appear() }
            group.addTask { await metrics.appear() }
        }
    }

    /// The skeleton rows show while the manifest loads.
    public var isLoading: Bool { manifest.isLoading }

    /// Every manifest entry with its metrics, in manifest order.
    public var rows: [EndpointRow] {
        Self.merge(manifest: manifest.data, metrics: metrics.data)
    }

    /// The rows whose path or method contains the filter, ignoring case.
    public var filteredRows: [EndpointRow] {
        Self.filter(rows, by: filter)
    }

    public static func merge(manifest: [OpenAPI.EndpointEntry]?, metrics: [OpenAPI.RouteMetric]?) -> [EndpointRow] {
        guard let manifest else { return [] }
        var byKey: [String: OpenAPI.RouteMetric] = [:]
        // A later metric for the same key replaces an earlier one, like `Map.set`.
        for metric in metrics ?? [] { byKey["\(metric.method):\(metric.path)"] = metric }
        return manifest.map { entry in
            EndpointRow(method: entry.method, path: entry.path, metric: byKey["\(entry.method):\(entry.path)"])
        }
    }

    public static func filter(_ rows: [EndpointRow], by text: String) -> [EndpointRow] {
        guard !text.isEmpty else { return rows }
        let query = text.lowercased()
        return rows.filter { $0.path.lowercased().contains(query) || $0.method.lowercased().contains(query) }
    }
}
