import AppKit
import SwiftUI

/// Native mixed-state checkbox retains the source All control's partial selection state.
struct NativeReportAllSectionsCheckbox: NSViewRepresentable {
    let title: String
    let all: Bool
    let some: Bool
    let change: () -> Void
    @Environment(\.isEnabled) private var enabled
    func makeCoordinator() -> Coordinator { Coordinator(change: change) }
    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(
            checkboxWithTitle: title, target: context.coordinator, action: #selector(Coordinator.changed))
        button.allowsMixedState = true
        button.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return button
    }
    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.change = change
        button.title = title
        button.state = all ? .on : some ? .mixed : .off
        button.isEnabled = enabled
        button.setAccessibilityLabel(title)
    }
    @MainActor final class Coordinator: NSObject {
        var change: () -> Void
        init(change: @escaping () -> Void) { self.change = change }
        @objc func changed() { change() }
    }
}
