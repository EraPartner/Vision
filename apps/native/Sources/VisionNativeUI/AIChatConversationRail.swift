import SwiftUI
import VisionNativeCore

struct AIChatConversationRail: View {
    let model: AIChatModel
    let shell: NativeShellModel
    var didSelect: (() -> Void)?
    @State private var renameTarget: AIChatConversation?
    @State private var deleteTarget: AIChatConversation?
    @Environment(\.visionTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    private var strings: any Localizing { shell.strings }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(strings.t("aiChat.conversations")).font(.headline).foregroundStyle(theme.secondaryLabel)
                Spacer()
                Button {
                    Task {
                        if await model.create() != nil { didSelect?() }
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.borderless).disabled(model.isCreating)
                .accessibilityLabel(strings.t("aiChat.newConversation"))
            }.padding(.horizontal, 16).padding(.vertical, 12)
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if model.isLoadingConversations && model.conversations.isEmpty {
                        ForEach(0..<5, id: \.self) { _ in
                            RoundedRectangle(cornerRadius: 8).fill(theme.muted).frame(height: 38).accessibilityHidden(
                                true)
                        }
                    } else if model.conversations.isEmpty {
                        VStack(spacing: 10) {
                            Image(systemName: "bubble.left").font(.title2)
                            Text(strings.t("aiChat.noConversations")).font(.callout).multilineTextAlignment(.center)
                        }.foregroundStyle(theme.secondaryLabel).padding(.vertical, 30).frame(maxWidth: .infinity)
                    }
                    ForEach(model.conversations) { conversation in
                        HStack(spacing: 6) {
                            Button {
                                Task { await model.select(id: conversation.id) }
                                didSelect?()
                            } label: {
                                let active = model.selectedID == conversation.id
                                HStack(spacing: 8) {
                                    Image(systemName: "bubble.left").font(.caption)
                                        .foregroundStyle(active ? theme.primary : theme.secondaryLabel)
                                    Text(conversation.title.isEmpty ? strings.t("aiChat.untitled") : conversation.title)
                                        .font(.callout).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                                        .foregroundStyle(active ? theme.foreground : theme.secondaryLabel)
                                    if model.streamingIDs.contains(conversation.id) {
                                        Circle().fill(theme.primary).frame(width: 6, height: 6)
                                            .phaseAnimator([false, true]) { view, phase in
                                                view.opacity(reducedMotion || phase ? 1 : 0.35)
                                            }
                                            .accessibilityLabel(strings.t("aiChat.streamingIndicator"))
                                    }
                                }.contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityAddTraits(
                                model.selectedID == conversation.id ? [.isSelected] : [])
                            Menu {
                                Button(strings.t("aiChat.rename"), systemImage: "pencil") {
                                    renameTarget = conversation
                                }
                                Divider()
                                Button(strings.t("aiChat.delete"), systemImage: "trash", role: .destructive) {
                                    deleteTarget = conversation
                                }
                            } label: {
                                Image(systemName: "ellipsis").frame(width: 20, height: 24)
                            }
                            .menuIndicator(.hidden)
                            .menuStyle(.borderlessButton).fixedSize().accessibilityLabel(
                                strings.t("aiChat.conversationActions"))
                        }.padding(.horizontal, 10).padding(.vertical, 9)
                            .background(
                                model.selectedID == conversation.id ? theme.primary.opacity(0.12) : .clear,
                                in: RoundedRectangle(cornerRadius: 8))
                    }
                    if model.hasMore {
                        Button(strings.t(model.isLoadingMore ? "aiChat.loading" : "aiChat.loadMore")) {
                            Task { await model.loadMore() }
                        }
                        .buttonStyle(.borderless).disabled(model.isLoadingMore).frame(maxWidth: .infinity).padding(10)
                    }
                }.padding(.horizontal, 8).padding(.bottom, 12)
            }
        }.frame(maxHeight: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
            .visionCardBackground()
            .sheet(item: $renameTarget) { target in
                AIChatRenameSheet(model: model, conversation: target, shell: shell)
            }
            .confirmationDialog(
                strings.t("aiChat.deleteTitle"),
                isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
                titleVisibility: .visible
            ) {
                Button(strings.t("aiChat.delete"), role: .destructive) {
                    guard let target = deleteTarget else { return }
                    deleteTarget = nil
                    Task { _ = await model.delete(id: target.id) }
                }
                Button(strings.t("common.cancel"), role: .cancel) { deleteTarget = nil }
            } message: {
                Text(strings.t("aiChat.deleteConfirm"))
            }
    }
}

private struct AIChatRenameSheet: View {
    let model: AIChatModel
    let conversation: AIChatConversation
    let shell: NativeShellModel
    @State private var title: String
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss
    init(model: AIChatModel, conversation: AIChatConversation, shell: NativeShellModel) {
        self.model = model
        self.conversation = conversation
        self.shell = shell
        _title = State(initialValue: conversation.title)
    }
    private var strings: any Localizing { shell.strings }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(strings.t("aiChat.renameTitle")).font(.title3.weight(.semibold))
            VStack(alignment: .leading, spacing: 7) {
                Text(strings.t("aiChat.renameLabel")).font(.callout)
                TextField(
                    strings.t("aiChat.renameLabel"),
                    text: Binding(get: { title }, set: { title = AIChatTextLimit.prefix($0, utf16: 120) })
                )
                .textFieldStyle(.roundedBorder).focused($focused).onSubmit(save)
            }
            HStack {
                Spacer()
                Button(strings.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(strings.t("common.save"), action: save).buttonStyle(.visionPrimary)
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isRenaming)
            }
        }.padding(24).frame(width: 400).onAppear { focused = true }
    }
    private func save() {
        let value = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !model.isRenaming else { return }
        Task { if await model.rename(id: conversation.id, title: value) { dismiss() } }
    }
}
