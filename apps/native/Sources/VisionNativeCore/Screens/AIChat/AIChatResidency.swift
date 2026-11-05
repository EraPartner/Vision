import Foundation

/// `APPLE_FOUNDATION_MODEL` in packages/types/src/aiChat.ts (ADR-246): the on-device model has no
/// residency or memory fit.
public let appleFoundationModel = "apple-foundation"

/// `useModelResidency` (apps/frontend/src/hooks/useModelResidency.ts, ADR-248): keep the chat model
/// loaded while the AI page is open and let it go when the page is left or the model changes.
/// Warms 2 s after the model is first known, re-warms every 4 minutes while the app is in the
/// foreground (one loop), and releases the previous model when the target changes or `stop()` runs.
/// Does nothing for the Apple Foundation model, a missing model or an unreachable Ollama.
/// Every call is a best-effort hint: the backend answers 204 even when it cannot act.
@MainActor public final class AIChatResidency {
    /// `WARM_DELAY_MS`.
    public static let warmDelay: Duration = .seconds(2)
    /// `WARM_REFRESH_MS`, under the backend's 10-minute keep_alive.
    public static let refreshInterval: Duration = .seconds(4 * 60)
    /// The `document.visibilityState === "visible"` check of the refresh tick.
    public var isForeground = true
    /// The model currently kept resident (or about to be), or nil.
    public private(set) var target: String?
    private let service: any AIChatService
    private let sleep: @Sendable (Duration) async throws -> Void
    private var loop: Task<Void, Never>?
    private var warmed = false
    public init(
        service: any AIChatService,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.service = service
        self.sleep = sleep
    }
    /// The effect's dependencies are `[model, ollamaOk]`: an unchanged target does nothing.
    public func update(model: String?, ollamaOK: Bool) {
        let next: String? = ollamaOK && model != nil && model != appleFoundationModel ? model : nil
        guard next != target else { return }
        stop()
        guard let next else { return }
        target = next
        let sleep = sleep
        loop = Task { [weak self] in
            do { try await sleep(Self.warmDelay) } catch { return }
            guard let self, !Task.isCancelled else { return }
            self.warm(next)
            while !Task.isCancelled {
                do { try await sleep(Self.refreshInterval) } catch { return }
                guard !Task.isCancelled else { return }
                if self.isForeground { self.warm(next) }
            }
        }
    }
    /// The effect cleanup: stop the timers and, when this page warmed the model, release it.
    /// Releasing a model this page never warmed could only load it.
    public func stop() {
        loop?.cancel()
        loop = nil
        if warmed, let model = target {
            let service = service
            Task { try? await service.chatRelease(model: model) }
        }
        warmed = false
        target = nil
    }
    private func warm(_ model: String) {
        warmed = true
        let service = service
        Task { try? await service.chatWarm(model: model) }
    }
}
