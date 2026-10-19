import SwiftUI
import VisionNativeCore

/// `BulkActionsBar`: "{n} selected", Select all {n} matching filter, the Actions menu (Bulk
/// actions) and Clear selection, with the bulk dialogs as sheets and the confirms as alerts.
struct TransactionBulkBar: View {
    let model: TransactionsModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }

    var body: some View {
        HStack(spacing: 8) {
            Text(strings.t("txPage.bulk.nSelected", ["n": String(model.bulkCount)]))
                .font(.callout.weight(.medium))
                .accessibilityAddTraits(.updatesFrequently)
            if model.canSelectAllMatching {
                Button(strings.t("txPage.bulk.selectAllMatching", ["n": String(model.total)])) {
                    model.selectAllMatching()
                }
                .buttonStyle(.visionOutline)
                .controlSize(.small)
                .disabled(model.bulkBusy)
            }
            actionsMenu
            Button(strings.t("common.clearSelection")) {
                model.clearBulkSelection()
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(model.bulkBusy)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(strings.t("txPage.bulk.menuLabel"))
        .sheet(
            isPresented: Binding(
                get: { model.bulkDialog != nil },
                set: { presented in
                    if !presented { model.closeBulkDialog() }
                })
        ) {
            if let dialog = model.bulkDialog {
                TransactionBulkDialogView(model: model, dialog: dialog, shell: shell)
                    .environment(\.visionTheme, theme)
                    .environment(\.colorScheme, theme.colorScheme)
            }
        }
        // `useConfirmDialog`. The buttons decide; the binding only reads.
        .alert(
            model.bulkConfirmationText()?.title ?? "",
            isPresented: Binding(get: { model.bulkConfirmation != nil }, set: { _ in })
        ) {
            Button(strings.t("common.cancel"), role: .cancel) { model.cancelBulkConfirmation() }
            Button(model.bulkConfirmationText()?.action ?? "", role: confirmRole) {
                Task { await model.confirmBulk() }
            }
        } message: {
            Text(model.bulkConfirmationText()?.message ?? "")
        }
    }

    /// Delete is destructive; the other confirms are not.
    private var confirmRole: ButtonRole? {
        if case .delete? = model.bulkConfirmation { return .destructive }
        return nil
    }

    private var actionsMenu: some View {
        Menu {
            Section(strings.t("txPage.bulk.menuLabel")) {
                if model.transferPair != nil {
                    Button {
                        model.requestMarkTransfer()
                    } label: {
                        Label(strings.t("txPage.bulk.markTransfer"), systemImage: "arrow.left.arrow.right")
                    }
                }
                if model.bulkIdsOnly {
                    Text(strings.t("txPage.bulk.tagSelectionHint"))
                }
                Button {
                    model.openBulkDialog(.tag)
                } label: {
                    Label(strings.t("txPage.bulk.tag"), systemImage: "tag")
                }
                .disabled(model.bulkIdsOnly)
                Button {
                    model.openBulkDialog(.split)
                } label: {
                    Label(strings.t("txPage.bulk.split"), systemImage: "person.2")
                }
                .disabled(model.bulkIdsOnly)
                Button {
                    model.openBulkDialog(.recategorize)
                } label: {
                    Label(strings.t("txPage.bulk.recategorize"), systemImage: "folder")
                }
                Button {
                    model.openBulkDialog(.recipient)
                } label: {
                    Label(strings.t("txPage.bulk.reassignRecipient"), systemImage: "person.crop.circle")
                }
                Button {
                    Task { await model.requestBulkSetActive(true) }
                } label: {
                    Label(strings.t("txPage.bulk.activate"), systemImage: "eye")
                }
                Button {
                    Task { await model.requestBulkSetActive(false) }
                } label: {
                    Label(strings.t("txPage.bulk.deactivate"), systemImage: "eye.slash")
                }
                Button {
                    model.openBulkDialog(.export)
                } label: {
                    Label(strings.t("txPage.bulk.export"), systemImage: "square.and.arrow.down")
                }
            }
            Divider()
            Button(role: .destructive) {
                model.requestBulkDelete()
            } label: {
                Label(strings.t("txPage.bulk.delete"), systemImage: "trash")
            }
        } label: {
            HStack(spacing: 4) {
                if model.bulkBusy {
                    ProgressView().controlSize(.mini)
                }
                Text(strings.t("txPage.bulk.actions"))
            }
        }
        .menuStyle(.button)
        .buttonStyle(.visionPrimary)
        .controlSize(.small)
        .fixedSize()
        .disabled(model.bulkBusy)
        .accessibilityLabel(strings.t("txPage.bulk.actions"))
    }
}

/// The five bulk dialogs (`BulkRecategorizeDialog`, `BulkRecipientDialog`,
/// `BulkExportDialog`, `BulkTagDialog`, `BulkSplitDialog`): a title with the count, a
/// description, the form, Cancel and the submit (Applying… while it runs). Return submits.
struct TransactionBulkDialogView: View {
    let model: TransactionsModel
    let dialog: TransactionBulkDialog
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }
    private var count: String { String(model.bulkCount) }
    private var drafts: TransactionBulkDrafts { model.bulkDrafts }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VisionDialogHeader(
                title: title, description: description, closeLabel: strings.t("common.close"),
                onClose: { if !model.bulkBusy { cancel() } })
            form
            VisionDialogFooter {
                Button(strings.t("common.cancel")) { cancel() }
                    .buttonStyle(.visionOutline)
                    .keyboardShortcut(.cancelAction)
                    .disabled(model.bulkBusy)
                Button(action: submit) {
                    Text(model.bulkBusy ? busyLabel : strings.t(confirmKey))
                }
                .buttonStyle(.visionPrimary)
                .keyboardShortcut(.defaultAction)
                .disabled(!canSubmit)
            }
        }
        .visionDialogPadding()
        .frame(minWidth: 448, idealWidth: 512)
        .foregroundStyle(theme.foreground)
        .task { await model.pickers.load() }
    }

    private var title: String {
        switch dialog {
        case .recategorize: return strings.t("txPage.bulk.recategorizeTitle", ["n": count])
        case .recipient: return strings.t("txPage.bulk.reassignRecipientTitle", ["n": count])
        case .export: return strings.t("txPage.bulk.exportTitle", ["n": count])
        case .tag: return strings.t("txPage.bulk.tagTitle", ["n": count])
        case .split: return strings.t("txPage.bulk.splitTitle", ["n": count])
        }
    }

    private var description: String {
        switch dialog {
        case .recategorize: return strings.t("txPage.bulk.recategorizeDesc")
        case .recipient: return strings.t("txPage.bulk.reassignRecipientDesc")
        case .export: return strings.t("txPage.bulk.exportDesc")
        case .tag: return strings.t("txPage.bulk.tagDesc")
        case .split: return strings.t("txPage.bulk.splitDesc")
        }
    }

    private var confirmKey: String {
        switch dialog {
        case .recategorize: return "txPage.bulk.recategorizeConfirm"
        case .recipient: return "txPage.bulk.reassignRecipientConfirm"
        case .export: return "txPage.bulk.exportConfirm"
        case .tag: return "txPage.bulk.tagConfirm"
        case .split: return "txPage.bulk.splitConfirm"
        }
    }

    /// Split says Splitting…; the others Applying….
    private var busyLabel: String {
        strings.t(dialog == .split ? "splitDialog.splitting" : "common.applying")
    }

    private var canSubmit: Bool {
        guard !model.bulkBusy else { return false }
        switch dialog {
        case .recategorize, .export: return true
        case .recipient: return drafts.recipientId != nil
        case .tag: return !drafts.tagsEmpty
        case .split: return drafts.splitRecipientId != nil
        }
    }

    @ViewBuilder
    private var form: some View {
        switch dialog {
        case .recategorize:
            labeled("txPage.field.category") {
                CategoryPicker(pickers: model.pickers, value: drafts.categoryId, strings: strings) { id in
                    model.setBulkCategory(id)
                }
            }
        case .recipient:
            labeled("txPage.field.recipient") {
                RecipientPicker(pickers: model.pickers, value: drafts.recipientId, strings: strings) { id in
                    model.setBulkRecipient(id)
                }
            }
        case .export:
            Picker(
                strings.t("txPage.bulk.exportFormat"),
                selection: Binding(get: { drafts.exportFormat }, set: { model.setBulkExportFormat($0) })
            ) {
                Text(strings.t("txPage.bulk.exportFormatCsv")).tag(ExportFormat.csv)
                Text(strings.t("txPage.bulk.exportFormatJson")).tag(ExportFormat.json)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        case .tag:
            labeled("txPage.bulk.tagAdd") {
                TagMultiSelect(pickers: model.pickers, selected: drafts.tagsToAdd, strings: strings) { slugs in
                    model.setBulkTagsToAdd(slugs)
                }
            }
            labeled("txPage.bulk.tagRemove") {
                TagMultiSelect(pickers: model.pickers, selected: drafts.tagsToRemove, strings: strings) { slugs in
                    model.setBulkTagsToRemove(slugs)
                }
            }
        case .split:
            labeled("txPage.field.recipient") {
                RecipientPicker(pickers: model.pickers, value: drafts.splitRecipientId, strings: strings) { id in
                    model.setBulkSplitRecipient(id)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Picker(
                    strings.t("splitDialog.splitType"),
                    selection: Binding(get: { drafts.splitMode }, set: { model.setBulkSplitMode($0) })
                ) {
                    ForEach(BulkSplitMode.allCases, id: \.self) { mode in
                        Text(strings.t(mode.labelKey)).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                Text(strings.t(drafts.splitMode.hintKey))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
            }
        }
    }

    private func labeled<Content: View>(_ key: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(strings.t(key))
                .font(.callout.weight(.medium))
                .foregroundStyle(theme.foreground)
            content()
        }
    }

    private func cancel() {
        if dialog == .tag {
            model.cancelBulkTags()
        } else {
            model.closeBulkDialog()
        }
    }

    private func submit() {
        guard canSubmit else { return }
        Task {
            switch dialog {
            case .recategorize: await model.applyBulkCategory()
            case .recipient: await model.applyBulkRecipient()
            case .export: await model.applyBulkExport()
            case .tag: await model.applyBulkTags()
            case .split: await model.applyBulkSplit()
            }
        }
    }
}
