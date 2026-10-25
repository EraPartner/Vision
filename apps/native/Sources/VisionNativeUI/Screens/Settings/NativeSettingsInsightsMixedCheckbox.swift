import AppKit
import SwiftUI
import VisionNativeCore

/// NSButton supplies a real, keyboard-accessible macOS mixed-state checkbox.
struct NativeSettingsInsightsMixedCheckbox: NSViewRepresentable {
    let title: String
    let state: NativeSettingsInsightsQuery.CheckState
    let foreground: HSLColor
    let toggle: () -> Void
    @Environment(\.isEnabled) private var enabled
    func makeCoordinator() -> Coordinator { Coordinator(toggle: toggle) }
    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(
            checkboxWithTitle: title, target: context.coordinator, action: #selector(Coordinator.changed))
        button.allowsMixedState = true
        button.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return button
    }
    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.toggle = toggle
        let rgb = foreground.rgb
        button.attributedTitle = NSAttributedString(
            string: title,
            attributes: [
                .font: NSFont.preferredFont(forTextStyle: .headline),
                .foregroundColor: NSColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1),
            ])
        button.state = state == .on ? .on : state == .mixed ? .mixed : .off
        button.isEnabled = enabled
        button.setAccessibilityLabel(title)
    }
    @MainActor final class Coordinator: NSObject {
        var toggle: () -> Void
        init(toggle: @escaping () -> Void) { self.toggle = toggle }
        @objc func changed() { toggle() }
    }
}
