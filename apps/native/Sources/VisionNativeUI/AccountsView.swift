import SwiftUI
import VisionNativeCore

/// `/accounts` (apps/frontend/src/pages/AccountsPage.tsx) in SwiftUI: the grouped account
/// list (Cash & savings, Portfolio accounts, Liabilities) with converted subtotals, the Net
/// cash card and the collapsed Archived group. A row opens the account; its ••• menu offers
/// View details, View transactions and Reconcile balance, and the drift chip opens Reconcile
/// in place. Add account opens the account sheet.
public struct AccountsView: View {
    private let model: AccountsModel
    private let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    public init(model: AccountsModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }

    static var symbol: String {
        NavigationRegistry.matchItem(path: AccountsRoutes.path)?.symbol ?? "building.columns"
    }

    public var body: some View {
        AdminPage {
            VisionPageHeader(title: strings.t("accounts.title"), subtitle: strings.t("accounts.subtitle"), symbol: Self.symbol) {
                Button {
                    model.openCreate()
                } label: {
                    Label(strings.t("accounts.addTitle"), systemImage: "plus")
                }
                .buttonStyle(.visionPrimary)
            }
            content
        }
        .task { await model.appear(.hub) }
        .onDisappear { model.disappear(.hub) }
        .overlay(alignment: .bottom) {
            ActionToast(
                notice: model.notice, strings: strings, actionTitle: nil, duration: AccountsModel.noticeDuration,
                action: {}, clear: { model.clearNotice($0) }, bindsUndoShortcut: false)
        }
        .modifier(AccountDialogs(model: model, shell: shell, theme: theme))
    }

    @ViewBuilder
    private var content: some View {
        if model.isLoading {
            AdminCard {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(0..<4, id: \.self) { _ in
                        SkeletonBar(width: nil, height: 56)
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(strings.t("common.loading"))
        } else if let error = model.accountsError {
            AccountsErrorCard(
                message: APIErrorMessage.text(error, strings: strings), strings: strings
            ) {
                Task { await model.retry() }
            }
        } else if (model.accounts ?? []).isEmpty {
            AdminCard {
                VisionEmptyState(
                    symbol: Self.symbol, title: strings.t("accounts.emptyTitle"),
                    description: strings.t("accounts.emptyDescription")
                ) {
                    Button {
                        model.openCreate()
                    } label: {
                        Label(strings.t("accounts.addTitle"), systemImage: "plus")
                    }
                    .buttonStyle(.visionPrimary)
                }
            }
        } else {
            ForEach(model.visibleGroups) { group in
                groupSection(group)
            }
            netCashCard
            if let archived = model.archivedGroup {
                archivedSection(archived)
            }
        }
    }

    private func groupSection(_ group: AccountGroup) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(strings.t(group.id.labelKey))
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                AccountSubtotalText(subtotal: model.subtotal(group), currency: model.displayCurrency, strings: strings, settings: settings)
            }
            accountList(group.accounts)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(strings.t(group.id.labelKey))
    }

    private func accountList(_ accounts: [OpenAPI.Account]) -> some View {
        AdminCard(padding: 0) {
            VStack(spacing: 0) {
                ForEach(Array(accounts.enumerated()), id: \.element.id) { index, account in
                    if index > 0 { Divider().padding(.leading, 56) }
                    AccountHubRow(model: model, account: account, shell: shell)
                }
            }
        }
    }

    private var netCashCard: some View {
        AdminCard(padding: VisionPageLayout.padding) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(strings.t("accounts.netCash"))
                        .font(.headline)
                    Text(strings.t("accounts.netCashHint"))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                    if case .amount(let total) = model.netCash, total.incomplete {
                        Label(strings.t("accounts.totalIncomplete"), systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(theme.warning)
                    }
                }
                Spacer(minLength: 12)
                switch model.netCash {
                case .amount(let total):
                    MoneyText(amount: total.amount, currency: model.displayCurrency, settings: settings, signed: false, colored: false)
                        .font(Font.visionTitle1)
                case .pending:
                    SkeletonBar(width: 128, height: 32)
                        .accessibilityLabel(strings.t("common.loading"))
                case .unavailable:
                    Text(strings.t("accounts.group.subtotalUnavailable"))
                        .font(.footnote)
                        .foregroundStyle(theme.warning)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(strings.t("accounts.netCash"))
    }

    private func archivedSection(_ group: AccountGroup) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Button {
                    withAnimation(.snappy) { model.archivedOpen.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .imageScale(.small)
                            .rotationEffect(.degrees(model.archivedOpen ? 90 : 0))
                            .accessibilityHidden(true)
                        Text(verbatim: "\(strings.t("accounts.group.archived")) (\(group.accounts.count))")
                            .font(.headline)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(strings.t("accounts.group.archived"))
                .accessibilityValue(Text(verbatim: String(group.accounts.count)))
                Spacer()
                AccountSubtotalText(subtotal: model.subtotal(group), currency: model.displayCurrency, strings: strings, settings: settings)
            }
            if model.archivedOpen {
                accountList(group.accounts)
            }
        }
    }
}

/// `renderGroupSubtotal`: "Subtotal" and the amount, or calculating… / unavailable, with
/// "(incomplete)".
struct AccountSubtotalText: View {
    let subtotal: AccountSubtotal
    let currency: CurrencyCode
    let strings: any Localizing
    let settings: NativeAppSettings
    @Environment(\.visionTheme) private var theme

    var body: some View {
        HStack(spacing: 4) {
            Text(strings.t("accounts.group.subtotal"))
                .foregroundStyle(theme.secondaryLabel)
            switch subtotal {
            case .pending:
                Text(strings.t("accounts.group.subtotalPending"))
                    .foregroundStyle(theme.secondaryLabel)
            case .unavailable:
                Text(strings.t("accounts.group.subtotalUnavailable"))
                    .foregroundStyle(theme.warning)
            case .amount(let total):
                MoneyText(amount: total.amount, currency: currency, settings: settings, signed: false, colored: false)
                    .fontWeight(.medium)
                if total.incomplete {
                    Text(strings.t("accounts.group.subtotalIncomplete"))
                        .foregroundStyle(theme.warning)
                }
            }
        }
        .font(.footnote)
    }
}

/// One account row of the hub: the type icon, the label with its badges, the meta line, the
/// drift chip, the provenance or cash line, the incomplete warning, the trailing value, the
/// chevron and the ••• menu.
struct AccountHubRow: View {
    let model: AccountsModel
    let account: OpenAPI.Account
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }
    private var label: String { AccountKinds.label(account) }
    private var isPortfolio: Bool { AccountKinds.isPortfolio(account) }
    private var holdingsOnly: Bool { AccountKinds.isHoldingsOnly(account) }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            // The whole row opens the account; the drift chip and the menu are their own
            // buttons, so the row is a tap target rather than a button around them.
            HStack(alignment: .center, spacing: 12) {
                // ListRow's leading glyph: a bare 18 pt icon in label-secondary, no tile.
                Image(systemName: AccountKinds.kind(account)?.symbol ?? "building.columns")
                    .font(.system(size: 16, weight: .regular))
                    .foregroundStyle(theme.secondaryLabel)
                    .frame(width: 28, height: 28)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    titleLine
                    subtitle
                }
                Spacer(minLength: 8)
                value
                    .frame(minWidth: 128, alignment: .trailing)
                Image(systemName: "chevron.right")
                    .imageScale(.small)
                    .foregroundStyle(theme.tertiaryLabel)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
            .onTapGesture { model.openDetail(account) }
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel(label)
            .accessibilityAction { model.openDetail(account) }
            rowMenu
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .opacity(account.isActive ? 1 : 0.6)
    }

    private var titleLine: some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.body.weight(.medium))
                .lineLimit(1)
            if !account.isActive {
                VisionBadge(text: strings.t("accounts.archived"), tone: .outline, small: true)
            }
            if !account.inNetWorth {
                VisionBadge(text: strings.t("accounts.notInNetWorth"), tone: .outline, small: true)
            }
        }
    }

    @ViewBuilder
    private var subtitle: some View {
        if let drift = model.drift(account) {
            AccountDriftChip(drift: drift, strings: strings) { model.openReconcile(account) }
        }
        Text(model.meta(account))
            .font(.footnote)
            .foregroundStyle(theme.secondaryLabel)
            .lineLimit(1)
        if isPortfolio {
            if !holdingsOnly, let balance = account.computedBalance {
                HStack(spacing: 4) {
                    Text(strings.t("accounts.portfolio.cash"))
                    MoneyText(amount: balance, currency: account.currency, settings: settings, signed: false, colored: false)
                    if let provenance = model.provenance(account) {
                        Text(verbatim: "· \(provenance)")
                    }
                }
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
                .lineLimit(1)
            }
        } else if account.computedBalance != nil, let provenance = model.provenance(account) {
            Text(provenance)
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
                .lineLimit(1)
        }
        if !isPortfolio && account.balanceIncomplete == true {
            Text(strings.t("accounts.balanceIncomplete"))
                .font(.footnote)
                .foregroundStyle(theme.warning)
            ForEach(model.excludedParts(account), id: \.currency) { part in
                HStack(spacing: 4) {
                    MoneyText(amount: part.balance, currency: part.currency, settings: settings, signed: false, colored: false)
                    Text(strings.t("accounts.balanceExcluded"))
                }
                .font(.footnote)
                .foregroundStyle(theme.warning)
            }
        }
    }

    @ViewBuilder
    private var value: some View {
        if isPortfolio {
            let metrics = model.metrics(account)
            if let metrics, metrics.hasPosition {
                VStack(alignment: .trailing, spacing: 1) {
                    MoneyText(
                        amount: metrics.holdingsValue, currency: model.displayCurrency, settings: settings, signed: false,
                        colored: false
                    )
                    .font(.body.weight(.medium))
                    Text(strings.t("accounts.portfolio.holdings"))
                        .font(.caption)
                        .foregroundStyle(theme.tertiaryLabel)
                    HStack(spacing: 4) {
                        Text(strings.t("accounts.portfolio.pnl"))
                        MoneyText.styled(
                            MoneyText.text(
                                metrics.gainLoss, currency: model.displayCurrency, settings: settings, signed: true),
                            decimalSeparator: settings.numberFormat.locale.decimalSeparator?.first,
                            color: Self.gainColor(metrics.gainLoss, theme: theme)
                        )
                        .monospacedDigit()
                    }
                    .font(.footnote)
                    .foregroundStyle(Self.gainColor(metrics.gainLoss, theme: theme))
                }
            } else {
                Text(strings.t(metrics == nil ? "accounts.trackedInPortfolio" : "accounts.portfolio.noAssignedHoldings"))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
            }
        } else if let balance = account.computedBalance {
            MoneyText(amount: balance, currency: account.currency, settings: settings, signed: false, colored: false)
                .font(.body.weight(.medium))
                .visionTooltip(strings.t("accounts.balanceTooltip"))
        }
    }

    static func gainColor(_ amount: Decimal, theme: VisionTheme) -> Color {
        if amount > 0 { return theme.gain }
        if amount < 0 { return theme.loss }
        return theme.secondaryLabel
    }

    private var rowMenu: some View {
        Menu {
            Button {
                model.openDetail(account)
            } label: {
                Label(strings.t("accounts.viewDetails"), systemImage: "sidebar.right")
            }
            if AccountKinds.canViewTransactions(account) {
                Button {
                    model.openTransactions(account)
                } label: {
                    Label(strings.t("accounts.openTransactions"), systemImage: "list.bullet.rectangle")
                }
            }
            if model.canReconcile(account) {
                Button {
                    model.openReconcile(account)
                } label: {
                    Label(strings.t("accounts.reconcile.open"), systemImage: "scalemass")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuIndicator(.hidden)
        .menuStyle(.borderlessButton)
        .fixedSize()
        .visionTooltip(strings.t("accounts.rowMenu", ["name": label]))
        .accessibilityLabel(strings.t("accounts.rowMenu", ["name": label]))
    }
}

/// The drift chip: "{amount} off your statement", destructive, or warning when stale. A
/// click opens Reconcile balance.
struct AccountDriftChip: View {
    let drift: AccountDrift
    let strings: any Localizing
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VisionBadge(text: drift.label, tone: drift.stale ? .warning : .destructive, small: true)
        }
        .buttonStyle(.plain)
        .visionTooltip(strings.t(drift.tooltipKey))
        .accessibilityLabel(strings.t("accounts.reconcile.open"))
        .accessibilityValue(drift.label)
    }
}

/// `PageError` with the API message and, when given, Retry.
struct AccountsErrorCard: View {
    let message: String
    let strings: any Localizing
    var retry: (() -> Void)?
    @Environment(\.visionTheme) private var theme

    var body: some View {
        AdminCard {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(theme.destructive)
                    .accessibilityHidden(true)
                Text(message)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                if let retry {
                    Button(strings.t("common.retry"), action: retry)
                        .buttonStyle(.visionOutline)
                        .controlSize(.small)
                }
            }
        }
    }
}
