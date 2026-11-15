import SwiftUI
import VisionNativeCore

/// Lay out the detail at its logical size, then scale it into the same viewport.
/// Keeping the wrapper mounted preserves screen visits and drafts during zoom changes.
struct NativePageZoomView<Content: View>: View {
    private let factor: CGFloat
    private let content: Content
    init(factor: Double, @ViewBuilder content: () -> Content) {
        self.factor = CGFloat(factor.isFinite ? min(PageZoom.maximumFactor, max(PageZoom.minimumFactor, factor)) : 1)
        self.content = content()
    }
    var body: some View {
        GeometryReader { geometry in
            content
                .frame(
                    width: max(1, geometry.size.width / factor), height: max(1, geometry.size.height / factor),
                    alignment: .topLeading
                )
                .scaleEffect(factor, anchor: .topLeading)
                .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
                // Clips the zoomed page's overflow on the right and at the bottom only. The page's
                // frame starts below the titlebar strip, and a page's dialog layer and side sheet
                // run up under that strip to the window's top edge (the web overlay is `fixed
                // inset-0`); a plain `clipped()` cut them off there, leaving an unscrimmed band
                // across the top with the sheet starting below it.
                .clipShape(PageZoomClip())
        }
    }
}

/// The viewport's rectangle, open 400 pt upward (as `ColumnSidewaysClip` is): a rectangular clip,
/// not a mask, so the page is not composited offscreen.
struct PageZoomClip: Shape {
    func path(in rect: CGRect) -> Path {
        Path(CGRect(x: rect.minX, y: rect.minY - 400, width: rect.width, height: rect.height + 400))
    }
}
