import Foundation

enum NativeSettingsWindowSection: String, CaseIterable {
    case general, appearance, statistics, behavior, ai, backup, about
    var titleKey: String {
        switch self {
        case .general: "settings.tab.general"
        case .appearance: "settings.tab.appearance"
        case .statistics: "settings.section.statistics"
        case .behavior: "settings.section.behavior"
        case .ai: "settings.section.ai"
        case .backup: "settings.tab.backup"
        case .about: "settings.section.about"
        }
    }
    var symbol: String {
        switch self {
        case .general: "slider.horizontal.3"
        case .appearance: "paintpalette"
        case .statistics: "chart.bar"
        case .behavior: "arrow.triangle.branch"
        case .ai: "sparkles"
        case .backup: "externaldrive"
        case .about: "info.circle"
        }
    }
    enum Movement { case previous, next, first, last }
    func moving(_ movement: Movement) -> Self {
        let sections = Self.allCases
        let index = sections.firstIndex(of: self) ?? 0
        switch movement {
        case .previous: return sections[(index + sections.count - 1) % sections.count]
        case .next: return sections[(index + 1) % sections.count]
        case .first: return sections[0]
        case .last: return sections[sections.count - 1]
        }
    }
}
