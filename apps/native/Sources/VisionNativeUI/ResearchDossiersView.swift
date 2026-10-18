import SwiftUI
import VisionNativeCore

public struct ResearchDossiersView: View {
    let model: ResearchDossiersModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    public init(model: ResearchDossiersModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private var showsList: Bool {
        !model.items.isEmpty || model.draft != nil || model.selectedId != nil || model.listLoading
            || model.listError != nil
    }
    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VisionPageHeader(
                    title: strings.t("dossiers.title"), subtitle: strings.t("dossiers.subtitle"), symbol: "folder"
                ) {
                    Menu {
                        Button(strings.t("dossiers.exportAll"), systemImage: "arrow.down.doc") {
                            Task { await model.exportAll() }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel(strings.t("dossiers.menu"))
                    Button(strings.t("dossiers.new"), systemImage: "plus") { model.requestNew() }
                        .buttonStyle(.visionPrimary)
                }
                if let error = model.error {
                    ResearchDossierMessage(text: strings.t(error), kind: .error) {
                        if model.conflict && model.selectedId != nil {
                            Button(strings.t("dossiers.reloadLatest")) { model.requestReloadLatest() }
                        }
                    }
                }
                if let notice = model.notice {
                    ResearchDossierMessage(
                        text: notice.detail ?? strings.t(notice.key, notice.variables), kind: notice.kind
                    ) {}
                }
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 24) {
                        if showsList { list.frame(width: 260) }
                        editor.frame(minWidth: 470, maxWidth: .infinity)
                    }
                    VStack(alignment: .leading, spacing: 24) {
                        if showsList { list }
                        editor
                    }
                }
            }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
        }
        .sheet(
            isPresented: Binding(get: { model.pendingReview != nil }, set: { if !$0 { model.cancelPendingReview() } })
        ) {
            ResearchDossierConfirmationView(model: model, shell: shell)
        }
    }
    private var list: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(strings.t("dossiers.list")).font(.headline).foregroundStyle(theme.secondaryLabel)
                .accessibilityAddTraits(.isHeader)
            if model.listLoading {
                ProgressView().frame(maxWidth: .infinity).accessibilityLabel(strings.t("common.loading"))
            }
            if let error = model.listError {
                ResearchDossierMessage(text: strings.t(error), kind: .error) {
                    Button(strings.t("common.retry")) { Task { await model.retryList() } }
                }
            }
            if !model.listLoading && model.listError == nil && model.items.isEmpty {
                ResearchCard {
                    VisionEmptyState(symbol: "folder", title: strings.t("dossiers.empty")) {}.padding(.vertical, 8)
                }
            }
            LazyVStack(spacing: 0) {
                ForEach(model.items) { item in
                    Button {
                        Task { await model.select(item.id) }
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(item.title).font(.body.weight(model.selectedId == item.id ? .medium : .regular))
                            Text(
                                strings.t("dossiers.workspace." + item.workspace) + " · "
                                    + strings.t("dossiers.version", ["version": String(item.version)])
                            )
                            .font(.caption).foregroundStyle(theme.secondaryLabel)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                            .background(model.selectedId == item.id ? theme.primary.opacity(0.1) : Color.clear)
                    }.buttonStyle(.plain).accessibilityAddTraits(model.selectedId == item.id ? [.isSelected] : [])
                    Divider()
                }
            }.clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
                .visionCardBackground()
            if model.total > 500 {
                HStack {
                    Button(strings.t("dossiers.previous")) { Task { await model.previousPage() } }.disabled(
                        model.listOffset == 0)
                    Text(
                        strings.t(
                            "dossiers.pageRange",
                            [
                                "first": String(model.listOffset + 1),
                                "last": String(min(model.listOffset + 500, model.total)), "total": String(model.total),
                            ])
                    )
                    .font(.caption).monospacedDigit().foregroundStyle(theme.secondaryLabel)
                    Button(strings.t("dossiers.next")) { Task { await model.nextPage() } }.disabled(
                        model.listOffset + 500 >= model.total)
                }
            }
        }.accessibilityElement(children: .contain).accessibilityLabel(strings.t("dossiers.list"))
    }
    @ViewBuilder private var editor: some View {
        VStack(alignment: .leading, spacing: 24) {
            if model.selectedId != nil && model.detailLoading {
                ResearchCard {
                    ProgressView().frame(maxWidth: .infinity).accessibilityLabel(strings.t("common.loading"))
                }
            }
            if model.selectedId != nil, let error = model.detailError {
                ResearchDossierMessage(text: strings.t(error), kind: .error) {
                    Button(strings.t("common.retry")) { Task { await model.retryDetail() } }
                }
            }
            if model.draft != nil {
                ResearchDossierEditorView(model: model, shell: shell)
                ResearchDossierEvidenceListView(model: model, shell: shell)
                ResearchDossierLinksView(model: model, shell: shell)
                if model.selectedId != nil { ResearchDossierHistoryView(model: model, shell: shell) }
            } else if model.selectedId == nil && !model.listLoading && model.listError == nil {
                ResearchCard {
                    VisionEmptyState(
                        symbol: "folder", title: strings.t(model.items.isEmpty ? "dossiers.empty" : "dossiers.select"),
                        description: model.items.isEmpty ? strings.t("dossiers.emptyHint") : nil
                    ) {}
                }
            }
        }.onSubmit { Task { await model.save() } }
    }
}

struct ResearchDossierMessage<Actions: View>: View {
    let text: String
    let kind: ScreenNotice.Kind
    @ViewBuilder var actions: () -> Actions
    @Environment(\.visionTheme) private var theme
    private var color: Color { kind == .error ? theme.destructive : kind == .success ? theme.success : theme.warning }
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: kind == .success ? "checkmark.circle" : "exclamationmark.triangle").accessibilityHidden(
                true)
            VStack(alignment: .leading, spacing: 8) {
                Text(text).textSelection(.enabled)
                actions()
            }
        }.font(.callout).foregroundStyle(color).padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            .accessibilityElement(children: .contain)
            .task(id: text) { AccessibilityNotification.Announcement(text).post() }
    }
}
