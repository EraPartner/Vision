import SwiftUI
import VisionNativeCore

/// `/accounts/:id` (apps/frontend/src/pages/AccountDetailPage.tsx) in SwiftUI: the header with
/// All accounts and the Account actions menu, the Balance card with its drift chip and
/// sparkline, the Holdings card of a portfolio account, the upcoming planned rows, the
/// running-balance ledger (with the `?since=` banner and Load more) and the Details card.
public struct AccountDetailView: View {
    private let model: AccountsModel
    private let shell: NativeShellModel
    private let accountId: AccountID
    @Environment(\.visionTheme) private var theme

    public init(model: AccountsModel, shell: NativeShellModel, accountId: AccountID) {
        self.model = model
        self.shell = shell
        self.accountId = accountId
    }

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }

    public var body: some View {
        AdminPage {
            backButton
            switch model.detailState(accountId) {
            case .loading:
                VisionPageHeader(title: strings.t("accounts.title"), subtitle: "", symbol: AccountsView.symbol)
                AdminCard {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(0..<4, id: \.self) { _ in
                            SkeletonBar(width: nil, height: 48)
                        }
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(strings.t("common.loading"))
            case .failed(let error):
                AccountsErrorCard(message: APIErrorMessage.text(error, strings: strings), strings: strings) {
                    Task { await model.retry() }
                }
            case .notFound:
                AdminCard {
                    VisionEmptyState(
                        symbol: "questionmark.folder", title: strings.t("accounts.detail.notFoundTitle"),
                        description: strings.t("accounts.detail.notFoundDescription")
                    ) {
                        Button(strings.t("accounts.detail.back")) { model.backToHub() }
                            .buttonStyle(.visionOutline)
                    }
                }
            case .loaded(let account):
                AccountDetailContent(model: model, account: account, shell: shell)
            }
        }
        .task(id: accountId) { await model.appear(.detail(accountId)) }
        .onDisappear { model.disappear(.detail(accountId)) }
        .overlay(alignment: .bottom) {
            ActionToast(
                notice: model.notice, strings: strings, actionTitle: nil, duration: AccountsModel.noticeDuration,
                action: {}, clear: { model.clearNotice($0) }, bindsUndoShortcut: false)
        }
        .modifier(AccountDialogs(model: model, shell: shell, theme: theme))
    }

    private var backButton: some View {
        Button {
            model.backToHub()
        } label: {
            Label(strings.t("accounts.detail.back"), systemImage: "chevron.left")
        }
        .buttonStyle(.vision(.ghost, size: .sm))
    }
}

/// The loaded detail.
struct AccountDetailContent: View {
    let model: AccountsModel
    let account: OpenAPI.Account
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }
    private var holdingsOnly: Bool { AccountKinds.isHoldingsOnly(account) }

    var body: some View {
        VisionPageHeader(title: AccountKinds.label(account), subtitle: model.detailSubtitle(account), symbol: AccountKinds.kind(account)?.symbol ?? AccountsView.symbol) {
            HStack(spacing: 8) {
                if !account.isActive {
                    VisionBadge(text: strings.t("accounts.archived"), tone: .outline)
                }
                actionsMenu
            }
        }
        balanceCard
        if AccountKinds.isPortfolio(account) {
            holdingsCard
        }
        if !holdingsOnly && model.showsPlannedCard {
            plannedCard
        }
        if !holdingsOnly {
            AccountLedgerCard(model: model, account: account, shell: shell)
        }
        detailsCard
    }

    // MARK: Header menu

    private var actionsMenu: some View {
        Menu {
            ForEach(Array(model.menuItems(account).enumerated()), id: \.offset) { _, item in
                menuRow(item)
            }
        } label: {
            Label(strings.t("accounts.actionsMenu"), systemImage: "ellipsis.circle")
                .labelStyle(.iconOnly)
        }
        .menuIndicator(.hidden)
        .fixedSize()
        .visionTooltip(strings.t("accounts.actionsMenu"))
        .accessibilityLabel(strings.t("accounts.actionsMenu"))
    }

    @ViewBuilder
    private func menuRow(_ item: AccountMenuItem) -> some View {
        switch item {
        case .edit:
            Button {
                model.openEdit(account)
            } label: {
                Label(strings.t("common.edit"), systemImage: "pencil")
            }
        case .openingBalance:
            Button {
                model.openOpeningBalance(account)
            } label: {
                Label(strings.t("accounts.openingBalance.action"), systemImage: "flag")
            }
        case .viewTransactions:
            Button {
                model.openTransactions(account)
            } label: {
                Label(strings.t("accounts.openTransactions"), systemImage: "list.bullet.rectangle")
            }
        case .separator:
            Divider()
        case .merge:
            Button {
                model.openMerge(account)
            } label: {
                Label(strings.t("accounts.merge"), systemImage: "arrow.triangle.merge")
            }
        case .transferLots:
            Button {
                Task { await model.openTransfer(account) }
            } label: {
                Label(strings.t("portfolio.brokerTransfer.action"), systemImage: "arrow.left.arrow.right")
            }
        case .close:
            Button {
                Task { await model.openClose(account) }
            } label: {
                Label(strings.t("accounts.close.action"), systemImage: "archivebox")
            }
        case .reopen:
            Button {
                Task { await model.reopen(account) }
            } label: {
                Label(strings.t("accounts.restore"), systemImage: "arrow.uturn.backward")
            }
            .disabled(model.isReopening)
        case .delete:
            Button(role: .destructive) {
                model.requestDelete(account)
            } label: {
                Label(strings.t("common.delete"), systemImage: "trash")
            }
        case .deleteDisabled:
            Button {
            } label: {
                Text(strings.t("common.delete"))
                Text(strings.t("accounts.delete.hasTransactions"))
            }
            .disabled(true)
        }
    }

    // MARK: Balance

    private var balanceCard: some View {
        AdminCard(padding: VisionPageLayout.padding) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(strings.t("accounts.detail.balance"))
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryLabel)
                            .accessibilityAddTraits(.isHeader)
                        if holdingsOnly {
                            Text(strings.t("accounts.trackedInPortfolio"))
                                .font(Font.visionTitle3)
                                .foregroundStyle(theme.secondaryLabel)
                        } else if let balance = account.computedBalance {
                            MoneyText(amount: balance, currency: account.currency, settings: settings, signed: false, colored: false)
                                .font(.visionLargeTitle)
                                .visionTooltip(strings.t("accounts.balanceTooltip"))
                            if let provenance = model.provenance(account) {
                                Text(provenance)
                                    .font(.footnote)
                                    .foregroundStyle(theme.secondaryLabel)
                            }
                        } else {
                            Text(strings.t("accounts.detail.noBalance"))
                                .foregroundStyle(theme.secondaryLabel)
                        }
                        if let drift = model.drift(account) {
                            AccountDriftChip(drift: drift, strings: strings) { model.openReconcile(account) }
                        }
                        if model.showsReconcileButton(account) {
                            Button {
                                model.openReconcile(account)
                            } label: {
                                Label(strings.t("accounts.reconcile.open"), systemImage: "scalemass")
                            }
                            .buttonStyle(.visionOutline)
                            .controlSize(.small)
                        }
                    }
                    Spacer(minLength: 16)
                    let points = model.sparkPoints(account)
                    if points.count >= 2 {
                        AccountSparkline(points: points, trend: AccountsModel.trend(points))
                            .frame(width: 256, height: 64)
                            .accessibilityElement()
                            .accessibilityLabel(strings.t("accounts.detail.sparklineAria"))
                    }
                }
            }
        }
    }

    // MARK: Holdings

    private var holdingsCard: some View {
        let metrics = model.metrics(account)
        return AdminCard(padding: VisionPageLayout.padding) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text(strings.t("accounts.detail.holdings"))
                        .font(Font.visionTitle3)
                        .accessibilityAddTraits(.isHeader)
                    if metrics?.oversold == true {
                        VisionBadge(text: strings.t("portfolio.oversold.label"), tone: .warning, small: true)
                            .visionTooltip(strings.t("portfolio.oversold.description"))
                            .accessibilityLabel(
                                "\(strings.t("portfolio.oversold.label")). \(strings.t("portfolio.oversold.description"))")
                    }
                }
                if let error = model.portfolioError {
                    HStack(spacing: 10) {
                        Text(APIErrorMessage.text(error, strings: strings))
                            .foregroundStyle(theme.destructive)
                        Spacer()
                        Button(strings.t("common.retry")) { Task { await model.retryPortfolio() } }
                            .buttonStyle(.visionOutline)
                            .controlSize(.small)
                    }
                } else if model.isPortfolioLoading {
                    SkeletonBar(width: nil, height: 40)
                        .accessibilityLabel(strings.t("common.loading"))
                } else if let metrics, metrics.hasPosition {
                    HStack(alignment: .top, spacing: 32) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(strings.t("accounts.portfolio.holdings"))
                                .font(.footnote)
                                .foregroundStyle(theme.secondaryLabel)
                            MoneyText(
                                amount: metrics.holdingsValue, currency: model.displayCurrency, settings: settings,
                                signed: false, colored: false
                            )
                            .font(Font.visionTitle1)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(strings.t("accounts.portfolio.pnl"))
                                .font(.footnote)
                                .foregroundStyle(theme.secondaryLabel)
                            MoneyText.styled(
                                MoneyText.text(
                                    metrics.gainLoss, currency: model.displayCurrency, settings: settings, signed: true),
                                decimalSeparator: settings.numberFormat.locale.decimalSeparator?.first,
                                color: AccountHubRow.gainColor(metrics.gainLoss, theme: theme)
                            )
                                .monospacedDigit()
                                .font(Font.visionTitle1)
                                .foregroundStyle(AccountHubRow.gainColor(metrics.gainLoss, theme: theme))
                        }
                    }
                } else {
                    Text(strings.t("accounts.portfolio.noAssignedHoldings"))
                        .foregroundStyle(theme.secondaryLabel)
                }
            }
        }
    }

    // MARK: Planned

    private var plannedCard: some View {
        AdminCard(padding: VisionPageLayout.padding) {
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(strings.t("accounts.detail.upcomingPlanned"))
                        .font(Font.visionTitle3)
                        .accessibilityAddTraits(.isHeader)
                    Text(strings.t("accounts.detail.upcomingPlannedHint"))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                }
                if let error = model.plannedError {
                    HStack(spacing: 10) {
                        Text(APIErrorMessage.text(error, strings: strings))
                            .foregroundStyle(theme.destructive)
                        Spacer()
                        Button(strings.t("common.retry")) { Task { await model.retryPlanned() } }
                            .buttonStyle(.visionOutline)
                            .controlSize(.small)
                    }
                } else if model.isPlannedLoading {
                    SkeletonBar(width: nil, height: 40)
                        .accessibilityLabel(strings.t("common.loading"))
                } else {
                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                        GridRow {
                            Text(strings.t("txPage.col.date"))
                            Text(strings.t("txPage.field.description"))
                                .gridColumnAlignment(.leading)
                            Text(strings.t("txPage.col.amount"))
                                .gridColumnAlignment(.trailing)
                        }
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(theme.secondaryLabel)
                        ForEach(model.plannedRows) { row in
                            Divider()
                            GridRow {
                                Text(VisionFormat.appDate(row.date, format: settings.dateFormat))
                                    .monospacedDigit()
                                Text(row.title ?? strings.t("accounts.detail.unlabelled"))
                                    .lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                MoneyText(
                                    amount: row.amount, currency: (row.currency ?? account.currency), settings: settings,
                                    signed: true)
                            }
                        }
                    }
                    if let note = model.plannedTruncatedText {
                        Text(note)
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryLabel)
                    }
                }
            }
        }
    }

    // MARK: Details

    private var detailsCard: some View {
        AdminCard(padding: VisionPageLayout.padding) {
            VStack(alignment: .leading, spacing: 10) {
                Text(strings.t("accounts.detail.details"))
                    .font(Font.visionTitle3)
                    .accessibilityAddTraits(.isHeader)
                Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 6) {
                    ForEach(model.details(account)) { entry in
                        GridRow {
                            Text(strings.t(entry.labelKey))
                                .font(.footnote)
                                .foregroundStyle(theme.secondaryLabel)
                            Text(entry.value)
                        }
                    }
                }
            }
        }
    }
}

/// The ledger card: Ledger with its count, the since banner, the running-balance table and
/// Load more.
struct AccountLedgerCard: View {
    let model: AccountsModel
    let account: OpenAPI.Account
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }
    private var canView: Bool { AccountKinds.canViewTransactions(account) }

    var body: some View {
        AdminCard(padding: VisionPageLayout.padding) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(strings.t("accounts.detail.ledgerTitle"))
                        .font(Font.visionTitle3)
                        .accessibilityAddTraits(.isHeader)
                    if canView && model.ledgerTotal > 0 {
                        Text(strings.tc("accounts.detail.ledgerCount", model.ledgerTotal))
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryLabel)
                    }
                    Spacer()
                }
                if let since = model.since {
                    HStack(spacing: 8) {
                        Text(strings.t("accounts.detail.sinceBanner", ["date": VisionFormat.appDate(since, format: settings.dateFormat)]))
                            .font(.callout)
                            .lineLimit(1)
                        Spacer()
                        Button {
                            model.clearSince()
                        } label: {
                            Image(systemName: "xmark")
                                .imageScale(.small)
                        }
                        .buttonStyle(.vision(.ghost, size: .iconXs))
                        .visionTooltip(strings.t("aria.clearFilter"))
                        .accessibilityLabel(strings.t("aria.clearFilter"))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                            .fill(theme.primary.opacity(0.12)))
                }
                content
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if !canView {
            Text(strings.t("accounts.detail.noLedger"))
                .foregroundStyle(theme.secondaryLabel)
        } else if model.isLedgerLoading {
            VStack(spacing: 8) {
                ForEach(0..<5, id: \.self) { _ in
                    SkeletonBar(width: nil, height: 28)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(strings.t("common.loading"))
        } else if let error = model.ledgerError {
            Text(APIErrorMessage.text(error, strings: strings))
                .foregroundStyle(theme.destructive)
        } else if model.visibleLedger.isEmpty {
            VisionEmptyState(symbol: "tray", title: strings.t("accounts.detail.noTransactions")) {
                EmptyView()
            }
        } else {
            table
            if model.ledgerHasMore {
                HStack {
                    Spacer()
                    Button(strings.t("accounts.detail.loadMore")) {
                        Task { await model.loadMoreLedger() }
                    }
                    .buttonStyle(.visionOutline)
                    .disabled(model.isFetchingMoreLedger)
                    Spacer()
                }
            }
        }
    }

    private var table: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
            GridRow {
                Text(strings.t("txPage.col.date"))
                Text(strings.t("txPage.field.description"))
                Text(strings.t("txPage.col.category"))
                Text(strings.t("txPage.col.amount"))
                    .gridColumnAlignment(.trailing)
                Text(strings.t("txPage.field.balance"))
                    .gridColumnAlignment(.trailing)
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(theme.secondaryLabel)
            ForEach(model.visibleLedger) { row in
                Divider()
                GridRow {
                    Text(VisionFormat.appDate(row.date, format: settings.dateFormat))
                        .monospacedDigit()
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.title ?? strings.t("accounts.detail.unlabelled"))
                            .lineLimit(1)
                        if let memo = row.subtitle {
                            Text(memo)
                                .font(.footnote)
                                .foregroundStyle(theme.secondaryLabel)
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Text(row.categoryName ?? "—")
                        .foregroundStyle(theme.secondaryLabel)
                        .lineLimit(1)
                    Text(MoneyText.text(row.amount, currency: row.currency, settings: settings, signed: true))
                        .monospacedDigit()
                        .foregroundStyle(row.amount < 0 ? theme.loss : (row.amount > 0 ? theme.gain : theme.secondaryLabel))
                    if let balance = row.runningBalance {
                        MoneyText(amount: balance, currency: row.currency, settings: settings, signed: false, colored: false)
                            .foregroundStyle(theme.secondaryLabel)
                    } else {
                        Text(verbatim: "—")
                            .foregroundStyle(theme.secondaryLabel)
                    }
                }
            }
        }
        .opacity(model.isFetchingMoreLedger ? 0.6 : 1)
    }
}

/// The balance sparkline (`Sparkline`): green rising, red falling, blue flat.
struct AccountSparkline: View {
    let points: [Decimal]
    let trend: AccountTrend
    @Environment(\.visionTheme) private var theme

    private var color: Color {
        switch trend {
        case .up: return theme.gain
        case .down: return theme.loss
        case .flat: return Color(hue: 217 / 360, saturation: 0.91, brightness: 0.96)
        }
    }

    /// `Sparkline`'s coordinates: the value range padded by 10 % (1 when flat) mapped onto
    /// `height - 2 ... 2`, spread evenly over the width.
    private func plotted(_ size: CGSize) -> [CGPoint] {
        let values = points.map { NSDecimalNumber(decimal: $0).doubleValue }
        let low = values.min() ?? 0
        let high = values.max() ?? 0
        let pad = high != low ? (high - low) * 0.1 : 1
        let bottom = low - pad
        let span = (high + pad) - bottom
        return values.enumerated().map { index, value in
            let x = values.count > 1 ? size.width * CGFloat(index) / CGFloat(values.count - 1) : 0
            let ratio = span > 0 ? (value - bottom) / span : 0.5
            return CGPoint(x: x, y: (size.height - 2) - CGFloat(ratio) * (size.height - 4))
        }
    }

    var body: some View {
        GeometryReader { proxy in
            let plot = plotted(proxy.size)
            ZStack {
                // `fillArea`: the series colour at 15 % under the smoothed line.
                ChartCurve.area(plot, baseline: proxy.size.height).fill(color.opacity(0.15))
                ChartCurve.line(plot)
                    .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
        }
    }
}
