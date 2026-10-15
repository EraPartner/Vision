#if canImport(AppKit)
    import AppKit
    import PDFKit
    import QuartzCore
    import SwiftUI
    import Testing
    @testable import VisionNativeUI

    /// Synthetic vector-PDF rendering with an actual AppKit display transaction.
    /// An unordered window can measure NSHostingView but export an empty display list.
    @MainActor enum NativePrintPDFRenderer {
        static func render(_ pages: NativePagePrintPagesView) throws -> [PDFDocument] {
            let diagnostics = try diagnosticDirectory()
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
            let readiness = NSHostingView(rootView: readinessText("initial"))
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
                repeat {
                    // Advance the display transaction, then observe its actual vector
                    // output. The deadline bounds failure; it is not a fixed sleep.
                    _ = RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.005))
                    root.layoutSubtreeIfNeeded()
                    window.displayIfNeeded()
                    root.display()
                    CATransaction.flush()
                    probeData = readiness.dataWithPDF(inside: readiness.bounds)
                    let probe = PDFDocument(data: probeData)
                    isReady = probe?.string?.contains(marker) == true
                } while !isReady && Date() < deadline
                let pageData = canvas.dataWithPDF(inside: canvas.bounds)
                if let diagnostics {
                    try probeData.write(to: diagnostics.appendingPathComponent("page-\(index)-readiness.pdf"))
                    try pageData.write(to: diagnostics.appendingPathComponent("page-\(index).pdf"))
                }
                try #require(isReady, "SwiftUI produced no vector PDF text after its display transaction")
                #expect(application.keyWindow === originalKeyWindow)
                let document = try #require(PDFDocument(data: pageData))
                #expect(document.pageCount == 1)
                let output = try #require(document.page(at: 0))
                #expect(abs(output.bounds(for: .mediaBox).width - rect.width) < 1)
                #expect(abs(output.bounds(for: .mediaBox).height - rect.height) < 1)
                return document
            }
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

    @MainActor private final class NativePrintPDFCanvas: NSView {
        override var isFlipped: Bool { true }
    }

    @MainActor private final class NativePrintPDFWindow: NSWindow {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }
#endif
