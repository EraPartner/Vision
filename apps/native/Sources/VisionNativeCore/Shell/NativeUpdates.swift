import Foundation
import Observation

/// `UpdateMode` (packaging/electron/updater.ts): `native` installs the packaged app from the
/// release ZIP, `source` sends the user to the release page. The Swift app is always built from
/// a checkout (`install-native.sh`, Xcode) and no release ships it, so it runs in `source` mode,
/// as an unpackaged Electron run does (ADR-218).
public enum NativeUpdateMode: String, Sendable, Equatable {
    case native
    case source
}

/// `ShellUpdateCheck`: the status the About section and the sidebar's Settings dot show.
public struct NativeUpdateStatus: Equatable, Sendable {
    public let upToDate: Bool
    public let currentVersion: String
    public let latestVersion: String?
    public let htmlURL: String?
    public let releaseNotes: String
    public let publishedAt: String?
    public let mode: NativeUpdateMode
    public let error: String?

    public init(
        upToDate: Bool, currentVersion: String, latestVersion: String?, htmlURL: String? = nil,
        releaseNotes: String = "", publishedAt: String? = nil, mode: NativeUpdateMode, error: String? = nil
    ) {
        self.upToDate = upToDate
        self.currentVersion = currentVersion
        self.latestVersion = latestVersion
        self.htmlURL = htmlURL
        self.releaseNotes = releaseNotes
        self.publishedAt = publishedAt
        self.mode = mode
        self.error = error
    }

    /// `safeHref(updateStatus.html_url)`: the Release notes link, when it is a web URL.
    public var releaseNotesURL: URL? { PlannedLinks.safeURL(htmlURL) }

    /// `releaseNotesSummary(release_notes)`, empty when there are none.
    public var releaseSummary: String { ReleaseNotes.summary(releaseNotes) }
}

/// `normalizeVersionTag` and `compareVersions` of the Electron updater (semver §9 and §11).
public enum ReleaseVersion {
    /// A non-empty version with a leading `v`.
    public static func normalizeTag(_ version: String?) -> String {
        guard let version, !version.isEmpty else { return "" }
        let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.hasPrefix("v") ? trimmed : "v" + trimmed
    }

    /// -1, 0 or 1. Numeric cores compare part by part (a missing or unparsable part is 0); with
    /// equal cores a pre-release sorts before the release.
    public static func compare(_ a: String, _ b: String) -> Int {
        let (coreA, preA) = split(a)
        let (coreB, preB) = split(b)
        let partsA = coreA.split(separator: ".", omittingEmptySubsequences: false).map(intOrZero)
        let partsB = coreB.split(separator: ".", omittingEmptySubsequences: false).map(intOrZero)
        for index in 0..<max(partsA.count, partsB.count) {
            let x = index < partsA.count ? partsA[index] : 0
            let y = index < partsB.count ? partsB[index] : 0
            if x != y { return x > y ? 1 : -1 }
        }
        switch (preA, preB) {
        case (nil, nil): return 0
        case (.some, nil): return -1
        case (nil, .some): return 1
        case (.some(let x), .some(let y)): return comparePreRelease(x, y)
        }
    }

    /// `comparePreRelease`: dot-separated identifiers left to right; numeric ones numerically,
    /// numeric before alphanumeric, and a shorter equal prefix first.
    static func comparePreRelease(_ a: String, _ b: String) -> Int {
        let idsA = a.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        let idsB = b.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        for index in 0..<max(idsA.count, idsB.count) {
            guard index < idsA.count else { return -1 }
            guard index < idsB.count else { return 1 }
            let x = idsA[index]
            let y = idsB[index]
            let xNumeric = isDigits(x)
            let yNumeric = isDigits(y)
            if xNumeric && yNumeric {
                let dx = Int(x) ?? 0
                let dy = Int(y) ?? 0
                if dx != dy { return dx < dy ? -1 : 1 }
            } else if xNumeric != yNumeric {
                return xNumeric ? -1 : 1
            } else if x != y {
                return x < y ? -1 : 1
            }
        }
        return 0
    }

    private static func split(_ version: String) -> (core: String, pre: String?) {
        let text = version.hasPrefix("v") ? String(version.dropFirst()) : version
        guard let dash = text.firstIndex(of: "-") else { return (text, nil) }
        let pre = String(text[text.index(after: dash)...])
        return (String(text[..<dash]), pre.isEmpty ? nil : pre)
    }

    /// `parseInt(n, 10)`, with NaN as 0: the leading digits, after an optional sign.
    private static func intOrZero(_ part: Substring) -> Int {
        var digits = part.drop { $0.isWhitespace }
        var sign = 1
        if let first = digits.first, first == "+" || first == "-" {
            sign = first == "-" ? -1 : 1
            digits = digits.dropFirst()
        }
        let leading = digits.prefix { $0.isASCII && $0.isNumber }
        return (Int(leading) ?? 0) * sign
    }

    private static func isDigits(_ text: String) -> Bool {
        !text.isEmpty && text.allSatisfy { $0.isASCII && $0.isNumber }
    }
}

/// `releaseNotesSummary` (apps/frontend/src/lib/releaseNotes.ts): the release body as plain text
/// for the two clamped lines of the About update row.
public enum ReleaseNotes {
    public static func summary(_ markdown: String) -> String {
        markdown.components(separatedBy: "\n")
            .map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
            .filter { !matches($0, #"^\s*(?:#{1,6}\s|<!--)"#) }
            .map(plain)
            .filter { !$0.isEmpty && !$0.hasSuffix(":") }
            .joined(separator: " · ")
    }

    private static func plain(_ line: String) -> String {
        var text = line
        text = replace(text, #"!\[[^\]]*\]\([^)]*\)"#, "")
        text = replace(text, #"\[([^\]]*)\]\([^)]*\)"#, "$1")
        text = replace(text, #"\s+in\s+https?://\S+"#, "")
        text = replace(text, #"https?://\S+"#, "")
        text = replace(text, #"^\s*(?:>\s*)+"#, "")
        text = replace(text, #"^\s*(?:[-*+]|\d+[.)])\s+"#, "")
        text = replace(text, #"(\*\*|__)(.+?)\1"#, "$2")
        text = replace(text, #"(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)"#, "$1$2")
        text = replace(text, #"`([^`]*)`"#, "$1")
        text = replace(text, "[<>]", "")
        text = replace(text, #"\s+"#, " ")
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }

    private static func replace(_ text: String, _ pattern: String, _ template: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        let range = NSRange(text.startIndex..., in: text)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: template)
    }
}

/// `checkForShellUpdate`: the latest GitHub release against the running Vision version.
public struct NativeUpdateChecker: Sendable {
    public static let latestReleaseAPI = URL.literal("https://api.github.com/repos/EraPartner/Vision/releases/latest")
    /// The release page `openReleasePage` falls back to.
    public static let releasesPage = URL.literal("https://github.com/EraPartner/Vision/releases/latest")
    /// `GITHUB_FETCH_TIMEOUT_MS`.
    public static let fetchTimeout: TimeInterval = 30

    /// The running Vision version (the runtime payload's `appVersion`); `nil` reads as `v0.0.0`.
    public let currentVersion: String?
    /// The Demo variant never offers the real Vision release and skips the GitHub round trip.
    public let isDemo: Bool
    public let mode: NativeUpdateMode
    let fetchRelease: @Sendable () async throws -> JSONValue

    public init(
        currentVersion: String?, isDemo: Bool, mode: NativeUpdateMode = .source,
        fetchRelease: @escaping @Sendable () async throws -> JSONValue
    ) {
        self.currentVersion = currentVersion
        self.isDemo = isDemo
        self.mode = mode
        self.fetchRelease = fetchRelease
    }

    /// The GitHub API over `URLSession`, with the Electron updater's headers and deadline. Like
    /// the original, a non-200 body still parses and reads as "no release version".
    public static func live(currentVersion: String?, isDemo: Bool, appName: String) -> NativeUpdateChecker {
        let agent = "\(appName)-desktop/\(currentVersion ?? "0.0.0")"
        return NativeUpdateChecker(currentVersion: currentVersion, isDemo: isDemo) {
            var request = URLRequest(url: latestReleaseAPI, timeoutInterval: fetchTimeout)
            request.setValue(agent, forHTTPHeaderField: "User-Agent")
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            let (data, _) = try await URLSession.shared.data(for: request)
            return try JSONValue.parse(data)
        }
    }

    public func check() async throws -> NativeUpdateStatus {
        let current = ReleaseVersion.normalizeTag(currentVersion ?? "0.0.0")
        if isDemo {
            return NativeUpdateStatus(upToDate: true, currentVersion: current, latestVersion: nil, mode: mode)
        }
        let release = try await fetchRelease()
        let latest = ReleaseVersion.normalizeTag(release["tag_name"]?.stringValue)
        guard !latest.isEmpty else {
            return NativeUpdateStatus(
                upToDate: true, currentVersion: current, latestVersion: nil, mode: mode,
                error: "Could not determine latest release version.")
        }
        return NativeUpdateStatus(
            upToDate: ReleaseVersion.compare(latest, current) <= 0, currentVersion: current, latestVersion: latest,
            htmlURL: release["html_url"]?.stringValue, releaseNotes: release["body"]?.stringValue ?? "",
            publishedAt: release["published_at"]?.stringValue, mode: mode)
    }

    /// `openReleasePage`: only an `https://github.com/` URL from the release is opened, else the
    /// canonical releases page.
    public static func releasePage(_ htmlURL: String?) -> URL {
        guard let htmlURL, htmlURL.lowercased().hasPrefix("https://github.com/"), let url = URL(string: htmlURL)
        else { return releasesPage }
        return url
    }
}

/// `update:pre-update-backup`: `{ success, ...result }` or `{ success: false, error }`.
public struct NativePreUpdateBackupResult: Equatable, Sendable {
    public let success: Bool
    public let error: String?
    public init(success: Bool, error: String? = nil) {
        self.success = success
        self.error = error
    }
}

/// The shared update state (`useUpdateStatus`, ADR-180): polled every five minutes while the
/// window is active and the user is present, read by the sidebar's Settings dot and the About
/// section, which also checks on demand and applies the update.
@MainActor @Observable public final class NativeUpdateModel {
    /// `CHECK_INTERVAL_MS`: the poll interval and how long a status stays fresh.
    public static let checkInterval: TimeInterval = 5 * 60

    /// `ApplyPhase` of the About section.
    public enum ApplyPhase: Equatable, Sendable {
        case idle
        case backingUp
        case downloading
        case restarting
        case done
    }

    public private(set) var status: NativeUpdateStatus?
    public private(set) var isChecking = false
    public private(set) var applyPhase: ApplyPhase = .idle
    public var isApplying: Bool { applyPhase != .idle && applyPhase != .done }
    /// `updateReady`: a status is known and it is not up to date.
    public var isUpdateReady: Bool { status.map { !$0.upToDate } ?? false }

    /// Toasts (`toast.success/info/error`), as `ScreenNotice`s.
    public var didNotice: (@MainActor (ScreenNotice) -> Void)?
    public var openURL: (@MainActor (URL) -> Void)?
    /// `apiClient.preUpdateBackup()`; `nil` skips the backup.
    public var preUpdateBackup: (@MainActor () async -> NativePreUpdateBackupResult)?

    @ObservationIgnored private let checker: NativeUpdateChecker
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var readAt: Date?
    @ObservationIgnored private var lastFailed = false
    @ObservationIgnored private var noticeID = 0

    public init(checker: NativeUpdateChecker, now: @escaping @Sendable () -> Date = { Date() }) {
        self.checker = checker
        self.now = now
    }

    /// The poll: re-reads a stale status, then every five minutes. A failed read stops the
    /// interval (`refetchInterval` is false after an error) until the window is active again.
    public func run() async {
        while !Task.isCancelled {
            await refreshIfStale()
            if lastFailed { return }
            try? await Task.sleep(for: .seconds(Self.checkInterval))
        }
    }

    /// `staleTime`: reads only when there is no status yet or it is older than the interval.
    public func refreshIfStale() async {
        if let readAt, !lastFailed, now().timeIntervalSince(readAt) < Self.checkInterval { return }
        await refresh()
    }

    /// One read; a failure keeps the last status, as a query keeps its data.
    public func refresh() async {
        readAt = now()
        do {
            status = try await checker.check()
            lastFailed = false
        } catch {
            lastFailed = true
        }
    }

    /// `handleCheckForUpdates`.
    public func checkNow() async {
        guard !isChecking else { return }
        isChecking = true
        defer { isChecking = false }
        readAt = now()
        do {
            let result = try await checker.check()
            status = result
            lastFailed = false
            if result.upToDate {
                notice(.success, "settings.app.upToDate")
            } else {
                notice(.info, "settings.app.updateAvailable", suffix: result.latestVersion ?? "")
            }
        } catch {
            lastFailed = true
            notice(.error, "settings.app.updateFailed")
        }
    }

    /// `handleApplyUpdate`: the pre-update backup, then the install. In `source` mode there is
    /// nothing to install: the release page opens and the user updates by hand.
    public func apply() async {
        guard !isApplying else { return }
        if let preUpdateBackup {
            applyPhase = .backingUp
            let backup = await preUpdateBackup()
            guard backup.success else {
                notice(.error, "update.backupFailed", detail: backup.error)
                applyPhase = .idle
                return
            }
        }
        // `installShellUpdate` answers `manual_download` in `source` mode, and no release carries
        // a Swift app ZIP to install in `native` mode either (see NativeUpdateMode).
        applyPhase = .downloading
        openURL?(NativeUpdateChecker.releasePage(status?.htmlURL))
        notice(.info, "update.manualDownload")
        applyPhase = .idle
    }

    private func notice(
        _ kind: ScreenNotice.Kind, _ key: String, suffix: String? = nil, detail: String? = nil
    ) {
        noticeID += 1
        var variables: [String: String] = [:]
        if let suffix { variables[ScreenNotice.titleSuffixVariable] = suffix }
        didNotice?(ScreenNotice(id: noticeID, kind: kind, key: key, variables: variables, detail: detail))
    }
}
