import Foundation
import Observation

/// One provider row of `/admin/providers` (`ProviderRow`), as text.
public struct ProviderHealthRow: Equatable, Sendable, Identifiable {
    /// `StatusIcon` and `statusBadgeVariant`: success at 0 failures, warning at 1-2,
    /// destructive from 3.
    public enum Tone: Equatable, Sendable {
        case success
        case warning
        case destructive

        public init(failures: Int) {
            self = failures == 0 ? .success : failures <= 2 ? .warning : .destructive
        }

        /// `CheckCircle2`, `AlertTriangle`, `XCircle`.
        public var symbol: String {
            switch self {
            case .success: return "checkmark.circle"
            case .warning: return "exclamationmark.triangle"
            case .destructive: return "xmark.circle"
            }
        }
    }

    public let provider: String
    public let label: String
    public let kind: String
    /// The last success as a date-time, or `admin.providers.never`.
    public let lastSuccess: String
    public let failures: String
    public let tone: Tone
    /// The last error, only when it is set and the provider is failing.
    public let lastError: String?
    /// The expanded row's `(date-time)` of the last error.
    public let lastErrorAt: String?

    public var id: String { provider }

    public init(
        _ health: OpenAPI.ProviderHealth, settings: NativeAppSettings, strings: any Localizing,
        timeZone: TimeZone = .current
    ) {
        let never = strings.t("admin.providers.never")
        func timestamp(_ text: String?) -> String {
            guard let text, !text.isEmpty else { return never }
            return VisionFormat.appDateTime(
                text, format: settings.dateFormat, locale: settings.numberFormat.locale, timeZone: timeZone)
        }
        provider = health.provider
        label = health.label
        kind = health.kind
        lastSuccess = timestamp(health.lastSuccessAt)
        failures = String(health.consecutiveFailures)
        tone = Tone(failures: health.consecutiveFailures)
        let error = health.lastError ?? ""
        let hasError = !error.isEmpty && health.consecutiveFailures > 0
        lastError = hasError ? error : nil
        lastErrorAt = hasError ? health.lastErrorAt.flatMap { $0.isEmpty ? nil : timestamp($0) } : nil
    }
}

/// The state of `/admin/providers` (`ProviderHealthPage`): `useProviderHealthQuery`, the
/// per-provider probes and the expanded error rows.
@MainActor
@Observable
public final class ProviderHealthModel {
    /// `adminKeys.providerHealth`, `QUERY_STALE_TIME_MS.FREQUENT`.
    public let providers: ScreenQuery<[OpenAPI.ProviderHealth]>
    /// `probingSet`: providers whose probe is in flight.
    public private(set) var probing: Set<String> = []
    /// Providers whose full error row is open.
    public private(set) var expanded: Set<String> = []
    public private(set) var notice: ScreenNotice?

    @ObservationIgnored private let service: any AdminService
    @ObservationIgnored private let onProvidersChanged: (@MainActor () -> Void)?
    @ObservationIgnored private var notices = NoticeCounter()

    /// - Parameter onProvidersChanged: a probe invalidated `adminKeys.providerHealth`, which
    ///   the overview's tile reads too.
    public init(
        service: any AdminService, now: @escaping @Sendable () -> Date = { Date() },
        onProvidersChanged: (@MainActor () -> Void)? = nil
    ) {
        self.service = service
        self.onProvidersChanged = onProvidersChanged
        providers = ScreenQuery(staleAfter: 30, now: now) { try await service.providerHealth() }
    }

    public func appear() async {
        await providers.appear()
    }

    /// `AdminErrorState` with `admin.providers.loadError`.
    public func errorState(strings: any Localizing) -> AdminErrorState? {
        providers.error.map {
            AdminErrorState(error: $0, fallbackTitle: strings.t("admin.providers.loadError"), strings: strings)
        }
    }

    public func rows(settings: NativeAppSettings, strings: any Localizing) -> [ProviderHealthRow] {
        (providers.data ?? []).map { ProviderHealthRow($0, settings: settings, strings: strings) }
    }

    public func isProbing(_ provider: String) -> Bool { probing.contains(provider) }
    public func isExpanded(_ provider: String) -> Bool { expanded.contains(provider) }

    /// The last-error link toggles the full error row.
    public func toggleExpanded(_ provider: String) {
        if expanded.contains(provider) {
            expanded.remove(provider)
        } else {
            expanded.insert(provider)
        }
    }

    /// Check now: `POST /api/admin/providers/:provider/probe`. Probes of different providers
    /// run concurrently; the row's button is disabled while its own probe runs.
    public func probe(_ provider: String) async {
        guard !probing.contains(provider) else { return }
        probing.insert(provider)
        do {
            let result = try await service.probeProvider(provider)
            let label = result.provider.label
            if result.ok {
                notice = notices.make(.success, "admin.providers.probeOk", ["provider": label])
            } else {
                notice = notices.make(.error, "admin.providers.probeFail", ["provider": label], detail: result.error)
            }
            probing.remove(provider)
            providers.invalidate()
            onProvidersChanged?()
            await providers.refetch()
        } catch {
            notice = notices.make(.error, "admin.providers.probeError", ["provider": provider])
            probing.remove(provider)
        }
    }

    public func clearNotice(_ id: Int) {
        if notice?.id == id { notice = nil }
    }
}
