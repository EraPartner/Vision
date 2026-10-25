import SwiftUI
import VisionNativeCore

/// The web `Textarea` (components/ui/textarea.tsx): `flex min-h-20 w-full rounded-control border
/// border-input/70 bg-background/80 px-3 py-2 type-body shadow-[inset_0_1px_0_0_foreground/0.04]
/// hover:border-input focus-visible:border-primary/60 focus-visible:bg-background/70 focus-ring
/// disabled:opacity-50`, the same chrome as `VisionTextFieldStyle` (`VisionFieldChrome`) around a
/// plain `TextEditor` with its own background hidden.
///
/// A `TextEditor` has no style hook for its focus, so call sites report it, either with
/// `isFocused` here or with `.visionFieldFocused(_:)` further out:
///
///     TextEditor(text: $notes).focused($focus, equals: .notes).visionTextEditor(isFocused: focus == .notes)
struct VisionTextEditorStyle: ViewModifier {
    var isFocused: Bool?
    var minHeight: CGFloat = VisionControlMetrics.textAreaMinHeight

    func body(content: Content) -> some View {
        VisionFieldChrome(
            isFocused: isFocused,
            // `px-3` of the chrome minus the 5 pt `NSTextView` text container inset, so text lines up
            // with a `VisionTextFieldStyle` field.
            horizontalPadding: VisionControlMetrics.fieldHorizontalPadding - Self.textContainerInset,
            verticalPadding: VisionControlMetrics.textAreaVerticalPadding - Self.textContainerInset,
            minHeight: minHeight, alignment: .topLeading
        ) {
            content
                .textEditorStyle(.plain)
                .scrollContentBackground(.hidden)
                .font(VisionControlMetrics.fieldFont)
        }
    }

    /// The horizontal inset `NSTextView` adds around its text.
    private static var textContainerInset: CGFloat { 5 }
}

extension View {
    /// Styles a `TextEditor` as the web `Textarea`; `minHeight` defaults to `min-h-20` (80 pt).
    func visionTextEditor(isFocused: Bool? = nil, minHeight: CGFloat = VisionControlMetrics.textAreaMinHeight)
        -> some View
    {
        modifier(VisionTextEditorStyle(isFocused: isFocused, minHeight: minHeight))
    }
}
