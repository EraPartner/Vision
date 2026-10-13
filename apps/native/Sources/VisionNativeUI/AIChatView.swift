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
                symbol: "bubble.left.and.bubble.right")
            Picker(strings.t("aiChat.mode.label"), selection: Binding(get: { model.mode }, set: model.setMode)) {
                Text(strings.t("aiChat.mode.chat")).tag(AIChatMode.chat)
                Text(strings.t("aiChat.mode.investigation")).tag(AIChatMode.investigation)
            }.pickerStyle(.segmented).frame(maxWidth: 360)
            HStack(alignment: .top, spacing: isChat && width >= 768 ? 16 : 0) {
                AIChatConversationRail(model: model, shell: shell)
                    .frame(width: isChat && width >= 768 ? 272 : 0)
                    .opacity(isChat && width >= 768 ? 1 : 0).clipped()
                    .disabled(!isChat || width < 768).allowsHitTesting(isChat && width >= 768)
                    .accessibilityHidden(!isChat || width < 768)
                ZStack {
                    chatRegion
                        .opacity(isChat ? 1 : 0).disabled(!isChat).allowsHitTesting(isChat).accessibilityHidden(!isChat)
                    ScrollView {
                        AIInvestigationView(model: investigation, shell: shell)
                    }.opacity(isChat ? 0 : 1).disabled(isChat).allowsHitTesting(!isChat).accessibilityHidden(isChat)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(theme.card, in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(theme.border.opacity(0.6)))
            }.frame(maxHeight: .infinity)
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .onGeometryChange(for: CGFloat.self) {
                $0.size.width
            } action: {
                width = $0
            }
            .sheet(isPresented: $conversationsOpen) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text(strings.t("aiChat.conversations")).font(.title3.weight(.semibold))
                        Spacer()
                        Button(strings.t("common.close")) { conversationsOpen = false }.keyboardShortcut(.cancelAction)
                    }.padding(16)
                    AIChatConversationRail(model: model, shell: shell, didSelect: { conversationsOpen = false })
                }.frame(minWidth: 320, idealWidth: 380, minHeight: 450, idealHeight: 620)
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
                    .buttonStyle(.borderless).accessibilityLabel(strings.t("aiChat.conversations"))
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(conversationTitle)
                        .font(.headline).lineLimit(1).accessibilityAddTraits(.isHeader)
                    HStack(spacing: 6) {
                        Circle().fill(model.status?.ok == true ? theme.gain : theme.tertiaryLabel).frame(
                            width: 6, height: 6)
                        Text(
                            strings.t(
                                statusLoading
                                    ? "aiChat.checkingOllama"
                                    : model.status?.ok == true ? "aiChat.ollamaReady" : "aiChat.ollamaUnreachable")
                        )
                        .font(.caption).foregroundStyle(theme.secondaryLabel)
                    }
                }
                Spacer(minLength: 0)
            }.padding(16)
            Divider()
            if !statusLoading && model.status?.ok != true {
                AIChatStatusBanner(model: model, shell: shell).padding(16)
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
                .buttonStyle(.bordered)
                Link(destination: URL(string: "https://ollama.com/download")!) {
                    Label(strings.t("aiChat.banner.setup"), systemImage: "arrow.up.right.square")
                }
            }.font(.callout)
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.muted, in: RoundedRectangle(cornerRadius: 10))
    }
}
