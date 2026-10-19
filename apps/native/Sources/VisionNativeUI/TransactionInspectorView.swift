import AppKit
import QuickLook
import SwiftUI
import UniformTypeIdentifiers
import VisionNativeCore

/// `TransactionInspector`: the payee, the date, account and status, and the amount; the
/// Category and payee pickers with their tips; Details with a pencil per editable field; the
/// tags; the attachments; and the footer actions. Docked beside the table, or in a sheet.
struct TransactionInspectorView: View {
    let model: TransactionsModel
    let inspector: TransactionInspectorModel
    let row: TransactionRow
    let shell: NativeShellModel
    let docked: Bool
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }
    private var labels: TransactionLabels { model.labels }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                classifySection
                detailsSection
                tagsSection
                TransactionAttachmentsPanel(model: model, attachments: inspector.attachments, strings: strings)
                footer
            }
            .padding(16)
        }
        .frame(maxHeight: docked ? CGFloat(760) : CGFloat.infinity)
        .background {
            if docked { Color.clear.visionCardBackground() }
        }
        .task(id: row.recipientId) { await inspector.load(recipientId: row.recipientId) }
        .task { await inspector.attachments.load() }
        .onExitCommand { model.closeInspector() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(strings.t("txPage.detailsTitle"))
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(row.recipient(labels))
                    .font(Font.visionTitle3)
                    .lineLimit(2)
                    .accessibilityAddTraits(.isHeader)
                Text(verbatim: subtitle)
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                MoneyText(amount: row.amount, currency: row.displayCurrency, settings: settings)
                    .font(.visionLargeTitle)
                    .strikethrough(!row.isActive)
                    .padding(.top, 4)
            }
            Spacer(minLength: 0)
            VisionDialogCloseButton(label: strings.t("common.close")) {
                model.closeInspector()
            }
            .keyboardShortcut(docked ? nil : .cancelAction)
        }
    }

    /// "date · bank" and ` · Excluded`.
    private var subtitle: String {
        var parts = [VisionFormat.appDate(row.date, format: settings.dateFormat)]
        if let bank = row.bank, !bank.isEmpty { parts.append(bank) }
        var text = parts.joined(separator: " · ")
        if !row.isActive { text += " · " + strings.t("txPage.statusInactive") }
        return text
    }

    private func section<Content: View>(_ title: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title)
                    .font(.caption2.weight(.medium))
                    .tracking(1.3)
                    .foregroundStyle(Color(token: theme.palette.mutedForeground).opacity(0.8))
                    .textCase(.uppercase)
                    .accessibilityAddTraits(.isHeader)
            }
            content()
        }
    }

    // MARK: Category and payee

    private var classifySection: some View {
        section(strings.t("txPage.inspector.classify")) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    TransactionCategoryDot(category: row.category(labels), uncategorised: row.isUncategorised(labels))
                    Text(strings.t("txPage.field.category"))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                }
                CategoryPicker(
                    pickers: model.pickers, value: row.categoryId, disabled: model.updatesInFlight > 0, strings: strings
                ) { id in
                    Task { await model.selectCategory(row, categoryId: id) }
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(strings.t("txPage.field.recipient"))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                RecipientPicker(
                    pickers: model.pickers, value: row.recipientId, disabled: model.updatesInFlight > 0,
                    strings: strings
                ) { id in
                    Task { await model.selectRecipient(row, recipientId: id) }
                }
            }
            tips
        }
    }

    @ViewBuilder
    private var tips: some View {
        if let tips = inspector.tips(for: row, labels: labels), let recipient = inspector.recipient {
            if tips.showsTipBox {
                VStack(alignment: .leading, spacing: 8) {
                    if tips.showsUseForAll {
                        tipLine(
                            strings.t(
                                "txPage.inspector.othersNeedCategory",
                                ["count": String(tips.othersNeedingCategory), "name": recipient.name]),
                            action: strings.t("txPage.inspector.useForAll", ["count": String(tips.othersNeedingCategory)])
                        ) {
                            Task { await model.useForAll() }
                        }
                    }
                    if tips.canSetUsual {
                        tipLine(
                            strings.t(
                                "txPage.inspector.alwaysUseQuestion",
                                ["category": row.category(labels), "name": recipient.name]),
                            action: strings.t("txPage.inspector.alwaysUse")
                        ) {
                            Task { await model.alwaysUse() }
                        }
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                        .fill(theme.foreground.opacity(0.04)))
            }
            if tips.ruleApplies {
                tipLine(
                    strings.t(
                        "txPage.inspector.ruleApplies", ["name": recipient.name, "category": row.category(labels)]),
                    action: strings.t("txPage.inspector.editRule")
                ) {
                    model.editRule()
                }
            }
        }
    }

    private func tipLine(_ text: String, action title: String, perform: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(text)
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
                .fixedSize(horizontal: false, vertical: true)
            Button(title, action: perform)
                .buttonStyle(.visionLink)
                .font(.footnote)
        }
    }

    // MARK: Details

    private var detailsSection: some View {
        section(strings.t("txPage.inspector.details")) {
            VStack(alignment: .leading, spacing: 0) {
                fieldRow(.date) { Text(VisionFormat.appDate(row.date, format: settings.dateFormat)) }
                Divider()
                fieldRow(.memo) { valueText(row.memo) }
                Divider()
                fieldRow(.amount) { MoneyText(amount: row.amount, currency: row.displayCurrency, settings: settings) }
                Divider()
                fieldRow(.currency) { valueText(row.currency) }
                Divider()
                fieldRow(.bank) { valueText(row.bank) }
                if let balance = row.balance {
                    Divider()
                    staticRow(strings.t("txPage.field.balance")) {
                        MoneyText(
                            amount: balance, currency: row.displayCurrency, settings: settings, signed: false,
                            colored: false)
                    }
                }
                Divider()
                fieldRow(.comment) { valueText(row.comment) }
                Divider()
                staticRow(strings.t("txPage.field.id")) { Text(verbatim: String(row.id)).monospacedDigit() }
            }
        }
    }

    private func valueText(_ value: String?) -> some View {
        Text(value.flatMap { $0.isEmpty ? nil : $0 } ?? "—")
            .foregroundStyle((value ?? "").isEmpty ? theme.tertiaryLabel : theme.foreground)
            .multilineTextAlignment(.trailing)
    }

    private func staticRow<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .foregroundStyle(theme.secondaryLabel)
            Spacer(minLength: 8)
            value()
        }
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func fieldRow<Value: View>(_ field: TransactionDetailField, @ViewBuilder value: () -> Value) -> some View {
        let label = strings.t(field.labelKey)
        if inspector.editingField == field {
            VStack(alignment: .leading, spacing: 6) {
                Text(label)
                    .foregroundStyle(theme.secondaryLabel)
                HStack(spacing: 6) {
                    editor(field, label: label)
                    Button {
                        Task { await model.saveDetail() }
                    } label: {
                        Image(systemName: "checkmark")
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(theme.primary)
                    .disabled(inspector.isSaving)
                    .help(strings.t("common.save"))
                    .accessibilityLabel(strings.t("common.save"))
                    Button {
                        inspector.cancelEdit()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(theme.secondaryLabel)
                    .help(strings.t("common.cancel"))
                    .accessibilityLabel(strings.t("aria.cancel"))
                }
                if field == .amount && inspector.amountError {
                    Text(strings.t("addTxn.invalidAmount"))
                        .font(.footnote)
                        .foregroundStyle(theme.destructive)
                }
            }
            .padding(.vertical, 8)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(label)
                    .foregroundStyle(theme.secondaryLabel)
                Spacer(minLength: 8)
                value()
                Button {
                    inspector.startEdit(field, row: row, format: settings.numberFormat)
                } label: {
                    Image(systemName: "pencil")
                        .imageScale(.small)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.tertiaryLabel)
                .help(strings.t("common.editField", ["field": label]))
                .accessibilityLabel(strings.t("common.editField", ["field": label]))
            }
            .padding(.vertical, 8)
        }
    }

    @ViewBuilder
    private func editor(_ field: TransactionDetailField, label: String) -> some View {
        let text = Binding(get: { inspector.editingValue }, set: { inspector.editingValue = $0 })
        switch field {
        case .date:
            VisionDateField(
                day: inspector.editingDate, placeholder: label, settings: settings, strings: strings,
                calendar: model.calendar
            ) { day in
                inspector.editingDate = day
            }
        case .bank:
            AccountPicker(
                pickers: model.pickers, value: inspector.editingValue, placeholder: label, strings: strings
            ) { name, id in
                inspector.editingValue = name
                inspector.editingAccountId = id
            }
        case .comment:
            TextField(label, text: text, axis: .vertical)
                .textFieldStyle(.vision)
                .lineLimit(2...5)
                .onSubmit { Task { await model.saveDetail() } }
        case .amount, .memo, .currency:
            TextField(label, text: text)
                .textFieldStyle(.vision)
                .onSubmit { Task { await model.saveDetail() } }
        }
    }

    // MARK: Tags and footer

    private var tagsSection: some View {
        section(strings.t("txPage.field.tags")) {
            TagField(
                pickers: model.pickers, selected: inspector.tagSlugs, disabled: model.updatesInFlight > 0,
                label: strings.t("txPage.field.tags"), strings: strings
            ) { slugs in
                Task { await model.setTags(slugs) }
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            if TransactionsModel.splitIsNative {
                footerButton(strings.t("splitDialog.buttonTitle"), symbol: "person.2") { model.requestSplit(row) }
            }
            if row.canDuplicate {
                footerButton(strings.t("contextMenu.duplicate"), symbol: "plus.square.on.square") {
                    Task { await model.duplicate(row) }
                }
            }
            if row.recipientId != nil {
                footerButton(strings.t("txPage.inspector.showAllFromPayee"), symbol: "line.3.horizontal.decrease") {
                    model.showAllFrom(row)
                }
            }
            footerButton(
                row.isActive ? strings.t("contextMenu.markInactive") : strings.t("contextMenu.markActive"),
                symbol: row.isActive ? "eye.slash" : "eye"
            ) {
                Task { await model.toggleActive(row) }
            }
            .disabled(model.updatesInFlight > 0)
            footerButton(strings.t("contextMenu.delete"), symbol: "trash", destructive: true) {
                model.requestDelete(row)
            }
            .disabled(model.deletePending)
        }
    }

    private func footerButton(
        _ title: String, symbol: String, destructive: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button(role: destructive ? .destructive : nil, action: action) {
            Label(title, systemImage: symbol)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(destructive ? theme.destructive : theme.foreground)
    }
}

/// `AttachmentPanel`: the transaction's files with Upload, Quick Look, Download and Delete.
struct TransactionAttachmentsPanel: View {
    let model: TransactionsModel
    let attachments: TransactionAttachmentsModel
    let strings: any Localizing
    @State private var isPickerPresented = false
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(strings.t("txPage.attachments"))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(theme.secondaryLabel)
                    .textCase(.uppercase)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button {
                    isPickerPresented = true
                } label: {
                    HStack(spacing: 4) {
                        if attachments.isUploading {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "paperclip")
                        }
                        Text(strings.t("txPage.uploadAttachment"))
                    }
                }
                .buttonStyle(.visionOutline)
                .controlSize(.small)
                .disabled(attachments.isUploading)
            }
            if attachments.uploadFailed {
                Text(strings.t("txPage.uploadError"))
                    .font(.footnote)
                    .foregroundStyle(theme.destructive)
            }
            list
        }
        .fileImporter(isPresented: $isPickerPresented, allowedContentTypes: [.image, .pdf]) { result in
            guard case .success(let url) = result else { return }
            Task {
                guard let file = Self.read(url) else { return }
                await attachments.upload(file)
            }
        }
        .quickLookPreview(
            Binding(
                get: { attachments.previewURL },
                set: { url in
                    if url == nil { attachments.closePreview() }
                }))
        .alert(
            strings.t("txPage.deleteAttachment"),
            isPresented: Binding(get: { attachments.pendingDelete != nil }, set: { _ in })
        ) {
            Button(strings.t("common.cancel"), role: .cancel) { attachments.cancelDelete() }
            Button(strings.t("common.delete"), role: .destructive) {
                Task {
                    await attachments.confirmDelete()
                    model.reportAttachmentDeleteFailure()
                }
            }
        } message: {
            Text(strings.t("txPage.deleteAttachment.desc", ["name": attachments.pendingDelete?.filename ?? ""]))
        }
    }

    @ViewBuilder
    private var list: some View {
        if attachments.isLoading {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity)
                .accessibilityLabel(strings.t("common.loading"))
        } else if attachments.loadFailed {
            Text(strings.t("txPage.attachmentsError"))
                .font(.footnote)
                .foregroundStyle(theme.destructive)
        } else if let items = attachments.items, !items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items, id: \.id) { item in
                    attachmentRow(item)
                }
            }
        } else {
            Text(strings.t("txPage.noAttachments"))
                .font(.footnote)
                .foregroundStyle(theme.tertiaryLabel)
        }
    }

    private func attachmentRow(_ item: OpenAPI.Attachment) -> some View {
        HStack(spacing: 8) {
            if TransactionAttachmentsModel.isImage(item) {
                Button {
                    Task { await attachments.preview(item) }
                } label: {
                    thumbnail(item)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(item.filename)
                .task { await attachments.loadThumbnail(item) }
            } else {
                Image(systemName: "doc")
                    .frame(width: 32, height: 32)
                    .foregroundStyle(theme.secondaryLabel)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Button(item.filename) {
                    Task { await attachments.preview(item) }
                }
                .buttonStyle(.visionLink)
                .lineLimit(1)
                Text(TransactionAttachmentsModel.size(item.sizeBytes))
                    .font(.caption)
                    .foregroundStyle(theme.tertiaryLabel)
            }
            Spacer(minLength: 0)
            Button {
                Task { await attachments.download(item) }
            } label: {
                Image(systemName: "arrow.down.circle")
            }
            .buttonStyle(.borderless)
            .help(strings.t("txPage.bulk.exportConfirm"))
            .accessibilityLabel(strings.t("txPage.bulk.exportConfirm"))
            Button {
                attachments.requestDelete(item)
            } label: {
                if attachments.deletingId == item.id {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "trash")
                }
            }
            .buttonStyle(.borderless)
            .foregroundStyle(theme.destructive)
            .disabled(attachments.deletingId != nil)
            .help(strings.t("aria.deleteAttachment", ["name": item.filename]))
            .accessibilityLabel(strings.t("aria.deleteAttachment", ["name": item.filename]))
        }
    }

    @ViewBuilder
    private func thumbnail(_ item: OpenAPI.Attachment) -> some View {
        if let data = attachments.thumbnails[item.id], let image = NSImage(data: data) {
            Image(nsImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 32, height: 32)
                .clipShape(RoundedRectangle(cornerRadius: 4))
        } else {
            RoundedRectangle(cornerRadius: 4)
                .fill(theme.muted)
                .frame(width: 32, height: 32)
        }
    }

    /// The chosen file's bytes and type, read under its security scope.
    static func read(_ url: URL) -> AttachmentUpload? {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return nil }
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        return AttachmentUpload(name: url.lastPathComponent, contentType: type, data: data)
    }
}
