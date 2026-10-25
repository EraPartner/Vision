import SwiftUI
import VisionNativeCore

/// Tailwind's window-width breakpoints (`sm` 640, `md` 768, `lg` 1024, `xl` 1280). The web
/// compares them with the viewport; native pages compare them with their page width (the
/// detail column), the same convention `TransactionsModel.dockedInspectorWidth` uses.
enum VisionBreakpoint {
    static let sm: CGFloat = 640
    static let md: CGFloat = 768
    static let lg: CGFloat = 1024
    static let xl: CGFloat = 1280
}

/// A CSS grid of weighted columns that collapses to one column below a breakpoint:
/// `grid gap-6 lg:grid-cols-3` with `lg:col-span-2` on the first child is `weights: [2, 1]`;
/// `lg:grid-cols-2` is `[1, 1]`. A lone child spans every column
/// (`lg:[&>*:only-child]:col-span-N`). The breakpoint is compared with the width this layout
/// is given plus the page padding, which is the page width.
struct VisionResponsiveColumns: Layout {
    var weights: [Int]
    var minimumPageWidth: CGFloat = VisionBreakpoint.lg
    var spacing: CGFloat = 24

    private func isWide(_ width: CGFloat, count: Int) -> Bool {
        count > 1 && weights.count > 1 && width + 2 * VisionPageLayout.padding >= minimumPageWidth
    }

    private func plan(width: CGFloat, subviews: Subviews) -> (frames: [CGRect], height: CGFloat) {
        guard !subviews.isEmpty else { return ([], 0) }
        var frames: [CGRect] = []
        var y: CGFloat = 0
        if !isWide(width, count: subviews.count) {
            for (index, subview) in subviews.enumerated() {
                let height = subview.sizeThatFits(ProposedViewSize(width: width, height: nil)).height
                if index > 0 { y += spacing }
                frames.append(CGRect(x: 0, y: y, width: width, height: height))
                y += height
            }
            return (frames, y)
        }
        let columns = weights.count
        let units = CGFloat(weights.reduce(0, +))
        let unit = (width - spacing * (units - 1)) / units
        var index = 0
        while index < subviews.count {
            let row = Array(index..<min(index + columns, subviews.count))
            if index > 0 { y += spacing }
            var x: CGFloat = 0
            var rowHeight: CGFloat = 0
            for (column, item) in row.enumerated() {
                let weight = CGFloat(weights[column])
                let itemWidth = weight * unit + (weight - 1) * spacing
                let height = subviews[item].sizeThatFits(ProposedViewSize(width: itemWidth, height: nil)).height
                frames.append(CGRect(x: x, y: y, width: itemWidth, height: height))
                rowHeight = max(rowHeight, height)
                x += itemWidth + spacing
            }
            y += rowHeight
            index += columns
        }
        return (frames, y)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 0
        return CGSize(width: width, height: plan(width: width, subviews: subviews).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let layout = plan(width: bounds.width, subviews: subviews)
        for (index, subview) in subviews.enumerated() {
            let frame = layout.frames[index]
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), anchor: .topLeading,
                proposal: ProposedViewSize(width: frame.width, height: frame.height))
        }
    }
}

extension View {
    /// A tinted inset panel inside a card: `rounded-card bg-foreground/[0.04] p-4`, optionally
    /// bordered (`border border-border/60`).
    func visionInsetPanel(
        padding: CGFloat = 16, cornerRadius: CGFloat = DesignTokens.Radius.card, bordered: Bool = false
    ) -> some View {
        modifier(VisionInsetPanel(padding: padding, cornerRadius: cornerRadius, bordered: bordered))
    }
}

private struct VisionInsetPanel: ViewModifier {
    let padding: CGFloat
    let cornerRadius: CGFloat
    let bordered: Bool
    @Environment(\.visionTheme) private var theme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.foreground.opacity(0.04), in: shape)
            .overlay { if bordered { shape.strokeBorder(theme.border.opacity(0.6), lineWidth: 1) } }
    }
}

extension View {
    /// The web `<List>` surface: `divide-y divide-border/50 overflow-hidden rounded-card border
    /// border-border/60 bg-card/70`. Rows are separated with `VisionListDivider`.
    func visionListSurface() -> some View {
        modifier(VisionListSurface())
    }
}

/// The hairline between `List` rows (`divide-border/50`).
struct VisionListDivider: View {
    @Environment(\.visionTheme) private var theme

    var body: some View {
        Rectangle().fill(theme.border.opacity(0.5)).frame(height: 1)
    }
}

private struct VisionListSurface: ViewModifier {
    @Environment(\.visionTheme) private var theme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
        content
            .background(theme.card.opacity(0.7), in: shape)
            .clipShape(shape)
            .overlay(shape.strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
    }
}
