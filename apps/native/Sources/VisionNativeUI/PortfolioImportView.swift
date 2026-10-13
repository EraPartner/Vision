import SwiftUI
import VisionNativeCore

public struct PortfolioImportView: View {
    let screens: PortfolioImportScreens
    let shell: NativeShellModel
    @State private var historyOpen = false
    @Environment(\.visionTheme) private var theme
    public init(screens: PortfolioImportScreens, shell: NativeShellModel) {
        self.screens = screens
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private var route: String { "/portfolio/import" }
    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VisionPageHeader(
                    title: strings.t("portfolioImport.title"), subtitle: strings.t("portfolioImport.desc"),
                    symbol: "tray.and.arrow.down")
                PortfolioImportHistoryView(
                    model: screens.history, shell: shell, expanded: $historyOpen,
                    isLocked: screens.session.locked || screens.advanced.isBusy)
                PortfolioImportSessionView(
                    model: screens.session, shell: shell,
                    isLocked: screens.advanced.isBusy || screens.history.isBusy,
                    onReviewHistory: {
                        historyOpen = true
                        Task { await screens.history.load(offset: 0, force: true) }
                    },
                    onRecover: {
                        historyOpen = true
                        await screens.history.load(offset: 0, force: true)
                        if screens.history.error == nil { screens.session.acknowledgeUncertainOutcome() }
                    })
                PortfolioImportAdvancedView(
                    model: screens.advanced, shell: shell,
                    isLocked: screens.session.locked || screens.history.isBusy,
                    onReviewHistory: {
                        historyOpen = true
                        Task { await screens.history.load(offset: 0, force: true) }
                    })
            }.padding(24).frame(maxWidth: 1360, alignment: .leading).frame(maxWidth: .infinity)
        }
        .task { await screens.load() }
        .onAppear {
            screens.history.disabled = screens.session.locked || screens.advanced.isBusy
            screens.navigateToReview = { id in
                // A verified upload receipt opens its review without discarding the staged batch.
                screens.advanced.discardDrafts()
                shell.removeLeaveGuard(id: route)
                shell.navigate(to: "/portfolio/import/\(id)/review")
            }
            shell.setLeaveGuard(
                NativeLeaveGuard(
                    id: route,
                    hasUnsavedChanges: { screens.isDirty || screens.isBusy },
                    discard: { screens.discardDrafts() }))
        }
        .onDisappear {
            screens.navigateToReview = nil
            shell.removeLeaveGuard(id: route)
            screens.session.stop()
        }
        .onChange(of: screens.session.operation) { _, _ in updateHistoryLock() }
        .onChange(of: screens.advanced.isBusy) { _, _ in updateHistoryLock() }
    }
    private func updateHistoryLock() {
        screens.history.disabled = screens.session.locked || screens.advanced.isBusy
    }
}
