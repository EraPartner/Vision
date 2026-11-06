import AppKit
import SwiftUI
import VisionNativeCore

private struct NativeNoticeCenterKey: EnvironmentKey {
    static let defaultValue: NativeNoticeCenter? = nil
}

private struct NativeNoticeAnnouncementsKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    var nativeNoticeCenter: NativeNoticeCenter? {
        get { self[NativeNoticeCenterKey.self] }
        set { self[NativeNoticeCenterKey.self] = newValue }
    }
    var nativeNoticeAnnouncementsEnabled: Bool {
        get { self[NativeNoticeAnnouncementsKey.self] }
        set { self[NativeNoticeAnnouncementsKey.self] = newValue }
    }
}

/// App-lifetime presentation; route changes never restart a notice's deadline.
struct NativeNoticeHost: View {
    let center: NativeNoticeCenter
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme
    @Environment(\.nativeNoticeAnnouncementsEnabled) private var announcementsEnabled
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 8) {
            ForEach(center.visibleEntries) { entry in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Label(
                            title(entry.notice),
                            systemImage: ActionToast.symbol(entry.notice.kind))
                        if let detail = entry.notice.detail, !detail.isEmpty {
                            Text(detail).font(.footnote).foregroundStyle(theme.secondaryLabel).lineLimit(3)
                        }
                    }
                    if let key = entry.actionTitleKey {
                        Button(strings.t(key.rawValue)) { Task { await center.performAction(entry.id) } }
                            .buttonStyle(.visionOutline).controlSize(.small)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background { ToastSurface() }
                .foregroundStyle(
                    entry.notice.kind == .error
                        ? theme.destructive : entry.notice.kind == .warning ? theme.warning : theme.foreground
                )
                .frame(maxWidth: 560)
                .accessibilityElement(children: .contain)
                .task(id: entry.revision) {
                    guard announcementsEnabled else { return }
                    AccessibilityNotification.Announcement(title(entry.notice))
                        .post()
                }
            }
        }
        .padding(.bottom, 20)
        .focusable().focused($focused)
        .onChange(of: center.focusRevision) { _, _ in
            if announcementsEnabled, !center.visibleEntries.isEmpty { focused = true }
        }
        .background {
            Group {
                Button("", action: undoShortcut)
                    .keyboardShortcut("z", modifiers: .command)
                    .disabled(!announcementsEnabled || !center.hasUndo)
                Button("", action: center.requestFocus)
                    .keyboardShortcut("t", modifiers: .option)
                    .disabled(!announcementsEnabled || center.visibleEntries.isEmpty)
            }.opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
        }
    }

    private func undoShortcut() {
        if let editor = NSApp.keyWindow?.firstResponder as? NSTextView, editor.isEditable {
            NSApp.sendAction(Selector(("undo:")), to: nil, from: nil)
            return
        }
        Task { await center.consumeUndo() }
    }

    /// The localized title, then the `titleSuffixVariable` value when there is one.
    private func title(_ notice: ScreenNotice) -> String {
        let text = strings.t(notice.key, displayVariables(notice))
        guard let suffix = notice.variables[ScreenNotice.titleSuffixVariable], !suffix.isEmpty else { return text }
        return text + " " + suffix
    }

    private func displayVariables(_ notice: ScreenNotice) -> [String: String] {
        var variables = notice.variables
        if notice.key == "addPortTxn.toast.recorded", let type = variables["type"] {
            variables["type"] = strings.t("portfolio.txnType.\(type)")
        }
        return variables
    }
}
