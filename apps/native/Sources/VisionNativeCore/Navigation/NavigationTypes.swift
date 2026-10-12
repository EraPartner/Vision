import Foundation

/// `NavSectionId` in apps/frontend/src/lib/navigation.ts.
public enum NavSectionID: String, CaseIterable, Sendable {
    case top
    case money
    case wealth
    case research
    case admin
}

/// `NavItem.badge`: the live count shown next to a label.
public enum NavBadge: String, Sendable {
    case needsCategory = "needs-category"
    case plannedDue = "planned-due"
    case insights
    case monitors
}

/// `NavItem`, with the Lucide icon replaced by an SF Symbol.
public struct NavItem: Equatable, Hashable, Sendable, Identifiable {
    public let titleKey: String
    public let url: String
    public let symbol: String
    public let shortcutKey: String?
    public let badge: NavBadge?
    /// Active only on an exact path match (section roots with child entries).
    public let exact: Bool

    public init(titleKey: String, url: String, symbol: String, shortcutKey: String?, badge: NavBadge?, exact: Bool) {
        self.titleKey = titleKey
        self.url = url
        self.symbol = symbol
        self.shortcutKey = shortcutKey
        self.badge = badge
        self.exact = exact
    }

    public var id: String { url }

    /// `isActiveNavItem`.
    public func isActive(path: String) -> Bool {
        if exact { return path == url }
        return path == url || path.hasPrefix(url + "/")
    }
}

/// `NavSection`.
public struct NavSection: Equatable, Sendable, Identifiable {
    public let id: NavSectionID
    public let labelKey: String?
    public let collapsible: Bool
    public let defaultHidden: Bool
    public let items: [NavItem]

    public init(id: NavSectionID, labelKey: String?, collapsible: Bool, defaultHidden: Bool, items: [NavItem]) {
        self.id = id
        self.labelKey = labelKey
        self.collapsible = collapsible
        self.defaultHidden = defaultHidden
        self.items = items
    }
}

extension NavigationRegistry {
    /// The sections the sidebar shows: admin is appended in admin mode.
    public static func visibleSections(adminMode: Bool) -> [NavSection] {
        adminMode ? sections + [adminSection] : sections
    }

    /// `ALL_NAV_ITEMS`.
    public static var allItems: [NavItem] {
        sections.flatMap(\.items) + footerItems + adminSection.items
    }

    /// `matchNavItem`: the most specific item for a path; the root matches only exactly.
    public static func matchItem(path: String) -> NavItem? {
        var best: NavItem?
        for item in allItems {
            let matches = item.url == "/" ? path == "/" : path == item.url || path.hasPrefix(item.url + "/")
            if matches, best.map({ item.url.count > $0.url.count }) ?? true { best = item }
        }
        return best
    }

    /// `matchNavSectionId`: the section of the matched item (footer items have none).
    public static func matchSection(path: String) -> NavSectionID? {
        guard let item = matchItem(path: path) else { return nil }
        return (sections + [adminSection]).first { $0.items.contains(item) }?.id
    }
}
