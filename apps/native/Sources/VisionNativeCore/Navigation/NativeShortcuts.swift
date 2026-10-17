import Foundation

/// What a key press on a native screen does.
public enum ShortcutOutcome: Equatable, Sendable {
    case ignored
    /// Part of a sequence (the `g` of `g` then a key).
    case consumed
    case navigate(String)
    /// ⌘K / Ctrl+K: CommandPalette.
    case openPalette
    /// `?`: ShortcutsOverlay.
    case openShortcuts
    /// ⌘B / Ctrl+B: the shadcn sidebar's toggle shortcut.
    case toggleSidebar
}

/// The page's keyboard shortcuts for native screens, which take key events away from the
/// web view: CommandPalette's ⌘K, ShortcutsOverlay's `?`, AppLayout's `N`,
/// `useGoToShortcuts` (`g` then a key within 900 ms) and `useSectionCycleShortcuts`
/// (`[` and `]`). Like `isShortcutSafeTarget`, the single-key ones stay inert while a text
/// field has focus; ⌘K and ⌘B work everywhere.
public struct NativeShortcuts: Sendable {
    /// `SEQUENCE_WINDOW_MS`.
    public static let sequenceWindow: TimeInterval = 0.9
    /// `SECTION_CYCLE`.
    public static let sectionCycle = ["/", "/portfolio", "/research"]

    /// `GO_TO_ROUTES`: every item with a `shortcutKey`, in `ALL_NAV_ITEMS` order.
    public static var goToRoutes: [(key: String, url: String)] {
        NavigationRegistry.allItems.compactMap { item in item.shortcutKey.map { (key: $0, url: item.url) } }
    }

    private var armedAt: Date?

    public init() {}

    /// - Parameters:
    ///   - key: the typed character (`KeyboardEvent.key` for printable keys).
    ///   - path: the current route's path, for `[` and `]`.
    ///   - typing: a text-entry control has focus (`isTypingTarget`).
    public mutating func handle(
        key: String, command: Bool = false, control: Bool = false, option: Bool = false, shift: Bool = false,
        path: String, typing: Bool = false, now: Date
    ) -> ShortcutOutcome {
        if let armedAt, now.timeIntervalSince(armedAt) > Self.sequenceWindow { self.armedAt = nil }
        let lower = key.lowercased()

        if lower == "k" && (command || control) {
            armedAt = nil
            return .openPalette
        }
        if lower == "b" && (command || control) && !option && !shift {
            armedAt = nil
            return .toggleSidebar
        }
        if command || control || option || typing {
            armedAt = nil
            return .ignored
        }
        if armedAt != nil {
            armedAt = nil
            if let route = Self.goToRoutes.first(where: { $0.key == lower }) { return .navigate(route.url) }
        } else if lower == "g" {
            armedAt = now
            return .consumed
        }
        if lower == "n" && !shift { return .navigate("/transactions?new=1") }
        if key == "?" { return .openShortcuts }
        if (key == "[" || key == "]") && !shift {
            let current = Self.sectionIndex(path)
            let count = Self.sectionCycle.count
            let next = (current + (key == "]" ? 1 : -1) + count) % count
            return .navigate(Self.sectionCycle[next])
        }
        return .ignored
    }

    /// `currentSectionIndex`.
    static func sectionIndex(_ path: String) -> Int {
        if path.hasPrefix("/portfolio") { return 1 }
        if path.hasPrefix("/research") { return 2 }
        return 0
    }
}
