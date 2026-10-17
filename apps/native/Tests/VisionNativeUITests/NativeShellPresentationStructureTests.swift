import AppKit
import SwiftUI
import Testing
import VisionNativeCore

@testable import VisionNativeUI

@MainActor
@Suite("Native shell document presentation", .serialized)
struct NativeShellPresentationStructureTests {
    init() throws { try NativeAppKitTestApplication.prepare() }

    @Test func helperRemainsMountedButHiddenAndInaccessibleAcrossNativePresentationStates() async throws {
        let shell = makeHelperShell()
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
        let states: [(NativeHelperDocumentState, NativeShellDetail)] = [
            (.loading, .loading), (.ready, .notFound), (.failed, .unavailable), (.loading, .loading),
        ]
        for (state, expected) in states {
            shell.setHelperDocumentState(state)
            #expect(shell.detail == expected)
            try fixture.settle(until: { probe.window === fixture.window })
            #expect(probe.isHiddenOrHasHiddenAncestor)
            let enclosure = try #require(hiddenAncestor(of: probe))
            #expect(enclosure.hitTest(NSPoint(x: 1, y: 1)) == nil)
            #expect(enclosure.accessibilityChildren()?.isEmpty == true)
            #expect(!requests.hidden.isEmpty && requests.hidden.allSatisfy { $0 })
            #expect(!accessibilityStrings(fixture.host).contains("synthetic helper document"))
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
        #expect(probe.accessibilityLabel() == "synthetic helper document")
        #expect(probe.hitTest(NSPoint(x: 1, y: 1)) === probe)
        #expect(!requests.hidden.isEmpty && requests.hidden.allSatisfy { !$0 })
    }

    @Test(arguments: [NativeShellDetail.loading, .unavailable])
    func startupAndFailureHaveNativeAccessibleContent(_ detail: NativeShellDetail) throws {
        let strings = DictionaryStrings(
            language: .en,
            table: [
                "common.loading": "Synthetic loading", "common.error": "Synthetic unavailable",
            ])
        let expected = detail == .loading ? "Synthetic loading" : "Synthetic unavailable"
        let request = NativeAppKitTestApplication.requestAccessibilityClientMode()
        let fixture = ShellPresentationWindow(NativeShellUnavailableView(detail: detail, strings: strings))
        defer { fixture.close() }
        try fixture.settle(
            until: { accessibilityStrings(fixture.host).contains(expected) },
            diagnostics: { request + "\n" + accessibilityDump(fixture.host) })
        #expect(accessibilityStrings(fixture.host).contains(expected))
    }

    private func makeHelperShell() -> NativeShellModel {
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
            recipients: RecipientsModel(service: StaticRecipientsService()), presentationMode: .helperDocument,
            nativeNavigation: NativeNavigationHistory(initial: NativeNavigationLocation("/no-such-route")!),
            loadSettings: { .defaults }, onNavigate: { _ in })
    }

    private func hiddenAncestor(of view: NSView) -> NSView? {
        var candidate = view.superview
        while let current = candidate {
            if current.isHidden { return current }
            candidate = current.superview
        }
        return nil
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

    private func accessibilityDump(_ object: Any, depth: Int = 0) -> String {
        guard depth < 8 else { return "" }
        let element = object as? any NSAccessibilityProtocol
        let children = element?.accessibilityChildren() ?? []
        let line = String(repeating: "  ", count: depth) + "\(type(of: object)) role=\(element?.accessibilityRole()?.rawValue ?? "-") children=\(children.count) strings=\(accessibilityStrings(object, depth: 29))"
        return ([line] + children.map { accessibilityDump($0, depth: depth + 1) }).joined(separator: "\n")
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
        setAccessibilityLabel("synthetic helper document")
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
    func settle(until ready: () -> Bool, diagnostics: () -> String = { "" }) throws {
        let deadline = Date().addingTimeInterval(2)
        repeat {
            host.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            if ready() { return }
            NativeAppKitTestApplication.pumpEvents(until: Date().addingTimeInterval(0.01))
        } while Date() < deadline
        try #require(ready(), "\(diagnostics())")
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
