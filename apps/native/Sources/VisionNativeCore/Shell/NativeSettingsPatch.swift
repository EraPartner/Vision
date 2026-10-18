import Foundation

/// Preference deltas from the retained page. This is restricted to the three
/// frontend preference envelopes; it cannot write credentials or arbitrary keys.
public struct NativeSettingsPatch: Equatable, Sendable {
    public let key: String
    public let updates: [String: JSONValue]
    public let removed: [String]

    public init(key: String, updates: [String: JSONValue], removed: [String]) throws {
        let allowed: Set<String>
        switch key {
        case "app_settings":
            allowed = Set(NativeSettingsDefaults.app.objectValue!.keys).union([
                "aiDefaultModel", "openAiDefaultModel", "aiAnswerDepth", "analysisBenchmark",
            ])
        case "dashboard_settings": allowed = Set(NativeSettingsDefaults.dashboard.objectValue!.keys)
        case "theme_settings": allowed = ["mode", "schedule", "variant", "systemAccent"]
        default: throw APIError.invalidRequest("Unsupported native settings key")
        }
        let optional: Set<String> = ["aiDefaultModel", "openAiDefaultModel", "aiAnswerDepth", "analysisBenchmark"]
        guard Set(updates.keys).isSubset(of: allowed),
            removed.isEmpty || key == "app_settings" && Set(removed).isSubset(of: optional),
            Set(removed).isDisjoint(with: updates.keys)
        else { throw APIError.invalidRequest("Unsupported native settings fields") }
        self.key = key
        self.updates = updates
        self.removed = removed
    }
}
