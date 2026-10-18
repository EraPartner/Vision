import SwiftUI
import VisionNativeCore

/// `/import/:batchId/review` (apps/frontend/src/pages/ImportReviewPage.tsx) in SwiftUI: the
/// badge legend, the accounts the batch writes to, one disclosure per payee group with its
/// payee and category pickers and staged rows, and Discard (an alert) or Import {n} rows.
public struct ImportReviewView: View {
    /// `max-w-3xl`.
    static let maxContentWidth: CGFloat = 768

    private let model: ImportReviewModel
    private let toasts: ImportNoticeCenter
    private let batchId: Int
    private let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    public init(model: ImportReviewModel, toasts: ImportNoticeCenter, batchId: Int, shell: NativeShellModel) {
        self.model = model
        self.toasts = toasts
        self.batchId = batchId
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                content
            }
            .padding(24)
            .frame(maxWidth: Self.maxContentWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .foregroundStyle(theme.foreground)
        .task(id: batchId) { await model.appear(batchId: batchId) }
        .onDisappear { model.disappear() }
        .onChange(of: model.navigationRequest) { _, request in
            guard let request else { return }
            switch request {
            case .push(let url): shell.navigate(to: url)
            case .replace(let url): shell.replace(with: url)
            }
            model.didHandleNavigation()
        }
        .overlay(alignment: .bottom) {
            ImportToastStack(center: toasts, strings: strings) { route in shell.navigate(to: route) }
        }
        // `useConfirmDialog`, destructive. The buttons decide; the binding only reads.
        .alert(
            strings.t("importReview.discard.title"),
            isPresented: Binding(get: { model.isDiscardConfirmationPresented }, set: { _ in })
        ) {
            Button(strings.t("common.cancel"), role: .cancel) { model.cancelDiscard() }
            Button(strings.t("importReview.discard.confirm"), role: .destructive) {
                Task { await model.confirmDiscard(strings: strings) }
            }
        } message: {
            Text(strings.t("importReview.discard.desc", ["n": String(model.totalRows)]))
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.batchId != batchId || model.isLoading {
            ProgressView()
                .controlSize(.regular)
                .frame(maxWidth: .infinity, minHeight: 240)
        } else if let error = model.error {
            backButton
            errorState(error)
        } else if let preview = model.preview {
            loaded(preview)
        }
    }

    private var backButton: some View {
        Button {
            model.goBack()
        } label: {
            Label(strings.t("importReview.back"), systemImage: "chevron.left")
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
    }

    /// `PageError`: `common.error`, the message and Retry.
    private func errorState(_ error: APIError) -> some View {
        let message = APIErrorMessage.text(error, strings: strings)
        return VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title)
                .foregroundStyle(theme.destructive)
                .accessibilityHidden(true)
            Text(strings.t("common.error"))
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            Text(message)
                .font(.callout)
                .foregroundStyle(theme.secondaryLabel)
                .multilineTextAlignment(.center)
            Button(strings.t("common.retry")) {
                Task { await model.retry() }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
        .accessibilityElement(children: .contain)
        .task(id: message) {
            AccessibilityNotification.Announcement("\(strings.t("common.error")). \(message)").post()
        }
    }

    @ViewBuilder
    private func loaded(_ preview: ImportPreview) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            backButton
            VisionPageHeader(
                title: strings.t("importReview.title"),
                subtitle: strings.t("importReview.subtitle", ["n": String(preview.totalRows)]),
                symbol: NavigationRegistry.matchItem(path: ImportRoutes.path)?.symbol ?? "square.and.arrow.down")
        }
        legend(preview)
        accounts
        groups(preview)
        footer(preview)
    }

    // MARK: Legend

    private func legend(_ preview: ImportPreview) -> some View {
        AdminCard(padding: 0) {
            VStack(alignment: .leading, spacing: 0) {
                Text(strings.t("importReview.legend.title"))
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                    .padding(20)
                ForEach(ImportMatchKind.allCases) { kind in
                    Divider().opacity(0.5)
                    HStack(spacing: 12) {
                        ImportMatchBadge(kind: kind, similarity: nil, settings: settings, strings: strings)
                            .frame(width: 160, alignment: .leading)
                        Text(strings.t(kind.legendKey))
                            .foregroundStyle(theme.secondaryLabel)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(verbatim: preview.totals[kind.rawValue].map { String($0) } ?? "")
                            .monospacedDigit()
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)
                    .frame(minHeight: 44)
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(strings.t("importReview.legend.title"))
    }

    // MARK: Accounts

    @ViewBuilder
    private var accounts: some View {
        let entries = model.accountDisclosure
        if !entries.isEmpty {
            AdminCard(padding: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(strings.t("importReview.accounts.title"))
                            .font(.headline)
                            .accessibilityAddTraits(.isHeader)
                        Text(strings.t("importReview.accounts.desc"))
                            .font(.callout)
                            .foregroundStyle(theme.secondaryLabel)
                    }
                    .padding(20)
                    ForEach(entries) { entry in
                        Divider().opacity(0.5)
                        FlowLayout(spacing: 8) {
                            Text(strings.t("importReview.accounts.line", ["n": String(entry.count)]))
                                .foregroundStyle(theme.secondaryLabel)
                            if entry.isUnspecified {
                                Text(strings.t("importReview.accounts.unspecified"))
                                    .italic()
                                    .foregroundStyle(theme.secondaryLabel)
                            } else {
                                Text(verbatim: entry.label)
                                    .fontWeight(.medium)
                            }
                            if entry.isNew {
                                VisionBadge(text: strings.t("importReview.accounts.newBadge"), tone: .success)
                            }
                        }
                        .padding(.horizontal, 20)
                        .padding(.vertical, 10)
                        .frame(minHeight: 44, alignment: .leading)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }

    // MARK: Payee groups

    private func groups(_ preview: ImportPreview) -> some View {
        AdminCard(padding: 0) {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(strings.t("importReview.groups.title"))
                        .font(.headline)
                        .accessibilityAddTraits(.isHeader)
                    Text(strings.t("importReview.groups.desc"))
                        .font(.callout)
                        .foregroundStyle(theme.secondaryLabel)
                }
                .padding(20)
                ForEach(Array(preview.groups.enumerated()), id: \.offset) { _, group in
                    Divider().opacity(0.5)
                    ImportReviewGroupView(model: model, group: group, settings: settings, strings: strings)
                }
            }
        }
    }

    // MARK: Footer

    private func footer(_ preview: ImportPreview) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(strings.t("importReview.readyHint"))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                if model.isSavingEdits {
                    Text(strings.t("importReview.savingEdits")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                }
                if model.hasEditErrors {
                    HStack(spacing: 8) {
                        Text(strings.t("importReview.editsFailed")).font(.footnote).foregroundStyle(theme.destructive)
                        Button(strings.t("importReview.reviewSavedEdits")) {
                            Task { await model.reviewSavedEdits() }
                        }
                        .buttonStyle(.bordered).controlSize(.small).disabled(model.isBusy)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button(strings.t(model.isDiscarding ? "importReview.discarding" : "importReview.discard")) {
                model.requestDiscard()
            }
            .buttonStyle(.bordered)
            .disabled(model.isBusy)
            Button {
                Task { await model.commit(strings: strings) }
            } label: {
                if model.isCommitting {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text(strings.t("importReview.committing"))
                    }
                } else {
                    Text(strings.t("importReview.approve", ["n": String(preview.totalRows)]))
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.isBusy || model.hasEditErrors)
        }
        .padding(.bottom, 32)
    }
}

/// `MatchBadge`: exact secondary, fuzzy warning with its similarity, pattern an info outline,
/// new success, unresolved destructive.
struct ImportMatchBadge: View {
    let kind: ImportMatchKind
    let similarity: Double?
    let settings: NativeAppSettings
    let strings: any Localizing
    @Environment(\.visionTheme) var theme

    private var text: String {
        let label = strings.t(kind.labelKey)
        guard kind == .fuzzy, let similarity, similarity.isFinite else { return label }
        return "\(label) \(VisionFormat.percent(Decimal(similarity * 100), digits: 0, locale: settings.numberFormat.locale))"
    }

    var body: some View {
        switch kind {
        case .exact:
            VisionBadge(text: text, tone: .secondary)
        case .fuzzy:
            VisionBadge(text: text, tone: .warning)
        case .pattern:
            Text(text)
                .font(.caption.weight(.medium))
                .lineLimit(1)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .foregroundStyle(theme.info)
                .overlay(Capsule().strokeBorder(theme.info.opacity(0.5), lineWidth: 1))
        case .new:
            VisionBadge(text: text, tone: .success)
        case .unresolved:
            VisionBadge(text: text, tone: .destructive)
        }
    }
}

/// One accordion item: the trigger (badge, name, row count) with the payee picker beside it,
/// and when open the matched rule, the category controls and the staged rows.
struct ImportReviewGroupView: View {
    let model: ImportReviewModel
    let group: ImportPreviewGroup
    let settings: NativeAppSettings
    let strings: any Localizing
    @Environment(\.visionTheme) var theme

    var body: some View {
        let state = model.state(for: group)
        let heading = model.heading(for: group, strings: strings)
        let expanded = model.isExpanded(group)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Button {
                    withAnimation(.snappy) { model.setExpanded(group, !expanded) }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "chevron.right")
                            .imageScale(.small)
                            .foregroundStyle(theme.secondaryLabel)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                            .accessibilityHidden(true)
                        ImportMatchBadge(kind: group.dominantKind, similarity: nil, settings: settings, strings: strings)
                        Text(verbatim: heading)
                            .fontWeight(.medium)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Text(strings.t("importReview.rowCount", ["n": String(group.rowCount)]))
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryLabel)
                            .fixedSize()
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isHeader)
                .accessibilityValue(Text(strings.t("importReview.rowCount", ["n": String(group.rowCount)])))
                if state.isSaving {
                    ProgressView()
                        .controlSize(.mini)
                        .accessibilityHidden(true)
                }
                ImportReviewPayeePicker(
                    pickers: model.pickers, value: state.recipientId, fallbackLabel: state.recipientName,
                    accessibilityName: strings.t("importReview.recipientPickerLabel", ["name": heading]),
                    disabled: state.recipientSaving, strings: strings
                ) { id, name in
                    Task { await model.setRecipient(id, name: name, for: group, strings: strings) }
                }
                .frame(maxWidth: 200)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            if expanded {
                details(state)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 16)
                    .transition(.opacity)
            }
        }
    }

    private func details(_ state: ImportReviewGroupState) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let pattern = group.matchedPatternText, !pattern.isEmpty {
                HStack(spacing: 4) {
                    Text(verbatim: "\(strings.t("importReview.pattern")):")
                    Text(verbatim: pattern).font(.footnote.monospaced())
                }
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
                .lineLimit(1)
                .truncationMode(.tail)
            }
            FlowLayout(spacing: 12) {
                Text(strings.t("importReview.category"))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                // A group whose rows resolve to different categories shows none, as the web does.
                let mixed =
                    !state.categorySaving
                    && Set(group.rows.map { $0.overrideCategoryId ?? group.recipientDefaultCategoryId }).count > 1
                CategoryPicker(
                    pickers: model.pickers, value: mixed ? nil : state.categoryId,
                    disabled: model.isBusy || state.categorySaving || state.recipientId == nil, strings: strings
                ) { id in
                    let label = model.pickers.categoryLabel(id)
                    Task { await model.setCategory(id, label: label, for: group, strings: strings) }
                }
                .frame(width: 260)
                .accessibilityLabel(strings.t("importReview.category"))
                if mixed {
                    Text(strings.t("importReview.mixedCategories")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                }
                if state.recipientId != nil {
                    Toggle(
                        strings.t("importReview.persistDefault"),
                        isOn: Binding(
                            get: { model.state(for: group).persistAsDefault },
                            set: { model.setPersistDefault($0, for: group) })
                    )
                    .toggleStyle(.checkbox)
                    .font(.footnote)
                    .disabled(model.isBusy || state.categorySaving)
                }
            }
            Divider().opacity(0.5)
            VStack(spacing: 0) {
                ForEach(Array(group.rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Divider().opacity(0.4) }
                    rowView(row)
                }
            }
        }
    }

    private func rowView(_ row: ImportStagingRow) -> some View {
        HStack(spacing: 12) {
            ImportMatchBadge(kind: row.matchKind, similarity: row.matchSimilarity, settings: settings, strings: strings)
                .fixedSize()
            Text(verbatim: dateText(row.txDate))
                .monospacedDigit()
                .foregroundStyle(theme.secondaryLabel)
                .fixedSize()
            Text(verbatim: row.recipientRaw ?? "")
                .lineLimit(1)
                .truncationMode(.tail)
            if let memo = row.memo, !memo.isEmpty {
                Text(verbatim: memo)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .foregroundStyle(theme.tertiaryLabel)
                    .layoutPriority(-1)
            }
            Spacer(minLength: 8)
            MoneyText(amount: row.amountValue, currency: row.currencyCode, settings: settings)
                .fontWeight(.medium)
                .fixedSize()
        }
        .font(.footnote)
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    /// `formatDateStringWithAppSettings(row.tx_date, format)`.
    private func dateText(_ text: String?) -> String {
        guard let text, let day = PlannedDay(ymd: text, calendar: .current) else { return text ?? "" }
        return day.text(format: settings.dateFormat)
    }
}

/// `DeferredRecipientCombobox` for a review group: No payee and the include-inactive payees
/// (the first page, or a debounced server search). The typed search stays when the popover
/// opens again; this picker never creates a payee.
struct ImportReviewPayeePicker: View {
    let pickers: PickerDataModel
    let value: Int?
    /// The group's payee name while the lists do not have it.
    let fallbackLabel: String?
    let accessibilityName: String
    var disabled = false
    let strings: any Localizing
    let onSelect: (Int?, String?) -> Void
    @State private var isOpen = false
    @State private var search = ""

    var body: some View {
        PickerButton(
            label: value == nil ? nil : (pickers.recipientName(value) ?? fallbackLabel),
            placeholder: strings.t("combobox.recipient.placeholder"), disabled: disabled, isOpen: $isOpen
        ) {
            PickerList(
                search: $search, searchPlaceholder: strings.t("combobox.recipient.search"),
                emptyText: strings.t("combobox.recipient.empty"), options: options
            )
            .task(id: search) {
                try? await Task.sleep(for: PickerDataModel.searchDebounce)
                guard !Task.isCancelled else { return }
                await pickers.searchRecipients(search)
            }
        }
        .font(.footnote)
        .accessibilityLabel(accessibilityName)
    }

    private var options: [PickerOption] {
        var options = [
            PickerOption(id: "none", title: strings.t("combobox.recipient.none"), isSelected: value == nil, isNone: true) {
                pick(nil, nil)
            }
        ]
        for recipient in pickers.recipients(matching: search) {
            options.append(
                PickerOption(id: String(recipient.id), title: recipient.name, isSelected: recipient.id == value) {
                    pick(recipient.id, recipient.name)
                })
        }
        return options
    }

    private func pick(_ id: Int?, _ name: String?) {
        onSelect(id, name)
        isOpen = false
    }
}
