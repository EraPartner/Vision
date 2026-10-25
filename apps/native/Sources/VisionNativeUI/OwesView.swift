import SwiftUI
import VisionNativeCore

/// `/owes` (apps/frontend/src/pages/OwesPage.tsx) in SwiftUI: the total outstanding and the
/// people who owe you; a person opens their detail (`RecipientOwesDetail`) with Back, Export
/// CSV in the ••• menu, Settle all, the open splits with Record payment and the row menu
/// (Mark as settled, Delete split), and the Recent transactions table. Confirms are alerts;
/// Record payment is a dialog. Both present from this view, not from the detail inside the
/// scrolling page, so they centre over the page.
public struct OwesView: View {
    private let model: OwesModel
    private let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    public init(model: OwesModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }

    private var symbol: String {
        NavigationRegistry.matchItem(path: TransactionsRoutes.owesPath)?.symbol ?? "dollarsign.circle"
    }

    public var body: some View {
        AdminPage {
            if let person = model.person {
                OwesPersonDetail(model: model, person: person, shell: shell)
            } else {
                summary
            }
        }
        .task { await model.appear() }
        .onDisappear { model.disappear() }
        .overlay(alignment: .bottom) {
            ActionToast(
                notice: model.notice, strings: strings, actionTitle: nil, duration: OwesModel.noticeDuration,
                action: {}, clear: { model.clearNotice($0) }, bindsUndoShortcut: false)
        }
        .visionDialog(
            isPresented: Binding(
                get: { model.payment != nil },
                set: { presented in
                    if !presented { model.closePayment() }
                }),
            metrics: .init(maxWidth: nil, padding: 0, spacing: 0)
        ) {
            OwesPaymentSheet(model: model, shell: shell)
                .environment(\.visionTheme, theme)
                .environment(\.colorScheme, theme.colorScheme)
        }
        // `useConfirmDialog`. The buttons decide; the binding only reads.
        .visionAlert(
            title: model.confirmationText()?.title ?? "",
            message: model.confirmationText()?.message,
            isPresented: Binding(get: { model.confirmation != nil }, set: { _ in })
        ) {
            VisionDialogAction(strings.t("common.cancel"), role: .cancel) { model.cancelConfirmation() }
            VisionDialogAction(model.confirmationText()?.action ?? "", role: confirmRole) {
                Task { await model.confirm() }
            }
        }
    }

    private var confirmRole: VisionDialogActionRole? {
        if case .deleteSplit? = model.confirmation { return .destructive }
        return nil
    }

    // MARK: Summary

    @ViewBuilder
    private var summary: some View {
        VisionPageHeader(title: strings.t("owesPage.title"), subtitle: strings.t("owesPage.subtitle"), symbol: symbol)
        if model.isLoadingSummary {
            AdminCard {
                VStack(alignment: .leading, spacing: 10) {
                    SkeletonBar(width: nil, height: 64)
                    ForEach(0..<3, id: \.self) { _ in
                        SkeletonBar(width: nil, height: 56)
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(strings.t("common.loading"))
        } else {
            if model.summaryError != nil {
                OwesErrorCard(strings: strings) { Task { await model.loadSummary(force: true) } }
            }
            if model.showsTotalCard {
                AdminCard(padding: VisionPageLayout.padding) {
                    HStack(alignment: .bottom) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(strings.t("owesPage.totalOutstanding"))
                                .font(.footnote)
                                .foregroundStyle(theme.secondaryLabel)
                            Text(model.peopleLabel())
                                .font(.callout)
                                .foregroundStyle(theme.secondaryLabel)
                            if model.unconvertedCount > 0 {
                                Text(strings.tc("owesPage.fxUnavailable", model.unconvertedCount))
                                    .font(.footnote)
                                    .foregroundStyle(theme.warning)
                            }
                        }
                        Spacer()
                        MoneyText(
                            amount: model.totalOutstanding, currency: model.defaultCurrency, settings: settings,
                            signed: false, colored: false, display: .largeTitle
                        )
                    }
                }
            }
            let items = model.summary ?? []
            if items.isEmpty && model.summaryError == nil {
                AdminCard {
                    VisionEmptyState(
                        symbol: "person.2", title: strings.t("owesPage.noDebts"),
                        description: strings.t("owesPage.splitToTrack")
                    ) {
                        EmptyView()
                    }
                }
            } else if !items.isEmpty {
                AdminCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.recipientId) { index, item in
                            if index > 0 { Divider().opacity(0.5) }
                            personRow(item)
                        }
                    }
                }
            }
        }
    }

    /// `ListRow` with a subtitle grid: the counts on the left and a short `h-1 w-24` progress bar
    /// beside them, then the remaining amount (`w-36`, `type-headline`) and the chevron.
    private func personRow(_ item: OpenAPI.SplitOwed) -> some View {
        Button {
            Task { await model.open(item) }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(item.recipientName)
                        .lineLimit(1)
                    HStack(spacing: 16) {
                        Text(model.personSubtitle(item))
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryLabel)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        ProgressView(value: OwesModel.progress(paid: item.totalPaid, of: item.totalOwed))
                            .progressViewStyle(.vision(height: Self.progressHeight))
                            .frame(width: Self.progressWidth)
                            .accessibilityLabel(
                                strings.t("owesPage.repaymentProgress", ["recipient": item.recipientName]))
                    }
                }
                MoneyText(
                    amount: item.remaining, currency: model.defaultCurrency, settings: settings, signed: false,
                    colored: false
                )
                .font(.headline)
                .frame(width: Self.amountWidth, alignment: .trailing)
                Image(systemName: "chevron.right")
                    .imageScale(.small)
                    .foregroundStyle(theme.tertiaryLabel)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// `h-1`.
    static let progressHeight: CGFloat = 4
    /// `w-24`.
    static let progressWidth: CGFloat = 96
    /// `w-36`.
    static let amountWidth: CGFloat = 144
}

/// `PageError`: `common.loadFailedRetry` with Retry.
struct OwesErrorCard: View {
    let strings: any Localizing
    let retry: () -> Void
    @Environment(\.visionTheme) private var theme

    var body: some View {
        AdminCard {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(theme.destructive)
                    .accessibilityHidden(true)
                Text(strings.t("common.loadFailedRetry"))
                Spacer()
                Button(strings.t("common.retry"), action: retry)
                    .buttonStyle(.visionOutline)
                    .controlSize(.small)
            }
        }
    }
}

/// `RecipientOwesDetail`.
struct OwesPersonDetail: View {
    let model: OwesModel
    let person: OwesPerson
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }
    private var items: [OpenAPI.SplitOwedDetail] { model.splits ?? [] }

    /// `HandCoins`, the page icon.
    static var symbol: String {
        NavigationRegistry.matchItem(path: TransactionsRoutes.owesPath)?.symbol ?? "dollarsign.circle"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Button {
                model.back()
            } label: {
                Label(strings.t("common.back"), systemImage: "chevron.left")
            }
            .buttonStyle(.vision(.ghost, size: .sm))
            VisionPageHeader(
                title: person.name, subtitle: strings.t("owesPage.outstandingSplits"), symbol: Self.symbol
            ) {
                HStack(spacing: 8) {
                    Menu {
                        Button {
                            Task { await model.exportCsv() }
                        } label: {
                            Label(
                                strings.t(model.isExporting ? "owesPage.export.loading" : "owesPage.export.button"),
                                systemImage: "arrow.down.doc")
                        }
                        .disabled(items.isEmpty || model.isExporting)
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .visionMoreActionsMenu()
                    .visionTooltip(strings.t("owesPage.menu"))
                    .accessibilityLabel(strings.t("owesPage.menu"))
                    Button(strings.t(model.isSettlingAll ? "owesPage.settleAll.loading" : "owesPage.settleAll.button")) {
                        model.requestSettleAll()
                    }
                    .buttonStyle(.visionPrimary)
                    .disabled(items.isEmpty || model.isSettlingAll)
                }
            }
            content
        }
        .task(id: person.id) { await model.loadSplits() }
    }

    @ViewBuilder
    private var content: some View {
        if model.splitsError != nil && model.splits == nil {
            OwesErrorCard(strings: strings) { Task { await model.loadSplits(force: true) } }
        } else if model.isLoadingSplits {
            AdminCard {
                VStack(spacing: 10) {
                    ForEach(0..<3, id: \.self) { _ in
                        SkeletonBar(width: nil, height: 64)
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(strings.t("common.loading"))
        } else {
            if model.splitsError != nil {
                OwesErrorCard(strings: strings) { Task { await model.loadSplits(force: true) } }
            }
            if items.isEmpty {
                AdminCard {
                    VisionEmptyState(symbol: "checkmark", title: strings.t("owesPage.allSettled")) {
                        EmptyView()
                    }
                }
            } else {
                AdminCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, split in
                            if index > 0 { Divider().opacity(0.5) }
                            splitRow(split)
                        }
                    }
                }
                OwesRecentTransactions(model: model, person: person, shell: shell)
            }
        }
    }

    /// `ListRow`: the transaction link (foreground, medium) with its date, the original amount and
    /// note, then a short progress bar with the paid / total figures; the remaining amount, Record
    /// payment and the row menu on the trailing side.
    private func splitRow(_ split: OpenAPI.SplitOwedDetail) -> some View {
        let title = model.title(split)
        let date = model.dateText(split)
        let context = "\(title), \(date)"
        let currency = model.currency(of: split)
        return HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Button(title) {
                        model.openTransaction(split.transactionId, label: title)
                    }
                    .buttonStyle(.plain)
                    .fontWeight(.medium)
                    .foregroundStyle(theme.foreground)
                    .lineLimit(1)
                    Text(date)
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                        .fixedSize()
                }
                HStack(spacing: 16) {
                    Text(model.originalText(split))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ProgressView(value: OwesModel.progress(paid: split.amountPaid, of: split.amount))
                        .progressViewStyle(.vision(height: OwesView.progressHeight))
                        .frame(width: OwesView.progressWidth)
                        .accessibilityLabel(strings.t("owesPage.repaymentProgress", ["recipient": person.name]))
                    Text(
                        verbatim: "\(model.money(split.amountPaid, currency: currency)) / \(model.money(split.amount, currency: currency))"
                    )
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(theme.secondaryLabel)
                    .fixedSize()
                }
            }
            MoneyText(amount: split.remaining, currency: currency, settings: settings, signed: false, colored: false)
                .font(.headline)
                .frame(width: OwesView.amountWidth, alignment: .trailing)
            Button {
                model.openPayment(split)
            } label: {
                Label(strings.t("owesPage.recordPayment"), systemImage: "banknote")
            }
            .buttonStyle(.vision(.outline, size: .sm))
            .accessibilityLabel("\(strings.t("owesPage.recordPayment")): \(context)")
            splitMenu(split, context: context)
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .padding(.vertical, 10)
        .frame(minHeight: 44)
    }

    private func splitMenu(_ split: OpenAPI.SplitOwedDetail, context: String) -> some View {
        Menu {
            Button {
                Task { await model.settle(split.id) }
            } label: {
                Label(strings.t("owesPage.markSettled"), systemImage: "checkmark")
            }
            .disabled(model.settlePending)
            Divider()
            Button(role: .destructive) {
                model.requestDeleteSplit(split.id)
            } label: {
                Label(strings.t("owesPage.deleteSplit"), systemImage: "trash")
            }
            .disabled(model.deletePending)
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuStyle(.button)
        .buttonStyle(.vision(.ghost, size: .iconSm))
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(strings.t("owesPage.rowMenu", ["name": context]))
    }
}

/// `RecentRecipientTransactionsTable`: the person's transactions, newest first, ten at a time
/// as the table scrolls; search, column filters and sort work on the loaded rows.
struct OwesRecentTransactions: View {
    let model: OwesModel
    let person: OwesPerson
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }

    var body: some View {
        Group {
            if !model.recentLoaded {
                AdminCard {
                    VStack(spacing: 8) {
                        ForEach(0..<3, id: \.self) { _ in
                            SkeletonBar(width: nil, height: 36)
                        }
                    }
                }
            } else if model.recent.isEmpty {
                AdminCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(strings.t("owesPage.recentTransactionsTitle"))
                            .font(Font.visionTitle3)
                            .accessibilityAddTraits(.isHeader)
                        VisionEmptyState(symbol: OwesPersonDetail.symbol, title: strings.t("owesPage.noRecentTransactions")) {
                            EmptyView()
                        }
                    }
                }
            } else {
                AdminCard(padding: 0) {
                    LocalDataTable(
                        title: strings.t("owesPage.recentTransactionsTitle"),
                        subtitle: strings.t("owesPage.recentTransactionsSubtitle", ["name": person.name]),
                        columns: columns, rows: model.recentRows, totalCount: model.recent.count,
                        query: Binding(get: { model.recentQuery }, set: { model.recentQuery = $0 }),
                        filterValues: { key in model.recentFilterValues(key) }, strings: strings,
                        serverTotal: model.recentTotal, isFetchingMore: model.isFetchingMoreRecent,
                        hasMore: model.recentHasMore
                    ) {
                        Text(strings.t("owesPage.noRecentTransactions"))
                            .foregroundStyle(theme.secondaryLabel)
                    }
                    .rowAppeared { id in Task { await model.recentRowAppeared(id) } }
                    .frame(maxHeight: 420)
                }
            }
        }
        .task(id: person.id) { await model.loadRecent() }
    }

    private var columns: [LocalDataColumn<OwesRecentRow>] {
        [
            LocalDataColumn(key: "date", title: strings.t("txPage.col.date"), width: 120, minWidth: 100) { row in
                AnyView(
                    Text(row.date.isEmpty ? "—" : VisionFormat.appDate(row.date, format: settings.dateFormat))
                        .monospacedDigit())
            },
            LocalDataColumn(
                key: "description", title: strings.t("txPage.field.description"), width: 180, minWidth: 180,
                flexible: true
            ) { row in
                AnyView(
                    Button(row.description) {
                        model.openTransaction(row.id, label: row.description)
                    }
                    .buttonStyle(.visionLink)
                    .lineLimit(1))
            },
            LocalDataColumn(key: "category", title: strings.t("txPage.col.category"), width: 180, minWidth: 180) { row in
                AnyView(Text(row.category).lineLimit(1))
            },
            LocalDataColumn(
                key: "amount", title: strings.t("txPage.col.amount"), width: 120, minWidth: 100, alignment: .trailing
            ) { row in
                AnyView(MoneyText(amount: row.amount, currency: row.currency, settings: settings))
            },
            LocalDataColumn(
                key: "bankAccount", title: strings.t("txPage.field.bankAccount"), width: 160, minWidth: 160
            ) { row in
                AnyView(Text(row.bankAccount).lineLimit(1))
            },
        ]
    }
}

/// The Record payment dialog: the amount (prefilled with the remaining amount) and Record
/// payment; an amount of zero or less shows `owesPage.recordDialog.invalidAmount`.
struct OwesPaymentSheet: View {
    let model: OwesModel
    let shell: NativeShellModel
    @FocusState private var amountFocused: Bool
    @Environment(\.visionTheme) private var theme

    init(model: OwesModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VisionDialogHeader(
                title: strings.t("owesPage.recordDialog.title"), closeLabel: strings.t("common.close"),
                onClose: { model.closePayment() })
            VStack(alignment: .leading, spacing: 6) {
                Text(strings.t("owesPage.recordDialog.amount"))
                    .font(.callout.weight(.medium))
                    .foregroundStyle(theme.foreground)
                TextField(
                    strings.t("owesPage.recordDialog.placeholder"),
                    text: Binding(get: { model.payment?.amountText ?? "" }, set: { model.setPaymentAmount($0) })
                )
                .textFieldStyle(.vision)
                .focused($amountFocused)
                .onSubmit(submit)
                .accessibilityLabel(strings.t("owesPage.recordDialog.amount"))
                if model.payment?.invalid == true {
                    Text(strings.t("owesPage.recordDialog.invalidAmount"))
                        .font(.footnote)
                        .foregroundStyle(theme.destructive)
                }
                if let payment = model.payment {
                    Text(strings.t("owesPage.recordDialog.remaining", ["amount": model.money(payment.remaining, currency: payment.currency)]))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                }
            }
            VisionDialogFooter {
                Button(strings.t("owesPage.recordDialog.cancel")) { model.closePayment() }
                    .buttonStyle(.visionOutline)
                    .keyboardShortcut(.cancelAction)
                Button(action: submit) {
                    Text(
                        strings.t(
                            model.isRecording ? "owesPage.recordDialog.recording" : "owesPage.recordDialog.submit"))
                }
                .buttonStyle(.visionPrimary)
                .keyboardShortcut(.defaultAction)
                .disabled(model.isRecording)
            }
        }
        .visionDialogPadding()
        .frame(minWidth: 384, idealWidth: 384)
        .foregroundStyle(theme.foreground)
        .onAppear { amountFocused = true }
    }

    private func submit() {
        Task { await model.submitPayment() }
    }
}
