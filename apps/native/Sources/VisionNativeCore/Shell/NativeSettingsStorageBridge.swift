import Foundation

/// Private host scripts for Settings backup/restore and the three local Settings
/// controls. The shell binds arguments through WKWebView; no storage RPC is added.
public enum NativeSettingsStorageBridge {
    /// Exact LOCAL_STORAGE_KEYS order from frontend lib/localStorage-keys.ts.
    /// BackupSection intentionally snapshots the entire registry rather than the
    /// different LOCAL_STORAGE_EXCLUDED_KEYS policy used by other consumers.
    public static let knownKeys = [
        "vision_theme", "vision_theme_variant", "vision.backup.passphrase.reminder.dismissed",
        "dismissed_upcoming_planned_payments", "vision.home.dismissedAccountInactivity",
        "dismissed_recurring_patterns", "vision.palette.recents", "vision.lastRoute", "vision.language",
        "vision.startupSection", "vision.onboarding.draft.v1", "vision.research.chartBuilder.layouts.v2",
        "vision.analysis.sqlHistory", "vision.sidebar.collapsed", "vision.sidebar.hiddenSections",
    ]
    public enum LocalKey: String, CaseIterable, Sendable {
        case reminder = "vision.backup.passphrase.reminder.dismissed"
        case onboardingDraft = "vision.onboarding.draft.v1"
        case recurringDismissals = "dismissed_recurring_patterns"
        case paletteRecents = "vision.palette.recents"
        case fxDismissedAt = "fx-status-banner-dismissed-at"
        case upcomingDismissals = "dismissed_upcoming_planned_payments"
    }
    public enum ReplyError: Error, Equatable, Sendable { case invalidReply }

    /// Source lib/keyboard.ts typing detection. Unknown DOM/transport state must
    /// not let a shell shortcut replace the focused editor's own action.
    public static let editingScript = """
        try {
            const target = document.activeElement;
            if (!(target instanceof HTMLElement)) return false;
            return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
        } catch { return true; }
        """
    /// Raw legacy ThemeHydration reads; SDK migration accepts only light/dark
    /// modes and recognized variants. Preserve the first read if the second fails.
    public static let legacyThemeScript = """
        const legacy = { mode: null, variant: null };
        try {
            legacy.mode = window.localStorage.getItem("vision_theme");
            legacy.variant = window.localStorage.getItem("vision_theme_variant");
        } catch {}
        return JSON.stringify(legacy);
        """

    /// Matches BackupSection's one outer nonfatal catch: a read error produces no
    /// capture, rather than a confident partial snapshot.
    public static var exportScript: String {
        let keys = literal(knownKeys)
        return """
            try {
                const keys = {};
                for (const key of \(keys)) {
                    const value = window.localStorage.getItem(key);
                    if (value !== null) keys[key] = value;
                }
                return JSON.stringify({ keys });
            } catch { return null; }
            """
    }
    /// `stateJSON` is a bound argument supplied only after confirmed backup
    /// restoration. Source restore accepts historical/unknown snapshot keys and
    /// preserves raw strings; it does not clear keys omitted from the snapshot.
    public static let restoreScript = """
        try {
            const state = JSON.parse(stateJSON);
            if (state && state.keys) {
                for (const [key, value] of Object.entries(state.keys)) {
                    window.localStorage.setItem(key, String(value));
                }
            }
            return true;
        } catch { return false; }
        """
    /// Bound `key` comes from LocalKey. A read failure/absent entry is nonfatal.
    public static let readScript =
        localGuard + """
            try { return window.localStorage.getItem(key); } catch { return null; }
            """
    /// Bound `value` is the existing raw string (for example the reminder's '1').
    public static let writeScript =
        localGuard + """
            try { window.localStorage.setItem(key, value); return true; } catch { return false; }
            """
    public static let removeScript =
        localGuard + """
            try { window.localStorage.removeItem(key); return true; } catch { return false; }
            """
    private static let localGuard = """
        if (!["vision.backup.passphrase.reminder.dismissed", "vision.onboarding.draft.v1", "dismissed_recurring_patterns"].includes(key)) {
            throw new Error("Unsupported Settings storage key");
        }

        """
    public static func arguments(for key: LocalKey, value: String? = nil) -> [String: JSONValue] {
        var arguments: [String: JSONValue] = ["key": .string(key.rawValue)]
        if let value { arguments["value"] = .string(value) }
        return arguments
    }
    public static func restoreArguments(_ state: JSONValue) throws -> [String: JSONValue] {
        let bytes = try JSONEncoder().encode(state)
        return ["stateJSON": .string(String(decoding: bytes, as: UTF8.self))]
    }
    /// Null means capture was unavailable, while a malformed transport reply is
    /// reported separately. Captured local values are strings, not parsed data.
    public static func readReply(_ value: JSONValue) throws -> String? {
        if value == .null { return nil }
        guard case .string(let text) = value,
            let snapshot = try? JSONDecoder().decode(Snapshot.self, from: Data(text.utf8)),
            Set(snapshot.keys.keys).isSubset(of: Set(knownKeys))
        else { throw ReplyError.invalidReply }
        return text
    }
    public static func readLocalReply(_ value: JSONValue) throws -> String? {
        if value == .null { return nil }
        guard case .string(let text) = value else { throw ReplyError.invalidReply }
        return text
    }
    public static func mutationReply(_ value: JSONValue) throws -> Bool {
        guard case .bool(let success) = value else { throw ReplyError.invalidReply }
        return success
    }
    private struct Snapshot: Decodable { let keys: [String: String] }
    private static func literal(_ keys: [String]) -> String {
        // Encoding a static registry cannot fail and never interpolates input.
        let bytes = try! JSONEncoder().encode(keys)
        return String(decoding: bytes, as: UTF8.self)
    }
}
