import SwiftUI
import VisionNativeCore

/// `LinkTransactionDialog` (apps/frontend/src/features/planned/LinkTransactionDialog.tsx):
/// Mark {name} as paid. The filters refetch the candidates (debounced); the search and the
/// amount match filter them locally; a chosen row shows the date the payment is recorded on.
struct PlannedLinkSheet: View {
    let model: PlannedPaymentsModel
    @Bindable var link: PlannedLinkModel
    let shell: NativeShellModel
    @FocusState private var toleranceFocused: Bool
    @Environment(\.visionTheme) var theme

    init(model: PlannedPaymentsModel, link: PlannedLinkModel, shell: NativeShellModel) {
        self.model = model
        _link = Bindable(wrappedValue: link)
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }
    private var calendar: Calendar { model.calendar }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    TextField(strings.t("plannedPage.link.searchPlaceholder"), text: $link.search)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel(strings.t("plannedPage.link.searchPlaceholder"))
                    filters
                    candidates
                    if let selected = link.selectedTransaction {
                        Text(strings.t("plannedPage.link.recordedOn", ["date": recordedDate(selected)]))
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryLabel)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 16)
            }
            Divider()
            footer
        }
        .frame(minWidth: 560, idealWidth: 640, minHeight: 520, idealHeight: 680)
        .foregroundStyle(theme.foreground)
        .task { await link.resolveCluster() }
        .task(id: link.filters.requestKey) {
            try? await Task.sleep(for: PlannedLinkModel.debounce)
            guard !Task.isCancelled else { return }
            await link.load()
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(strings.t("plannedPage.link.title", ["name": link.payment.name]))
                    .font(.visionCardTitle)
                    .accessibilityAddTraits(.isHeader)
                Text(description)
                    .font(.callout)
                    .foregroundStyle(theme.secondaryLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button {
                model.dismissLinkDialog()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(strings.t("common.close"))
            .help(strings.t("common.close"))
        }
        .padding(.horizontal, 24)
        .padding(.top, 20)
        .padding(.bottom, 4)
    }

    /// The intro, then "Due on {date}." when the payment has a due date.
    private var description: String {
        let intro = strings.t("plannedPage.link.intro")
        guard !link.payment.dueDate.isEmpty else { return intro }
        let due = strings.t(
            "plannedPage.link.dueOn",
            ["date": VisionFormat.appDate(link.payment.dueDate, format: settings.dateFormat)])
        return "\(intro) \(due)."
    }

    // MARK: Filters

    private var filters: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(strings.t("plannedPage.link.filters").uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(theme.secondaryLabel)
                .accessibilityAddTraits(.isHeader)
            HStack(alignment: .top, spacing: 12) {
                labeled("importPage.startDate") {
                    VisionDateField(
                        day: link.day(link.filters.startDate, calendar: calendar),
                        placeholder: strings.t("plannedPage.link.pickDate"), allowClear: true,
                        clearLabel: strings.t("common.clear"), settings: settings, strings: strings, calendar: calendar
                    ) { day in link.setStartDate(day) }
                }
                labeled("importPage.endDate") {
                    VisionDateField(
                        day: link.day(link.filters.endDate, calendar: calendar),
                        placeholder: strings.t("plannedPage.link.pickDate"), allowClear: true,
                        clearLabel: strings.t("common.clear"), settings: settings, strings: strings, calendar: calendar
                    ) { day in link.setEndDate(day) }
                }
            }
            HStack(alignment: .top, spacing: 12) {
                labeled("importPage.bankAccount") {
                    TextField(
                        strings.t("importPage.bankAccount"),
                        text: Binding(get: { link.filters.bankAccount }, set: { link.setBankAccount($0) })
                    )
                    .textFieldStyle(.roundedBorder)
                }
                labeled("recipientsPage.col.recipient") {
                    TextField(
                        strings.t("recipientsPage.search"),
                        text: Binding(get: { link.filters.recipientName }, set: { link.setRecipientName($0) })
                    )
                    .textFieldStyle(.roundedBorder)
                    if link.includesLinked {
                        Text(strings.t("plannedPage.link.includesLinked"))
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryLabel)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            HStack(spacing: 20) {
                Toggle(
                    strings.t("plannedPage.link.uncategorised"),
                    isOn: Binding(get: { link.filters.uncategorised }, set: { link.setUncategorised($0) }))
                Toggle(
                    strings.t("plannedPage.link.activeOnly"),
                    isOn: Binding(get: { link.filters.active }, set: { link.setActiveOnly($0) }))
                HStack(spacing: 6) {
                    Toggle(
                        strings.t("plannedPage.link.matchAmount"),
                        isOn: Binding(get: { link.filters.matchAmount }, set: { link.setMatchAmount($0) }))
                    TextField(
                        "", text: Binding(get: { link.toleranceInput }, set: { link.setToleranceInput($0) })
                    )
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 52)
                    .multilineTextAlignment(.trailing)
                    .focused($toleranceFocused)
                    .disabled(!link.filters.matchAmount)
                    .accessibilityLabel(strings.t("importPage.toleranceAriaLabel"))
                    .onSubmit { link.commitTolerance() }
                    .onChange(of: toleranceFocused) { _, focused in
                        if !focused { link.commitTolerance() }
                    }
                    Text(verbatim: "%")
                        .foregroundStyle(theme.secondaryLabel)
                }
            }
            .toggleStyle(.checkbox)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .fill(theme.foreground.opacity(0.04)))
    }

    // MARK: Candidates

    private var candidates: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(strings.t("plannedPage.link.candidates").uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(theme.secondaryLabel)
                .accessibilityAddTraits(.isHeader)
            let rows = link.visibleCandidates
            if link.isLoading {
                placeholder("plannedPage.link.loading")
            } else if rows.isEmpty {
                placeholder("plannedPage.link.empty")
            } else {
                List(
                    selection: Binding(
                        get: { link.selectedTransactionId },
                        set: { id in
                            if let id { link.select(id) }
                        })
                ) {
                    ForEach(rows, id: \.id) { transaction in
                        candidateRow(transaction)
                            .tag(transaction.id)
                    }
                }
                .listStyle(.bordered)
                .frame(height: min(256, CGFloat(rows.count) * 46 + 8))
                .accessibilityLabel(strings.t("plannedPage.link.candidates"))
            }
        }
    }

    private func candidateRow(_ transaction: OpenAPI.Transaction) -> some View {
        let isSelected = transaction.id == link.selectedTransactionId
        return HStack(spacing: 12) {
            Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                .foregroundStyle(isSelected ? theme.primary : theme.tertiaryLabel)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(PlannedLinkModel.title(transaction, strings: strings))
                    .fontWeight(.medium)
                    .lineLimit(1)
                    .truncationMode(.tail)
                let detail = PlannedLinkModel.detail(transaction, format: settings.dateFormat)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer(minLength: 8)
            MoneyText(
                amount: transaction.amount, currency: transaction.currency ?? settings.defaultCurrency,
                settings: settings
            )
            .fontWeight(.semibold)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func placeholder(_ key: String) -> some View {
        Text(strings.t(key))
            .foregroundStyle(theme.secondaryLabel)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                    .strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
    }

    private func recordedDate(_ transaction: OpenAPI.Transaction) -> String {
        transaction.transactionDate.isEmpty
            ? "—" : VisionFormat.appDate(transaction.transactionDate, format: settings.dateFormat)
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 12) {
            Spacer()
            Button(strings.t("common.cancel")) {
                model.dismissLinkDialog()
            }
            .keyboardShortcut(.cancelAction)
            Button {
                Task { await model.executeLink(strings: strings) }
            } label: {
                HStack(spacing: 6) {
                    if link.isExecuting {
                        ProgressView().controlSize(.small)
                    }
                    Text(strings.t("plannedPage.link.linkAndExecute"))
                }
            }
            .buttonStyle(.visionPrimary)
            .keyboardShortcut(.defaultAction)
            .disabled(!link.canExecute || model.actionLoading)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 14)
    }

    // MARK: Pieces

    private func labeled<Content: View>(_ key: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t(key))
                .font(.callout.weight(.medium))
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
