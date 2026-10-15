import AppKit

/// Frozen sections laid out in source order. Short sections begin on a fresh page
/// when needed; sections taller than the paper continue on the following page.
@MainActor
public final class NativePagePrintPagesView: NSView {
    private var pageHeight: CGFloat = 1
    private var pageCount = 1
    private var measuredSize: NSSize?
    private let suppliedPrintInfo: NSPrintInfo
    private let buildBlocks: @MainActor (CGFloat) -> [NSView]
    public override var isFlipped: Bool { true }

    public init(printInfo: NSPrintInfo, buildBlocks: @escaping @MainActor (CGFloat) -> [NSView]) {
        suppliedPrintInfo = printInfo
        self.buildBlocks = buildBlocks
        super.init(frame: .zero)
        remeasure(printInfo: printInfo)
    }

    private func remeasure(printInfo: NSPrintInfo) {
        let width = max(1, printInfo.paperSize.width - printInfo.leftMargin - printInfo.rightMargin)
        let heightPerPage = max(1, printInfo.paperSize.height - printInfo.topMargin - printInfo.bottomMargin)
        let contentSize = NSSize(width: width, height: heightPerPage)
        guard measuredSize != contentSize else { return }
        measuredSize = contentSize
        var blocks: [(NSView, CGFloat, CGFloat)] = []
        var offset: CGFloat = 0
        for block in buildBlocks(width) {
            if let table = block as? NativePagePrintTableBlock {
                let layout = NativePagePrintTableLayout(
                    table: table, width: width, pageHeight: heightPerPage, start: offset)
                blocks.append(contentsOf: layout.blocks)
                offset = layout.end + 16
                continue
            }
            block.setFrameSize(NSSize(width: width, height: 1))
            block.layoutSubtreeIfNeeded()
            let height = max(1, block.fittingSize.height)
            let remaining = heightPerPage - offset.truncatingRemainder(dividingBy: heightPerPage)
            if height <= heightPerPage, height > remaining { offset += remaining }
            blocks.append((block, offset, height))
            offset += height + 16
        }
        let count = max(1, Int(ceil(max(1, offset - 16) / heightPerPage)))
        pageHeight = heightPerPage
        pageCount = count
        for view in subviews { view.removeFromSuperview() }
        setFrameSize(NSSize(width: width, height: CGFloat(count) * heightPerPage))
        for (block, offset, height) in blocks {
            block.frame = NSRect(x: 0, y: offset, width: width, height: height)
            addSubview(block)
        }
    }

    public required init?(coder: NSCoder) { nil }

    public override func knowsPageRange(_ range: NSRangePointer) -> Bool {
        // The print panel can mutate paper, orientation and margins after construction.
        // Each pagination pass measures that operation's settings once; rectForPage and
        // drawing then use exactly the same frozen layout until the next pass.
        let info: NSPrintInfo
        if let operation = NSPrintOperation.current, operation.view === self {
            info = operation.printInfo
        } else {
            info = suppliedPrintInfo
        }
        remeasure(printInfo: info)
        range.pointee = NSRange(location: 1, length: pageCount)
        return true
    }

    public override func rectForPage(_ page: Int) -> NSRect {
        NSRect(x: 0, y: CGFloat(page - 1) * pageHeight, width: bounds.width, height: pageHeight)
    }
}

@MainActor private final class NativeMeasuredPrintRow {
    let height: CGFloat
    private let row: NativePagePrintRow
    private var initialView: NSView?

    init(_ row: NativePagePrintRow, width: CGFloat) {
        self.row = row
        let view = row.makeView(width)
        view.setFrameSize(NSSize(width: width, height: 1))
        view.layoutSubtreeIfNeeded()
        let fitted = view.fittingSize.height
        height = fitted.isFinite ? max(1, fitted) : 1
        initialView = view
    }

    func view(width: CGFloat) -> NSView {
        let view = initialView ?? row.makeView(width)
        initialView = nil
        view.setFrameSize(NSSize(width: width, height: height))
        view.layoutSubtreeIfNeeded()
        return view
    }
}

/// Each fragment contains a fresh header and complete measured rows. A single row
/// taller than a fresh page's body is the only row-splitting exception: clipped
/// continuations preserve all of that row's content and always advance its offset.
@MainActor private final class NativePagePrintTableLayout {
    private(set) var blocks: [(NSView, CGFloat, CGFloat)] = []
    private(set) var end: CGFloat
    private let width: CGFloat
    private let pageHeight: CGFloat
    private let spacing: CGFloat
    private let header: NativeMeasuredPrintRow
    private let rows: [NativeMeasuredPrintRow]
    private let footerIndex: Int?
    private var fragment: NativePagePrintFragmentView?
    private var fragmentStart: CGFloat = 0
    private var used: CGFloat = 0

    init(table: NativePagePrintTableBlock, width: CGFloat, pageHeight: CGFloat, start: CGFloat) {
        self.width = width
        self.pageHeight = pageHeight
        self.spacing = table.spacing
        self.end = start
        self.header = NativeMeasuredPrintRow(table.header, width: width)
        var rows = table.rows.map { NativeMeasuredPrintRow($0, width: width) }
        if let footer = table.footer {
            footerIndex = rows.count
            rows.append(NativeMeasuredPrintRow(footer, width: width))
        } else {
            footerIndex = nil
        }
        self.rows = rows
        layout()
    }

    private func layout() {
        let bodyCapacity = pageHeight - header.height - spacing
        guard bodyCapacity > 0 else {
            // A header occupying the entire paper cannot coexist with any row.
            // Preserve all content as ordinary blocks rather than crop the header
            // or repeatedly start a page on which no row can make progress.
            appendOrdinary(header)
            for row in rows {
                end += spacing
                appendOrdinary(row)
            }
            return
        }
        let completeHeight = header.height + rows.reduce(CGFloat.zero) { $0 + spacing + $1.height }
        if completeHeight <= pageHeight {
            beginFragment(minimumBodyHeight: max(0, completeHeight - header.height - spacing))
            for row in rows { append(row.view(width: width), height: row.height) }
            finishFragment()
            return
        }
        for (index, row) in rows.enumerated() {
            var consumed: CGFloat = 0
            var remaining = row.height
            while remaining > 0 {
                var minimumBodyHeight = min(remaining, bodyCapacity)
                if consumed == 0, let footerIndex, index == footerIndex - 1 {
                    let pairHeight = remaining + spacing + rows[footerIndex].height
                    if pairHeight <= bodyCapacity { minimumBodyHeight = pairHeight }
                }
                if fragment == nil {
                    beginFragment(minimumBodyHeight: minimumBodyHeight)
                } else if minimumBodyHeight > availableBodyHeight,
                    minimumBodyHeight <= bodyCapacity, remaining <= bodyCapacity
                {
                    nextPage()
                    continue
                }
                let available = availableBodyHeight
                if remaining <= available {
                    let view = row.view(width: width)
                    if consumed == 0 {
                        append(view, height: remaining)
                    } else {
                        append(
                            NativePagePrintRowSliceView(
                                source: view, offset: consumed, width: width, height: remaining),
                            height: remaining)
                    }
                    remaining = 0
                } else if remaining <= bodyCapacity || available <= 0 {
                    nextPage()
                } else {
                    let height = min(remaining, available)
                    append(
                        NativePagePrintRowSliceView(
                            source: row.view(width: width), offset: consumed, width: width, height: height),
                        height: height)
                    consumed += height
                    remaining -= height
                    nextPage()
                }
            }
        }
        finishFragment()
    }

    private var availableBodyHeight: CGFloat {
        pageHeight - fragmentStart.truncatingRemainder(dividingBy: pageHeight) - used - spacing
    }

    private func beginFragment(minimumBodyHeight: CGFloat) {
        let required = header.height + (rows.isEmpty ? 0 : spacing + minimumBodyHeight)
        let available = pageHeight - end.truncatingRemainder(dividingBy: pageHeight)
        if required > available { end += available }
        fragmentStart = end
        let fragment = NativePagePrintFragmentView(frame: NSRect(x: 0, y: 0, width: width, height: 1))
        let headerView = header.view(width: width)
        headerView.frame.origin = .zero
        fragment.addSubview(headerView)
        self.fragment = fragment
        used = header.height
    }

    private func append(_ view: NSView, height: CGFloat) {
        view.frame = NSRect(x: 0, y: used + spacing, width: width, height: height)
        fragment?.addSubview(view)
        used += spacing + height
    }

    private func finishFragment() {
        guard let fragment else { return }
        fragment.setFrameSize(NSSize(width: width, height: used))
        blocks.append((fragment, fragmentStart, used))
        end = fragmentStart + used
        self.fragment = nil
    }

    private func nextPage() {
        finishFragment()
        let remainder = end.truncatingRemainder(dividingBy: pageHeight)
        if remainder > 0 { end += pageHeight - remainder }
    }

    private func appendOrdinary(_ row: NativeMeasuredPrintRow) {
        let available = pageHeight - end.truncatingRemainder(dividingBy: pageHeight)
        if row.height <= pageHeight, row.height > available { end += available }
        blocks.append((row.view(width: width), end, row.height))
        end += row.height
    }
}

@MainActor private final class NativePagePrintFragmentView: NSView {
    override var isFlipped: Bool { true }
}

@MainActor private final class NativePagePrintRowSliceView: NSView {
    override var isFlipped: Bool { true }

    init(source: NSView, offset: CGFloat, width: CGFloat, height: CGFloat) {
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: height))
        clipsToBounds = true
        source.frame.origin = NSPoint(x: 0, y: -offset)
        addSubview(source)
    }

    required init?(coder: NSCoder) { nil }
}
