import AppKit
import SwiftUI

/// Hosts frozen SwiftUI print content. NSHostingView renders through its layer
/// tree, which NSPrintOperation does not capture, so printed and PDF output stayed
/// blank. Outside the screen this draws the same root view as vector content via
/// ImageRenderer; layout, measurement and on-screen display are NSHostingView's own.
@MainActor
public final class NativePrintHostingView<Content: View>: NSHostingView<Content> {
    public override func draw(_ dirtyRect: NSRect) {
        guard !NSGraphicsContext.currentContextDrawingToScreen(),
            let context = NSGraphicsContext.current?.cgContext,
            bounds.width > 0, bounds.height > 0
        else {
            super.draw(dirtyRect)
            return
        }
        let size = bounds.size
        let renderer = ImageRenderer(
            content: rootView.frame(width: size.width, height: size.height, alignment: .topLeading)
                .environment(\.colorScheme, .light))
        renderer.proposedSize = ProposedViewSize(size)
        renderer.render { _, draw in
            context.saveGState()
            // ImageRenderer draws in an unflipped space whose origin is the bottom-left corner.
            if isFlipped {
                context.translateBy(x: 0, y: size.height)
                context.scaleBy(x: 1, y: -1)
            }
            draw(context)
            context.restoreGState()
        }
    }
}
