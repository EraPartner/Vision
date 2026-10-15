import Foundation

/// Opt-in in-memory route authority. The mounted renderer stays authoritative unless a
/// shell explicitly receives this value; no storage, financial logic or SDK switch-over lives here.
public struct NativeNavigationHistory: Sendable {
    public enum Intent: Equatable, Sendable {
        case push(NativeNavigationLocation)
        case replace(NativeNavigationLocation)
        case traverse(Int)
    }

    public enum Outcome: Equatable, Sendable {
        case committed(NativeNavigationLocation)
        case blocked(NativeNavigationLocation)
        case waitingForSettings
        case unchanged
    }

    private struct Entry: Sendable {
        let id: UUID
        var location: NativeNavigationLocation
    }

    private var entries: [Entry]
    public private(set) var index = 0
    public private(set) var pending: Intent?
    private var pendingNeedsSettings = false
    private var settingsEntryID: UUID?
    public var location: NativeNavigationLocation { entries[index].location }
    public var count: Int { entries.count }
    public var canGoBack: Bool { index > 0 }
    public var canGoForward: Bool { index + 1 < entries.count }

    public init(initial: NativeNavigationLocation = .home) {
        entries = [Entry(id: UUID(), location: initial)]
    }

    /// `nil` adminMode means settings are still loading, as in RequireAdmin. A pending
    /// intent holds its operation as well as its destination so a confirmed Back stays Back.
    @discardableResult
    public mutating func request(_ intent: Intent, adminMode: Bool?, hasUnsavedChanges: Bool) -> Outcome {
        guard let proposed = destination(for: intent) else {
            pending = nil
            pendingNeedsSettings = false
            return .unchanged
        }
        guard let next = Self.resolve(proposed, adminMode: adminMode) else {
            pending = intent
            pendingNeedsSettings = true
            return .waitingForSettings
        }
        if hasUnsavedChanges, next.path != location.path {
            pending = intent
            pendingNeedsSettings = false
            return .blocked(next)
        }
        pending = nil
        pendingNeedsSettings = false
        switch intent {
        case .push:
            if canGoForward { entries.removeSubrange((index + 1)..<entries.count) }
            entries.append(Entry(id: UUID(), location: next))
            index += 1
        case .replace:
            entries[index].location = next
        case .traverse(let delta):
            index += delta
            // React's legacy/admin Navigate replaces the entry reached by Back or Forward.
            entries[index].location = next
        }
        if !Self.isSettingsOpen(next) { settingsEntryID = nil }
        return .committed(next)
    }

    public mutating func cancelPending() {
        pending = nil
        pendingNeedsSettings = false
    }

    @discardableResult
    public mutating func confirmPending(adminMode: Bool?) -> Outcome {
        guard let pending else { return .unchanged }
        return request(pending, adminMode: adminMode, hasUnsavedChanges: false)
    }

    /// Resolve an initial location or a settings-mode change without creating an entry.
    /// A loading admin request is retried with the same leave guard once settings arrive.
    @discardableResult
    public mutating func settingsDidLoad(adminMode: Bool, hasUnsavedChanges: Bool) -> Outcome {
        if pendingNeedsSettings, let pending {
            return request(pending, adminMode: adminMode, hasUnsavedChanges: hasUnsavedChanges)
        }
        guard let next = Self.resolve(location, adminMode: adminMode), next != location else { return .unchanged }
        return request(.replace(next), adminMode: adminMode, hasUnsavedChanges: hasUnsavedChanges)
    }

    @discardableResult
    public mutating func openSettings(section: String = "general", adminMode: Bool?, hasUnsavedChanges: Bool = false)
        -> Outcome
    {
        let section = Self.settingsSections.contains(section) ? section : "general"
        guard let next = location.setting("settings", to: section) else { return .unchanged }
        let alreadyOpen = Self.isSettingsOpen(location)
        let result = request(
            alreadyOpen ? .replace(next) : .push(next), adminMode: adminMode, hasUnsavedChanges: hasUnsavedChanges)
        if case .committed = result, !alreadyOpen { settingsEntryID = entries[index].id }
        return result
    }

    @discardableResult
    public mutating func closeSettings(adminMode: Bool?, hasUnsavedChanges: Bool = false) -> Outcome {
        guard Self.isSettingsOpen(location) else { return .unchanged }
        if settingsEntryID == entries[index].id, canGoBack {
            return request(.traverse(-1), adminMode: adminMode, hasUnsavedChanges: hasUnsavedChanges)
        }
        guard let next = location.setting("settings", to: nil) else { return .unchanged }
        return request(.replace(next), adminMode: adminMode, hasUnsavedChanges: hasUnsavedChanges)
    }

    private func destination(for intent: Intent) -> NativeNavigationLocation? {
        switch intent {
        case .push(let next), .replace(let next): return next
        case .traverse(let delta):
            // Avoid overflow for arbitrary external history deltas.
            guard delta != 0, delta >= -index, delta < entries.count - index else { return nil }
            return entries[index + delta].location
        }
    }

    public static let settingsSections: Set<String> = [
        "general", "appearance", "statistics", "behavior", "ai", "backup", "about",
    ]

    private static func isSettingsOpen(_ location: NativeNavigationLocation) -> Bool {
        location.route.value("settings").map { settingsSections.contains($0) } ?? false
    }

    /// Mirrors manifest route matching (case-insensitive, optional trailing slash), then
    /// redirects only actual admin pages. `/admin/unknown` is still the NotFound route.
    public static func resolve(_ location: NativeNavigationLocation, adminMode: Bool?) -> NativeNavigationLocation? {
        let path = canonicalPath(location.path)
        if path == "/portfolio/performance" { return location.replacingPath("/portfolio") }
        if NativeScreen.screen(forPath: path)?.requiresAdmin == true {
            guard let adminMode else { return nil }
            if !adminMode { return .home }
        }
        guard let next = path == location.path ? location : location.replacingPath(path) else { return nil }
        if let section = next.route.value("settings"), !section.isEmpty, !settingsSections.contains(section) {
            return next.setting("settings", to: nil)
        }
        return next
    }

    private static func canonicalPath(_ path: String) -> String {
        var trimmed = path
        while trimmed.count > 1, trimmed.hasSuffix("/") { trimmed.removeLast() }
        let lower = trimmed.lowercased()
        if lower == "/portfolio/performance" { return lower }
        if let fixed = NativeScreen.fixedScreens.first(where: { $0.path.lowercased() == lower }) { return fixed.path }
        if lower == "/owes" { return lower }
        var parts = trimmed.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        let normalized = parts.map { $0.lowercased() }
        if parts.count == 3, normalized[1] == "accounts" {
            parts[1] = "accounts"
        } else if parts.count == 4, normalized[1] == "admin", normalized[2] == "db" {
            parts[1] = "admin"
            parts[2] = "db"
        } else if parts.count == 4, normalized[1] == "import", normalized[3] == "review" {
            parts[1] = "import"
            parts[3] = "review"
        } else if parts.count == 5, normalized[1] == "portfolio", normalized[2] == "import", normalized[4] == "review" {
            parts[1] = "portfolio"
            parts[2] = "import"
            parts[4] = "review"
        } else {
            return path
        }
        let candidate = parts.joined(separator: "/")
        return NativeScreen.screen(forPath: candidate) == nil ? path : candidate
    }
}
