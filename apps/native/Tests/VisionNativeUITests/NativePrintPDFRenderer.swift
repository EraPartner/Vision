#if canImport(AppKit)
    import AppKit
    import PDFKit
    import QuartzCore
    import SwiftUI
    import Testing
    @testable import VisionNativeUI

    /// Synthetic vector-PDF rendering through AppKit's printing lifecycle.
    /// A measured NSHostingView is insufficient: its real PDF text must also be ready.
    @MainActor enum NativePrintPDFRenderer {
        static func render(_ pages: NativePagePrintPagesView) throws -> [PDFDocument] {
            let diagnostics = try diagnosticDirectory()
            try NativeAppKitTestApplication.prepare()
            let application = NSApplication.shared
            let originalKeyWindow = application.keyWindow
            var range = NSRange()
            #expect(pages.knowsPageRange(&range))
            let pageSize = pages.rectForPage(1).size
            let root = NativePrintPDFCanvas(
                frame: NSRect(origin: .zero, size: NSSize(width: pageSize.width + 240, height: pageSize.height)))
            let canvas = NativePrintPDFCanvas(frame: NSRect(origin: .zero, size: pageSize))
            canvas.clipsToBounds = true
            root.addSubview(canvas)
            let originalFrame = pages.frame
            canvas.addSubview(pages)
            let readiness = NativePrintHostingView(rootView: readinessText("initial"))
            readiness.frame = NSRect(x: pageSize.width + 8, y: 0, width: 224, height: 32)
            root.addSubview(readiness)
            let window = NativePrintPDFWindow(
                contentRect: root.bounds, styleMask: .borderless, backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.ignoresMouseEvents = true
            window.contentView = root
            window.orderFront(nil)
            defer {
                pages.removeFromSuperview()
                pages.frame = originalFrame
                window.contentView = nil
                window.close()
                #expect(application.keyWindow === originalKeyWindow, "Print rendering changed the key window")
            }
            #expect(!window.canBecomeKey && !window.canBecomeMain)
            #expect(application.keyWindow === originalKeyWindow)
            return try (1...range.length).map { index in
                let rect = pages.rectForPage(index)
                // Give every page a visible viewport so SwiftUI cannot cull later
                // pages merely because the synthetic report is taller than the screen.
                pages.setFrameOrigin(NSPoint(x: 0, y: -rect.minY))
                let marker = "SwiftUI PDF ready \(index)"
                readiness.rootView = readinessText(marker)
                let deadline = Date(timeIntervalSinceNow: 1)
                var isReady = false
                var probeData = Data()
                var probeSucceeded = false
                repeat {
                    // Advance the display transaction, then observe its actual vector
                    // output. The deadline bounds failure; it is not a fixed sleep.
                    NativeAppKitTestApplication.pumpEvents(until: Date(timeIntervalSinceNow: 0.005))
                    root.layoutSubtreeIfNeeded()
                    window.displayIfNeeded()
                    root.display()
                    CATransaction.flush()
                    let probeOutput = vectorPDF(readiness)
                    probeData = probeOutput.data
                    probeSucceeded = probeOutput.succeeded
                    let probe = PDFDocument(data: probeData)
                    isReady = probeSucceeded && probe?.string?.contains(marker) == true
                } while !isReady && Date() < deadline
                let pageOutput = vectorPDF(canvas)
                let pageData = pageOutput.data
                if let diagnostics {
                    try probeData.write(to: diagnostics.appendingPathComponent("page-\(index)-readiness.pdf"))
                    try pageData.write(to: diagnostics.appendingPathComponent("page-\(index).pdf"))
                    try NativeAppKitTestApplication.diagnostics(window: window).write(
                        to: diagnostics.appendingPathComponent("page-\(index)-appkit.txt"),
                        atomically: true, encoding: .utf8)
                }
                try #require(probeSucceeded, "The SwiftUI readiness PDF print operation failed")
                try #require(pageOutput.succeeded, "The page PDF print operation failed")
                try #require(
                    isReady,
                    "SwiftUI produced no vector PDF text after its display transaction: \(NativeAppKitTestApplication.diagnostics(window: window))"
                )
                #expect(application.keyWindow === originalKeyWindow)
                let document = try #require(PDFDocument(data: pageData))
                #expect(document.pageCount == 1)
                let output = try #require(document.page(at: 0))
                #expect(abs(output.bounds(for: .mediaBox).width - rect.width) < 1)
                #expect(abs(output.bounds(for: .mediaBox).height - rect.height) < 1)
                return document
            }
        }

        private static func vectorPDF(_ view: NSView) -> (data: Data, succeeded: Bool) {
            let info = NSPrintInfo(dictionary: [:])
            info.paperSize = view.bounds.size
            info.leftMargin = 0
            info.rightMargin = 0
            info.topMargin = 0
            info.bottomMargin = 0
            info.isHorizontallyCentered = false
            info.isVerticallyCentered = false
            let data = NSMutableData()
            // Use AppKit's actual printing hooks, as the application does, while
            // the wrapper canvas keeps its frozen paginator out of a new layout pass.
            let operation = NSPrintOperation.pdfOperation(with: view, inside: view.bounds, to: data, printInfo: info)
            operation.showsPrintPanel = false
            operation.showsProgressPanel = false
            let succeeded = operation.run()
            return (data as Data, succeeded)
        }

        private static func diagnosticDirectory() throws -> URL? {
            guard let path = ProcessInfo.processInfo.environment["VISION_NATIVE_INTEROP_DIR"], !path.isEmpty else {
                return nil
            }
            let directory = URL(fileURLWithPath: path, isDirectory: true)
                .appendingPathComponent("print-render", isDirectory: true)
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            return directory
        }

        private static func readinessText(_ marker: String) -> some View {
            Text(marker).font(.system(size: 12)).foregroundStyle(.black)
                .frame(width: 224, height: 32, alignment: .topLeading)
        }
    }

    /// Printed glyphs located by their own bounds. PDFPage.selection(for:) behaves like a drag
    /// selection over reading order, and findString needs contiguous extracted text; ImageRenderer
    /// output interleaves neighbouring cells in content order. Glyphs are therefore grouped into
    /// printed lines by baseline and read left to right, top line first.
    enum NativePDFGlyphs {
        typealias Glyph = (character: Character, bounds: NSRect)

        static func lines(_ page: PDFPage) -> [[Glyph]] {
            // page.string and characterBounds(at:) use different index spaces; a one-character
            // selection reports its text and bounds from the same character.
            let glyphs: [Glyph] = (0..<page.numberOfCharacters).compactMap { index in
                guard let selection = page.selection(for: NSRange(location: index, length: 1)),
                    let character = selection.string?.first, !character.isWhitespace
                else { return nil }
                let bounds = selection.bounds(for: page)
                return bounds.isEmpty ? nil : (character, bounds)
            }
            // Ink bounds differ between ascenders and x-height glyphs: a glyph joins a line when
            // its centre lies within the line's vertical extent.
            var lines: [(minY: CGFloat, maxY: CGFloat, glyphs: [Glyph])] = []
            for glyph in glyphs.sorted(by: { $0.bounds.midY > $1.bounds.midY }) {
                if let last = lines.last, glyph.bounds.midY >= last.minY - 0.5, glyph.bounds.midY <= last.maxY + 0.5 {
                    lines[lines.count - 1].minY = min(last.minY, glyph.bounds.minY)
                    lines[lines.count - 1].maxY = max(last.maxY, glyph.bounds.maxY)
                    lines[lines.count - 1].glyphs.append(glyph)
                } else {
                    lines.append((glyph.bounds.minY, glyph.bounds.maxY, [glyph]))
                }
            }
            return lines.map { $0.glyphs.sorted { $0.bounds.minX < $1.bounds.minX } }
        }

        /// Non-whitespace text whose glyph centres fall inside the horizontal band, line by line.
        static func text(_ page: PDFPage, from minX: CGFloat, to maxX: CGFloat) -> String {
            lines(page).map { line in
                String(line.filter { $0.bounds.midX >= minX && $0.bounds.midX <= maxX }.map(\.character))
            }.joined()
        }

        /// Union bounds of every occurrence within one printed line, top first, ignoring whitespace.
        static func occurrences(of needle: String, in page: PDFPage) -> [NSRect] {
            let target = Array(needle.filter { !$0.isWhitespace })
            guard !target.isEmpty else { return [] }
            return lines(page).flatMap { line -> [NSRect] in
                guard line.count >= target.count else { return [] }
                return (0...(line.count - target.count)).compactMap { start in
                    guard target.indices.allSatisfy({ line[start + $0].character == target[$0] }) else { return nil }
                    return line[start..<(start + target.count)].reduce(NSRect.null) { $0.union($1.bounds) }
                }
            }
        }

        static func bounds(of needle: String, in page: PDFPage) -> NSRect? { occurrences(of: needle, in: page).first }

        /// Failure diagnostics: each printed line as runs of adjacent glyphs with their x-extent.
        static func layout(_ page: PDFPage) -> String {
            lines(page).map { line in
                var runs: [(minX: CGFloat, maxX: CGFloat, text: String)] = []
                for glyph in line {
                    if let last = runs.last, glyph.bounds.minX - last.maxX <= 3 {
                        runs[runs.count - 1].maxX = max(last.maxX, glyph.bounds.maxX)
                        runs[runs.count - 1].text.append(glyph.character)
                    } else {
                        runs.append((glyph.bounds.minX, glyph.bounds.maxX, String(glyph.character)))
                    }
                }
                let y = Int(line.first?.bounds.midY ?? 0)
                return "y\(y): " + runs.map { "[\(Int($0.minX))-\(Int($0.maxX))]\($0.text)" }.joined(separator: " ")
            }.joined(separator: "\n")
        }
    }

    @MainActor private final class NativePrintPDFCanvas: NSView {
        override var isFlipped: Bool { true }
    }

    @MainActor private final class NativePrintPDFWindow: NSWindow {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }
#endif
