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
    var isWebVisible = false
    var isEditingWebText: (@MainActor () async -> Bool)? = nil
    @Environment(\.visionTheme) private var theme
    @Environment(\.visionVisualEffects) private var effects
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.nativeNoticeAnnouncementsEnabled) private var announcementsEnabled
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 8) {
            ForEach(center.visibleEntries) { entry in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Label(
                            strings.t(entry.notice.key, displayVariables(entry.notice)),
                            systemImage: ActionToast.symbol(entry.notice.kind))
                        if let detail = entry.notice.detail, !detail.isEmpty {
                            Text(detail).font(.footnote).foregroundStyle(theme.secondaryLabel).lineLimit(3)
                        }
                    }
                    if let key = entry.actionTitleKey {
                        Button(strings.t(key)) { Task { await center.performAction(entry.id) } }
                            .buttonStyle(.visionOutline).controlSize(.small)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background {
                    if effects == "reduced" || reduceTransparency {
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.card).fill(theme.card)
                    } else {
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.card).fill(.regularMaterial)
                    }
                }
                .foregroundStyle(
                    entry.notice.kind == .error
                        ? theme.destructive : entry.notice.kind == .warning ? theme.warning : theme.foreground
                )
                .frame(maxWidth: 560)
                .accessibilityElement(children: .contain)
                .task(id: entry.revision) {
                    guard announcementsEnabled else { return }
                    AccessibilityNotification.Announcement(strings.t(entry.notice.key, displayVariables(entry.notice)))
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
        Task {
            if isWebVisible, await isEditingWebText?() ?? true {
                NSApp.sendAction(Selector(("undo:")), to: nil, from: nil)
                return
            }
            await center.consumeUndo()
        }
    }

    private func displayVariables(_ notice: ScreenNotice) -> [String: String] {
        var variables = notice.variables
        if notice.key == "addPortTxn.toast.recorded", let type = variables["type"] {
            variables["type"] = strings.t("portfolio.txnType.\(type)")
        }
        return variables
    }
}
