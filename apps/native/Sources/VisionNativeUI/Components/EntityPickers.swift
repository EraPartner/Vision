import SwiftUI
import VisionNativeCore

/// One row of a searchable picker popover.
struct PickerOption: Identifiable {
    let id: String
    let title: String
    var detail: String?
    var isSelected = false
    /// The italic "none" row.
    var isNone = false
    /// A leading symbol in the accent colour in place of the check mark (a create row).
    var symbol: String?
    let pick: () -> Void
}

/// The closed face shared by the comboboxes: the label (or the placeholder in the tertiary
/// colour) and an up-down chevron, opening `content` in a popover.
struct PickerButton<Content: View>: View {
    let label: String?
    let placeholder: String
    var invalid = false
    var disabled = false
    @Binding var isOpen: Bool
    @ViewBuilder let content: () -> Content
    @Environment(\.visionTheme) var theme

    var body: some View {
        Button {
            isOpen.toggle()
        } label: {
            HStack(spacing: 6) {
                Text(label ?? placeholder)
                    .foregroundStyle(label == nil ? theme.tertiaryLabel : theme.foreground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down")
                    .imageScale(.small)
                    .foregroundStyle(theme.tertiaryLabel)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.bordered)
        .disabled(disabled)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                .strokeBorder(invalid ? theme.destructive : Color.clear, lineWidth: 1)
        )
        .accessibilityValue(label ?? placeholder)
        .popover(isPresented: $isOpen, arrowEdge: .bottom) {
            content()
                .environment(\.visionTheme, theme)
        }
    }
}

/// The popover body of a combobox (`Command`): a search field over a scrolling list with a
/// check mark on the selected row, or the empty text.
struct PickerList: View {
    @Binding var search: String
    let searchPlaceholder: String
    let emptyText: String?
    let options: [PickerOption]
    @FocusState private var searchFocused: Bool
    @Environment(\.visionTheme) var theme

    init(search: Binding<String>, searchPlaceholder: String, emptyText: String?, options: [PickerOption]) {
        _search = search
        self.searchPlaceholder = searchPlaceholder
        self.emptyText = emptyText
        self.options = options
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField(searchPlaceholder, text: $search)
                .textFieldStyle(.roundedBorder)
                .focused($searchFocused)
                .onSubmit {
                    options.first?.pick()
                }
            if options.isEmpty, let emptyText {
                Text(emptyText)
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(options) { option in
                            row(option)
                        }
                    }
                }
                .frame(maxHeight: 280)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(8)
        .frame(width: 280)
        .onAppear { searchFocused = true }
    }

    private func row(_ option: PickerOption) -> some View {
        Button(action: option.pick) {
            HStack(spacing: 8) {
                Image(systemName: option.symbol ?? "checkmark")
                    .imageScale(.small)
                    .foregroundStyle(option.symbol == nil ? theme.foreground : theme.primary)
                    .opacity(option.isSelected || option.symbol != nil ? 1 : 0)
                    .accessibilityHidden(true)
                Text(option.title)
                    .italic(option.isNone)
                    .foregroundStyle(
                        option.symbol != nil ? theme.primary : option.isNone ? theme.secondaryLabel : theme.foreground)
                    .lineLimit(1)
                if let detail = option.detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.chip)
                .fill(option.isSelected ? theme.primary.opacity(0.08) : Color.clear))
        .accessibilityAddTraits(option.isSelected ? .isSelected : [])
    }
}

/// `RecipientCombobox`: "No payee" and the include-inactive recipients (or only the active
/// ones), the first page unsearched and a server search (debounced) while typing. With
/// `onCreate` (`allowCreate`), a typed name no listed payee has offers "Add {name}" first.
struct RecipientPicker: View {
    let pickers: PickerDataModel
    let value: Int?
    var disabled = false
    var invalid = false
    /// `active`: only the active payees.
    var activeOnly = false
    let strings: any Localizing
    let onSelect: (Int?) -> Void
    /// The create row's action, with the trimmed name.
    var onCreate: ((String) -> Void)?
    @State var isOpen = false
    @State var search = ""

    var body: some View {
        PickerButton(
            label: pickers.recipientName(value), placeholder: strings.t("combobox.recipient.placeholder"),
            invalid: invalid, disabled: disabled, isOpen: $isOpen
        ) {
            PickerList(
                search: $search, searchPlaceholder: strings.t("combobox.recipient.search"), emptyText: nil,
                options: options
            )
            .task(id: search) {
                try? await Task.sleep(for: PickerDataModel.searchDebounce)
                guard !Task.isCancelled else { return }
                await pickers.searchRecipients(search)
            }
        }
        .task(id: value) { await pickers.resolveRecipient(value) }
        .onChange(of: isOpen) { _, open in
            if !open { search = "" }
        }
    }

    private var listed: [OpenAPI.Recipient] {
        activeOnly ? pickers.activeRecipients(matching: search) : pickers.recipients(matching: search)
    }

    private var options: [PickerOption] {
        let shown = listed
        var options: [PickerOption] = []
        if let onCreate, let name = PickerDataModel.creatableName(search, listed: shown) {
            options.append(
                PickerOption(
                    id: "create", title: strings.t("combobox.recipient.create", ["name": name]), symbol: "plus"
                ) {
                    isOpen = false
                    onCreate(name)
                })
        }
        options.append(
            PickerOption(id: "none", title: strings.t("combobox.recipient.none"), isSelected: value == nil, isNone: true) {
                pick(nil)
            })
        for recipient in shown {
            options.append(
                PickerOption(id: String(recipient.id), title: recipient.name, isSelected: recipient.id == value) {
                    pick(recipient.id)
                })
        }
        return options
    }

    private func pick(_ id: Int?) {
        onSelect(id)
        isOpen = false
    }
}

/// `CategoryCombobox`: "No category" and the active categories by their full path, filtered
/// locally while typing.
struct CategoryPicker: View {
    let pickers: PickerDataModel
    let value: Int?
    var disabled = false
    let strings: any Localizing
    let onSelect: (Int?) -> Void
    @State var isOpen = false
    @State var search = ""

    var body: some View {
        PickerButton(
            label: pickers.categoryLabel(value), placeholder: strings.t("combobox.category.placeholder"),
            disabled: disabled, isOpen: $isOpen
        ) {
            PickerList(
                search: $search, searchPlaceholder: strings.t("combobox.category.search"),
                emptyText: strings.t("combobox.category.empty"), options: options)
        }
        .onChange(of: isOpen) { _, open in
            if !open { search = "" }
        }
    }

    private var options: [PickerOption] {
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        var options: [PickerOption] = []
        if query.isEmpty {
            options.append(
                PickerOption(id: "none", title: strings.t("combobox.category.none"), isSelected: value == nil, isNone: true) {
                    pick(nil)
                })
        }
        for node in pickers.activeCategories {
            let label = PickerDataModel.label(node)
            guard query.isEmpty || "\(label) \(node.id)".lowercased().contains(query) else { continue }
            options.append(PickerOption(id: String(node.id), title: label, isSelected: node.id == value) { pick(node.id) })
        }
        return options
    }

    private func pick(_ id: Int?) {
        onSelect(id)
        isOpen = false
    }
}

/// `AccountCombobox`: the active accounts by display name (the account name beside it when
/// it differs), filtered locally; it always picks an existing account.
struct AccountPicker: View {
    let pickers: PickerDataModel
    /// The selected account's name.
    let value: String
    let placeholder: String
    var invalid = false
    var disabled = false
    let strings: any Localizing
    let onPick: (String, Int) -> Void
    @State var isOpen = false
    @State var search = ""

    var body: some View {
        PickerButton(
            label: pickers.accountLabel(name: value), placeholder: placeholder, invalid: invalid, disabled: disabled,
            isOpen: $isOpen
        ) {
            PickerList(
                search: $search, searchPlaceholder: strings.t("combobox.account.search"),
                emptyText: strings.t("combobox.account.empty"), options: options)
        }
        .onChange(of: isOpen) { _, open in
            if !open { search = "" }
        }
    }

    private var options: [PickerOption] {
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        let selected = value.trimmingCharacters(in: .whitespaces).lowercased()
        return pickers.accounts.compactMap { account in
            let display = account.displayName.flatMap { $0.isEmpty ? nil : $0 }
            let haystack = "\(display ?? "") \(account.name) \(account.id)".lowercased()
            guard query.isEmpty || haystack.contains(query) else { return nil }
            return PickerOption(
                id: String(account.id), title: display ?? account.name,
                detail: display != nil && display != account.name ? account.name : nil,
                isSelected: account.name.trimmingCharacters(in: .whitespaces).lowercased() == selected
            ) {
                onPick(account.name, account.id)
                search = ""
                isOpen = false
            }
        }
    }
}
