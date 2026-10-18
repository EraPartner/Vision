import AppKit
import SwiftUI
import VisionNativeCore

struct AIChatComposer: View {
    let model: AIChatModel
    let shell: NativeShellModel
    @State private var textHeight: CGFloat = 44
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var streaming: Bool { model.streamSnapshot.isStreaming }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 16) {
                Picker(
                    strings.t("aiChat.model"),
                    selection: Binding(
                        get: { model.activeModel ?? model.models.first?.name ?? "" }, set: { model.modelOverride = $0 })
                ) {
                    if model.models.isEmpty { Text(strings.t("aiChat.selectModel")).tag("") }
                    ForEach(model.models) { item in Text(item.name).tag(item.name) }
                }.frame(maxWidth: 300).disabled(model.status?.ok != true || model.models.isEmpty)
                Toggle(
                    strings.t(model.useTools ? "aiChat.toolsOn" : "aiChat.toolsOff"),
                    isOn: Binding(get: { model.useTools }, set: { model.useTools = $0 })
                )
                .toggleStyle(.switch).fixedSize().disabled(model.composerDisabled || streaming)
                .accessibilityLabel(strings.t("aiChat.tools"))
                Spacer(minLength: 0)
            }.font(.footnote)
            HStack(alignment: .bottom, spacing: 8) {
                ZStack(alignment: .topLeading) {
                    if model.draft.isEmpty {
                        Text(strings.t("aiChat.composerPlaceholder")).foregroundStyle(theme.tertiaryLabel)
                            .padding(.horizontal, 7).padding(.vertical, 9).allowsHitTesting(false)
                    }
                    AIChatDraftEditor(
                        text: Binding(
                            get: { model.draft }, set: { model.draft = AIChatTextLimit.prefix($0, utf16: 4000) }),
                        height: $textHeight, enabled: !model.composerDisabled && !streaming,
                        label: strings.t("aiChat.composerPlaceholder"), foreground: theme.palette.foreground,
                        onSend: send
                    )
                    .frame(height: textHeight)
                }.padding(4)
                    .background(theme.background, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control))
                    .overlay(RoundedRectangle(cornerRadius: DesignTokens.Radius.control).stroke(theme.border))
                Button {
                    if streaming { model.stop() } else { send() }
                } label: {
                    Image(systemName: streaming ? "stop.fill" : "paperplane.fill").frame(width: 24, height: 24)
                }
                .buttonStyle(.borderedProminent).disabled(!streaming && !model.canSend)
                .accessibilityLabel(strings.t(streaming ? "aiChat.stop" : "aiChat.send"))
            }
            HStack {
                Text(strings.t("aiChat.enterHint"))
                Spacer()
                Text(String(model.draft.utf16.count) + "/4000").monospacedDigit()
            }.font(.caption).foregroundStyle(theme.tertiaryLabel)
        }.frame(maxWidth: 768).frame(maxWidth: .infinity).padding(.horizontal, 16).padding(.vertical, 12)
            .background(theme.card).overlay(alignment: .top) { Divider().opacity(0.6) }
    }
    private func send() {
        guard model.canSend else { return }
        Task { await model.send() }
    }
}

enum AIChatTextLimit {
    static func prefix(_ text: String, utf16 limit: Int) -> String {
        guard text.utf16.count > limit else { return text }
        var result = String.UnicodeScalarView()
        var count = 0
        for scalar in text.unicodeScalars {
            let size = scalar.value > 0xFFFF ? 2 : 1
            guard count + size <= limit else { break }
            result.append(scalar)
            count += size
        }
        return String(result)
    }
}

private struct AIChatDraftEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    let enabled: Bool
    let label: String
    let foreground: HSLColor
    let onSend: () -> Void
    @Environment(\.isEnabled) private var environmentEnabled

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true
        let editor = DraftTextView()
        editor.delegate = context.coordinator
        editor.isRichText = false
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.allowsUndo = true
        editor.drawsBackground = false
        editor.font = .preferredFont(forTextStyle: .body)
        editor.textColor = .labelColor
        editor.textContainerInset = NSSize(width: 3, height: 5)
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.textContainer?.containerSize = NSSize(width: scroll.contentSize.width, height: .greatestFiniteMagnitude)
        editor.send = onSend
        scroll.documentView = editor
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let editor = scroll.documentView as? DraftTextView else { return }
        if editor.string != text {
            editor.string = text
            editor.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
        }
        let rgb = foreground.rgb
        editor.textColor = NSColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
        editor.insertionPointColor = editor.textColor ?? .labelColor
        editor.isEditable = enabled && environmentEnabled
        if !editor.isEditable, editor.window?.firstResponder === editor { editor.window?.makeFirstResponder(nil) }
        editor.isSelectable = true
        editor.send = onSend
        editor.setAccessibilityLabel(label)
        context.coordinator.updateHeight(editor)
    }
    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: AIChatDraftEditor
        init(_ parent: AIChatDraftEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            let limited = AIChatTextLimit.prefix(editor.string, utf16: 4000)
            if limited != editor.string { editor.string = limited }
            parent.text = limited
            updateHeight(editor)
        }
        func updateHeight(_ editor: NSTextView) {
            guard let container = editor.textContainer, let layout = editor.layoutManager else { return }
            layout.ensureLayout(for: container)
            let newHeight = min(
                200, max(44, ceil(layout.usedRect(for: container).height + 2 * editor.textContainerInset.height)))
            guard abs(parent.height - newHeight) > 1 else { return }
            let parent = parent
            Task { @MainActor in parent.height = newHeight }
        }
    }
}

@MainActor private final class DraftTextView: NSTextView {
    var send: (() -> Void)?
    override func keyDown(with event: NSEvent) {
        if isEditable && (event.keyCode == 36 || event.keyCode == 76) && !event.modifierFlags.contains(.shift)
            && !hasMarkedText()
        {
            send?()
            return
        }
        super.keyDown(with: event)
    }
}
