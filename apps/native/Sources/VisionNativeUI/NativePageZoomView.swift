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
                .clipped()
        }
    }
}
