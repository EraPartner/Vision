import SwiftUI
import VisionNativeCore

public struct AIChatView: View {
    let model: AIChatModel
    let investigation: AIInvestigationModel
    let shell: NativeShellModel
    @State private var conversationsOpen = false
    @State private var width: CGFloat = 0
    @Environment(\.visionTheme) private var theme

    public init(model: AIChatModel, investigation: AIInvestigationModel, shell: NativeShellModel) {
        self.model = model
        self.investigation = investigation
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private var isChat: Bool { model.mode == .chat }
    private var statusLoading: Bool { model.isLoadingStatus && model.status == nil }
    private var conversationTitle: String {
        guard let title = model.detail?.conversation.title, !title.isEmpty else { return strings.t("aiChat.mode.chat") }
        return title
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VisionPageHeader(
                title: strings.t("aiChat.title"),
                subtitle: strings.t(isChat ? "aiChat.mode.chatHint" : "aiChat.mode.investigationHint"),
                symbol: "bubble.left.and.bubble.right"
            ) {
                // The web header's trailing Chat / Investigation toggle; the label stays for VoiceOver.
                VisionSegmentedControl(
                    selection: Binding(get: { model.mode }, set: { value in model.setMode(value) }),
                    values: [AIChatMode.chat, AIChatMode.investigation],
                    title: { strings.t($0 == .chat ? "aiChat.mode.chat" : "aiChat.mode.investigation") }
                )
                .visionAccessibilityLabel(strings.t("aiChat.mode.label")).fixedSize()
            }
            HStack(alignment: .top, spacing: isChat && width >= 768 ? 16 : 0) {
                // Only the active tab is mounted: a hidden Investigation (or Chat) view must not
                // stay in the accessibility tree.
                if isChat && width >= 768 {
                    AIChatConversationRail(model: model, shell: shell)
                        .frame(width: 272)
                }
                ZStack {
                    if isChat {
                        chatRegion
                    } else {
                        ScrollView {
                            AIInvestigationView(model: investigation, shell: shell)
                        }
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
                    .visionCardBackground()
            }.frame(maxHeight: .infinity)
        }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .onGeometryChange(for: CGFloat.self) {
                $0.size.width
            } action: {
                width = $0
            }
            // `SheetContent side="left" className="w-72 p-0"` with an sr-only header; Escape and the scrim close it (the web X would sit over the new-chat button).
            .visionSideSheet(
                isPresented: $conversationsOpen, metrics: .sideSheet(maxWidth: 288, edge: .leading),
                accessibilityTitle: strings.t("aiChat.conversations")
            ) {
                AIChatConversationRail(model: model, shell: shell, didSelect: { conversationsOpen = false })
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .overlay(alignment: .bottom) {
                NoticeToast(notice: model.notice, strings: strings, clear: model.clearNotice)
            }
    }

    private var chatRegion: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                if width < 768 {
                    Button {
                        conversationsOpen = true
                    } label: {
                        Image(systemName: "sidebar.left")
                    }
                    .buttonStyle(.vision(.ghost, size: .icon)).accessibilityLabel(strings.t("aiChat.conversations"))
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(conversationTitle)
                        .font(.researchCardTitle).lineLimit(1).accessibilityAddTraits(.isHeader)
                    // `(statusLoading || status?.ok)`: when Ollama is unreachable only the banner says so.
                    if statusLoading || model.status?.ok == true {
                        HStack(spacing: 6) {
                            Circle().fill(model.status?.ok == true ? theme.gain : theme.tertiaryLabel).frame(
                                width: 6, height: 6)
                            Text(strings.t(statusLoading ? "aiChat.checkingOllama" : "aiChat.ollamaReady"))
                                .font(.footnote).foregroundStyle(theme.secondaryLabel)
                        }
                    }
                }
                Spacer(minLength: 0)
            }.padding(.horizontal, 20).padding(.vertical, 12)
            Divider().opacity(0.5)
            if !statusLoading && model.status?.ok != true {
                AIChatStatusBanner(model: model, shell: shell).padding(.horizontal, 20).padding(.vertical, 12)
            }
            AIChatTranscript(model: model, shell: shell, isVisible: isChat)
            if !model.composerDisabled || model.streamSnapshot.isStreaming {
                AIChatComposer(model: model, shell: shell)
            }
        }
    }
}

struct AIChatStatusBanner: View {
    let model: AIChatModel
    let shell: NativeShellModel
    @State private var detailsOpen = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var shownURL: String? {
        if let shown = model.status?.displayUrl, !shown.isEmpty { return shown }
        guard let base = model.status?.baseUrl, !base.isEmpty else { return nil }
        return base
    }
    private var shownHint: String? {
        guard let hint = model.status?.hint, !hint.isEmpty else { return nil }
        return hint
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(strings.t("aiChat.banner.unreachable"), systemImage: "info.circle").font(.callout.weight(.semibold))
            Text(strings.t("aiChat.banner.hint")).font(.callout).foregroundStyle(theme.secondaryLabel)
            if shownURL != nil || shownHint != nil {
                DisclosureGroup(strings.t("aiChat.banner.connectionDetails"), isExpanded: $detailsOpen) {
                    VStack(alignment: .leading, spacing: 5) {
                        if let shownURL { Text(shownURL).textSelection(.enabled) }
                        if let hint = shownHint { Text(hint) }
                    }.font(.caption).foregroundStyle(theme.secondaryLabel).padding(.top, 5)
                }
            }
            HStack {
                Button(strings.t("aiChat.banner.retry"), systemImage: "arrow.clockwise") {
                    Task { await model.retryStatus() }
                }
                .buttonStyle(.visionOutline)
                Link(destination: URL(string: "https://ollama.com/download")!) {
                    Label(strings.t("aiChat.banner.setup"), systemImage: "arrow.up.right.square")
                }
            }.font(.callout)
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.muted, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control))
    }
}
