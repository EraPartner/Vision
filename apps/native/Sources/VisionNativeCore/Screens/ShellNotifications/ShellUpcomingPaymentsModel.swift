import Foundation
import Observation

@MainActor @Observable public final class ShellUpcomingPaymentsModel {
    public private(set) var upcoming: [OpenAPI.PlannedTransaction]?
    public private(set) var dismissalKeys: [String] = []
    public private(set) var isStorageLoaded = false
    public private(set) var isFetching = false
    public private(set) var readError: String?
    public var expanded = false
    public var isOnline = true
    public var visibleUpcoming: [OpenAPI.PlannedTransaction] {
        (upcoming ?? []).filter { !dismissalKeys.contains(Self.dismissKey($0)) }
    }
    public var displayedUpcoming: [OpenAPI.PlannedTransaction] {
        Array(visibleUpcoming.sorted { $0.plannedDate < $1.plannedDate }.prefix(5))
    }
    public var shouldShow: Bool { isStorageLoaded && !visibleUpcoming.isEmpty }
    @ObservationIgnored public var didChangeDockBadge: (@MainActor (Int) -> Void)?
    @ObservationIgnored public var didChangeDismissals: (@MainActor ([String]) -> Void)?
    @ObservationIgnored public var didLoadUpcoming: (@MainActor ([OpenAPI.PlannedTransaction]) -> Void)?

    @ObservationIgnored private let service: any ShellNotificationsService
    @ObservationIgnored private let storage: NativeShellNotificationStorage
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let timeZone: TimeZone
    @ObservationIgnored private var active = true
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var readRevision = UUID()
    @ObservationIgnored private var storageRevision = 0
    @ObservationIgnored private var storageTask: Task<Void, Never>?
    @ObservationIgnored private var writeTask: Task<Void, Never>?
    @ObservationIgnored private var readTask: Task<Void, Never>?
    @ObservationIgnored private var queryDay: String?
    @ObservationIgnored private var fetchedAt: Date?

    public init(
        service: any ShellNotificationsService, storage: NativeShellNotificationStorage = .unavailable,
        timeZone: TimeZone = .current, now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        self.storage = storage
        self.timeZone = timeZone
        self.now = now
    }
    public static func dismissKey(_ payment: OpenAPI.PlannedTransaction) -> String {
        "\(payment.id.rawValue):\(payment.plannedDate.prefix(10))"
    }
    public func load(force: Bool = false) async {
        guard active else { return }
        async let stored: Void = restoreDismissals()
        async let rows: Void = loadUpcoming(force: force)
        _ = await (stored, rows)
    }
    public func refreshIfStale() async { await load() }
    public func invalidate() { fetchedAt = nil }

    private func restoreDismissals() async {
        guard active else { return }
        if let storageTask {
            await storageTask.value
            return
        }
        guard !isStorageLoaded else { return }
        let token = revision
        let edits = storageRevision
        let today = ShellNotificationDate.day(now(), timeZone: timeZone)
        let task = Task { [weak self] in
            guard let self, active, token == revision, !Task.isCancelled else { return }
            let raw: String?
            do {
                raw = try await storage.read(.upcomingDismissals)
            } catch is CancellationError {
                return
            } catch {
                raw = nil
            }
            guard active, token == revision, !Task.isCancelled else { return }
            if edits == storageRevision {
                dismissalKeys = Self.readKeys(raw, today: today)
                didChangeDismissals?(dismissalKeys)
            }
            isStorageLoaded = true
            publishBadge()
        }
        storageTask = task
        await task.value
        if token == revision { storageTask = nil }
    }
    private static func readKeys(_ raw: String?, today: String) -> [String] {
        guard let raw, let values = try? JSONDecoder().decode([JSONValue].self, from: Data(raw.utf8)) else { return [] }
        var keys: [String] = []
        for value in values {
            guard let key = value.stringValue,
                key.range(of: #"^[0-9]+:[0-9]{4}-[0-9]{2}-[0-9]{2}$"#, options: .regularExpression) != nil,
                let colon = key.firstIndex(of: ":"), String(key[key.index(after: colon)...]) >= today,
                !keys.contains(key)
            else { continue }
            keys.append(key)
        }
        return keys
    }
    private func loadUpcoming(force: Bool) async {
        guard active, isOnline else { return }
        let window = ShellNotificationDate.window(now(), timeZone: timeZone)
        if queryDay != window.start {
            readRevision = UUID()
            readTask?.cancel()
            readTask = nil
            queryDay = window.start
            upcoming = nil
            fetchedAt = nil
            readError = nil
            isFetching = false
        }
        if let readTask {
            await readTask.value
            return
        }
        if !force, let fetchedAt, now().timeIntervalSince(fetchedAt) < 300 { return }
        let token = revision
        let readToken = readRevision
        isFetching = true
        let task = Task { [weak self] in
            guard let self, active, token == revision, readToken == readRevision, !Task.isCancelled else { return }
            do {
                let rows = try await service.notificationUpcoming(start: window.start, end: window.end)
                guard active, token == revision, readToken == readRevision, !Task.isCancelled else { return }
                upcoming = rows.filter { !($0.isExecuted && !$0.isRecurring) }
                fetchedAt = now()
                readError = nil
                didLoadUpcoming?(upcoming ?? [])
                publishBadge()
            } catch is CancellationError {
                return
            } catch {
                guard active, token == revision, readToken == readRevision, !Task.isCancelled else { return }
                readError = error.localizedDescription
            }
        }
        readTask = task
        await task.value
        if token == revision, readToken == readRevision {
            readTask = nil
            isFetching = false
        }
    }
    private func publishBadge() {
        guard active, isStorageLoaded, upcoming != nil else { return }
        didChangeDockBadge?(visibleUpcoming.count)
    }
    public func dismiss(_ payment: OpenAPI.PlannedTransaction) { dismissKeys([Self.dismissKey(payment)]) }
    public func dismissAll() { dismissKeys(visibleUpcoming.map(Self.dismissKey)) }
    private func dismissKeys(_ keys: [String]) {
        guard active else { return }
        storageRevision += 1
        for key in keys where !dismissalKeys.contains(key) { dismissalKeys.append(key) }
        didChangeDismissals?(dismissalKeys)
        publishBadge()
        let raw = String(decoding: (try? JSONEncoder().encode(dismissalKeys)) ?? Data("[]".utf8), as: UTF8.self)
        let previous = writeTask
        let storage = storage
        writeTask = Task {
            await previous?.value
            try? await storage.write(.upcomingDismissals, raw)
        }
    }
    public func flushStorage() async { await writeTask?.value }
    public func didDisappear() {
        guard active else { return }
        active = false
        revision = UUID()
        readTask?.cancel()
        readTask = nil
        isFetching = false
        storageTask?.cancel()
        storageTask = nil
        didChangeDockBadge?(0)
        didChangeDockBadge = nil
    }
}
