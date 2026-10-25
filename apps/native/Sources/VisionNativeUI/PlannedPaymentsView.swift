import SwiftUI
import VisionNativeCore

/// `/planned` (apps/frontend/src/pages/PlannedPaymentsPage.tsx, ADR-183) in SwiftUI: the
/// header with View, More actions and Add payment, the Next 7 days strip with Estimated
/// monthly, and the payments table with its row menus; Delete asks in an alert and Payment
/// history opens as a sheet.
public struct PlannedPaymentsView: View {
    private let model: PlannedPaymentsModel
    private let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    @Environment(\.openURL) private var openURL

    public init(model: PlannedPaymentsModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }
    private var showAll: Bool { PlannedPaymentsRoute.showAll(in: shell.route) }

    /// What the list depends on: the `show_all` view and the default currency.
    private struct LoadKey: Equatable {
        let showAll: Bool
        let currency: String
    }

    public var body: some View {
        AdminPage {
            content
        }
        .task(id: LoadKey(showAll: showAll, currency: settings.defaultCurrency)) {
            await model.appear(showAll: showAll, defaultCurrency: settings.defaultCurrency)
        }
        .task { await model.loadSuggestions() }
        .task { await model.recurring.load() }
        // The recurring panel names categories from the category tree.
        .task { await model.pickers.load() }
        .onAppear { shell.setLeaveGuard(model.leaveGuard) }
        .onDisappear {
            shell.removeLeaveGuard(id: PlannedPaymentsRoute.path)
            model.disappear()
        }
        .overlay(alignment: .bottom) {
            ActionToast(
                notice: model.notice, strings: strings,
                actionTitle: model.notice.flatMap { model.undo?.noticeID == $0.id ? strings.t("common.undo") : nil },
                duration: model.notice.map { model.duration(of: $0) } ?? PlannedPaymentsModel.noticeDuration,
                action: { Task { await model.undoToggle() } },
                clear: { model.clearNotice($0) })
        }
        // `useConfirmDialog`, destructive. The buttons decide; the binding only reads.
        .alert(
            strings.t("plannedPage.delete.title"),
            isPresented: Binding(get: { model.pendingDelete != nil }, set: { _ in })
        ) {
            Button(strings.t("common.cancel"), role: .cancel) { model.cancelDelete() }
            Button(strings.t("plannedPage.delete.confirm"), role: .destructive) {
                Task { await model.confirmDelete() }
            }
        } message: {
            Text(strings.t("plannedPage.delete.desc"))
        }
        .sheet(
            isPresented: Binding(
                get: { model.isHistoryPresented },
                set: { presented in
                    if !presented { model.closeHistory() }
                })
        ) {
            PlannedHistorySheet(model: model, shell: shell)
                .environment(\.visionTheme, theme)
                .environment(\.colorScheme, theme.colorScheme)
        }
        // The planned-payment sheet: Escape and the close button leave without saving.
        .sheet(
            item: Binding(
                get: { model.editor },
                set: { form in
                    if form == nil { model.dismissEditor() }
                })
        ) { form in
            PlannedPaymentFormSheet(model: model, form: form, shell: shell)
                .environment(\.visionTheme, theme)
                .environment(\.colorScheme, theme.colorScheme)
        }
        .sheet(
            item: Binding(
                get: { model.link },
                set: { link in
                    if link == nil { model.dismissLinkDialog() }
                })
        ) { link in
            PlannedLinkSheet(model: model, link: link, shell: shell)
                .environment(\.visionTheme, theme)
                .environment(\.colorScheme, theme.colorScheme)
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.isLoading {
            header(withActions: false)
            loadingState
        } else if let error = model.error {
            errorState(error)
        } else {
            header(withActions: true)
            stripCard
            matchSuggestions
            recurringDetection
            AdminCard(padding: 0) {
                table
            }
        }
    }

    // MARK: Header

    private var symbol: String {
        NavigationRegistry.matchItem(path: PlannedPaymentsRoute.path)?.symbol ?? "calendar.badge.clock"
    }

    @ViewBuilder
    private func header(withActions: Bool) -> some View {
        if withActions {
            VisionPageHeader(title: strings.t("plannedPage.title"), subtitle: strings.t("plannedPage.subtitle"), symbol: symbol) {
                HStack(spacing: 8) {
                    viewMenu
                    moreActions
                    addButton
                }
            }
        } else {
            VisionPageHeader(title: strings.t("plannedPage.title"), subtitle: strings.t("plannedPage.subtitle"), symbol: symbol)
        }
    }

    /// `txPage.view.menu`: one checkbox item, Include paused (`show_all`).
    private var viewMenu: some View {
        Menu {
            Toggle(strings.t("plannedPage.includePaused"), isOn: Binding(get: { showAll }, set: { setShowAll($0) }))
        } label: {
            Label(strings.t("txPage.view.menu"), systemImage: "slider.horizontal.3")
        }
        .fixedSize()
        .accessibilityLabel(strings.t("txPage.view.menu"))
    }

    /// `plannedPage.menu`: Payment history.
    private var moreActions: some View {
        Menu {
            Button {
                model.openHistory()
            } label: {
                Label(strings.t("plannedPage.history.title"), systemImage: "clock.arrow.circlepath")
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(strings.t("plannedPage.menu"))
        .help(strings.t("plannedPage.menu"))
    }

    private var addButton: some View {
        Button {
            model.openEditor(for: nil, settings: settings)
        } label: {
            Label(strings.t("plannedPage.newPayment"), systemImage: "plus")
        }
        .buttonStyle(.visionPrimary)
    }

    /// `setShowAll`: written with replace, deleted when false.
    private func setShowAll(_ value: Bool) {
        shell.replaceQuery(PlannedPaymentsRoute.showAllParameter, with: PlannedPaymentsRoute.showAllValue(value))
    }

    // MARK: Loading and error

    private var loadingState: some View {
        VStack(alignment: .leading, spacing: 20) {
            AdminCard {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 8) {
                            SkeletonBar(width: 112, height: 12)
                            SkeletonBar(width: 224, height: 16)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 8) {
                            SkeletonBar(width: 80, height: 12)
                            SkeletonBar(width: 96, height: 28)
                        }
                    }
                    LazyVGrid(columns: Self.tileColumns, spacing: 8) {
                        ForEach(0..<PlannedStrip.windowDays, id: \.self) { _ in
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                                .fill(theme.muted)
                                .frame(height: 104)
                        }
                    }
                }
            }
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .fill(theme.muted)
                .frame(height: 300)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(strings.t("common.loading"))
        .accessibilityAddTraits(.updatesFrequently)
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
            // A contract violation names the endpoint and field, as the Home and Net worth
            // errors do; the generic message alone cannot be traced to a cause.
            if case .contract = error, let detail = error.errorDescription {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(theme.secondaryLabel)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
            }
            Button(strings.t("common.retry")) {
                Task { await model.retry() }
            }
            .buttonStyle(.visionOutline)
            .controlSize(.small)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
        .accessibilityElement(children: .contain)
        .task(id: message) {
            AccessibilityNotification.Announcement("\(strings.t("common.error")). \(message)").post()
        }
    }

    // MARK: Next 7 days

    static let tileColumns = [GridItem(.adaptive(minimum: 104), spacing: 8)]

    private var stripCard: some View {
        let strip = model.strip
        let monthly = model.estimatedMonthly
        let windowTotal = model.windowTotal
        return AdminCard(padding: VisionPageLayout.padding) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(strings.t("plannedPage.next7.title"))
                            .font(.headline)
                            .accessibilityAddTraits(.isHeader)
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(strings.tc("plannedPage.next7.dueCount", strip.dueCount))
                                .font(.headline)
                            if strip.dueCount > 0 {
                                Text(verbatim: "·").foregroundStyle(theme.tertiaryLabel)
                                if let windowTotal {
                                    MoneyText(
                                        amount: windowTotal.net, currency: settings.defaultCurrency,
                                        settings: settings
                                    )
                                    .font(.headline)
                                } else {
                                    SkeletonBar(width: 80, height: 14)
                                        .accessibilityLabel(strings.t("common.loading"))
                                }
                            }
                            Text(verbatim: "·").foregroundStyle(theme.tertiaryLabel)
                            Text(strip.rangeText(strings, format: settings.dateFormat))
                                .foregroundStyle(theme.secondaryLabel)
                        }
                        if let windowTotal, windowTotal.unconvertedCount > 0 {
                            fxWarning(windowTotal.unconvertedCount)
                        }
                    }
                    Spacer(minLength: 0)
                    VStack(alignment: .trailing, spacing: 4) {
                        Label(strings.t("plannedPage.estMonthly").uppercased(), systemImage: "repeat")
                            .font(.caption2.weight(.medium))
                            .tracking(1.3)
                            .foregroundStyle(theme.secondaryLabel)
                        if let monthly {
                            MoneyText(amount: monthly.total, currency: settings.defaultCurrency, settings: settings)
                                .font(.visionCardTitle)
                        } else {
                            SkeletonBar(width: 96, height: 28)
                                .accessibilityLabel(strings.t("common.loading"))
                        }
                        if let monthly, monthly.unconvertedCount > 0 {
                            fxWarning(monthly.unconvertedCount)
                        }
                    }
                }
                LazyVGrid(columns: Self.tileColumns, spacing: 8) {
                    ForEach(strip.buckets) { bucket in
                        dayTile(bucket)
                    }
                }
                if strip.dueCount == 0 {
                    HStack(spacing: 10) {
                        Image(systemName: "calendar.badge.checkmark")
                            .foregroundStyle(theme.success)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(strings.t("plannedPage.next7.emptyTitle"))
                                .font(.body.weight(.medium))
                            Text(strings.t("plannedPage.next7.emptyDesc"))
                                .font(.footnote)
                                .foregroundStyle(theme.secondaryLabel)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .overlay(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                            .strokeBorder(theme.border.opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                }
            }
        }
    }

    /// `plannedPage.fxUnavailable`.
    private func fxWarning(_ count: Int) -> some View {
        Label(strings.tc("plannedPage.fxUnavailable", count), systemImage: "exclamationmark.circle")
            .font(.footnote)
            .foregroundStyle(theme.warning)
    }

    private func dayTile(_ bucket: PlannedDayBucket) -> some View {
        let isToday = bucket.isToday
        let weekday = LanguageLocale.shortWeekday(bucket.date, language: strings.language, calendar: model.calendar)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text((isToday ? strings.t("plannedPage.next7.today") : weekday).uppercased())
                    .font(.caption2.weight(.medium))
                    .tracking(1.3)
                    .foregroundStyle(isToday ? theme.primary : theme.secondaryLabel)
                Spacer(minLength: 0)
                Text(verbatim: String(bucket.day))
                    .font(.headline)
                    .monospacedDigit()
                    .foregroundStyle(isToday ? theme.primary : theme.secondaryLabel)
            }
            if bucket.items.isEmpty {
                Spacer(minLength: 0)
                Circle()
                    .fill(theme.foreground.opacity(0.15))
                    .frame(width: 4, height: 4)
                    .frame(maxWidth: .infinity)
                    .accessibilityHidden(true)
            } else {
                ForEach(bucket.shown) { payment in
                    dayItem(payment)
                }
            }
            if bucket.overflow > 0 {
                Text(strings.t("plannedPage.next7.more", ["n": String(bucket.overflow)]))
                    .font(.caption)
                    .foregroundStyle(theme.secondaryLabel)
                    .padding(.horizontal, 4)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .fill(
                    isToday
                        ? theme.primary.opacity(0.07)
                        : bucket.items.isEmpty ? Color.clear : theme.foreground.opacity(0.03)))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .strokeBorder(
                    isToday ? theme.primary.opacity(0.45) : theme.border.opacity(bucket.items.isEmpty ? 0.4 : 0.6),
                    lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    /// A strip item: opens the sheet for the payment (`plannedPage.next7.itemTitle`).
    private func dayItem(_ payment: PlannedPayment) -> some View {
        Button {
            model.openEditor(for: payment, settings: settings)
        } label: {
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .top, spacing: 3) {
                    if payment.isExecuted {
                        Image(systemName: "checkmark.circle.fill")
                            .imageScale(.small)
                            .foregroundStyle(theme.success)
                            .accessibilityHidden(true)
                    }
                    Text(payment.name)
                        .font(.caption)
                        .strikethrough(payment.isExecuted)
                        .foregroundStyle(payment.isExecuted ? theme.secondaryLabel : theme.foreground)
                        .multilineTextAlignment(.leading)
                }
                MoneyText(amount: payment.amount, currency: payment.currency, settings: settings)
                    .font(.caption.weight(.medium))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(strings.t("plannedPage.next7.itemTitle", ["name": payment.name]))
        .accessibilityLabel(strings.t("plannedPage.next7.itemTitle", ["name": payment.name]))
    }

    // MARK: Suggestions

    private var matchSuggestions: some View {
        PlannedMatchSuggestionsBanner(model: model, strings: strings)
    }

    private var recurringDetection: some View {
        PlannedRecurringPanel(model: model, strings: strings, settings: settings)
    }

    // MARK: Table

    private var queryBinding: Binding<LocalTableQuery> {
        Binding(get: { model.table }, set: { model.table = $0 })
    }

    private var table: some View {
        LocalDataTable(
            title: strings.t("plannedPage.tableTitle"),
            subtitle: strings.t("plannedPage.tableSubtitle", ["n": String(model.payments.count)]),
            columns: columns, rows: model.visibleRows, totalCount: model.tablePayments.count, query: queryBinding,
            filterValues: { key in PlannedColumn(rawValue: key).map { model.filterValues($0) } ?? [] },
            strings: strings
        ) {
            emptyState
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        switch model.emptyState {
        case .noFilterResults:
            VisionEmptyState(symbol: "magnifyingglass", title: strings.t("table.noFilterResults")) {
                EmptyView()
            }
        case .noPayments:
            VisionEmptyState(
                symbol: symbol, title: strings.t("plannedPage.empty"), description: strings.t("plannedPage.emptyDesc")
            ) {
                addButton
            }
        case .allPaused:
            VisionEmptyState(
                symbol: symbol, title: strings.t("plannedPage.emptyFiltered"),
                description: strings.t("plannedPage.emptyFilteredDesc")
            ) {
                Button(strings.t("plannedPage.includePaused")) { setShowAll(true) }
                    .buttonStyle(.visionOutline)
            }
        }
    }

    private func title(_ column: PlannedColumn) -> String {
        column.headerKey.map { strings.t($0) } ?? ""
    }

    private var columns: [LocalDataColumn<PlannedPayment>] {
        [
            LocalDataColumn(
                key: PlannedColumn.payment.rawValue, title: title(.payment), width: 220, minWidth: 200, flexible: true
            ) { payment in AnyView(paymentCell(payment)) },
            LocalDataColumn(key: PlannedColumn.amount.rawValue, title: title(.amount), width: 130, minWidth: 60) {
                payment in
                AnyView(
                    MoneyText(amount: payment.amount, currency: payment.currency, settings: settings)
                        .fontWeight(.semibold))
            },
            LocalDataColumn(key: PlannedColumn.dueDate.rawValue, title: title(.dueDate), width: 130, minWidth: 60) {
                payment in
                AnyView(PlannedDueBadge(state: model.dueState(payment), strings: strings, format: settings.dateFormat))
            },
            LocalDataColumn(
                key: PlannedColumn.recurrence.rawValue, title: title(.recurrence), width: 170, minWidth: 60
            ) { payment in AnyView(recurrenceCell(payment)) },
            LocalDataColumn(key: PlannedColumn.category.rawValue, title: title(.category), width: 160, minWidth: 140) {
                payment in AnyView(categoryCell(payment))
            },
            LocalDataColumn(key: PlannedColumn.status.rawValue, title: "", width: 170, minWidth: 60) { payment in
                AnyView(statusCell(payment))
            },
            LocalDataColumn(
                key: PlannedColumn.actions.rawValue, title: "", width: 44, minWidth: 44, alignment: .trailing
            ) { payment in AnyView(rowMenu(payment)) },
        ]
    }

    private func paymentCell(_ payment: PlannedPayment) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(payment.name)
                    .fontWeight(.medium)
                    .strikethrough(payment.isStruckThrough)
                    .foregroundStyle(payment.isStruckThrough ? theme.secondaryLabel : theme.foreground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if payment.isLoan {
                    VisionBadge(text: strings.t("plannedPage.loanBadge"), tone: .secondary, small: true)
                }
                if !payment.isActive {
                    VisionBadge(text: strings.t("plannedPage.statusPaused"), tone: .muted, small: true)
                }
                if let url = payment.safeURL {
                    let label = "\(strings.t("plannedPage.openLink")): \(payment.name)"
                    Button {
                        openURL(url)
                    } label: {
                        Image(systemName: "arrow.up.right.square")
                            .imageScale(.small)
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(theme.secondaryLabel)
                    .help(label)
                    .accessibilityLabel(label)
                }
            }
            if let recipient = payment.recipient, !recipient.isEmpty {
                Text(verbatim: "→ \(recipient)")
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private func recurrenceCell(_ payment: PlannedPayment) -> some View {
        if payment.showsRepeat {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: "repeat")
                        .imageScale(.small)
                        .foregroundStyle(theme.secondaryLabel)
                        .accessibilityHidden(true)
                    Text(payment.recurrenceText(strings))
                }
                if let executed = payment.executedText(strings) {
                    Text(executed)
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                }
            }
        } else {
            Text(payment.recurrenceText(strings))
                .foregroundStyle(theme.secondaryLabel)
        }
    }

    @ViewBuilder
    private func categoryCell(_ payment: PlannedPayment) -> some View {
        if let category = payment.category, !category.isEmpty {
            VisionBadge(text: category, tone: .outline)
        } else {
            Text(verbatim: "—")
                .foregroundStyle(theme.tertiaryLabel)
        }
    }

    /// Mark as paid, or the Paid badge that links to the transaction.
    @ViewBuilder
    private func statusCell(_ payment: PlannedPayment) -> some View {
        let linked = strings.t("plannedPage.execute.linked", ["n": String(payment.executedTransactionId ?? 0)])
        if payment.isExecuted {
            if let route = payment.linkedTransactionRoute {
                Button {
                    shell.navigate(to: route)
                } label: {
                    VisionBadge(text: linked, tone: .success)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isLink)
            } else {
                VisionBadge(text: linked, tone: .success)
            }
        } else {
            Button(strings.t("plannedPage.execute.button")) {
                model.openLinkDialog(for: payment)
            }
            .buttonStyle(.visionOutline)
            .controlSize(.small)
            .disabled(!model.canMarkAsPaid(payment))
            .accessibilityLabel("\(strings.t("plannedPage.execute.button")): \(payment.name)")
        }
    }

    /// `plannedPage.rowMenu`: Edit, Pause or Resume, then Delete.
    private func rowMenu(_ payment: PlannedPayment) -> some View {
        let label = strings.t("plannedPage.rowMenu", ["name": payment.name])
        return Menu {
            Button {
                model.openEditor(for: payment, settings: settings)
            } label: {
                Label(strings.t("common.edit"), systemImage: "pencil")
            }
            Button {
                Task { await model.toggleActive(payment) }
            } label: {
                Label(
                    strings.t(payment.isActive ? "plannedPage.pause" : "plannedPage.resume"),
                    systemImage: payment.isActive ? "pause" : "play")
            }
            Divider()
            Button(role: .destructive) {
                model.requestDelete(payment)
            } label: {
                Label(strings.t("common.delete"), systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(model.actionLoading)
        .accessibilityLabel(label)
        .help(label)
    }
}

/// `ExecutionHistoryDialog`: every execution of the loaded payments with its transaction,
/// newest first; a partial failure offers Retry.
struct PlannedHistorySheet: View {
    let model: PlannedPaymentsModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) var theme

    private var strings: any Localizing { shell.strings }
    private var history: PlannedHistoryModel { model.history }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VisionDialogHeader(
                title: strings.t("plannedPage.history.title"), closeLabel: strings.t("common.close"),
                onClose: { model.closeHistory() })
            if history.failed && !history.isLoading {
                HStack(spacing: 12) {
                    Text(strings.t("plannedPage.history.loadFailed"))
                    Spacer(minLength: 0)
                    Button(strings.t("common.retry")) {
                        Task { await history.load(payments: model.payments) }
                    }
                    .buttonStyle(.visionOutline)
                    .controlSize(.small)
                }
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                        .fill(theme.warning.opacity(0.05)))
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                        .strokeBorder(theme.warning.opacity(0.3), lineWidth: 1))
                .accessibilityElement(children: .contain)
            }
            if history.isLoading {
                Text(strings.t("plannedPage.history.loading"))
                    .foregroundStyle(theme.secondaryLabel)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
            } else if history.entries.isEmpty {
                if !history.failed {
                    Text(strings.t("plannedPage.history.empty"))
                        .foregroundStyle(theme.secondaryLabel)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 40)
                }
            } else {
                entriesTable
            }
            VisionDialogFooter {
                Button(strings.t("common.close")) {
                    model.closeHistory()
                }
                .buttonStyle(.visionOutline)
                .keyboardShortcut(.cancelAction)
            }
        }
        .visionDialogPadding()
        .frame(minWidth: 680, idealWidth: 896, minHeight: 320)
        .foregroundStyle(theme.foreground)
        .task(id: model.payments) {
            await history.load(payments: model.payments)
        }
    }

    private var entriesTable: some View {
        ScrollView {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 0) {
                GridRow {
                    headerText("plannedPage.history.colExecutedOn")
                    headerText("plannedPage.history.colPlanned")
                    headerText("plannedPage.history.colTransaction")
                    headerText("plannedPage.col.amount")
                        .gridColumnAlignment(.trailing)
                }
                .padding(.vertical, 8)
                ForEach(history.entries) { entry in
                    Divider().gridCellUnsizedAxes(.horizontal)
                    entryRow(entry)
                }
            }
            .padding(.horizontal, 12)
        }
        .frame(maxHeight: 460)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(strings.t("plannedPage.history.title"))
    }

    private func headerText(_ key: String) -> some View {
        Text(strings.t(key))
            .font(.caption.weight(.medium))
            .foregroundStyle(theme.secondaryLabel)
            .accessibilityAddTraits(.isHeader)
    }

    private func entryRow(_ entry: PlannedHistoryModel.Entry) -> some View {
        let format = shell.settings.dateFormat
        let executed = VisionFormat.appDate(entry.executionDate, format: format)
        return GridRow {
            Text(executed.isEmpty ? "—" : executed)
                .foregroundStyle(theme.secondaryLabel)
                .monospacedDigit()
            Text(entry.plannedPaymentName)
                .fontWeight(.medium)
                .lineLimit(1)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title(strings))
                    .lineLimit(1)
                Text(entry.detail(format: format))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                    .lineLimit(1)
            }
            HStack(spacing: 8) {
                MoneyText(
                    amount: entry.amount, currency: entry.currency ?? shell.settings.defaultCurrency,
                    settings: shell.settings
                )
                .fontWeight(.semibold)
                Button {
                    model.closeHistory()
                    shell.navigate(to: entry.route)
                } label: {
                    Image(systemName: "arrow.up.right.square")
                }
                .buttonStyle(.borderless)
                .help(strings.t("plannedPage.history.openTransaction"))
                .accessibilityLabel(strings.t("plannedPage.history.openTransaction"))
            }
            .gridColumnAlignment(.trailing)
        }
        .padding(.vertical, 8)
    }
}
