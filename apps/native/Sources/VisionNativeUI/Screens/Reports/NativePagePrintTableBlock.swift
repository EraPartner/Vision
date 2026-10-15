import AppKit

/// A fresh, inert view of frozen print values at the table's full printable width.
/// Builders must create a new view each time: headers repeat and an exceptionally
/// tall row may need more than one clipped continuation view.
@MainActor
public struct NativePagePrintRow {
    let makeView: @MainActor (CGFloat) -> NSView

    public init(_ makeView: @escaping @MainActor (CGFloat) -> NSView) {
        self.makeView = makeView
    }
}

/// A table consumed by NativePagePrintPagesView alongside ordinary section views.
/// Resolve columns once from the complete frozen table at the supplied width, then
/// reuse those widths in every header, row and footer builder. Pagination never
/// queries a model or infers column widths from an individual page's subset of rows.
@MainActor
public final class NativePagePrintTableBlock: NSView {
    let header: NativePagePrintRow
    let rows: [NativePagePrintRow]
    let footer: NativePagePrintRow?
    let spacing: CGFloat

    public init(
        header: NativePagePrintRow, rows: [NativePagePrintRow],
        footer: NativePagePrintRow? = nil, spacing: CGFloat = 8
    ) {
        self.header = header
        self.rows = rows
        self.footer = footer
        self.spacing = spacing.isFinite ? max(0, spacing) : 0
        super.init(frame: .zero)
    }

    public required init?(coder: NSCoder) { nil }
}
