import SwiftUI
import VisionNativeCore

/// The web `<Table>` (`components/ui/table.tsx`: `w-full`, automatic table layout) as a layout.
///
/// A SwiftUI `Grid` sizes every column to its content, so a table in a wide card sat packed
/// against the leading edge. This layout fills the width it is offered, as `w-full` does: each
/// column starts at the widest of its cells and the room left over is shared between the
/// columns in proportion to those widths (CSS automatic table layout). When the content is
/// wider than the card the columns keep their content widths and the table scrolls sideways
/// inside its card, as the web `<Table>`'s `overflow-auto` wrapper does: cells never squeeze
/// into piled-up lines.
///
/// The cells are the layout's direct children in row order, one per column. A child marked
/// with `visionTableSpan()` takes a whole row (a divider, an expanded detail row, an empty
/// state).
///
///     VisionTable(columns: [.leading, .trailing]) {
///         Text("Currency")
///         Text("Rate")
///         ForEach(rows) { row in
///             Divider().visionTableSpan()
///             Text(row.currency)
///             Text(row.rate)
///         }
///     }
struct VisionTable<Content: View>: View {
    /// The horizontal alignment of each column's cells; its count is the column count.
    let columns: [HorizontalAlignment]
    /// The gap between two columns (the two `px-4` paddings that meet there are 32 pt on the
    /// web; the native tables keep the 16 pt they were drawn with unless a table asks).
    var columnSpacing: CGFloat = 16
    /// A column that keeps its content width instead of taking a share of the spare room
    /// (`w-24`, an actions column).
    var fixedColumns: Set<Int> = []
    /// `TableRow`'s `hover:bg-foreground/[0.03]` band under the pointer's row.
    var rowHover = true
    @ViewBuilder var content: () -> Content
    /// The hovered row. Only the band reads it, so a pointer moving over the table redraws the
    /// band and never re-runs this body, the cells or the table layout.
    @State private var hover = VisionTableHover()
    /// The width the table is offered: the scroll view proposes no width to its content.
    @State private var availableWidth: CGFloat?

    var body: some View {
        ScrollView(.horizontal) {
            table
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            if availableWidth != width { availableWidth = width }
        }
    }

    @ViewBuilder
    private var table: some View {
        let layout = VisionTableLayout(
            columns: columns, columnSpacing: columnSpacing, fixedColumns: fixedColumns,
            availableWidth: availableWidth, hover: rowHover ? hover : nil)
        if rowHover {
            layout { content() }
                .background(alignment: .topLeading) { VisionTableHoverBand(hover: hover) }
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let point): hover.pointerMoved(toY: point.y)
                    case .ended: hover.pointerMoved(toY: nil)
                    }
                }
        } else {
            layout { content() }
        }
    }
}

/// The vertical extent of one cell row of a `VisionTable`.
struct VisionTableRowSpan: Equatable {
    var top: CGFloat
    var height: CGFloat
}

/// Where the pointer is over a `VisionTable`. The layout records where its cell rows are and the
/// hover handler turns the pointer's y into one of them; `band` changes only when the pointer
/// crosses into another row, and only `VisionTableHoverBand` observes it.
@Observable
final class VisionTableHover {
    /// The row under the pointer; nil hides the band.
    private(set) var band: VisionTableRowSpan?
    /// The cell rows of the last layout pass (dividers and full-width rows left out).
    @ObservationIgnored var rows: [VisionTableRowSpan] = []

    func pointerMoved(toY y: CGFloat?) {
        let next = y.flatMap { y in rows.first { y >= $0.top && y < $0.top + $0.height } }
        if band != next { band = next }
    }
}

/// `TableRow`'s `hover:bg-foreground/[0.03]` band, behind the cells of the row under the pointer.
private struct VisionTableHoverBand: View {
    let hover: VisionTableHover
    @Environment(\.visionTheme) private var theme

    var body: some View {
        if let band = hover.band {
            Rectangle().fill(theme.foreground.opacity(0.03))
                .frame(height: band.height)
                .offset(y: band.top)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}

extension View {
    /// The view takes a whole row of its `VisionTable`.
    func visionTableSpan() -> some View { layoutValue(key: VisionTableSpanKey.self, value: true) }
}

private struct VisionTableSpanKey: LayoutValueKey {
    static let defaultValue = false
}

struct VisionTableLayout: Layout {
    let columns: [HorizontalAlignment]
    let columnSpacing: CGFloat
    let fixedColumns: Set<Int>
    /// The width to fill when the proposal has none (inside the horizontal scroll view).
    var availableWidth: CGFloat? = nil
    /// Receives the cell rows' extents for the hover band; nil for a table without one.
    var hover: VisionTableHover? = nil

    struct Cache {
        var width: CGFloat?
        var plan: Plan?
    }

    /// The measured table: where each row starts, how tall it is and how wide each column is.
    struct Plan {
        var columnWidths: [CGFloat]
        var cellSizes: [Int: CGSize]
        /// One entry per row: the subview indices in it, whether it spans, its top and height.
        var rows: [Row]
        var size: CGSize

        struct Row {
            var indices: [Int]
            var spans: Bool
            var top: CGFloat
            var height: CGFloat
        }
    }

    func makeCache(subviews: Subviews) -> Cache { Cache() }

    func updateCache(_ cache: inout Cache, subviews: Subviews) { cache = Cache() }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        plan(width: proposal.width, subviews: subviews, cache: &cache).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        let plan = plan(width: bounds.width, subviews: subviews, cache: &cache)
        // Plain storage, not observed: the next pointer move reads it.
        hover?.rows = plan.rows.filter { !$0.spans }.map { VisionTableRowSpan(top: $0.top, height: $0.height) }
        for row in plan.rows {
            if row.spans {
                for index in row.indices {
                    subviews[index].place(
                        at: CGPoint(x: bounds.minX, y: bounds.minY + row.top), anchor: .topLeading,
                        proposal: ProposedViewSize(width: bounds.width, height: row.height))
                }
                continue
            }
            var x = bounds.minX
            for (column, index) in row.indices.enumerated() {
                let width = plan.columnWidths[column]
                let size = plan.cellSizes[index] ?? .zero
                let offset: CGFloat
                switch columns[column] {
                case .trailing: offset = width - size.width
                case .center: offset = (width - size.width) / 2
                default: offset = 0
                }
                subviews[index].place(
                    at: CGPoint(x: x + max(0, offset), y: bounds.minY + row.top + (row.height - size.height) / 2),
                    anchor: .topLeading, proposal: ProposedViewSize(width: width, height: nil))
                x += width + columnSpacing
            }
        }
    }

    /// Groups the subviews into rows: a spanning child is a row of its own, the others fill
    /// rows of `columns.count` cells.
    static func rows(spans: [Bool], columnCount: Int) -> [(indices: [Int], spans: Bool)] {
        var rows: [(indices: [Int], spans: Bool)] = []
        var current: [Int] = []
        for (index, isSpan) in spans.enumerated() {
            if isSpan {
                if !current.isEmpty {
                    rows.append((current, false))
                    current = []
                }
                rows.append(([index], true))
            } else {
                current.append(index)
                if current.count == columnCount {
                    rows.append((current, false))
                    current = []
                }
            }
        }
        if !current.isEmpty { rows.append((current, false)) }
        return rows
    }

    /// CSS automatic table layout for `available` points: the content widths, plus a share of
    /// the spare room in proportion to them (fixed columns keep theirs). Content wider than the
    /// room keeps its widths: the table overflows and scrolls sideways.
    static func columnWidths(ideal: [CGFloat], available: CGFloat?, spacing: CGFloat, fixed: Set<Int>) -> [CGFloat] {
        guard let available, !ideal.isEmpty else { return ideal }
        let room = available - spacing * CGFloat(ideal.count - 1)
        let total = ideal.reduce(0, +)
        guard room > 0, total > 0 else { return ideal }
        if room >= total {
            let flexible = ideal.enumerated().filter { !fixed.contains($0.offset) }.map(\.element).reduce(0, +)
            // Nothing can grow: every column is fixed, so the last one takes the room.
            guard flexible > 0 else {
                var widths = ideal
                widths[widths.count - 1] += room - total
                return widths
            }
            let spare = room - total
            return ideal.enumerated().map { index, width in
                fixed.contains(index) ? width : width + spare * width / flexible
            }
        }
        return ideal
    }

    private func plan(width: CGFloat?, subviews: Subviews, cache: inout Cache) -> Plan {
        let finite = width.flatMap { $0.isFinite ? $0 : nil } ?? availableWidth
        if let plan = cache.plan, cache.width == finite { return plan }
        let count = max(1, columns.count)
        let grouped = Self.rows(spans: subviews.map { $0[VisionTableSpanKey.self] }, columnCount: count)
        var ideal = [CGFloat](repeating: 0, count: count)
        for row in grouped where !row.spans {
            for (column, index) in row.indices.enumerated() {
                ideal[column] = max(ideal[column], subviews[index].sizeThatFits(.unspecified).width)
            }
        }
        let widths = Self.columnWidths(ideal: ideal, available: finite, spacing: columnSpacing, fixed: fixedColumns)
        let contentWidth = widths.reduce(0, +) + columnSpacing * CGFloat(count - 1)
        let tableWidth = max(finite ?? 0, contentWidth)
        var rows: [Plan.Row] = []
        var cellSizes: [Int: CGSize] = [:]
        var top: CGFloat = 0
        for row in grouped {
            var height: CGFloat = 0
            if row.spans {
                for index in row.indices {
                    height = max(
                        height, subviews[index].sizeThatFits(ProposedViewSize(width: tableWidth, height: nil)).height)
                }
            } else {
                for (column, index) in row.indices.enumerated() {
                    let size = subviews[index].sizeThatFits(ProposedViewSize(width: widths[column], height: nil))
                    cellSizes[index] = size
                    height = max(height, size.height)
                }
            }
            rows.append(Plan.Row(indices: row.indices, spans: row.spans, top: top, height: height))
            top += height
        }
        let plan = Plan(columnWidths: widths, cellSizes: cellSizes, rows: rows, size: CGSize(width: tableWidth, height: top))
        cache.width = finite
        cache.plan = plan
        return plan
    }
}

/// A row's bottom border (`border-b border-border/40` of `TableRow`), across the whole table.
struct VisionTableDivider: View {
    @Environment(\.visionTheme) private var theme

    var body: some View {
        Rectangle().fill(theme.border.opacity(0.4)).frame(height: 1).visionTableSpan()
    }
}
