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
    @Test func settingsRailRowsAre42PointsTall() {
        #expect(NativeSettingsWindow.Layout.railRowHeight == 42)
    }
}
