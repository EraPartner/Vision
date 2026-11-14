import SwiftUI

/// A table that fills its card and scrolls sideways only when it is wider than the card
/// (`<div class="overflow-x-auto"><table class="w-full">`). Inside a horizontal scroll view a
/// table is never offered the card's width, so it sat at its content width against the leading
/// edge; `ViewThatFits` lays the table out at the card's width whenever its content fits.
/// Printer pages render the complete table rather than a clipped horizontal viewport.
struct TaxTableViewport<Content: View>: View {
    let isPrinting: Bool
    @ViewBuilder let content: () -> Content
    var body: some View {
        if isPrinting {
            content()
        } else {
            ViewThatFits(in: .horizontal) {
                content().frame(maxWidth: .infinity, alignment: .leading)
                ScrollView(.horizontal) { content() }
            }
        }
    }
}
