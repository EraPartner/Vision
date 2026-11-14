import Foundation

// The string-valued `app_settings` fields as types. Each keeps the raw value the web app stores, so a
// persisted settings document is unchanged, and decodes any other value to `.unknown` instead of
// failing, so a setting written by a newer client never breaks the settings decode.

/// `AppSettings.language` (`Language` in apps/frontend/src/types/i18n.ts). The generated investigation
/// request models the same value set, so it is reused.
public typealias AppLanguage = AIInvestigationLanguage

/// `AppSettings.aiAnswerDepth`. The generated investigation request models the same value set.
public typealias AIAnswerDepth = AIInvestigationDepth

/// `AppSettings.startOfWeek` in apps/frontend/src/stores/settingsStore.ts.
/// A value this client does not know decodes to `.unknown` and encodes back unchanged.
public enum StartOfWeek: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case monday
    case sunday
    case unknown(String)

    public static var allCases: [StartOfWeek] { [.monday, .sunday] }

    private static let known: [String: Self] = ["monday": .monday, "sunday": .sunday]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .monday: return "monday"
        case .sunday: return "sunday"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// `CostBasisMethod` in apps/frontend/src/stores/settingsStore.ts (also the `cost_basis_method` setting).
/// A value this client does not know decodes to `.unknown` and encodes back unchanged.
public enum CostBasisMethod: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case weightedAvg
    case fifo
    case lifo
    case unknown(String)

    public static var allCases: [CostBasisMethod] { [.weightedAvg, .fifo, .lifo] }

    private static let known: [String: Self] = ["weighted_avg": .weightedAvg, "fifo": .fifo, "lifo": .lifo]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .weightedAvg: return "weighted_avg"
        case .fifo: return "fifo"
        case .lifo: return "lifo"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// `StartupSection` in apps/frontend/src/stores/settingsStore.ts: the section the app opens on at launch.
/// A value this client does not know decodes to `.unknown` and encodes back unchanged.
public enum StartupSection: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case budgeting
    case portfolio
    case research
    case aiChat
    case last
    case unknown(String)

    public static var allCases: [StartupSection] { [.budgeting, .portfolio, .research, .aiChat, .last] }

    private static let known: [String: Self] = ["budgeting": .budgeting, "portfolio": .portfolio, "research": .research, "ai-chat": .aiChat, "last": .last]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .budgeting: return "budgeting"
        case .portfolio: return "portfolio"
        case .research: return "research"
        case .aiChat: return "ai-chat"
        case .last: return "last"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// `VisualEffectsTier` in apps/frontend/src/stores/settingsStore.ts (ADR-075): the atmosphere/material tier.
/// A value this client does not know decodes to `.unknown` and encodes back unchanged.
public enum VisualEffects: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case reduced
    case standard
    case enhanced
    case unknown(String)

    public static var allCases: [VisualEffects] { [.reduced, .standard, .enhanced] }

    private static let known: [String: Self] = ["reduced": .reduced, "standard": .standard, "enhanced": .enhanced]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .reduced: return "reduced"
        case .standard: return "standard"
        case .enhanced: return "enhanced"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// `AppSettings.fullEffects` (`FullEffectsChoice`, settingsStore.ts; ADR-255): `auto` follows the
/// tier the user chose, `on` and `off` are the user's own choice from the Appearance switch.
public enum FullEffectsChoice: String, Codable, Hashable, Sendable, CaseIterable {
    case auto
    case on
    case off

    /// The stored value as the web store reads it: a choice, or the pre-ADR-255 boolean. A stored
    /// `false` cannot be told apart from the old untouched default, so it becomes `auto`; `true` is
    /// `on`. Anything else is `nil` (the caller falls back to the default).
    public init?(stored: TaxValue?) {
        if let raw = stored?.stringValue, let choice = Self(rawValue: raw) {
            self = choice
        } else if let flag = stored?.boolValue {
            self = flag ? .on : .auto
        } else {
            return nil
        }
    }

    /// `resolveFullEffects`: `auto` is on for the chosen Standard tier only (not the display-capped one).
    public func resolved(chosenTier: VisualEffects) -> Bool {
        switch self {
        case .auto: return chosenTier == .standard
        case .on: return true
        case .off: return false
        }
    }
}
