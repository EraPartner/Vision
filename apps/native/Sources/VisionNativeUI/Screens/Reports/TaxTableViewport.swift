import SwiftUI

/// Printer pages render the complete table rather than a clipped horizontal viewport.
struct TaxTableViewport<Content: View>: View {
    let isPrinting: Bool
    @ViewBuilder let content: () -> Content
    var body: some View {
        if isPrinting {
            content()
        } else {
            ScrollView(.horizontal) { content() }
        }
    }
}
