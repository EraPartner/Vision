import SwiftUI
import VisionNativeCore

struct PortfolioImportHistoryView: View {
    let model: PortfolioImportHistoryModel
    let shell: NativeShellModel
    @Binding var expanded: Bool
    var isLocked = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        AdminCard {
            DisclosureGroup(strings.t("portfolioImport.session.history.title"), isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 14) {
                    if model.isLoading {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text(strings.t("common.loading"))
                        }
                    }
                    if let error = model.error {
                        Text(error).foregroundStyle(theme.destructive).textSelection(.enabled)
                        Button(strings.t("common.retry")) {
                            Task { await model.load(offset: model.offset, force: true) }
                        }
                    }
                    if let page = model.page {
                        ForEach(page.items) { batch in
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(verbatim: batch.sourceFilename ?? batch.adapterName).lineLimit(1)
                                        .truncationMode(.middle)
                                    Text(strings.t("portfolioImport.session.batch", ["id": String(batch.id)]))
                                        .font(.caption).foregroundStyle(theme.secondaryLabel)
                                }
                                Spacer()
                                if batch.canRollback {
                                    Button(strings.t("portfolioImport.session.history.rollback")) {
                                        model.pendingRollback = batch
                                    }
                                    .disabled(isLocked || model.isBusy)
                                }
                            }.padding(.vertical, 5)
                            Divider()
                        }
                        if page.total > PortfolioImportHistoryModel.pageSize {
                            HStack {
                                Button(strings.t("common.previous")) {
                                    Task {
                                        await model.load(
                                            offset: max(0, model.offset - PortfolioImportHistoryModel.pageSize))
                                    }
                                }.disabled(model.isBusy || model.isLoading || model.offset == 0)
                                Button(strings.t("common.next")) {
                                    Task {
                                        await model.load(offset: model.offset + PortfolioImportHistoryModel.pageSize)
                                    }
                                }.disabled(
                                    model.isBusy || model.isLoading
                                        || model.offset + PortfolioImportHistoryModel.pageSize >= page.total)
                            }
                        }
                    }
                    if let notice = model.notice { Text(strings.t(notice)).foregroundStyle(theme.success) }
                }.padding(.top, 14)
            }
        }.task(id: expanded) { if expanded { await model.load(offset: model.offset) } }
            .alert(
                strings.t("portfolioImport.session.history.rollbackTitle"),
                isPresented: Binding(
                    get: { model.pendingRollback != nil }, set: { if !$0 { model.pendingRollback = nil } })
            ) {
                Button(strings.t("common.cancel"), role: .cancel) { model.pendingRollback = nil }
                Button(strings.t("portfolioImport.session.history.rollback"), role: .destructive) {
                    guard let id = model.pendingRollback?.id else { return }
                    Task { await model.rollback(batchId: id) }
                }.disabled(isLocked || model.isBusy)
            } message: {
                Text(
                    strings.t(
                        "portfolioImport.session.history.rollbackDescription",
                        ["file": model.pendingRollback?.sourceFilename ?? model.pendingRollback?.adapterName ?? ""]))
            }
    }
}
