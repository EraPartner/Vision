#if canImport(AppKit)
    import AppKit
    import PDFKit
    import Testing
    @testable import VisionNativeUI

    @MainActor @Suite("Measured table print pagination")
    struct NativePagePrintTablePaginationTests {
        init() throws {
            try NativeAppKitTestApplication.prepare()
        }

        @Test func fittingTableMovesIntactAndKeepsItsFooterWithItsRows() throws {
            let pages = NativePagePrintPagesView(printInfo: paper(height: 160)) { _ in
                [
                    PrintTableTestView(height: 100, id: "before", label: "Before table"),
                    NativePagePrintTableBlock(
                        header: row("header", height: 20),
                        rows: [row("first", height: 20), row("second", height: 30)],
                        footer: row("footer", height: 15), spacing: 5),
                ]
            }
            #expect(range(pages).length == 2)
            let header = try #require(find("header", in: pages).first)
            #expect(header.convert(header.bounds, to: pages).minY == 160)
            for id in ["header", "first", "second", "footer"] {
                let view = try #require(find(id, in: pages).first)
                #expect(pages.rectForPage(2).contains(view.convert(view.bounds, to: pages)))
            }
            let documents = try render(pages)
            #expect(documents[0].string?.contains("Before table") == true)
            #expect(documents[1].string?.contains("footer") == true)
        }

        @Test func variableHeightRowsStayWholeAndEveryContinuationRepeatsItsHeader() throws {
            let pages = NativePagePrintPagesView(printInfo: paper(height: 150)) { _ in
                [
                    NativePagePrintTableBlock(
                        header: row("header", height: 20),
                        rows: [
                            row("first", height: 30), row("second", height: 60),
                            row("third", height: 25), row("fourth", height: 40),
                        ],
                        footer: row("footer", height: 15), spacing: 5)
                ]
            }
            #expect(range(pages).length == 2)
            #expect(find("header", in: pages).count == 2)
            for id in ["first", "second", "third", "fourth", "footer"] {
                let views = find(id, in: pages)
                #expect(views.count == 1)
                let view = try #require(views.first)
                let rect = view.convert(view.bounds, to: pages)
                #expect((1...2).contains { pages.rectForPage($0).contains(rect) })
            }
            let documents = try render(pages)
            for document in documents { #expect(document.string?.contains("header") == true) }
            #expect(documents[1].string?.contains("fourth") == true)
            #expect(documents[1].string?.contains("footer") == true)
        }

        @Test func footerAndFinalRowMoveTogetherWhenTheyFitOnAFreshPage() throws {
            let pages = NativePagePrintPagesView(printInfo: paper(height: 100)) { _ in
                [
                    NativePagePrintTableBlock(
                        header: row("header", height: 20),
                        rows: [row("first", height: 40), row("last", height: 40)],
                        footer: row("footer", height: 25), spacing: 5)
                ]
            }
            #expect(range(pages).length == 2)
            for id in ["last", "footer"] {
                let view = try #require(find(id, in: pages).first)
                #expect(pages.rectForPage(2).contains(view.convert(view.bounds, to: pages)))
            }
            #expect(find("footer", in: pages).count == 1)
        }

        @Test func emptyTableRetainsOneHeaderAndOneFinalFooterWithoutABlankPage() {
            let pages = NativePagePrintPagesView(printInfo: paper(height: 100)) { _ in
                [
                    NativePagePrintTableBlock(
                        header: row("header", height: 20), rows: [],
                        footer: row("footer", height: 20), spacing: 5)
                ]
            }
            #expect(range(pages).length == 1)
            #expect(find("header", in: pages).count == 1)
            #expect(find("footer", in: pages).count == 1)
        }

        @Test func changedWidthRemeasuresWrappedRowsAndUsesTheSameWidthForEveryBuilder() {
            let info = paper(width: 200, height: 150)
            var widths: [CGFloat] = []
            let header = NativePagePrintRow { width in
                widths.append(width)
                return PrintTableTestView(height: 20, id: "header", label: "Header")
            }
            let body = NativePagePrintRow { width in
                widths.append(width)
                return PrintTableTestView(height: width < 180 ? 80 : 40, id: "body", label: "Wrapped row")
            }
            let footer = NativePagePrintRow { width in
                widths.append(width)
                return PrintTableTestView(height: 15, id: "footer", label: "Footer")
            }
            let pages = NativePagePrintPagesView(printInfo: info) { _ in
                [NativePagePrintTableBlock(header: header, rows: [body, body], footer: footer, spacing: 5)]
            }
            #expect(range(pages).length == 1)
            #expect(widths.allSatisfy { $0 == 200 })
            widths.removeAll()
            info.rightMargin += 50
            #expect(range(pages).length == 2)
            #expect(widths.allSatisfy { $0 == 150 })
            #expect(find("header", in: pages).count == 2)
            #expect(find("body", in: pages).count == 2)
            let calls = widths.count
            #expect(range(pages).length == 2)
            #expect(widths.count == calls)
        }

        @Test func oversizedSingleRowMakesProgressAndPreservesEveryContinuationWithRepeatedHeaders() throws {
            let oversized = NativePagePrintRow { _ in
                PrintTableTestView(
                    height: 260, id: "oversized",
                    labels: [
                        (10, "Top segment"), (90, "Second segment"),
                        (170, "Third segment"), (235, "Last segment"),
                    ])
            }
            let pages = NativePagePrintPagesView(printInfo: paper(height: 100)) { _ in
                [
                    NativePagePrintTableBlock(
                        header: row("header", height: 20), rows: [oversized],
                        footer: row("footer", height: 10), spacing: 5)
                ]
            }
            #expect(range(pages).length == 4)
            #expect(find("header", in: pages).count == 4)
            #expect(find("oversized", in: pages).count == 4)
            #expect(find("footer", in: pages).count == 1)
            let documents = try render(pages)
            for (index, word) in ["Top", "Second", "Third", "Last"].enumerated() {
                let document = documents[index]
                let page = try #require(document.page(at: 0))
                let marker = try #require(document.findString(word + " segment", withOptions: []).first)
                #expect(page.bounds(for: .mediaBox).contains(marker.bounds(for: page)))
                #expect(document.string?.contains("header") == true)
            }
            #expect(documents[3].string?.contains("footer") == true)
        }

        @Test func activeOperationPrintInfoWinsOverTheOriginalPaperSnapshot() {
            let original = paper(width: 240, height: 150)
            var widths: [CGFloat] = []
            let pages = NativePagePrintPagesView(printInfo: original) { width in
                widths.append(width)
                return [
                    NativePagePrintTableBlock(
                        header: row("header", height: 20),
                        rows: [row("first", height: 40), row("last", height: 40)],
                        footer: row("footer", height: 15), spacing: 5)
                ]
            }
            #expect(range(pages).length == 1)
            let operation = NSPrintOperation(view: pages, printInfo: paper(width: 180, height: 100))
            let previous = NSPrintOperation.current
            NSPrintOperation.current = operation
            defer { NSPrintOperation.current = previous }
            #expect(range(pages).length == 2)
            #expect(pages.rectForPage(1).size == NSSize(width: 180, height: 100))
            #expect(widths == [240, 180])
            #expect(find("header", in: pages).count == 2)
        }

        @Test func headerLargerThanPaperPreservesContentWithoutAnEmptyPageLoop() {
            let pages = NativePagePrintPagesView(printInfo: paper(height: 100)) { _ in
                [
                    NativePagePrintTableBlock(
                        header: row("header", height: 110), rows: [row("body", height: 20)],
                        footer: row("footer", height: 10), spacing: 5)
                ]
            }
            #expect(range(pages).length == 2)
            #expect(find("header", in: pages).count == 1)
            #expect(find("body", in: pages).count == 1)
            #expect(find("footer", in: pages).count == 1)
        }

        private func row(_ id: String, height: CGFloat) -> NativePagePrintRow {
            NativePagePrintRow { _ in PrintTableTestView(height: height, id: id, label: id) }
        }
        private func paper(width: CGFloat = 240, height: CGFloat) -> NSPrintInfo {
            let info = NSPrintInfo(dictionary: [:])
            info.paperSize = NSSize(width: width + 72, height: height + 72)
            info.leftMargin = 36
            info.rightMargin = 36
            info.topMargin = 36
            info.bottomMargin = 36
            return info
        }
        private func range(_ pages: NativePagePrintPagesView) -> NSRange {
            var value = NSRange()
            #expect(pages.knowsPageRange(&value))
            return value
        }
        private func find(_ id: String, in view: NSView) -> [NSView] {
            let own: [NSView] = view.identifier?.rawValue == id ? [view] : []
            return own + view.subviews.flatMap { find(id, in: $0) }
        }
        private func render(_ pages: NativePagePrintPagesView) throws -> [PDFDocument] {
            try NativePrintPDFRenderer.render(pages)
        }
    }

    @MainActor private final class PrintTablePDFCanvas: NSView {
        override var isFlipped: Bool { true }
    }

    @MainActor private final class PrintTableTestView: NSView {
        let height: CGFloat
        let labels: [(CGFloat, String)]
        override var isFlipped: Bool { true }
        override var fittingSize: NSSize { NSSize(width: frame.width, height: height) }
        init(height: CGFloat, id: String, label: String) {
            self.height = height
            self.labels = [(3, label)]
            super.init(frame: .zero)
            identifier = NSUserInterfaceItemIdentifier(id)
        }
        init(height: CGFloat, id: String, labels: [(CGFloat, String)]) {
            self.height = height
            self.labels = labels
            super.init(frame: .zero)
            identifier = NSUserInterfaceItemIdentifier(id)
        }
        required init?(coder: NSCoder) { nil }
        override func draw(_ dirtyRect: NSRect) {
            for (offset, label) in labels {
                (label as NSString).draw(
                    at: NSPoint(x: 2, y: offset),
                    withAttributes: [.font: NSFont.systemFont(ofSize: 10), .foregroundColor: NSColor.black])
            }
        }
    }
#endif
