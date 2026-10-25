import SwiftUI
import VisionNativeCore

/// The Import & export toasts (one Sonner toaster for `/import` and its review page): up to
/// three stacked, newest at the bottom; a toast with an action opens its route.
struct ImportToastStack: View {
    let center: ImportNoticeCenter
    let strings: any Localizing
    let open: (String) -> Void

    var body: some View {
        VStack(spacing: 8) {
            ForEach(center.notices) { notice in
                let action = center.action(for: notice.id)
                ActionToast(
                    notice: notice, strings: strings, actionTitle: action.map { strings.t($0.titleKey) },
                    duration: center.duration(of: notice),
                    action: {
                        guard let action else { return }
                        center.clear(notice.id)
                        open(action.route)
                    },
                    clear: { center.clear($0) }, bindsUndoShortcut: false, bottomPadding: 0)
            }
        }
        .padding(.bottom, 20)
        .animation(.snappy, value: center.notices)
    }
}

/// One item of a multi-select popover.
struct MultiSelectOption: Identifiable {
    let id: String
    let title: String
    let isSelected: Bool
    let toggle: () -> Void
}

/// `MultiCombobox`: the face shows "All" or "{n} selected"; the popover has a search field
/// and a list where a click (or Return on the first match) toggles an item with a check
/// mark. It stays open while picking.
struct MultiSelectPicker: View {
    let label: String
    let accessibilityName: String
    let searchPlaceholder: String
    let emptyText: String
    let options: @MainActor (String) -> [MultiSelectOption]
    @State private var isOpen = false
    @State private var search = ""

    var body: some View {
        PickerButton(label: label, placeholder: label, isOpen: $isOpen) {
            PickerList(
                search: $search, searchPlaceholder: searchPlaceholder, emptyText: emptyText,
                options: options(search).map { option in
                    PickerOption(id: option.id, title: option.title, isSelected: option.isSelected, pick: option.toggle)
                })
        }
        .accessibilityLabel(accessibilityName)
        .onChange(of: isOpen) { _, open in
            if !open { search = "" }
        }
    }
}

/// `ExportCard`: Export filters (Show / Hide filters, start and end date, bank accounts,
/// categories, the note) and Export CSV / Export JSON, which fetch the file and then ask
/// where to save it.
struct ImportExportCard: View {
    let model: TransactionExportModel
    let settings: NativeAppSettings
    let strings: any Localizing
    @Environment(\.visionTheme) var theme

    private static let columns = [
        GridItem(.flexible(), spacing: 12, alignment: .top), GridItem(.flexible(), spacing: 12, alignment: .top),
    ]

    var body: some View {
        AdminCard(padding: 24) {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Label {
                        Text(strings.t("importPage.csvExport"))
                    } icon: {
                        Image(systemName: "square.and.arrow.down")
                            .foregroundStyle(Color(token: theme.palette.accent))
                    }
                    .font(.visionCardTitle)
                    .accessibilityAddTraits(.isHeader)
                    Text(strings.t("importPage.csvExportDesc"))
                        .font(.body)
                        .foregroundStyle(theme.secondaryLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Text(strings.t("importPage.exportFilters"))
                        .font(.headline)
                        .accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button(strings.t(model.showsFilters ? "importPage.hideFilters" : "importPage.showFilters")) {
                        Task { await model.toggleFilters() }
                    }
                    .buttonStyle(.visionOutline)
                    .controlSize(.small)
                }
                if model.showsFilters {
                    filters
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
                HStack(spacing: 8) {
                    ForEach(ExportFormat.allCases) { format in
                        Button {
                            Task { await model.export(format, strings: strings) }
                        } label: {
                            Group {
                                if model.exportingFormat == format {
                                    HStack(spacing: 6) {
                                        ProgressView().controlSize(.small)
                                        Text(strings.t("importPage.exporting"))
                                    }
                                } else {
                                    Label(strings.t(format.labelKey), systemImage: "arrow.down.doc")
                                }
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.visionOutline)
                        .controlSize(.large)
                        .disabled(model.isExporting)
                    }
                }
            }
            .animation(.snappy, value: model.showsFilters)
        }
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: 16) {
            LazyVGrid(columns: Self.columns, alignment: .leading, spacing: 16) {
                ImportField(label: strings.t("importPage.startDate")) {
                    VisionDateField(
                        day: model.filters.startDate, placeholder: strings.t("plannedPage.link.pickDate"),
                        allowClear: true, clearLabel: strings.t("common.clear"), settings: settings, strings: strings,
                        calendar: .current, onChange: { model.filters.startDate = $0 })
                }
                ImportField(label: strings.t("importPage.endDate")) {
                    VisionDateField(
                        day: model.filters.endDate, placeholder: strings.t("plannedPage.link.pickDate"),
                        allowClear: true, clearLabel: strings.t("common.clear"), settings: settings, strings: strings,
                        calendar: .current, onChange: { model.filters.endDate = $0 })
                }
                ImportField(label: strings.t("importPage.bankAccounts")) {
                    MultiSelectPicker(
                        label: model.bankAccountsLabel(strings), accessibilityName: strings.t("importPage.bankAccounts"),
                        searchPlaceholder: strings.t("combobox.bankAccount.search"),
                        emptyText: strings.t("combobox.bankAccount.empty"), options: { bankAccountOptions($0) })
                }
                ImportField(label: strings.t("importPage.categories")) {
                    MultiSelectPicker(
                        label: model.categoriesLabel(strings), accessibilityName: strings.t("importPage.categories"),
                        searchPlaceholder: strings.t("combobox.categoryMulti.search"),
                        emptyText: strings.t("combobox.categoryMulti.empty"), options: { categoryOptions($0) })
                }
            }
            Text(strings.t("importPage.exportNote"))
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: DesignTokens.Radius.card).fill(theme.foreground.opacity(0.04)))
    }

    private func bankAccountOptions(_ search: String) -> [MultiSelectOption] {
        let picked = model.filters.bankAccounts
        return MultiSelection.ordered(
            model.bankAccounts, selection: picked, value: { $0 }, searchText: { $0 }, search: search
        ).map { label in
            MultiSelectOption(id: label, title: label, isSelected: picked.contains(label)) {
                model.toggleBankAccount(label)
            }
        }
    }

    private func categoryOptions(_ search: String) -> [MultiSelectOption] {
        let picked = model.filters.categoryIds
        return MultiSelection.ordered(
            model.activeCategories, selection: picked, value: { $0.id }, searchText: { PickerDataModel.label($0) },
            search: search
        ).map { node in
            MultiSelectOption(id: String(node.id), title: PickerDataModel.label(node), isSelected: picked.contains(node.id)) {
                model.toggleCategory(node.id)
            }
        }
    }
}

/// The collapsible Setup and reference card: Payees from CSV, Categories from CSV and
/// Supported banks behind the chevron.
struct ImportSetupReferenceCard: View {
    let model: ImportsModel
    let strings: any Localizing
    @Environment(\.visionTheme) var theme

    var body: some View {
        AdminCard(padding: 24) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(strings.t("importPage.setupReference"))
                            .font(Font.visionTitle3)
                            .accessibilityAddTraits(.isHeader)
                        Text(strings.t("importPage.setupReferenceDesc"))
                            .font(.body)
                            .foregroundStyle(theme.secondaryLabel)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    Button {
                        withAnimation(.snappy) { model.toggleSetupReference() }
                    } label: {
                        Image(systemName: "chevron.down")
                            .rotationEffect(.degrees(model.isSetupReferenceExpanded ? 180 : 0))
                    }
                    .buttonStyle(.visionOutline)
                    .accessibilityLabel(strings.t("importPage.toggleSetupReference"))
                    .help(strings.t("importPage.toggleSetupReference"))
                }
                if model.isSetupReferenceExpanded {
                    VStack(alignment: .leading, spacing: 16) {
                        SimpleCSVImportCard(model: model.recipientsCSV, strings: strings)
                        SimpleCSVImportCard(model: model.categoriesCSV, strings: strings)
                        SupportedBanksCard(model: model, strings: strings)
                    }
                    .transition(.opacity)
                }
            }
        }
    }
}

/// `SimpleImportCard`: the separator (and for payees the encoding), the compact dropzone,
/// the result line and the import button.
struct SimpleCSVImportCard: View {
    let model: SimpleCSVImportModel
    let strings: any Localizing
    @Environment(\.visionTheme) var theme

    private static let columns = [
        GridItem(.flexible(), spacing: 12, alignment: .top), GridItem(.flexible(), spacing: 12, alignment: .top),
    ]

    private var symbol: String {
        switch model.kind {
        case .recipients: return "person.2"
        case .categories: return "tag"
        }
    }

    var body: some View {
        AdminCard(padding: 16) {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Label {
                        Text(strings.t(model.kind.titleKey))
                    } icon: {
                        Image(systemName: symbol).foregroundStyle(theme.primary)
                    }
                    .font(.visionCardTitle)
                    .accessibilityAddTraits(.isHeader)
                    Text(strings.t(model.kind.descriptionKey))
                        .font(.body)
                        .foregroundStyle(theme.secondaryLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
                LazyVGrid(columns: Self.columns, alignment: .leading, spacing: 12) {
                    ImportField(label: strings.t("importPage.separator")) {
                        Picker(
                            strings.t("importPage.separator"),
                            selection: Binding(get: { model.separator }, set: { model.separator = $0 })
                        ) {
                            ForEach(CSVSeparator.candidates, id: \.self) { separator in
                                Text(CSVSeparator.labelKey(separator).map { strings.t($0) } ?? separator).tag(separator)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                    }
                    if model.kind.showsEncoding {
                        ImportField(label: strings.t("importPage.encoding")) {
                            Picker(
                                strings.t("importPage.encoding"),
                                selection: Binding(
                                    get: { CSVFormatOptions.selectedEncoding(model.encoding) },
                                    set: { model.encoding = $0 })
                            ) {
                                ForEach(CSVFormatOptions.encodings, id: \.value) { option in
                                    Text(verbatim: option.label).tag(option.value)
                                }
                            }
                            .labelsHidden()
                            .pickerStyle(.menu)
                        }
                    }
                }
                CSVDropzone(
                    file: model.file, compact: true, strings: strings, choose: { model.chooseFile($0) },
                    unreadable: { model.fileUnreadable() }, remove: { model.removeFile() })
                if let result = model.result, !model.isImporting {
                    HStack(spacing: 10) {
                        Image(systemName: "checkmark.circle.fill").accessibilityHidden(true)
                        Text(
                            strings.t(
                                "importPage.resultSummary",
                                [
                                    "imported": String(result.imported), "skipped": String(result.skipped),
                                    "errors": String(result.errors),
                                ]))
                    }
                    .font(.callout)
                    .foregroundStyle(theme.success)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: DesignTokens.Radius.card).fill(theme.success.opacity(0.1)))
                    .overlay(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.card).strokeBorder(
                            theme.success.opacity(0.3), lineWidth: 1))
                    .accessibilityElement(children: .combine)
                }
                Button {
                    Task { await model.startImport(strings: strings) }
                } label: {
                    Group {
                        if model.isImporting {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text(strings.t(model.kind.importingKey))
                            }
                        } else {
                            Label(strings.t(model.kind.importKey), systemImage: symbol)
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.visionPrimary)
                .controlSize(.large)
                .disabled(!model.canImport)
            }
        }
    }
}

/// `SupportedBanksCard`: a loading badge, one badge per built-in bank (or the empty text),
/// and the Custom hint.
struct SupportedBanksCard: View {
    let model: ImportsModel
    let strings: any Localizing
    @Environment(\.visionTheme) var theme

    var body: some View {
        AdminCard(padding: 16) {
            VStack(alignment: .leading, spacing: 12) {
                Text(strings.t("importPage.supportedBanks"))
                    .font(Font.visionTitle3)
                    .accessibilityAddTraits(.isHeader)
                if model.isLoadingAdapters {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text(strings.t("importPage.supportedLoading"))
                    }
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(theme.foreground.opacity(0.06)))
                    .accessibilityElement(children: .combine)
                } else if let adapters = model.adapters, !adapters.isEmpty {
                    FlowLayout(spacing: 6) {
                        ForEach(adapters, id: \.key) { adapter in
                            VisionBadge(text: adapter.name, tone: .primary)
                        }
                    }
                } else {
                    Text(strings.t("importPage.noSupportedParsers"))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                }
                Text(strings.t("importPage.noSupportedBank"))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
            }
        }
    }
}
