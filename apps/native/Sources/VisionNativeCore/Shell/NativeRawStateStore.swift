import Foundation

/// Dormant phase-4 storage boundary. The host still owns admission, restore drains,
/// generation fences and the transition away from the retained browser store.
public actor NativeRawStateStore {
    public enum StoreError: Error, Equatable, Sendable {
        case invalidSource, invalidPersistenceURL, incompleteCapture, sourceMismatch, unsupportedVersion
        case migrationRequired, alreadyMigrated
    }

    /// Identifies the exact browser origin and website-data store that was read.
    /// A changed loopback port is a different origin and cannot reuse a capture.
    public struct Source: Codable, Equatable, Sendable {
        public let webOrigin: String
        public let storeIdentifier: String

        public init(webOrigin: URL, storeIdentifier: String) throws {
            guard var parts = URLComponents(url: webOrigin, resolvingAgainstBaseURL: false),
                let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
                let host = parts.host?.lowercased(), !host.isEmpty,
                parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
                parts.path.isEmpty || parts.path == "/", !storeIdentifier.isEmpty
            else { throw StoreError.invalidSource }
            parts.scheme = scheme
            parts.host = host
            parts.port = parts.port ?? (scheme == "https" ? 443 : 80)
            parts.path = ""
            guard let origin = parts.string else { throw StoreError.invalidSource }
            self.webOrigin = origin
            self.storeIdentifier = storeIdentifier
        }
    }

    public enum CaptureStatus: Equatable, Sendable { case complete, partial, unavailable }

    /// `complete` attests that the host read all local entries successfully from
    /// this source and captured its supported session keys after draining accepted
    /// writers. A backup's known-key subset is not a complete migration capture.
    /// No browser keys are deleted here.
    public struct MigrationCapture: Sendable {
        public let source: Source
        public let identifier: UUID
        public let status: CaptureStatus
        public let localValues: [String: String]
        public let sessionValues: [SessionKey: String]

        public init(
            source: Source, identifier: UUID, status: CaptureStatus,
            localValues: [String: String], sessionValues: [SessionKey: String]
        ) {
            self.source = source
            self.identifier = identifier
            self.status = status
            self.localValues = localValues
            self.sessionValues = sessionValues
        }
    }

    /// Application callers get an explicit capability rather than arbitrary keys.
    /// Unknown historical keys survive capture, persistence and restore overlays.
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
        case adminToken = "vision.adminToken"
        case portfolioSession = "vision.portfolio-import.latest-session.v1"
        case portfolioReview = "vision.portfolio-import.latest-review-settings.v1"
        case dashboardArrival = "vision.dashboardArrivalSeen"
    }

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
        /// inferred Application Support path or fallback to another browser origin.
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

    private struct Document: Codable {
        let version: Int
        let source: Source
        let migrationCaptureID: UUID
        var localValues: [String: String]
    }

    private let source: Source
    private let persistenceURL: URL
    private let persistence: Persistence
    private var document: Document?
    private var sessionValues: [SessionKey: String] = [:]

    /// An absent file leaves the store uninitialized. Corruption, version or source
    /// mismatch throws; none of those cases silently becomes an empty database.
    /// The host must retain a single writer instance for each persistence URL.
    public init(persistenceURL: URL, source: Source, persistence: Persistence = .atomicFile) throws {
        guard persistenceURL.isFileURL else { throw StoreError.invalidPersistenceURL }
        self.source = source
        self.persistenceURL = persistenceURL
        self.persistence = persistence
        if let data = try persistence.load(persistenceURL) {
            let loaded = try JSONDecoder().decode(Document.self, from: data)
            guard loaded.version == 1 else { throw StoreError.unsupportedVersion }
            guard loaded.source == source else { throw StoreError.sourceMismatch }
            document = loaded
        }
    }

    public var isMigrated: Bool { document != nil }

    public func migrate(_ capture: MigrationCapture) throws {
        guard document == nil else { throw StoreError.alreadyMigrated }
        guard capture.source == source else { throw StoreError.sourceMismatch }
        guard capture.status == .complete else { throw StoreError.incompleteCapture }
        try commit(Document(version: 1, source: source, migrationCaptureID: capture.identifier, localValues: capture.localValues))
        sessionValues = capture.sessionValues
    }

    /// Nil means absent; empty strings and the literal string "null" remain values.
    public func value(for key: LocalKey) throws -> String? {
        try requireDocument().localValues[key.rawValue]
    }

    public func setValue(_ value: String?, for key: LocalKey) throws {
        var next = try requireDocument()
        next.localValues[key.rawValue] = value
        try commit(next)
    }

    /// Session lifetime belongs to this store instance, not a shell graph. A graph
    /// rebuild can reuse it; a new browser-equivalent session starts a new instance.
    public func sessionValue(for key: SessionKey) throws -> String? {
        _ = try requireDocument()
        return sessionValues[key]
    }

    public func setSessionValue(_ value: String?, for key: SessionKey) throws {
        _ = try requireDocument()
        sessionValues[key] = value
    }

    /// Matches BackupSection's full registry, including its boot caches/recents.
    /// Transient session values never participate in capture or persistence.
    public func backupSnapshot() throws -> BackupSnapshot {
        let values = try requireDocument().localValues
        return BackupSnapshot(keys: values.filter { NativeSettingsStorageBridge.knownKeys.contains($0.key) })
    }

    /// Values must already have passed the retained source's `String(value)`
    /// conversion. JSON encoding arbitrary values is not equivalent. Omitted
    /// keys remain untouched, and historical keys are retained exactly.
    public func applyRestoredLocalValues(_ values: [String: String]) throws {
        var next = try requireDocument()
        next.localValues.merge(values) { _, restored in restored }
        try commit(next)
    }

    private func requireDocument() throws -> Document {
        guard let document else { throw StoreError.migrationRequired }
        return document
    }

    private func commit(_ next: Document) throws {
        let data = try JSONEncoder().encode(next)
        try persistence.save(data, persistenceURL)
        document = next
    }
}
