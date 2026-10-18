import Foundation
import Observation

/// The toasts of the Import & export and Review import pages, shared like the web's one
/// Sonner toaster: a toast the review page posts on Commit or Discard is still up on
/// `/import` after the navigation. Up to three show at once, newest last.
@MainActor
@Observable
public final class ImportNoticeCenter {
    /// The default toast duration.
    public nonisolated static let defaultDuration: Duration = .seconds(4)
    /// How many toasts stack at once (Sonner's `visibleToasts`).
    public nonisolated static let maximumShown = 3

    /// A toast's action button: its label, the route it opens and how long the toast stays.
    public struct Action: Equatable, Sendable {
        public let titleKey: String
        public let route: String
        public let duration: Duration

        public init(titleKey: String, route: String, duration: Duration) {
            self.titleKey = titleKey
            self.route = route
            self.duration = duration
        }
    }

    public private(set) var notices: [ScreenNotice] = []
    public private(set) var actions: [Int: Action] = [:]
    @ObservationIgnored private var counter = NoticeCounter()

    public init() {}

    /// The newest toast.
    public var latest: ScreenNotice? { notices.last }

    @discardableResult
    public func post(
        _ kind: ScreenNotice.Kind, _ key: String, _ variables: [String: String] = [:], detail: String? = nil,
        action: Action? = nil
    ) -> ScreenNotice {
        let notice = counter.make(kind, key, variables, detail: detail)
        notices.append(notice)
        if let action { actions[notice.id] = action }
        while notices.count > Self.maximumShown {
            let dropped = notices.removeFirst()
            actions[dropped.id] = nil
        }
        return notice
    }

    /// The toast timed out or its action ran.
    public func clear(_ id: Int) {
        notices.removeAll { $0.id == id }
        actions[id] = nil
    }

    public func action(for id: Int) -> Action? {
        actions[id]
    }

    public func duration(of notice: ScreenNotice) -> Duration {
        actions[notice.id]?.duration ?? Self.defaultDuration
    }
}
