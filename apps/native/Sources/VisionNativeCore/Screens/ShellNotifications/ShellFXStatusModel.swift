import Foundation
import Observation

@MainActor @Observable public final class ShellFXStatusModel {
    public private(set) var data: OpenAPI.ExchangeRates?
    public private(set) var isFetching = false
    public private(set) var isRefreshing = false
    public private(set) var isStorageLoaded = false
    public private(set) var dismissed = false
    /// Failed passive reads are silent, as in useFxStatus; a cached warning remains visible.
    public private(set) var readError: String?
    public private(set) var notice: ScreenNotice?
    public var isOnline = true {
        didSet {
            if isOnline, !oldValue, pendingRefresh, active {
                Task { [weak self] in await self?.runRefreshIfPending() }
            }
        }
    }
    @ObservationIgnored public var didRefreshRates: (@MainActor () async -> Void)?
    public var shouldShow: Bool {
        isStorageLoaded && !dismissed && (data?.isStale == true || data?.source == "fallback")
    }
    public var isBusy: Bool { isFetching || isRefreshing }

    @ObservationIgnored private let service: any ShellNotificationsService
    @ObservationIgnored private let storage: NativeShellNotificationStorage
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var active = true
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var storageRevision = 0
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var readTask: Task<Void, Never>?
    @ObservationIgnored private var readTaskID: UUID?
    @ObservationIgnored private var readTaskRevision: UUID?
    @ObservationIgnored private var rateReadRevision = UUID()
    @ObservationIgnored private var storageTask: Task<Void, Never>?
    @ObservationIgnored private var writeTask: Task<Void, Never>?
    @ObservationIgnored private var pendingRefresh = false
    @ObservationIgnored private var notices = NoticeCounter()

    public init(
        service: any ShellNotificationsService, storage: NativeShellNotificationStorage = .unavailable,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        self.storage = storage
        self.now = now
    }

    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }
    public func clearNotice(_ id: Int) { if notice?.id == id { notice = nil } }

    public func load(force: Bool = false) async {
        guard active else { return }
        async let stored: Void = restoreDismissal()
        async let rates: Void = loadRates(force: force)
        _ = await (stored, rates)
    }
    public func refreshIfStale() async { await load() }
    public func invalidate() {
        fetchedAt = nil
        rateReadRevision = UUID()
    }

    private func restoreDismissal() async {
        guard active else { return }
        if let storageTask {
            await storageTask.value
            return
        }
        guard !isStorageLoaded else { return }
        let token = revision
        let edits = storageRevision
        let task = Task { [weak self] in
            guard let self, active, token == revision, !Task.isCancelled else { return }
            let raw: String?
            do {
                raw = try await storage.read(.fxDismissedAt)
            } catch is CancellationError {
                return
            } catch {
                raw = nil
            }
            guard active, token == revision, !Task.isCancelled else { return }
            if edits == storageRevision, let raw, !raw.isEmpty, let milliseconds = Self.dismissalMilliseconds(raw) {
                dismissed = milliseconds.isFinite && now().timeIntervalSince1970 * 1000 - milliseconds < 3_600_000
            }
            isStorageLoaded = true
        }
        storageTask = task
        await task.value
        if token == revision { storageTask = nil }
    }

    private static func dismissalMilliseconds(_ raw: String) -> Double? {
        let whitespace = CharacterSet(
            charactersIn:
                "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D} \u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
        )
        let text = raw.trimmingCharacters(in: whitespace)
        if text.isEmpty { return 0 }
        for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] where text.lowercased().hasPrefix(prefix) {
            guard let number = UInt64(text.dropFirst(2), radix: radix) else { return nil }
            return Double(number)
        }
        guard
            text.range(
                of: #"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$"#,
                options: .regularExpression) != nil
        else { return nil }
        return Double(text)
    }

    private func loadRates(force: Bool) async {
        guard active, isOnline else { return }
        if force { invalidate() }
        let lifetime = revision
        if let readTask {
            let id = readTaskID
            let token = readTaskRevision
            await readTask.value
            clearRateRead(id)
            if active, lifetime == revision, token != rateReadRevision { await loadRates(force: false) }
            return
        }
        if !force, let fetchedAt, now().timeIntervalSince(fetchedAt) < 60 { return }
        let token = revision
        let rateToken = rateReadRevision
        let id = UUID()
        isFetching = true
        let task = Task { [weak self] in
            guard let self, active, token == revision, rateToken == rateReadRevision, !Task.isCancelled else { return }
            do {
                let value = try await service.notificationExchangeRates()
                guard active, token == revision, rateToken == rateReadRevision, !Task.isCancelled else { return }
                data = value
                readError = nil
                fetchedAt = now()
            } catch is CancellationError {
                return
            } catch {
                guard active, token == revision, rateToken == rateReadRevision, !Task.isCancelled else { return }
                readError = error.localizedDescription
            }
        }
        readTask = task
        readTaskID = id
        readTaskRevision = rateToken
        await task.value
        clearRateRead(id)
    }
    private func clearRateRead(_ id: UUID?) {
        guard readTaskID == id else { return }
        readTask = nil
        readTaskID = nil
        readTaskRevision = nil
        isFetching = false
    }

    public func dismiss() {
        guard active else { return }
        dismissed = true
        storageRevision += 1
        let timestamp = String(Int64((now().timeIntervalSince1970 * 1000).rounded(.down)))
        let previous = writeTask
        let storage = storage
        writeTask = Task {
            await previous?.value
            try? await storage.write(.fxDismissedAt, timestamp)
        }
    }
    public func flushStorage() async { await writeTask?.value }

    public func refresh() async {
        guard active, !isRefreshing else { return }
        isRefreshing = true
        pendingRefresh = true
        await runRefreshIfPending()
    }
    private func runRefreshIfPending() async {
        guard active, isOnline, pendingRefresh else { return }
        pendingRefresh = false
        defer { isRefreshing = false }
        do {
            try await service.notificationRefreshExchangeRates()
            invalidate()
            await didRefreshRates?()
            // The mutation itself survives route changes; a retired shell starts no new read.
            if active { await loadRates(force: true) }
            notice = notices.make(.success, "exchangeRates.refreshSuccess")
        } catch is CancellationError {
            // A retired/paused shell has no failed provider receipt to announce.
        } catch {
            notice = notices.make(.error, "exchangeRates.refreshError")
        }
    }

    /// Only whole-shell teardown calls this, never a page change or covered native sheet.
    public func didDisappear() {
        active = false
        revision = UUID()
        readTask?.cancel()
        readTask = nil
        readTaskID = nil
        readTaskRevision = nil
        storageTask?.cancel()
        storageTask = nil
        isFetching = false
        if pendingRefresh {
            pendingRefresh = false
            isRefreshing = false
        }
    }
}
