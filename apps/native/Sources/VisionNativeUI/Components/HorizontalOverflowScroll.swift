import SwiftUI

/// The web `<Table>` wrapper (`relative w-full overflow-auto`): the table fills the width it is
/// offered and, when its content is wider (a narrow window), keeps its content width and
/// scrolls sideways instead of squeezing its cells into piled-up lines.
///
/// A plain `ScrollView(.horizontal)` proposes no width, so its content would stop filling the
/// card; this layout proposes the larger of the offered width and the content's own width.
struct HorizontalOverflowScroll<Content: View>: View {
    @ViewBuilder var content: () -> Content
    @State private var availableWidth: CGFloat?

    var body: some View {
        ScrollView(.horizontal) {
            HorizontalOverflowLayout(availableWidth: availableWidth) { content() }
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            if availableWidth != width { availableWidth = width }
        }
    }
}

/// Lays its one child out at `max(offered width, the child's ideal width)`.
struct HorizontalOverflowLayout: Layout {
    var availableWidth: CGFloat?

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let width = width(proposal: proposal, child: child)
        return CGSize(width: width, height: child.sizeThatFits(ProposedViewSize(width: width, height: nil)).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        child.place(
            at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(width: bounds.width, height: nil))
    }

    private func width(proposal: ProposedViewSize, child: LayoutSubview) -> CGFloat {
        let ideal = child.sizeThatFits(.unspecified).width
        let offered = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? availableWidth ?? ideal
        return max(offered, ideal)
    }
}
