import AppKit
import SwiftUI
import Testing
import VisionNativeCore

@testable import VisionNativeUI

struct NativeOverlayMetricsTests {
    @Test func sideSheetMetricsFollowTheWebOverrides() {
        let standard = VisionDialogMetrics.sideSheet
        #expect(standard.maxWidth == 384)
        #expect(standard.sideWidthFraction == 0.75)
        #expect(standard.padding == CGFloat(DesignTokens.Overlay.dialogPadding))
        #expect(standard.spacing == 16)
        #expect(standard.sideEdge == .trailing)
        // `w-full sm:max-w-[470px] p-0 gap-0`
        let form = VisionDialogMetrics.sideSheet(maxWidth: 470)
        #expect(form.maxWidth == 470)
        #expect(form.sideWidthFraction == 1)
        #expect(form.padding == 0)
        #expect(form.spacing == 0)
        // `side="left" w-72 p-0`
        #expect(VisionDialogMetrics.sideSheet(maxWidth: 288, edge: .leading).sideEdge == .leading)
    }
    @Test func commandPaletteFitsItsContentInTheDefaultDialogWidth() {
        let palette = NativeShellOverlayHost.metrics(for: .palette)
        #expect(palette.maxWidth == CGFloat(DesignTokens.Overlay.dialogMaxWidth))
        #expect(palette.height == .fitContent)
        #expect(palette.padding == 0)
    }
    @Test func contentSizedDialogsTakeTheContentSizeUpToTheWindowAllowance() {
        let limit = CGSize(width: 1052, height: 684)
        let fits = VisionDialogFit.size(ideal: CGSize(width: 448, height: 300), heightAtWidth: { _ in 300 }, limit: limit)
        #expect(fits == CGSize(width: 448, height: 300))
        let tall = VisionDialogFit.size(ideal: CGSize(width: 896, height: 900), heightAtWidth: { _ in 900 }, limit: limit)
        #expect(tall == CGSize(width: 896, height: 684))
        // Unbounded ideal sizes (a flexible frame without an ideal) stop at the allowance.
        let flexible = VisionDialogFit.size(
            ideal: CGSize(width: CGFloat.infinity, height: 200), heightAtWidth: { _ in .infinity }, limit: limit)
        #expect(flexible == limit)
    }

    /// The panel hugs its content: no band of empty glass around a short body (the chart
    /// builder, Customize and Mark as filed dialogs were 90 % of the window tall), and a long
    /// body stops at the window allowance with its preferred height given up.
    @MainActor @Test func contentSizedPanelsHugTheirContent() {
        let available = CGSize(width: 1100, height: 760)
        let metrics = VisionDialogMetrics(maxWidth: nil, padding: 0, spacing: 0)
        func panelSize<Content: View>(_ content: Content) -> CGSize {
            let host = NSHostingView(rootView: VisionGlassDialog(metrics: metrics, available: available) { content })
            host.frame = NSRect(origin: .zero, size: available)
            host.layoutSubtreeIfNeeded()
            return host.fittingSize
        }
        let short = panelSize(Color.clear.frame(width: 448, height: 300))
        #expect(abs(short.width - 448) <= 1 && abs(short.height - 300) <= 1)
        let allowance = (available.height * CGFloat(DesignTokens.Overlay.dialogMaxHeightFraction)).rounded()
        let tall = panelSize(Color.clear.visionDialogFrame(width: 760, height: 1200))
        #expect(abs(tall.width - 760) <= 1)
        #expect(abs(tall.height - allowance) <= 1)
    }

    @Test func settingsRailRowsAre42PointsTall() {
        #expect(NativeSettingsWindow.Layout.railRowHeight == 42)
    }
}
