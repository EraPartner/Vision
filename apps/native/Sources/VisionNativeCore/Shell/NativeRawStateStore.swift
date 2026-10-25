import Foundation

/// The native shell's private per-device state: what the web app kept in the browser's
/// `localStorage` (and a little `sessionStorage`), now a JSON file in the runtime directory
/// (`raw-state.json`). There is no web document to capture anything from: a missing file is
/// an empty store, and the file is written on the first change. A file that cannot be read is
/// never replaced by an empty one.
///
/// The host owns admission, restore drains and generation fences around this store.
public actor NativeRawStateStore {
    public enum StoreError: Error, Equatable, Sendable {
        case invalidPersistenceURL, unsupportedVersion
    }

    /// Application callers get an explicit capability rather than arbitrary keys.
    /// Unknown historical keys survive persistence and restore overlays.
    public enum LocalKey: String, CaseIterable, Sendable {
        case theme = "vision_theme"
        case themeVariant = "vision_theme_variant"
        case backupReminder = "vision.backup.passphrase.reminder.dismissed"
        case upcomingDismissals = "dismissed_upcoming_planned_payments"
        case accountInactivity = "vision.home.dismissedAccountInactivity"
        case recurringDismissals = "dismissed_recurring_patterns"
        case paletteRecents = "vision.palette.recents"
        case lastRoute = "vision.lastRoute"
        case language = "vision.language"
        case startupSection = "vision.startupSection"
        case onboardingDraft = "vision.onboarding.draft.v1"
        case chartLayouts = "vision.research.chartBuilder.layouts.v2"
        case analysisHistory = "vision.analysis.sqlHistory"
        case sidebarCollapsed = "vision.sidebar.collapsed"
        case sidebarHiddenSections = "vision.sidebar.hiddenSections"
        case fxDismissedAt = "fx-status-banner-dismissed-at"
        case deductionDismissals = "dismissed_deduction_candidates_v1"
    }

    public enum SessionKey: String, CaseIterable, Sendable {
        case portfolioSession = "vision.portfolio-import.latest-session.v1"
        case portfolioReview = "vision.portfolio-import.latest-review-settings.v1"
        case dashboardArrival = "vision.dashboardArrivalSeen"
    }

    /// The keys a backup carries: the frontend's `LOCAL_STORAGE_KEYS` registry in its exact order
    /// (lib/localStorage-keys.ts), which backups made by the web app and by Electron use.
    /// Credentials and session values are not part of it.
    public static let backupKeys = [
        "vision_theme", "vision_theme_variant", "vision.backup.passphrase.reminder.dismissed",
        "dismissed_upcoming_planned_payments", "vision.home.dismissedAccountInactivity",
        "dismissed_recurring_patterns", "vision.palette.recents", "vision.lastRoute", "vision.language",
        "vision.startupSection", "vision.onboarding.draft.v1", "vision.research.chartBuilder.layouts.v2",
        "vision.analysis.sqlHistory", "vision.sidebar.collapsed", "vision.sidebar.hiddenSections",
    ]

    /// Both closures execute synchronously inside this actor: the durable commit
    /// finishes before memory advances. Injected save implementations must offer
    /// the same all-or-nothing replacement contract as the default atomic write.
    public struct Persistence: Sendable {
        public let load: @Sendable (URL) throws -> Data?
        public let save: @Sendable (Data, URL) throws -> Void

        public init(
            load: @escaping @Sendable (URL) throws -> Data?,
            save: @escaping @Sendable (Data, URL) throws -> Void
        ) {
            self.load = load
            self.save = save
        }

        /// The caller must provide an existing parent directory. There is no
        /// inferred Application Support path.
        public static let atomicFile = Persistence(
            load: { url in
                do { return try Data(contentsOf: url) } catch {
                    let failure = error as NSError
                    if failure.domain == NSCocoaErrorDomain, failure.code == NSFileReadNoSuchFileError { return nil }
                    throw error
                }
            },
            save: { data, url in try data.write(to: url, options: .atomic) }
        )
    }

    public struct BackupSnapshot: Codable, Equatable, Sendable {
        public let keys: [String: String]
    }

    /// Version 1 files written while the app still captured browser storage carry extra
    /// fields (`source`, `migrationCaptureID`, `startedEmpty`); decoding ignores them, and the
    /// next write drops them.
    private struct Document: Codable {
        let version: Int
        var localValues: [String: String]
    }

    private let persistenceURL: URL
    private let persistence: Persistence
    private var document: Document
    private var sessionValues: [SessionKey: String] = [:]

    /// An absent file is an empty store. Corruption or an unknown version throws and leaves
    /// the file untouched: none of those cases silently becomes an empty database.
    /// The host must retain a single writer instance for each persistence URL.
    public init(persistenceURL: URL, persistence: Persistence = .atomicFile) throws {
        guard persistenceURL.isFileURL else { throw StoreError.invalidPersistenceURL }
        self.persistenceURL = persistenceURL
        self.persistence = persistence
        if let data = try persistence.load(persistenceURL) {
            let loaded = try JSONDecoder().decode(Document.self, from: data)
            guard loaded.version == 1 else { throw StoreError.unsupportedVersion }
            document = loaded
        } else {
            document = Document(version: 1, localValues: [:])
        }
    }

    /// How many local keys the store holds.
    public var localKeyCount: Int { document.localValues.count }

    /// Nil means absent; empty strings and the literal string "null" remain values.
    public func value(for key: LocalKey) -> String? {
        document.localValues[key.rawValue]
    }

    public func setValue(_ value: String?, for key: LocalKey) throws {
        var next = document
        next.localValues[key.rawValue] = value
        try commit(next)
    }

    /// Session lifetime belongs to this store instance, not a shell graph. A graph
    /// rebuild can reuse it; a new app session starts a new instance.
    public func sessionValue(for key: SessionKey) -> String? {
        sessionValues[key]
    }

    public func setSessionValue(_ value: String?, for key: SessionKey) {
        sessionValues[key] = value
    }

    /// Matches BackupSection's full registry, including its boot caches/recents.
    /// Transient session values never participate in persistence.
    public func backupSnapshot() -> BackupSnapshot {
        BackupSnapshot(keys: document.localValues.filter { Self.backupKeys.contains($0.key) })
    }

    /// Values must already have passed the source's `String(value)` conversion. JSON
    /// encoding arbitrary values is not equivalent. Omitted keys remain untouched, and
    /// historical keys are retained exactly.
    public func applyRestoredLocalValues(_ values: [String: String]) throws {
        var next = document
        next.localValues.merge(values) { _, restored in restored }
        try commit(next)
    }

    private func commit(_ next: Document) throws {
        let data = try JSONEncoder().encode(next)
        try persistence.save(data, persistenceURL)
        document = next
    }
}
