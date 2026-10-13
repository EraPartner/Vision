import Foundation
import Observation

/// Sonner's app-lifetime notices and the web's one-slot Undo registry. Screens own
/// write semantics; this host owns deadlines and consumes an action before awaiting it.
@MainActor @Observable public final class NativeNoticeCenter {
    public struct Entry: Identifiable {
        public let id: UUID
        public let notice: ScreenNotice
        public let expiresAt: Date
        public let actionTitleKey: String?
        public let isUndo: Bool
    }

    public private(set) var entries: [Entry] = []
    public var visibleEntries: [Entry] { Array(entries.suffix(3)) }
    public var hasUndo: Bool {
        guard let id = latestUndo, let entry = entries.first(where: { $0.id == id }) else { return false }
        return now() <= entry.expiresAt && actions[id] != nil
    }
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let automaticExpiry: Bool
    @ObservationIgnored private var actions: [UUID: @MainActor () async -> Void] = [:]
    @ObservationIgnored private var clears: [UUID: @MainActor () -> Void] = [:]
    @ObservationIgnored private var timers: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var identities: [String: UUID] = [:]
    @ObservationIgnored private var latestUndo: UUID?

    public init(now: @escaping @Sendable () -> Date = { Date() }, automaticExpiry: Bool = true) {
        self.now = now
        self.automaticExpiry = automaticExpiry
    }

    /// `source` separates per-model notice counters. Offering an action immediately
    /// after a plain publication updates that entry rather than showing a second toast.
    @discardableResult public func publish(
        _ notice: ScreenNotice, source: UUID, lifetime: TimeInterval = 4,
        actionTitleKey: String? = nil, isUndo: Bool = false,
        action: (@MainActor () async -> Void)? = nil, clear: @escaping @MainActor () -> Void = {}
    ) -> UUID {
        let identity = "\(source.uuidString):\(notice.id)"
        let id = identities[identity] ?? UUID()
        identities[identity] = id
        let entry = Entry(
            id: id, notice: notice, expiresAt: now().addingTimeInterval(max(0, lifetime)),
            actionTitleKey: actionTitleKey, isUndo: isUndo)
        if let index = entries.firstIndex(where: { $0.id == id }) {
            entries[index] = entry
        } else {
            entries.append(entry)
        }
        actions[id] = action
        clears[id] = clear
        if isUndo, action != nil { latestUndo = id }
        timers[id]?.cancel()
        if automaticExpiry {
            timers[id] = Task { [weak self] in
                // The registry's boundary is strictly greater than the deadline.
                do { try await Task.sleep(for: .seconds(max(0, lifetime)) + .milliseconds(1)) } catch { return }
                self?.expire()
            }
        }
        return id
    }

    public func contains(_ notice: ScreenNotice) -> Bool { entries.contains { $0.notice == notice } }

    public func dismiss(_ id: UUID) {
        guard entries.contains(where: { $0.id == id }) else { return }
        let clear = clears.removeValue(forKey: id)
        entries.removeAll { $0.id == id }
        actions[id] = nil
        timers.removeValue(forKey: id)?.cancel()
        identities = identities.filter { $0.value != id }
        if latestUndo == id { latestUndo = nil }
        clear?()
    }

    public func expire() {
        let expired = entries.filter { now() > $0.expiresAt }.map(\.id)
        for id in expired { dismiss(id) }
    }

    /// Clicking an older Undo toast clears the shared shortcut slot too, like
    /// undoToast's clearUndo(). Its own captured action still runs at most once.
    @discardableResult public func performAction(_ id: UUID) async -> Bool {
        guard let entry = entries.first(where: { $0.id == id }), now() <= entry.expiresAt,
            let action = actions[id]
        else {
            expire()
            return false
        }
        if entry.isUndo { latestUndo = nil }
        dismiss(id)
        await action()
        return true
    }

    @discardableResult public func consumeUndo() async -> Bool {
        expire()
        guard let id = latestUndo else { return false }
        // Reserve synchronously, before performAction reaches its first suspension.
        latestUndo = nil
        return await performAction(id)
    }
}
