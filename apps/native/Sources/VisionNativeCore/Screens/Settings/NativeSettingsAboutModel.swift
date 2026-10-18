import Foundation
import Observation

@MainActor @Observable public final class NativeSettingsAboutModel {
    public static let repositoryURL = URL(string: "https://github.com/EraPartner/Vision")!
    public static let documentationURL = URL(string: "https://github.com/EraPartner/Vision/tree/main/docs")!
    public let appName: String
    public let version: String?
    public let license = "AGPL-3.0-only"
    public private(set) var restartingOnboarding = false
    public private(set) var notices: [ScreenNotice] = []
    public var onRestartOnboarding: (@MainActor () async throws -> Void)?
    public var onOpenExternal: (@MainActor (URL) -> Void)?
    public var didNotice: (@MainActor (ScreenNotice) -> Void)?
    public var usesExternalNotices: Bool { didNotice != nil }
    @ObservationIgnored private let service: any NativeSettingsDesktopService
    @ObservationIgnored private let reloadDelay: Duration
    @ObservationIgnored private var noticeID = 0
    public init(
        service: any NativeSettingsDesktopService, version: String?, appName: String = "Vision",
        reloadDelay: Duration = .milliseconds(500)
    ) {
        self.service = service
        self.version = version
        self.appName = appName
        self.reloadDelay = reloadDelay
    }
    public func openSource() { onOpenExternal?(Self.repositoryURL) }
    public func openDocumentation() { onOpenExternal?(Self.documentationURL) }
    public func restartOnboarding() async {
        guard !restartingOnboarding else { return }
        restartingOnboarding = true
        defer { restartingOnboarding = false }
        do {
            guard let onRestartOnboarding else { throw APIError.backendUnavailable }
            try await onRestartOnboarding()
            enqueue("settings.app.onboardingRestarted")
            // Closing Settings is part of restart; the delayed reload must survive that close.
            Task { [service, reloadDelay] in
                do {
                    try await Task.sleep(for: reloadDelay)
                    try await service.reloadFrontend()
                } catch {}
            }
        } catch { enqueue("onboarding.persist.failed", kind: .error, detail: error.localizedDescription) }
    }
    private func enqueue(_ key: String, kind: ScreenNotice.Kind = .success, detail: String? = nil) {
        noticeID += 1
        let notice = ScreenNotice(id: noticeID, kind: kind, key: key, detail: detail)
        if let didNotice { didNotice(notice) } else { notices.append(notice) }
    }
    public func clearNotice(_ id: Int) { notices.removeAll { $0.id == id } }
}
