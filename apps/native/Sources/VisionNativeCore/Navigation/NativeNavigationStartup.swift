/// One document's StartupRedirect selection, before route validation or admin/legacy
/// redirects. Capture raw storage values before the document tracks its first location.
/// This type performs no reads, writes, navigation or route admission.
public struct NativeNavigationStartup: Sendable {
    public enum Context: Sendable {
        /// Collapse the document's initial visit and source replace into one new history seed.
        case newSession
        /// Keep the existing history stack; a source redirect replaces its current entry.
        case documentReload
    }

    public enum Settings: Sendable {
        case loading
        case loaded(startupSection: String)
    }

    public enum Resolution: Equatable, Sendable {
        case waitingForSettings
        case unchanged
        case seedNewSession(String)
        case replaceCurrentEntry(String)
    }

    private let context: Context
    private let mirroredSection: String?
    private let lastRoute: String?
    public private(set) var hasResolved = false

    /// `nil` covers a missing key or an unavailable/throwing storage read. Empty,
    /// whitespace, unknown and differently cased section strings are not valid mirrors.
    public init(context: Context, mirroredStartupSection: String?, lastRoute: String?) {
        self.context = context
        self.mirroredSection = mirroredStartupSection.flatMap {
            Self.sectionHomes[$0] != nil || $0 == "last" ? $0 : nil
        }
        // Source readLastPage does not validate the complete route. Preserve that
        // selection; NativeNavigationLocation must still admit it before navigation.
        self.lastRoute = lastRoute.flatMap { $0.hasPrefix("/") ? $0 : nil }
    }

    /// Use the current location at evaluation time, including after settings arrive.
    /// A valid boot mirror resolves immediately; without one the source waits for
    /// settings even on a deep link, then consumes its one-time decision.
    ///
    /// Returned strings are raw selections, not approved routes. A last-route value
    /// may begin with `/` yet fail the existing route validator; callers must not
    /// silently replace that separate admission check with this startup policy.
    public mutating func evaluate(currentLocation: String, settings: Settings) -> Resolution {
        guard !hasResolved else { return .unchanged }
        let section: String
        if let mirroredSection {
            section = mirroredSection
        } else {
            guard case .loaded(let loadedSection) = settings else { return .waitingForSettings }
            section = loadedSection
        }
        hasResolved = true

        let pathname = currentLocation.prefix { $0 != "?" }
        let target = section == "last" ? lastRoute ?? "/" : Self.sectionHomes[section] ?? "/"
        // Source checks pathname exactly and only calls navigate for a non-root
        // target. In particular, budgeting must preserve an existing root query.
        let replacement = pathname == "/" && target != "/" ? target : nil
        switch context {
        case .newSession:
            return .seedNewSession(replacement ?? currentLocation)
        case .documentReload:
            return replacement.map(Resolution.replaceCurrentEntry) ?? .unchanged
        }
    }

    private static let sectionHomes = [
        "budgeting": "/", "portfolio": "/portfolio", "research": "/research", "ai-chat": "/ai-chat",
    ]
}
