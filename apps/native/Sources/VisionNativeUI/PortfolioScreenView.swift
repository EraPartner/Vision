import SwiftUI
import VisionNativeCore

/// One presentation owner keeps the detail dialog open while its child editor is shown.
struct PortfolioScreenView: View {
    let screens: PortfolioScreens
    let shell: NativeShellModel
    var page: PortfolioHoldingsPage? = nil
    @State private var connectivity = PortfolioConnectivity()
    private var guardId: String {  // lint:allow raw-id leave-guard route key, not an API entity
        page.map(\.path) ?? "/portfolio"
    }
    var body: some View {
        Group {
            if let page {
                PortfolioHoldingsView(model: screens.model, editing: screens.editing, shell: shell, page: page)
                    .id(page)
            } else {
                PortfolioOverviewView(model: screens.model, editing: screens.editing, shell: shell)
            }
        }
        .task(id: "\(shell.settingsRevision)|\(shell.strings.language.rawValue)") {
            screens.editing.configure(settings: shell.settings, strings: shell.strings)
        }
        .task(id: screens.dataRevision) {
            await screens.model.load(currency: shell.settings.portfolioCurrency, route: shell.route)
        }
        .onAppear {
            connectivity.start { screens.model.isOnline = $0 }
            shell.setLeaveGuard(
                NativeLeaveGuard(
                    id: guardId, hasUnsavedChanges: { screens.editing.hasUnsavedChanges },
                    discard: { screens.editing.discardDrafts() }))
        }
        .onDisappear {
            connectivity.stop()
            shell.removeLeaveGuard(id: guardId)
        }
        .onChange(of: screens.model.transactions) { _, rows in screens.editing.bindTransactions(rows) }
        .onChange(of: screens.model.investments) { _, rows in screens.editing.bindInvestments(rows) }
        .visionDialog(
            isPresented: Binding(
                get: { screens.model.selectedInvestmentId != nil }, set: { if !$0 { screens.model.closeDetail() } }),
            metrics: PortfolioDetailSheet.metrics,
            accessibilityTitle: screens.model.selectedInvestment?.name
        ) {
            PortfolioDetailSheet(model: screens.model, editing: screens.editing, shell: shell)
        }
        .visionDialog(
            isPresented: Binding(
                get: { screens.editing.classification.isPresented },
                set: { if !$0 { screens.editing.classification.close() } }),
            metrics: VisionDialogMetrics(maxWidth: nil, padding: 0, spacing: 0),
            accessibilityTitle: shell.strings.t("portfolio.classify.title")
        ) {
            PortfolioClassifySheet(
                model: screens.editing.classification, editing: screens.editing, portfolio: screens.model,
                shell: shell)
        }
        // Applied after the detail dialog so the editor and its confirmation open over it: in-window
        // dialogs cannot nest inside another dialog's panel.
        .portfolioEditingPresentation(model: screens.editing, shell: shell)
        .overlay(alignment: .bottom) { PortfolioPriceRefreshToast(model: screens.model, shell: shell) }
    }
}
