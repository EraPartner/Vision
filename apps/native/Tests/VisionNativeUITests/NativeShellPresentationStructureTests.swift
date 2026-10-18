import AppKit
import PDFKit
import SwiftUI
import Testing
import VisionNativeCore

@testable import VisionNativeUI

@MainActor
@Suite("Native shell document presentation", .serialized)
struct NativeShellPresentationStructureTests {
    init() throws { try NativeAppKitTestApplication.prepare() }

    @Test func nativeOnlyNeverBuildsADocumentAcrossNativePresentationStates() async throws {
        let shell = makeNativeOnlyShell()
        let probe = ShellDocumentProbe(frame: NSRect(x: 0, y: 0, width: 240, height: 80))
        let requests = ShellDocumentRequests()
        let fixture = ShellPresentationWindow(
            ShellRootView(model: shell) { hidden in
                requests.hidden.append(hidden)
                return ShellDocumentProbeView(probe: probe).frame(width: 240, height: 80)
            })
        defer { fixture.close() }
        shell.reloadSettings()
        await shell.settingsSettled()
        let states: [(NativeDocumentState, NativeShellDetail)] = [
            (.loading, .loading), (.ready, .notFound), (.failed, .unavailable), (.loading, .loading),
        ]
        for (state, expected) in states {
            shell.setNativeDocumentState(state)
            #expect(shell.detail == expected)
            try fixture.settle(until: { true })
            #expect(probe.window == nil && requests.hidden.isEmpty)
            #expect(!accessibilityStrings(fixture.host).contains("synthetic web document"))
            #expect(shell.detail != .web && shell.printDisposition == .unavailable)
        }
    }

    @Test func retainedWebKeepsItsExistingVisibleAccessiblePresentation() throws {
        let probe = ShellDocumentProbe(frame: NSRect(x: 0, y: 0, width: 240, height: 80))
        let requests = ShellDocumentRequests()
        let fixture = ShellPresentationWindow(
            NativeShellWebPresentation(mode: .retainedWeb, hidden: false) { hidden in
                requests.hidden.append(hidden)
                return ShellDocumentProbeView(probe: probe).frame(width: 240, height: 80)
            })
        defer { fixture.close() }
        try fixture.settle(until: { probe.window === fixture.window })
        #expect(!probe.isHiddenOrHasHiddenAncestor)
        #expect(probe.isAccessibilityElement())
        #expect(probe.accessibilityLabel() == "synthetic web document")
        #expect(probe.hitTest(NSPoint(x: 1, y: 1)) === probe)
        #expect(!requests.hidden.isEmpty && requests.hidden.allSatisfy { !$0 })
    }

    /// Regression: hosted in an `NSHostingView` without sizing options (as ShellController
    /// hosts it), the sidebar started narrower than its minimum and wrapped the search hint.
    @Test func sidebarStartsAtLeastAtItsMinimumWidth() throws {
        let shell = makeNativeOnlyShell()
        let fixture = ShellPresentationWindow(ShellRootView(model: shell) { _ in EmptyView() })
        fixture.host.sizingOptions = []
        defer { fixture.close() }
        do {
            try fixture.settle(until: {
                (sidebarSplitView(in: fixture.host)?.arrangedSubviews.first?.frame.width ?? 0)
                    >= SidebarWidthGuard.minimumWidth
            })
        } catch {
            Issue.record(Comment(rawValue: sidebarDiagnostics(fixture.host)))
            throw error
        }
    }

    @Test func sidebarWidthCorrectionOnlyWidensANarrowSidebarOnce() {
        let ideal = SidebarWidthGuard.idealWidth
        let minimum = SidebarWidthGuard.minimumWidth
        #expect(SidebarWidthGuard.correctedWidth(sidebar: 140, splitView: 1100, minimum: minimum, ideal: ideal) == ideal)
        #expect(SidebarWidthGuard.correctedWidth(sidebar: 300, splitView: 1100, minimum: minimum, ideal: ideal) == nil)
        #expect(SidebarWidthGuard.correctedWidth(sidebar: 0, splitView: 1100, minimum: minimum, ideal: ideal) == nil)
        #expect(SidebarWidthGuard.correctedWidth(sidebar: 140, splitView: 400, minimum: minimum, ideal: ideal) == nil)
        #expect(
            SidebarWidthGuard.correctedWidth(
                sidebar: 150, splitView: 1100, minimum: minimum, ideal: ideal, firstLayout: false) == ideal)
        #expect(
            SidebarWidthGuard.correctedWidth(
                sidebar: 220, splitView: 1100, minimum: minimum, ideal: ideal, firstLayout: false) == nil)
    }

    /// SwiftUI builds no accessibility tree inside the SwiftPM test process on the macOS runner:
    /// the hosting view exposes one empty node, and the process cannot enable client
    /// accessibility for itself (AXEnhancedUserInterface -25208, AXManualAccessibility -25205).
    /// This asserts the native views render their localized content; VoiceOver exposure of the
    /// same text is a manual Mac check recorded in the native handoff.
    @Test(arguments: [NativeShellDetail.loading, .unavailable])
    func startupAndFailureRenderTheirNativeLocalizedContent(_ detail: NativeShellDetail) throws {
        let strings = DictionaryStrings(
            language: .en,
            table: [
                "common.loading": "Synthetic loading", "common.error": "Synthetic unavailable",
            ])
        let expected = detail == .loading ? "Synthetic loading" : "Synthetic unavailable"
        let info = NSPrintInfo(dictionary: [:])
        info.paperSize = NSSize(width: 480, height: 240)
        info.leftMargin = 0
        info.rightMargin = 0
        info.topMargin = 0
        info.bottomMargin = 0
        let pages = NativePagePrintPagesView(printInfo: info) { width in
            [
                NativePrintHostingView(
                    rootView: NativeShellUnavailableView(detail: detail, strings: strings)
                        .frame(width: width, height: 200))
            ]
        }
        let text = try NativePrintPDFRenderer.render(pages).compactMap(\.string).joined()
        #expect(text.contains(expected), "Rendered: \(text)")
    }

    private func makeNativeOnlyShell() -> NativeShellModel {
        let rates = ExchangeRatesModel(service: StaticRatesService(NativeScreenStructureTests.rates))
        let planned = StaticPlannedService()
        return NativeShellModel(
            strings: CatalogStrings(language: .en), theme: ThemeSelection(appearance: .light),
            notices: NativeNoticeCenter(automaticExpiry: false), exchangeRates: rates,
            admin: AdminScreens.make(
                service: StaticAdminService(), database: StaticDatabaseService(),
                token: AdminTokenAccess(read: { nil }, write: { _ in true }), audit: StaticAuditHistory()),
            planned: PlannedPaymentsModel(
                service: planned, editing: planned, pickers: planned, rates: rates, dismissals: .memory()),
            imports: ImportsModel(
                service: StaticImportService(), exports: StaticImportService(), review: StaticImportService(),
                pickers: planned),
            transactions: TransactionsModel(
                service: StaticTransactionsService(), attachments: StaticTransactionsService(), pickers: planned,
                bulk: StaticSplitsService(), splits: StaticSplitsService()),
            accounts: AccountsModel(service: StaticAccountsService(), rates: rates),
            categories: CategoriesModel(service: StaticCategoriesService()),
            recipients: RecipientsModel(service: StaticRecipientsService()), presentationMode: .nativeOnly,
            nativeNavigation: NativeNavigationHistory(initial: NativeNavigationLocation("/no-such-route")!),
            loadSettings: { .defaults }, onNavigate: { _ in })
    }

    /// Reads both the NSAccessibility protocol and the attribute API, which some SwiftUI
    /// nodes still answer through, including titles as well as labels and values.
    private func accessibilityStrings(_ object: Any, depth: Int = 0) -> [String] {
        guard depth < 30 else { return [] }
        var own: [String] = []
        var children: [Any] = []
        if let element = object as? any NSAccessibilityProtocol {
            own += [element.accessibilityLabel(), element.accessibilityTitle(), element.accessibilityValue() as? String]
                .compactMap { $0 }
            children += element.accessibilityChildren() ?? []
        }
        if children.isEmpty, let legacy = object as? NSObject,
            legacy.responds(to: #selector(NSObject.accessibilityAttributeValue(_:)))
        {
            own += [NSAccessibility.Attribute.description, .title, .value].compactMap {
                legacy.accessibilityAttributeValue($0) as? String
            }
            children += legacy.accessibilityAttributeValue(.children) as? [Any] ?? []
        }
        return own + children.flatMap { accessibilityStrings($0, depth: depth + 1) }
    }
}

@MainActor
private final class ShellDocumentRequests {
    var hidden: [Bool] = []
}

@MainActor
private final class ShellDocumentProbe: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel("synthetic web document")
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

private struct ShellDocumentProbeView: NSViewRepresentable {
    let probe: ShellDocumentProbe
    func makeNSView(context: Context) -> ShellDocumentProbe { probe }
    func updateNSView(_ view: ShellDocumentProbe, context: Context) {}
}

@MainActor
private func sidebarSplitView(in view: NSView) -> NSSplitView? {
    if let split = view as? NSSplitView, split.isVertical { return split }
    for child in view.subviews {
        if let split = sidebarSplitView(in: child) { return split }
    }
    return nil
}

/// Names every split view (and the hosting view's top levels) with its frame, so a failure on
/// the runner says whether the split view was missing or simply never widened.
@MainActor
private func sidebarDiagnostics(_ host: NSView) -> String {
    var lines = ["host \(host.frame.size)"]
    func walk(_ view: NSView, depth: Int) {
        let name = String(describing: type(of: view))
        if let split = view as? NSSplitView {
            let delegate = split.delegate.map { String(describing: type(of: $0)) } ?? "nil"
            let widths = split.arrangedSubviews.map { "\($0.frame.width)" }.joined(separator: ",")
            lines.append("\(depth) \(name) vertical=\(split.isVertical) width=\(split.bounds.width) arranged=[\(widths)] delegate=\(delegate)")
            for (index, item) in ((split.delegate as? NSSplitViewController)?.splitViewItems ?? []).enumerated() {
                lines.append(
                    "  item\(index) behavior=\(item.behavior.rawValue) min=\(item.minimumThickness) max=\(item.maximumThickness) collapsed=\(item.isCollapsed) holding=\(item.holdingPriority.rawValue) view=\(item.viewController.view.frame.width)")
            }
        } else if depth <= 3 || name.contains("Split") || name.contains("ProbeView") {
            lines.append("\(depth) \(name) \(view.frame.size)")
        }
        for child in view.subviews where depth < 40 { walk(child, depth: depth + 1) }
    }
    walk(host, depth: 0)
    lines.append("guard trace: " + SidebarWidthGuard.trace.joined(separator: " | "))
    return lines.joined(separator: "\n")
}

@MainActor
private final class ShellPresentationWindow<Content: View> {
    let window: NSWindow
    let host: NSHostingView<Content>
    init(_ content: Content) {
        _ = NSApplication.shared
        host = NSHostingView(rootView: content)
        window = ShellPresentationNonKeyWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760), styleMask: [.borderless],
            backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
    }
    func settle(until ready: () -> Bool) throws {
        let deadline = Date().addingTimeInterval(2)
        repeat {
            host.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            if ready() { return }
            NativeAppKitTestApplication.pumpEvents(until: Date().addingTimeInterval(0.01))
        } while Date() < deadline
        try #require(ready())
    }
    func close() {
        window.orderOut(nil)
        window.contentView = nil
        window.close()
    }
}

@MainActor
private final class ShellPresentationNonKeyWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
