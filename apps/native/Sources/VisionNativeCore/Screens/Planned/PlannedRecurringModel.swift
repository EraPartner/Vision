import Foundation
import Observation

/// Where the dismissed payee ids live on this Mac: the native counterpart of the web's
/// `localStorage["dismissed_recurring_patterns"]`, a JSON array as text.
public struct PlannedDismissalStore: Sendable {
    public static let key = "dismissed_recurring_patterns"

    public let read: @Sendable () -> String?
    public let write: @Sendable (String?) -> Void

    public init(read: @escaping @Sendable () -> String?, write: @escaping @Sendable (String?) -> Void) {
        self.read = read
        self.write = write
    }

    /// The app's user defaults.
    public static let userDefaults = PlannedDismissalStore(
        read: { UserDefaults.standard.string(forKey: key) },
        write: { value in
            if let value {
                UserDefaults.standard.set(value, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        })

    /// An in-memory store, for tests and previews.
    public static func memory(_ initial: String? = nil) -> PlannedDismissalStore {
        let box = MemoryBox(initial)
        return PlannedDismissalStore(read: { box.get() }, write: { box.set($0) })
    }

    // lint:allow unchecked-sendable value guarded by an NSLock
    private final class MemoryBox: @unchecked Sendable {
        private let lock = NSLock()
        private var value: String?

        init(_ value: String?) { self.value = value }

        func get() -> String? {
            lock.lock()
            defer { lock.unlock() }
            return value
        }

        func set(_ next: String?) {
            lock.lock()
            defer { lock.unlock() }
            value = next
        }
    }

    /// `loadDismissedFromLocalStorage`: the positive integers of a JSON array (`Number(v)`);
    /// anything unreadable is no dismissals.
    public func load() -> [Int] {
        guard let raw = read(), let data = raw.data(using: .utf8), let value = try? JSONValue.parse(data) else {
            return []
        }
        return Self.ids(value)
    }

    /// `persistDismissedToLocalStorage`.
    public func save(_ ids: [Int]) {
        write("[" + ids.map(String.init).joined(separator: ",") + "]")
    }

    /// `Array.isArray(v) ? v.map(Number).filter(n => Number.isInteger(n) && n > 0) : []`.
    public static func ids(_ value: JSONValue?) -> [Int] {
        guard let items = value?.arrayValue else { return [] }
        return items.compactMap { item in
            guard let number = item.numberCoercion, number.isFinite, number.rounded() == number, number > 0,
                number < 9.0e15
            else { return nil }
            return Int(number)
        }
    }
}

/// `RecurringDetectionPanel`: the detected patterns and amount changes, the dismissed payees
/// (this Mac's copy merged with the `dismissed_recurring_patterns` setting), and the two
/// collapsed cards. Track lives on `PlannedPaymentsModel`, which refreshes the list.
@MainActor
@Observable
public final class PlannedRecurringModel {
    /// The patterns query's `staleTime`.
    public static let staleAfter: TimeInterval = 5 * 60
    /// The amount-change card lists at most five rows.
    public static let maxAlertRows = 5

    public enum Patterns: Equatable, Sendable {
        case loading
        /// A contract mismatch: the panel shows nothing.
        case failed
        case loaded([PlannedRecurringPattern])
    }

    public private(set) var patterns: Patterns = .loading
    public private(set) var dismissed: Set<Int> = []
    /// The panel renders nothing until the dismissals have loaded.
    public private(set) var dismissedLoaded = false
    /// The Recurring payments found card (collapsed by default).
    public var patternsExpanded = false
    /// The Amounts that changed card (collapsed by default).
    public var alertsExpanded = false

    @ObservationIgnored private let service: any PlannedEditingService
    @ObservationIgnored private let store: PlannedDismissalStore
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var inFlight: Task<Void, Never>?
    /// The baseline of the last read or write of the setting; `nil` when it is unknown, so
    /// a save is not attempted (the web throws "Settings were not loaded").
    @ObservationIgnored private var baseline: JSONValue?
    /// A rejected save leaves the queue rejected, like the web's per-key save chain.
    @ObservationIgnored private var saveBroken = false
    @ObservationIgnored private var saves: Task<Void, Never>?

    public init(service: any PlannedEditingService, store: PlannedDismissalStore, now: @escaping @Sendable () -> Date) {
        self.service = service
        self.store = store
        self.now = now
    }

    // MARK: Loading

    /// The panel appeared: dismissals load once, the patterns unless a fresh answer is
    /// cached. A second caller awaits the load in flight.
    public func load() async {
        if let inFlight {
            await inFlight.value
            return
        }
        let needsDismissals = !dismissedLoaded
        let needsPatterns: Bool
        if case .loaded = patterns, let fetchedAt, now().timeIntervalSince(fetchedAt) < Self.staleAfter {
            needsPatterns = false
        } else {
            needsPatterns = true
        }
        guard needsDismissals || needsPatterns else { return }
        let task = Task { [weak self] in
            guard let self else { return }
            let dismissals: Task<Void, Never>? = needsDismissals ? Task { await self.loadDismissed() } : nil
            if needsPatterns { await self.fetchPatterns() }
            await dismissals?.value
        }
        inFlight = task
        await task.value
        inFlight = nil
    }

    /// Track invalidated the patterns: fetch again.
    public func reloadPatterns() async {
        fetchedAt = nil
        await load()
    }

    private func fetchPatterns() async {
        do {
            let answer = try await service.recurringPatterns()
            patterns = .loaded(answer)
            fetchedAt = now()
        } catch is CancellationError {
            return
        } catch {
            patterns = .failed
            fetchedAt = nil
        }
    }

    /// `loadDismissed`: this Mac's ids merged with the setting's, written back locally; the
    /// local ids alone when the setting cannot be read.
    private func loadDismissed() async {
        let local = store.load()
        do {
            let setting = try await service.setting(key: PlannedDismissalStore.key)
            baseline = setting.expected
            let merged = Self.merge(local, PlannedDismissalStore.ids(setting.value))
            dismissed = Set(merged)
            store.save(merged)
        } catch {
            if case .client(let failure)? = error as? APIError, failure.status == 404 {
                baseline = .object(["exists": .bool(false)])
            }
            dismissed = Set(local)
        }
        dismissedLoaded = true
    }

    /// `new Set([...local, ...setting])` in insertion order.
    static func merge(_ first: [Int], _ second: [Int]) -> [Int] {
        var seen = Set<Int>()
        var merged: [Int] = []
        for id in first + second where seen.insert(id).inserted {
            merged.append(id)
        }
        return merged
    }

    // MARK: Lists

    /// Every loaded pattern (empty while loading or failed).
    public var allPatterns: [PlannedRecurringPattern] {
        if case .loaded(let list) = patterns { return list }
        return []
    }

    /// Patterns not yet planned and not dismissed.
    public var visiblePatterns: [PlannedRecurringPattern] {
        allPatterns.filter { !$0.isAlreadyPlanned && !dismissed.contains($0.recipientId) }
    }

    /// Patterns with an amount change whose payee is not dismissed.
    public var amountAlerts: [PlannedRecurringPattern] {
        allPatterns.filter { !$0.amountChanges.isEmpty && !dismissed.contains($0.recipientId) }
    }

    /// What the panel shows.
    public enum Display: Equatable, Sendable {
        /// Nothing: dismissals still loading, or the patterns failed.
        case hidden
        case loading
        /// `recurring.allCaughtUp`.
        case caughtUp
        case cards
    }

    public var display: Display {
        guard dismissedLoaded else { return .hidden }
        switch patterns {
        case .loading: return .loading
        case .failed: return .hidden
        case .loaded:
            return visiblePatterns.isEmpty && amountAlerts.isEmpty ? .caughtUp : .cards
        }
    }

    // MARK: Dismissing

    /// The X of an amount-change row or Dismiss of a pattern row: the payee's patterns and
    /// alerts go, here and in the setting.
    public func dismiss(_ recipientId: Int) {
        guard !dismissed.contains(recipientId) else { return }
        var ordered = orderedDismissed
        ordered.append(recipientId)
        persist(ordered)
    }

    /// The reset the Settings dialog offers: no payee dismissed, here and in the setting.
    public func resetDismissals() {
        persist([])
    }

    /// The ids in the order they were dismissed, as the stored array keeps them.
    private var orderedDismissed: [Int] {
        let stored = store.load()
        let extra = dismissed.subtracting(stored).sorted()
        return stored.filter { dismissed.contains($0) } + extra
    }

    private func persist(_ ids: [Int]) {
        dismissed = Set(ids)
        store.save(ids)
        let previous = saves
        let service = service
        saves = Task { [weak self] in
            await previous?.value
            guard let self, !self.saveBroken, let expected = self.baseline else { return }
            let value = JSONValue.array(ids.map { JSONValue.int($0) })
            do {
                let saved = try await service.saveSetting(key: PlannedDismissalStore.key, value: value, expected: expected)
                self.baseline = .object(["exists": .bool(true), "value": saved.value])
            } catch {
                // The local copy stays even if the backend save fails.
                self.saveBroken = true
            }
        }
    }

    /// Waits for the setting writes queued so far.
    public func settle() async {
        await saves?.value
    }
}
