#if canImport(AppKit)
    import AppKit
    import Testing
    @testable import VisionNativeUI

    @MainActor @Suite("Native overlay responder ownership")
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
    }
    @MainActor private final class OverlayFieldEditorOwner: NSView, NSTextViewDelegate {}
#endif
