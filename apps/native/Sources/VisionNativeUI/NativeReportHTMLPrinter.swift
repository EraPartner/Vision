import AppKit
import VisionNativeCore
import WebKit

/// The desktop shell's `printToPdf` (ADR-234, `packaging/electron/report-pdf.ts`) for the native
/// app: the report document is loaded into an off-screen WebKit view without JavaScript and
/// printed to a PDF file through the system print path, which honours the document's own print
/// CSS (`@page` A4 portrait, page breaks).
///
/// Known difference from the web renderer: `footerTemplate` is a Chromium header/footer
/// template, which WebKit's print path does not support, so the per-page "page N of M" band is
/// left blank (the document still reserves its 28 px bottom margin).
@MainActor
public final class NativeReportHTMLPrinter: NSObject, WKNavigationDelegate {
    public enum Failure: Error, LocalizedError, Equatable {
        case loadFailed(String)
        case printFailed

        public var errorDescription: String? {
            switch self {
            case .loadFailed(let reason): return "Report printing failed: \(reason)"
            case .printFailed: return "Report printing failed"
            }
        }
    }

    /// A4 in points (595.28 x 841.89).
    static let pageSize = NSSize(width: 595.28, height: 841.89)
    /// The report CSS reserves 28 CSS px (21 pt) at the bottom of every page.
    static let bottomMargin: CGFloat = 21

    private let webView: WKWebView
    private let window: NSWindow
    private var loaded: CheckedContinuation<Void, any Error>?
    private var printed: CheckedContinuation<Bool, Never>?

    private override init() {
        let configuration = WKWebViewConfiguration()
        // The report needs no script; keep it that way even if a document ever carried one.
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: NSRect(origin: .zero, size: Self.pageSize), configuration: configuration)
        let host = NSWindow(
            contentRect: NSRect(origin: .zero, size: Self.pageSize), styleMask: [.borderless], backing: .buffered,
            defer: true)
        host.isReleasedWhenClosed = false
        host.contentView = view
        webView = view
        window = host
        super.init()
        webView.navigationDelegate = self
    }

    /// The `NativeReportPDFRenderer` the app hands to `NativeReportsAPIService`: one printer per
    /// document, so a failed print never leaves state behind.
    public static func pdf(for document: NativeReportDocument) async throws -> Data {
        try await NativeReportHTMLPrinter().render(document.html)
    }

    private func render(_ html: String) async throws -> Data {
        try await load(html)
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("vision-report-\(UUID().uuidString).pdf")
        defer { try? FileManager.default.removeItem(at: file) }

        let info = NSPrintInfo()
        info.paperSize = Self.pageSize
        info.topMargin = 0
        info.leftMargin = 0
        info.rightMargin = 0
        info.bottomMargin = Self.bottomMargin
        info.isHorizontallyCentered = false
        info.isVerticallyCentered = false
        info.jobDisposition = .save
        info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = file

        let operation = webView.printOperation(with: info)
        operation.showsPrintPanel = false
        operation.showsProgressPanel = false
        operation.view?.frame = NSRect(origin: .zero, size: Self.pageSize)
        // A WebKit print operation only runs asynchronously against a window.
        let succeeded = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            printed = continuation
            operation.runModal(
                for: window, delegate: self, didRun: #selector(printOperationDidRun(_:success:contextInfo:)),
                contextInfo: nil)
        }
        guard succeeded, let data = try? Data(contentsOf: file), !data.isEmpty else { throw Failure.printFailed }
        return data
    }

    private func load(_ html: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            loaded = continuation
            webView.loadHTMLString(html, baseURL: nil)
        }
    }

    @objc private func printOperationDidRun(
        _ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?
    ) {
        printed?.resume(returning: success)
        printed = nil
    }

    // MARK: WKNavigationDelegate

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded?.resume()
        loaded = nil
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        loaded?.resume(throwing: Failure.loadFailed(error.localizedDescription))
        loaded = nil
    }

    public func webView(
        _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error
    ) {
        loaded?.resume(throwing: Failure.loadFailed(error.localizedDescription))
        loaded = nil
    }
}
