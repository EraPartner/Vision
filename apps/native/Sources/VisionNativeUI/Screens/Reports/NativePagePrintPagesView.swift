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
