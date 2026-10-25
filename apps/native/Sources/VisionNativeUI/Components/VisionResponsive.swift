import SwiftUI
import VisionNativeCore

// `VisionBreakpoint` lives in VisionResponsiveColumns.swift.

/// `grid grid-cols-1 items-start gap-6 lg:grid-cols-2 lg:[&>*:only-child]:col-span-2`: the
/// children share the width in `columns` equal columns, top aligned, and a row is as tall as its
/// tallest child. A single child takes the whole width. Below the breakpoint, or in one column,
/// they stack.
struct VisionGridLayout: Layout {
    var columns: Int
    var spacing: CGFloat

    private struct Plan {
        var frames: [CGRect]
        var size: CGSize
    }

    private func plan(width: CGFloat, subviews: Subviews) -> Plan {
        let count = subviews.count
        guard count > 0 else { return Plan(frames: [], size: CGSize(width: width, height: 0)) }
        let perRow = count == 1 ? 1 : max(1, columns)
        let columnWidth = max(0, (width - spacing * CGFloat(perRow - 1)) / CGFloat(perRow))
        var frames: [CGRect] = []
        var originY: CGFloat = 0
        var index = 0
        while index < count {
            let row = Array(subviews[index..<min(index + perRow, count)])
            let heights = row.map { $0.sizeThatFits(ProposedViewSize(width: columnWidth, height: nil)).height }
            for (offset, height) in heights.enumerated() {
                frames.append(
                    CGRect(
                        x: CGFloat(offset) * (columnWidth + spacing), y: originY, width: columnWidth, height: height))
            }
            originY += (heights.max() ?? 0) + spacing
            index += perRow
        }
        return Plan(frames: frames, size: CGSize(width: width, height: max(0, originY - spacing)))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 0
        return plan(width: width, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let layout = plan(width: bounds.width, subviews: subviews)
        for (subview, frame) in zip(subviews, layout.frames) {
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(width: frame.width, height: frame.height))
        }
    }
}

/// Hands its content whether the window is at least `breakpoint` wide. The window width is read
/// from where the view ends in the window, so the sidebar counts, as the viewport does on the web.
/// Until it is measured the window is assumed wide.
struct VisionBreakpointReader<Content: View>: View {
    var breakpoint = VisionBreakpoint.lg
    @ViewBuilder var content: (Bool) -> Content
    @State private var wide = true

    var body: some View {
        content(wide)
            .onGeometryChange(for: Bool.self) { proxy in
                proxy.frame(in: .global).maxX >= breakpoint
            } action: { isWide in
                wide = isWide
            }
    }
}

/// A responsive grid: `columns` equal columns from the window width `breakpoint` up, one column
/// below it.
struct VisionResponsiveGrid<Content: View>: View {
    var columns = 2
    var breakpoint = VisionBreakpoint.lg
    var spacing: CGFloat = 24
    @ViewBuilder var content: () -> Content

    var body: some View {
        VisionBreakpointReader(breakpoint: breakpoint) { wide in
            VisionGridLayout(columns: wide ? columns : 1, spacing: spacing) {
                content()
            }
        }
    }
}
