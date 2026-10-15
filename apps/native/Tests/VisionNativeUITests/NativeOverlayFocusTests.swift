#if canImport(AppKit)
    import AppKit
    import Testing
    import VisionNativeCore
    @testable import VisionNativeUI

    @MainActor @Suite("Native overlay responder ownership", .serialized)
    struct NativeOverlayFocusTests {
        @Test func sharedFieldEditorCapturesItsOwnerAndCaretRatherThanTheSharedEditor() throws {
            let owner = OverlayFieldEditorOwner(frame: .zero)
            let editor = NSTextView(frame: .zero)
            editor.isFieldEditor = true
            editor.delegate = owner
            editor.string = "synthetic draft"
            editor.setSelectedRange(NSRange(location: 4, length: 2))
            let snapshot = try #require(NativeOverlayFocusSnapshot.capture(editor))
            #expect(snapshot.view === owner)
            #expect(snapshot.view !== editor)
            #expect(snapshot.selection == NSRange(location: 4, length: 2))
        }
        @Test func fieldEditorWithoutAnOwnerCannotBecomeAnotherControlsReturnTarget() {
            let editor = NSTextView(frame: .zero)
            editor.isFieldEditor = true
            #expect(NativeOverlayFocusSnapshot.capture(editor) == nil)
        }
        @Test func standaloneEditorPreservesItsOwnSelection() throws {
            let editor = NSTextView(frame: .zero)
            editor.string = "synthetic draft"
            editor.setSelectedRange(NSRange(location: 3, length: 0))
            let snapshot = try #require(NativeOverlayFocusSnapshot.capture(editor))
            #expect(snapshot.view === editor)
            #expect(snapshot.selection == NSRange(location: 3, length: 0))
        }
        @Test func snapshotsDoNotKeepClosedOverlayControlsAlive() throws {
            var owner: OverlayFieldEditorOwner? = .init(frame: .zero)
            let snapshot = NativeOverlayFocusSnapshot(view: try #require(owner))
            owner = nil
            #expect(snapshot.view == nil)
        }

        @Test func coveredOverlaysRestoreTheirOwnAttachedResponder() async throws {
            let fixture = try OverlayFocusWindow()
            defer { fixture.close() }
            let graph = NSObject()
            let context = NativeOverlayFocusContext(graph: ObjectIdentifier(graph), route: .home)
            let coordinator = NativeOverlayFocusBridge.Coordinator(kind: .settings, context: context)
            coordinator.attach(fixture.marker)
            defer { coordinator.stop() }
            try #require(fixture.window.makeFirstResponder(fixture.opener))
            coordinator.update(.palette, context: context)
            try #require(fixture.window.makeFirstResponder(fixture.other))
            await coordinator.update(.settings, context: context)?.value
            #expect(fixture.window.firstResponder === fixture.opener)
            await coordinator.update(.palette, context: context)?.value
            #expect(fixture.window.firstResponder === fixture.other)
        }

        @Test func finalDismissalReturnsToTheRouteOpenerOnlyAfterTheSheetEnds() async throws {
            let fixture = try OverlayFocusWindow()
            defer { fixture.close() }
            let graph = NSObject()
            let context = NativeOverlayFocusContext(graph: ObjectIdentifier(graph), route: .home)
            let coordinator = NativeOverlayFocusReturnCoordinator()
            coordinator.attach(fixture.marker)
            defer { coordinator.stop() }
            coordinator.update(context, isPresented: false)
            try #require(fixture.window.makeFirstResponder(fixture.opener))
            coordinator.update(context, isPresented: true)
            try #require(fixture.window.makeFirstResponder(fixture.other))
            coordinator.update(context, isPresented: false)
            #expect(fixture.window.firstResponder === fixture.other)
            await coordinator.didDismiss(context: context, isPresented: false)?.value
            #expect(fixture.window.firstResponder === fixture.opener)
        }

        @Test func finalDismissalRestoresFieldOwnerAndSelectionRatherThanTheSharedEditor() async throws {
            let fixture = try OverlayFocusWindow()
            defer { fixture.close() }
            let field = NSTextField(string: "synthetic route draft")
            field.frame = NSRect(x: 10, y: 100, width: 220, height: 24)
            fixture.content.addSubview(field)
            field.selectText(nil)
            let originalEditor = try #require(fixture.window.firstResponder as? NSTextView)
            let selection = NSRange(location: 5, length: 4)
            originalEditor.setSelectedRange(selection)
            let graph = NSObject()
            let context = NativeOverlayFocusContext(graph: ObjectIdentifier(graph), route: .home)
            let coordinator = NativeOverlayFocusReturnCoordinator()
            coordinator.attach(fixture.marker)
            defer { coordinator.stop() }
            coordinator.update(context, isPresented: false)
            coordinator.update(context, isPresented: true)
            try #require(fixture.window.makeFirstResponder(fixture.other))
            await coordinator.didDismiss(context: context, isPresented: false)?.value
            let restoredEditor = try #require(fixture.window.firstResponder as? NSTextView)
            let snapshot = try #require(NativeOverlayFocusSnapshot.capture(restoredEditor))
            #expect(snapshot.view === field)
            #expect(restoredEditor.selectedRange() == selection)
        }

        @Test func detachedFieldOwnerCannotRedirectTheSharedEditorOfAnotherField() async throws {
            let fixture = try OverlayFocusWindow()
            defer { fixture.close() }
            let original = NSTextField(string: "synthetic opener draft")
            let current = NSTextField(string: "synthetic current draft")
            original.frame = NSRect(x: 10, y: 100, width: 220, height: 24)
            current.frame = NSRect(x: 10, y: 140, width: 220, height: 24)
            fixture.content.addSubview(original)
            fixture.content.addSubview(current)
            original.selectText(nil)
            _ = try #require(fixture.window.firstResponder as? NSTextView)
            let graph = NSObject()
            let context = NativeOverlayFocusContext(graph: ObjectIdentifier(graph), route: .home)
            let coordinator = NativeOverlayFocusReturnCoordinator()
            coordinator.attach(fixture.marker)
            defer { coordinator.stop() }
            coordinator.update(context, isPresented: false)
            coordinator.update(context, isPresented: true)
            current.selectText(nil)
            let currentEditor = try #require(fixture.window.firstResponder as? NSTextView)
            let selection = NSRange(location: 3, length: 2)
            currentEditor.setSelectedRange(selection)
            original.removeFromSuperview()
            await coordinator.didDismiss(context: context, isPresented: false)?.value
            #expect(fixture.window.firstResponder === currentEditor)
            #expect(NativeOverlayFocusSnapshot.capture(currentEditor)?.view === current)
            #expect(currentEditor.selectedRange() == selection)
        }

        @Test(arguments: ["detached", "anotherWindow", "hidden", "disabled", "detachedMarker"])
        func finalDismissalCannotRestoreAnUnavailableOrReparentedControl(_ change: String) async throws {
            let fixture = try OverlayFocusWindow()
            let second = try OverlayFocusWindow()
            defer {
                second.close()
                fixture.close()
            }
            try fixture.makeKey()
            let graph = NSObject()
            let context = NativeOverlayFocusContext(graph: ObjectIdentifier(graph), route: .home)
            let coordinator = NativeOverlayFocusReturnCoordinator()
            coordinator.attach(fixture.marker)
            defer { coordinator.stop() }
            coordinator.update(context, isPresented: false)
            try #require(fixture.window.makeFirstResponder(fixture.opener))
            coordinator.update(context, isPresented: true)
            try #require(fixture.window.makeFirstResponder(fixture.other))
            switch change {
            case "detached": fixture.opener.removeFromSuperview()
            case "anotherWindow": second.content.addSubview(fixture.opener)
            case "hidden": fixture.opener.isHidden = true
            case "disabled": fixture.opener.isEnabled = false
            default: fixture.marker.removeFromSuperview()
            }
            await coordinator.didDismiss(context: context, isPresented: false)?.value
            #expect(fixture.window.firstResponder === fixture.other)
            #expect(second.window.firstResponder !== fixture.opener)
        }

        @Test(arguments: ["graph", "route", "query", "restore"])
        func routeGraphAndRestoreChangesRetireTheOpener(_ change: String) async throws {
            let fixture = try OverlayFocusWindow()
            defer { fixture.close() }
            let graph = NSObject()
            let replacementGraph = NSObject()
            let context = NativeOverlayFocusContext(graph: ObjectIdentifier(graph), route: .home)
            let coordinator = NativeOverlayFocusReturnCoordinator()
            coordinator.attach(fixture.marker)
            defer { coordinator.stop() }
            coordinator.update(context, isPresented: false)
            try #require(fixture.window.makeFirstResponder(fixture.opener))
            coordinator.update(context, isPresented: true)
            try #require(fixture.window.makeFirstResponder(fixture.other))
            let changed = NativeOverlayFocusContext(
                graph: ObjectIdentifier(change == "graph" ? replacementGraph : graph),
                route: NativeRoute(
                    change == "route" ? "/accounts" : change == "query" ? "/?period=all" : "/")!,
                isBlocked: change == "restore")
            await coordinator.didDismiss(context: changed, isPresented: false)?.value
            #expect(fixture.window.firstResponder === fixture.other)
        }

        @Test func settingsAndExportQueryChangesKeepTheSameUnderlyingVisit() async throws {
            let fixture = try OverlayFocusWindow()
            defer { fixture.close() }
            let graph = NSObject()
            let plain = NativeOverlayFocusContext(
                graph: ObjectIdentifier(graph), route: NativeRoute("/statistics?period=all")!)
            let covered = NativeOverlayFocusContext(
                graph: ObjectIdentifier(graph),
                route: NativeRoute("/statistics?period=all&export=pdf&settings=general")!)
            let coordinator = NativeOverlayFocusReturnCoordinator()
            coordinator.attach(fixture.marker)
            defer { coordinator.stop() }
            coordinator.update(plain, isPresented: false)
            try #require(fixture.window.makeFirstResponder(fixture.opener))
            coordinator.update(covered, isPresented: true)
            try #require(fixture.window.makeFirstResponder(fixture.other))
            await coordinator.didDismiss(context: plain, isPresented: false)?.value
            #expect(fixture.window.firstResponder === fixture.opener)
        }

        @Test func dismissalDoesNotStealFocusFromAnotherWindowOrANewOverlay() async throws {
            let fixture = try OverlayFocusWindow()
            defer { fixture.close() }
            let graph = NSObject()
            let context = NativeOverlayFocusContext(graph: ObjectIdentifier(graph), route: .home)
            let coordinator = NativeOverlayFocusReturnCoordinator()
            coordinator.attach(fixture.marker)
            defer { coordinator.stop() }
            coordinator.update(context, isPresented: false)
            try #require(fixture.window.makeFirstResponder(fixture.opener))
            coordinator.update(context, isPresented: true)
            try #require(fixture.window.makeFirstResponder(fixture.other))
            let second = try OverlayFocusWindow()
            defer { second.close() }
            try #require(second.window.makeFirstResponder(second.opener))
            await coordinator.didDismiss(context: context, isPresented: false)?.value
            #expect(second.window.firstResponder === second.opener)
            #expect(fixture.window.firstResponder === fixture.other)

            try fixture.makeKey()
            try #require(fixture.window.makeFirstResponder(fixture.opener))
            coordinator.update(context, isPresented: true)
            try #require(fixture.window.makeFirstResponder(fixture.other))
            let pendingReturn = coordinator.didDismiss(context: context, isPresented: false)
            coordinator.update(context, isPresented: true)
            await pendingReturn?.value
            #expect(fixture.window.firstResponder === fixture.other)
        }
    }
    @MainActor private final class OverlayFieldEditorOwner: NSView, NSTextViewDelegate {}

    @MainActor private final class OverlayFocusableControl: NSButton {
        override var acceptsFirstResponder: Bool { true }
    }

    @MainActor private struct OverlayFocusWindow {
        private static var applicationPrepared = false
        let window: NSWindow
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 240))
        let marker = NSView(frame: .zero)
        let opener = OverlayFocusableControl(frame: NSRect(x: 10, y: 10, width: 80, height: 24))
        let other = OverlayFocusableControl(frame: NSRect(x: 10, y: 50, width: 80, height: 24))
        init() throws {
            let application = NSApplication.shared
            if !Self.applicationPrepared {
                // A command-line swift-test process starts without the app target's
                // activation policy and application event loop. An ordered window
                // alone is not evidence that AppKit granted it keyboard ownership.
                if application.activationPolicy() == .prohibited {
                    try #require(application.setActivationPolicy(.accessory))
                }
                application.finishLaunching()
                Self.applicationPrepared = true
            }
            window = NSWindow(
                contentRect: NSRect(x: -10_000, y: -10_000, width: 320, height: 240),
                styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            content.addSubview(marker)
            content.addSubview(opener)
            content.addSubview(other)
            window.contentView = content
            do { try makeKey() } catch {
                close()
                throw error
            }
        }
        func makeKey() throws {
            let application = NSApplication.shared
            application.activate()
            window.makeKeyAndOrderFront(nil)
            window.makeKey()
            let deadline = Date().addingTimeInterval(2)
            while (!application.isActive || application.keyWindow !== window || !window.isKeyWindow)
                && Date() < deadline
            {
                if let event = application.nextEvent(
                    matching: .any, until: Date().addingTimeInterval(0.01), inMode: .default, dequeue: true)
                {
                    application.sendEvent(event)
                }
                application.updateWindows()
                window.makeKey()
            }
            try #require(
                application.isActive && application.keyWindow === window && window.isKeyWindow,
                "Synthetic fixture must activate and own AppKit's actual key window before testing responder restoration")
        }
        func close() {
            window.orderOut(nil)
            window.contentView = nil
            window.close()
        }
    }
#endif
