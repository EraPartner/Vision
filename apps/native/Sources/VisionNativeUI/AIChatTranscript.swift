import SwiftUI
import VisionNativeCore

struct AIChatTranscript: View {
    let model: AIChatModel
    let shell: NativeShellModel
    let isVisible: Bool
    @State private var pinned = true
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var snapshot: AIChatStreamSnapshot { model.streamSnapshot }
    private var thinking: Bool {
        snapshot.isStreaming && snapshot.assistantDraft.isEmpty && snapshot.toolMessages.isEmpty
    }
    private var terminal: Bool { ["stopped", "interrupted", "timed_out"].contains(snapshot.status.rawValue) }
    private var signature: String {
        [
            model.selectedID ?? "", String(model.messages.count), model.messages.last?.id ?? "",
            String(snapshot.assistantDraft.utf16.count),
            String(snapshot.toolMessages.reduce(0) { $0 + ($1.content?.utf16.count ?? 0) }), snapshot.status.rawValue,
        ].joined(separator: "|")
    }
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if model.messages.isEmpty && snapshot.assistantDraft.isEmpty && !thinking && !terminal
                        && !model.composerDisabled
                    {
                        VStack(spacing: 14) {
                            Image(systemName: "bubble.left.and.bubble.right").font(.largeTitle).foregroundStyle(
                                theme.primary)
                            Text(strings.t("aiChat.emptyTitle")).font(.title3.weight(.semibold))
                            Text(strings.t("aiChat.emptyState")).font(.callout).foregroundStyle(theme.secondaryLabel)
                                .multilineTextAlignment(.center)
                            Button(strings.t("aiChat.insightsDigestButton"), systemImage: "sparkles") {
                                Task { await model.digest(prompt: strings.t("aiChat.insightsDigestPrompt")) }
                            }.buttonStyle(.bordered).disabled(model.composerDisabled)
                        }.padding(24).frame(maxWidth: .infinity).background(
                            theme.muted, in: RoundedRectangle(cornerRadius: 12))
                    }
                    ForEach(model.messages) { message in
                        AIChatBubble(message: message, shell: shell)
                    }
                    if !snapshot.assistantDraft.isEmpty {
                        AIChatTextBubble(
                            role: "assistant", content: snapshot.assistantDraft, streaming: snapshot.isStreaming,
                            shell: shell)
                    }
                    if terminal {
                        HStack(spacing: 14) {
                            Text(
                                strings.t(
                                    snapshot.status.rawValue == "stopped"
                                        ? "aiChat.streamStopped"
                                        : snapshot.status.rawValue == "timed_out"
                                            ? "aiChat.streamTimedOut" : "aiChat.streamInterrupted")
                            )
                            .font(.callout).foregroundStyle(theme.secondaryLabel)
                            Spacer()
                            if snapshot.lastRequest != nil && !model.composerDisabled {
                                Button(strings.t("common.retry")) { Task { await model.retryLastTurn() } }.buttonStyle(
                                    .bordered)
                            }
                        }.padding(12).background(theme.muted, in: RoundedRectangle(cornerRadius: 10))
                    }
                    if thinking {
                        HStack(spacing: 12) {
                            AIChatAvatar(role: "assistant")
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text(strings.t("aiChat.thinking")).font(.callout).foregroundStyle(theme.secondaryLabel)
                            }.padding(12).background(theme.muted, in: RoundedRectangle(cornerRadius: 12))
                        }.accessibilityElement(children: .combine)
                    }
                    Color.clear.frame(height: 1).id("chat-bottom").accessibilityHidden(true)
                }.padding(20).frame(maxWidth: 850).frame(maxWidth: .infinity)
            }.onScrollGeometryChange(for: ChatScrollPosition.self) { geometry in
                ChatScrollPosition(
                    top: geometry.contentOffset.y, distance: geometry.contentSize.height - geometry.visibleRect.maxY)
            } action: { old, new in
                guard isVisible else { return }
                if new.distance <= 8 { pinned = true } else if new.top < old.top { pinned = false }
            }
            .onChange(of: signature) { _, _ in follow(proxy) }
            .onChange(of: model.messages.last?.id) { _, _ in
                guard isVisible, let message = model.messages.last, message.role == "assistant",
                    let content = message.content, !content.isEmpty
                else { return }
                AccessibilityNotification.Announcement(content).post()
            }
            .onChange(of: snapshot.status) { _, status in
                guard isVisible else { return }
                let key: String? =
                    status == .stopped
                    ? "aiChat.streamStopped"
                    : status == .timedOut
                        ? "aiChat.streamTimedOut" : status == .interrupted ? "aiChat.streamInterrupted" : nil
                if let key { AccessibilityNotification.Announcement(strings.t(key)).post() }
            }
            .onChange(of: thinking) { _, value in
                if value && isVisible { AccessibilityNotification.Announcement(strings.t("aiChat.thinking")).post() }
            }
            .onChange(of: model.selectedID) { _, _ in
                pinned = true
                follow(proxy)
            }
            .onChange(of: snapshot.userMessage?.id) { _, id in
                if id != nil {
                    pinned = true
                    follow(proxy)
                }
            }
            .onChange(of: isVisible) { _, visible in if visible { follow(proxy) } }
            .onAppear { follow(proxy) }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityLabel(strings.t("aiChat.mode.chat"))
    }
    private func follow(_ proxy: ScrollViewProxy) {
        guard isVisible && pinned else { return }
        Task { @MainActor in
            await Task.yield()
            guard isVisible && pinned else { return }
            proxy.scrollTo("chat-bottom", anchor: .bottom)
        }
    }
}

private struct ChatScrollPosition: Equatable {
    let top: CGFloat
    let distance: CGFloat
}

struct AIChatBubble: View {
    let message: AIChatMessage
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    var body: some View {
        if message.role == "tool" {
            HStack(alignment: .top, spacing: 12) {
                AIChatAvatar(role: "tool")
                VStack(alignment: .leading, spacing: 10) {
                    Label(message.toolName ?? shell.strings.t("aiChat.toolResult"), systemImage: "wrench")
                        .font(.caption.weight(.medium)).foregroundStyle(theme.secondaryLabel)
                    if let result = message.toolResult {
                        AIChatToolResultCard(result: result, presentation: message.toolPresentation, shell: shell)
                    } else {
                        Text(shell.strings.t("aiChat.noDataReturned")).font(.caption).foregroundStyle(
                            theme.secondaryLabel)
                    }
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(theme.card, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(theme.border.opacity(0.6)))
            }
        } else {
            AIChatTextBubble(role: message.role, content: message.content ?? "", streaming: false, shell: shell)
        }
    }
}

struct AIChatTextBubble: View {
    let role: String
    let content: String
    let streaming: Bool
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    private var user: Bool { role == "user" }
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if user { Spacer(minLength: 30) } else { AIChatAvatar(role: role) }
            HStack(alignment: .bottom, spacing: 3) {
                Text(verbatim: content).font(.body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                if streaming {
                    Rectangle().fill(theme.primary).frame(width: 2, height: 13)
                        .phaseAnimator([false, true]) { view, phase in view.opacity(reducedMotion || phase ? 1 : 0.25) }
                        .accessibilityHidden(true)
                }
            }.padding(.horizontal, 16).padding(.vertical, 12)
                .foregroundStyle(user ? theme.primaryForeground : theme.foreground)
                .background(user ? theme.primary : theme.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(user ? .clear : theme.border.opacity(0.6)))
            if user { AIChatAvatar(role: role) } else { Spacer(minLength: 30) }
        }
    }
}

struct AIChatAvatar: View {
    let role: String
    @Environment(\.visionTheme) private var theme
    var body: some View {
        Image(systemName: role == "user" ? "person" : role == "tool" ? "wrench" : "sparkles")
            .font(.callout).foregroundStyle(role == "tool" ? theme.secondaryLabel : theme.primary)
            .frame(width: 32, height: 32).background(theme.primary.opacity(0.1), in: Circle()).accessibilityHidden(true)
    }
}
