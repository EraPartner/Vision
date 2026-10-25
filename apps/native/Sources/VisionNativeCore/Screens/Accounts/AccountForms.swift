import Foundation

/// The option lists of the Add / Edit account sheet (AddAccountDialog.tsx).
public enum AccountOptions {
    /// `SUPPORTED_CURRENCIES` (apps/frontend/src/utils/currency.ts).
    public static let currencies: [CurrencyCode] = [
        "EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "BGN",
        "HRK", "TRY", "SAR", "AED", "INR", "BRL", "MXN", "ZAR", "SGD", "HKD", "NZD", "KRW", "THB", "MYR", "PHP",
    ].compactMap { CurrencyCode(rawValue: $0) }
    /// `OWNERS`, labelled `accounts.owner.<owner>`.
    public static let owners: [OpenAPI.Account.Owner] = [.me, .partner, .joint]
    /// `LIQUIDITY`, labelled `accounts.liquidity.<class>`.
    public static let liquidityClasses: [OpenAPI.Account.LiquidityClass] = [.liquid, .semiLiquid, .illiquid]
    /// The sheet's name, display name and institution `maxLength`.
    public static let maxTextLength = 200

    /// The currency select: an unknown existing code is listed first.
    public static func currencies(including code: CurrencyCode) -> [CurrencyCode] {
        currencies.contains(code) ? currencies : [code] + currencies
    }
}

/// The flag fields `flagsForType` pre-fills (`FLAG_KEYS`). Once the user edits one, a later
/// type change leaves it alone.
public enum AccountFlag: String, Sendable, CaseIterable {
    case liquidityClass
    case spendable
    case hasCashSleeve
    case taxWrapper
}

/// `flagsForType`: the ADR-089 suggestions a type pre-fills.
public struct AccountTypeFlags: Equatable, Sendable {
    public let liquidityClass: OpenAPI.Account.LiquidityClass
    public let spendable: Bool
    public let hasCashSleeve: Bool
    public let taxWrapper: OpenAPI.Account.TaxWrapper

    public static func of(_ type: OpenAPI.Account.AccountType) -> AccountTypeFlags {
        switch AccountKind(type) {
        case .savings:
            return AccountTypeFlags(liquidityClass: .liquid, spendable: false, hasCashSleeve: true, taxWrapper: .none)
        case .brokerage, .cryptoExchange:
            return AccountTypeFlags(
                liquidityClass: .semiLiquid, spendable: false, hasCashSleeve: true, taxWrapper: .none)
        case .wallet:
            return AccountTypeFlags(
                liquidityClass: .semiLiquid, spendable: false, hasCashSleeve: false, taxWrapper: .none)
        case .pension:
            return AccountTypeFlags(
                liquidityClass: .illiquid, spendable: false, hasCashSleeve: false, taxWrapper: .pension)
        case .liability:
            return AccountTypeFlags(liquidityClass: .illiquid, spendable: false, hasCashSleeve: false, taxWrapper: .none)
        case .checking, nil:
            return AccountTypeFlags(liquidityClass: .liquid, spendable: true, hasCashSleeve: true, taxWrapper: .none)
        }
    }
}

/// The Add account / Edit account sheet (`AddAccountDialog`).
public struct AccountFormDraft: Equatable, Sendable {
    public enum Mode: Equatable, Sendable {
        case create
        /// Edit mode for the account with this id.
        case edit(id: AccountID)
    }

    /// What the submit button finds (`handleSubmit`).
    public enum Check: Equatable, Sendable {
        /// The name is empty: a silent block, as the button is disabled too.
        case blocked
        /// `accounts.openingBalance.invalid` shows on the opening balance.
        case openingInvalid
        /// `validation.required` shows on the As of date.
        case openingDateMissing
        case ready
    }

    public let mode: Mode
    public let numberFormat: NumberFormat
    public private(set) var name = ""
    public private(set) var displayName = ""
    public private(set) var institution = ""
    public var currency = LedgerCurrency.eur
    public private(set) var type = AccountKind.checking.type
    public var owner = OpenAPI.Account.Owner.me
    public private(set) var liquidityClass = OpenAPI.Account.LiquidityClass.liquid
    public private(set) var taxWrapper = OpenAPI.Account.TaxWrapper.none
    public private(set) var spendable = true
    public var inNetWorth = true
    public private(set) var multiCurrencyCash = false
    public private(set) var hasCashSleeve = true
    /// The flags the user edited by hand.
    public private(set) var touched: Set<AccountFlag> = []
    /// The display name stopped mirroring the name (always in edit mode).
    public private(set) var displayNameEdited: Bool
    /// The optional opening balance (create mode only).
    public private(set) var openingBalance = ""
    /// The As of date; `nil` once cleared.
    public var openingDate: PlannedDay?
    /// The submit ran once, so the opening-balance errors show.
    public private(set) var openingSubmitted = false
    /// The Advanced section: collapsed in create mode, expanded in edit mode.
    public var showAdvanced: Bool

    /// Create mode: `EMPTY`, with the As of date on today.
    public init(today: PlannedDay, numberFormat: NumberFormat) {
        mode = .create
        self.numberFormat = numberFormat
        displayNameEdited = false
        openingDate = today
        showAdvanced = false
    }

    /// Edit mode: `accountToFormValues`.
    public init(editing account: OpenAPI.Account, numberFormat: NumberFormat) {
        mode = .edit(id: account.id)
        self.numberFormat = numberFormat
        name = account.name
        displayName = account.displayName ?? ""
        institution = account.institution ?? ""
        currency = account.currency
        type = account.type
        owner = account.owner
        liquidityClass = account.liquidityClass
        taxWrapper = account.taxWrapper
        spendable = account.spendable
        inNetWorth = account.inNetWorth
        multiCurrencyCash = account.multiCurrencyCash
        hasCashSleeve = account.hasCashSleeve
        displayNameEdited = true
        openingDate = nil
        showAdvanced = true
    }

    public var isCreate: Bool { mode == .create }

    /// `accounts.addTitle` or `accounts.editTitle`.
    public var titleKey: String { isCreate ? "accounts.addTitle" : "accounts.editTitle" }

    /// `accounts.addTitle` or `common.save`.
    public var submitKey: String { isCreate ? "accounts.addTitle" : "common.save" }

    private static func limited(_ text: String) -> String {
        String(text.prefix(AccountOptions.maxTextLength))
    }

    /// `onNameChange`: in create mode the display name copies it until edited.
    public mutating func setName(_ text: String) {
        name = Self.limited(text)
        if !displayNameEdited { displayName = name }
    }

    /// `onDisplayNameChange`: the mirroring stops.
    public mutating func setDisplayName(_ text: String) {
        displayNameEdited = true
        displayName = Self.limited(text)
    }

    public mutating func setInstitution(_ text: String) {
        institution = Self.limited(text)
    }

    /// `onTypeChange`: the type defaults apply to every flag the user has not touched, and a
    /// holdings-only type clears the opening balance.
    public mutating func setType(_ next: OpenAPI.Account.AccountType) {
        let defaults = AccountTypeFlags.of(next)
        type = next
        if !touched.contains(.liquidityClass) { liquidityClass = defaults.liquidityClass }
        if !touched.contains(.spendable) { spendable = defaults.spendable }
        if !touched.contains(.hasCashSleeve) { hasCashSleeve = defaults.hasCashSleeve }
        if !touched.contains(.taxWrapper) { taxWrapper = defaults.taxWrapper }
        if AccountKind(next)?.isHoldingsOnly == true { openingBalance = "" }
    }

    /// The Liquidity select: marks it touched.
    public mutating func setLiquidityClass(_ value: OpenAPI.Account.LiquidityClass) {
        touched.insert(.liquidityClass)
        liquidityClass = value
    }

    /// The Spendable switch: marks it touched.
    public mutating func setSpendable(_ value: Bool) {
        touched.insert(.spendable)
        spendable = value
    }

    public mutating func setOpeningBalance(_ text: String) {
        openingBalance = text
    }

    /// The sheet closed or reopened: the errors hide again.
    public mutating func resetSubmitted() {
        openingSubmitted = false
    }

    /// `isHoldingsOnlyPortfolioType(form.type)`.
    public var isHoldingsOnly: Bool { AccountKind(type)?.isHoldingsOnly ?? false }

    /// The opening balance and its date show: create mode, not a wallet or exchange.
    public var showsOpeningBalance: Bool { isCreate && !isHoldingsOnly }

    /// `accounts.openingBalance.createDebtLabel` for a liability.
    public var openingLabelKey: String {
        type == .liability
            ? "accounts.openingBalance.createDebtLabel" : "accounts.openingBalance.createLabel"
    }

    private var hasOpeningBalance: Bool {
        showsOpeningBalance && !openingBalance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// `openingBalanceInvalid`.
    public var openingInvalid: Bool {
        hasOpeningBalance && LocaleNumber.parse(openingBalance, format: numberFormat) == nil
    }

    /// `showOpeningBalanceError`.
    public var showsOpeningError: Bool { openingSubmitted && openingInvalid }

    /// `showOpeningDateError`.
    public var showsOpeningDateError: Bool {
        openingSubmitted && isCreate && !openingBalance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && openingDate == nil
    }

    /// The submit button: `!form.name.trim()` disables it.
    public var canSubmit: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// `handleSubmit`'s checks, in order; marks the submit as tried in create mode.
    public mutating func check() -> Check {
        guard canSubmit else { return .blocked }
        guard isCreate else { return .ready }
        openingSubmitted = true
        if hasOpeningBalance && LocaleNumber.parse(openingBalance, format: numberFormat) == nil {
            return .openingInvalid
        }
        if hasOpeningBalance && openingDate == nil { return .openingDateMissing }
        return .ready
    }

    private static func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `currencyCode("EUR")`.
    public var normalizedCurrency: CurrencyCode { currency }

    /// `toAccountPayload(values, "create")`: empty optionals are left out.
    public var createBody: OpenAPI.AccountCreate {
        let display = Self.trimmed(displayName)
        let place = Self.trimmed(institution)
        return OpenAPI.AccountCreate(
            name: Self.trimmed(name), displayName: display.isEmpty ? nil : display,
            institution: place.isEmpty ? nil : place, currency: normalizedCurrency,
            type: OpenAPI.AccountCreate.AccountCreateType(rawValue: type.rawValue),
            liquidityClass: OpenAPI.AccountCreate.LiquidityClass(rawValue: liquidityClass.rawValue), spendable: spendable,
            inNetWorth: inNetWorth, taxWrapper: OpenAPI.AccountCreate.TaxWrapper(rawValue: taxWrapper.rawValue),
            owner: OpenAPI.AccountCreate.Owner(rawValue: owner.rawValue), multiCurrencyCash: multiCurrencyCash, hasCashSleeve: hasCashSleeve)
    }

    /// `toAccountEditPayload`: empty optionals are sent as `null` so the server clears them.
    public var patch: AccountPatch {
        let display = Self.trimmed(displayName)
        let place = Self.trimmed(institution)
        var patch = AccountPatch()
        patch.name = Self.trimmed(name)
        patch.displayName = .some(display.isEmpty ? nil : display)
        patch.institution = .some(place.isEmpty ? nil : place)
        patch.currency = normalizedCurrency
        patch.type = OpenAPI.AccountUpdate.AccountUpdateType(rawValue: type.rawValue)
        patch.owner = OpenAPI.AccountUpdate.Owner(rawValue: owner.rawValue)
        patch.liquidityClass = OpenAPI.AccountUpdate.LiquidityClass(rawValue: liquidityClass.rawValue)
        patch.taxWrapper = OpenAPI.AccountUpdate.TaxWrapper(rawValue: taxWrapper.rawValue)
        patch.spendable = spendable
        patch.inNetWorth = inNetWorth
        patch.multiCurrencyCash = multiCurrencyCash
        patch.hasCashSleeve = hasCashSleeve
        return patch
    }

    /// The opening balance to stamp after a create: `nil` when none was entered.
    public var openingStamp: (balance: Decimal, date: String)? {
        guard hasOpeningBalance, let amount = LocaleNumber.parse(openingBalance, format: numberFormat),
            let openingDate
        else { return nil }
        return (amount, openingDate.ymd)
    }
}

/// Money arithmetic of the reconcile and close dialogs.
public enum AccountMoney {
    /// `DRIFT_EPSILON`: a difference below half a cent is already reconciled.
    public static let epsilon = Decimal(string: "0.005") ?? 0

    /// `roundToCents`: half away from zero.
    public static func roundToCents(_ value: Decimal) -> Decimal {
        var input = value
        var output = Decimal()
        NSDecimalRound(&output, &input, 2, .plain)
        return output
    }

    public static func magnitude(_ value: Decimal) -> Decimal {
        value < 0 ? -value : value
    }
}

/// The Reconcile balance dialog (`ReconcileDialog`).
public struct ReconcileDraft: Equatable, Sendable {
    public let account: OpenAPI.Account
    public let numberFormat: NumberFormat
    /// The statement currency.
    public private(set) var selectedCurrency: CurrencyCode
    /// The new statement reading as typed.
    public private(set) var reading = ""
    /// The As of date; `nil` once cleared.
    public var readingDate: PlannedDay?
    /// The resolution in flight, for its spinner.
    public var pendingAction: ReconcileAction?

    public init(account: OpenAPI.Account, today: PlannedDay, numberFormat: NumberFormat) {
        self.account = account
        self.numberFormat = numberFormat
        selectedCurrency = account.reconcilableCurrency ?? account.currency
        readingDate = today
    }

    /// `reconcilable_currency ?? currency`.
    public var defaultCurrency: CurrencyCode { account.reconcilableCurrency ?? account.currency }

    /// Every currency the account holds or has a statement for, sorted.
    public var availableCurrencies: [CurrencyCode] {
        var codes = Set([defaultCurrency])
        for part in account.balanceParts ?? [] { codes.insert(part.currency) }
        for statement in account.statementBalances ?? [] { codes.insert(statement.currency) }
        return codes.sorted()
    }

    /// The Statement currency select: multi-currency cash accounts holding more than one.
    public var showsCurrencyPicker: Bool { account.multiCurrencyCash && availableCurrencies.count > 1 }

    /// Switching the currency clears the reading.
    public mutating func selectCurrency(_ code: CurrencyCode) {
        selectedCurrency = code
        reading = ""
    }

    public mutating func setReading(_ text: String) {
        reading = text
    }

    private var selectedStatement: OpenAPI.Account.StatementBalancesItem? {
        account.statementBalances?.first { $0.currency == selectedCurrency }
    }

    /// The stored statement figure in the selected currency, else 0.
    public var statement: Decimal { selectedStatement?.balance ?? 0 }

    /// `computed_balance ?? 0`.
    public var computed: Decimal { account.computedBalance ?? 0 }

    /// The reconciliation base: the selected currency's partition, else the reconcilable
    /// balance (default currency), else 0.
    public var base: Decimal {
        if let part = account.balanceParts?.first(where: { $0.currency == selectedCurrency }) { return part.balance }
        return selectedCurrency == defaultCurrency ? (account.reconcilableBalance ?? computed) : 0
    }

    /// The stored difference.
    public var delta: Decimal {
        selectedCurrency == defaultCurrency ? (account.drift ?? statement - base) : statement - base
    }

    /// The base row and its hint show only when the base differs from the computed balance.
    public var baseIsComputed: Bool {
        selectedCurrency == account.currency && AccountMoney.magnitude(base - computed) < AccountMoney.epsilon
    }

    /// The typed reading, rounded to cents; `nil` when empty or not a number.
    public var parsedReading: Decimal? {
        let raw = reading.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, let value = LocaleNumber.parse(raw, format: numberFormat) else { return nil }
        return AccountMoney.roundToCents(value)
    }

    /// Something was typed that is not an amount.
    public var readingInvalid: Bool {
        !reading.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && parsedReading == nil
    }

    public var hasReading: Bool { parsedReading != nil }

    /// Save reading: a reading and its date.
    public var canSaveReading: Bool { hasReading && readingDate != nil }

    /// `readingNeedsDate`: blocks the resolutions.
    public var readingNeedsDate: Bool { hasReading && readingDate == nil }

    /// The live Difference: the reading minus the base, else the stored difference.
    public var previewDrift: Decimal { parsedReading.map { $0 - base } ?? delta }

    public var previewIsZero: Bool { AccountMoney.magnitude(previewDrift) < AccountMoney.epsilon }

    /// The stored statement date of the selected currency.
    public var storedStatementDate: String? {
        guard let raw = selectedStatement?.balanceDate else { return nil }
        let ymd = String(raw.prefix(10))
        return AccountDates.isYmd(ymd) ? ymd : nil
    }

    /// The date of Show transactions since: the entered reading's, else the stored one.
    public var sinceDate: String? {
        if canSaveReading, let readingDate { return readingDate.ymd }
        return storedStatementDate
    }

    /// A reading dated before today: the backdated warning.
    public func isBackdated(today: String) -> Bool {
        guard canSaveReading, let readingDate else { return false }
        return readingDate.ymd < today
    }

    /// Set as opening balance: no statement anchor yet, and a reading or a stored statement.
    public var canBackfill: Bool {
        let anchored = !(account.anchorDate ?? "").isEmpty
        let storedAvailable = reading.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && selectedStatement != nil
        return !anchored && (canSaveReading || storedAvailable)
    }

    public var backfillBalance: Decimal {
        canSaveReading ? (parsedReading ?? statement) : statement
    }

    public func backfillDate(today: String) -> String {
        if canSaveReading, let readingDate { return readingDate.ymd }
        return storedStatementDate ?? today
    }
}

/// The write a Reconcile button started.
public enum ReconcileAction: Equatable, Sendable {
    case saveReading
    case resolve(ReconcileMode)
    case backfill
}

/// The Set opening balance dialog (`OpeningBalanceDialog`).
public struct OpeningBalanceDraft: Equatable, Sendable {
    public let accountId: AccountID
    public let accountName: String
    /// `reconcilable_currency ?? currency`: the anchor's currency.
    public let currency: CurrencyCode
    public let numberFormat: NumberFormat
    public var balance: String
    /// `nil` once cleared.
    public var date: PlannedDay?
    public var isSaving = false

    /// Pre-filled from the stored statement, else the reconcilable balance, else the computed
    /// balance; dated on the statement, else today.
    public init(account: OpenAPI.Account, today: PlannedDay, numberFormat: NumberFormat, calendar: Calendar) {
        accountId = account.id
        accountName = AccountKinds.label(account)
        let currency = account.reconcilableCurrency ?? account.currency
        self.currency = currency
        self.numberFormat = numberFormat
        let statement = account.statementBalances?.first { $0.currency == currency }
        let prefill = statement?.balance ?? account.reconcilableBalance ?? account.computedBalance
        balance = LocaleNumber.editable(prefill, format: numberFormat)
        if let raw = statement?.balanceDate, let day = PlannedDay(ymd: String(raw.prefix(10)), calendar: calendar) {
            date = day
        } else {
            date = today
        }
    }

    public var parsedBalance: Decimal? {
        let raw = balance.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        return LocaleNumber.parse(raw, format: numberFormat)
    }

    /// `canSubmit`.
    public var canSubmit: Bool { !isSaving && parsedBalance != nil && date != nil }
}

/// A list that loads: the lot preview, the merge preview, the broker destinations.
public enum AccountLoad<Value: Equatable & Sendable>: Equatable, Sendable {
    case loading
    case loaded(Value)
    case failed

    public var value: Value? {
        if case .loaded(let value) = self { return value }
        return nil
    }

    public var isLoading: Bool { self == .loading }
    public var isFailed: Bool { self == .failed }
}

/// The Merge account dialog (`MergeAccountDialog`).
public struct MergeDraft: Equatable, Sendable {
    public let source: OpenAPI.Account
    public private(set) var targetId: AccountID?
    /// The preview of the chosen pair; `nil` before a target is chosen.
    public var preview: AccountLoad<AccountMergePreview>?
    /// The acknowledgement holds only for the pair it was given for.
    public private(set) var acknowledgedTarget: AccountID?
    public var isMerging = false

    public init(source: OpenAPI.Account) {
        self.source = source
    }

    /// A new target: the preview reloads and the acknowledgement clears.
    public mutating func selectTarget(_ id: AccountID) {
        targetId = id
        acknowledgedTarget = nil
        preview = .loading
    }

    public mutating func setAcknowledged(_ value: Bool) {
        acknowledgedTarget = value ? targetId : nil
    }

    public mutating func clearAcknowledgement() {
        acknowledgedTarget = nil
    }

    public var acknowledged: Bool { targetId != nil && acknowledgedTarget == targetId }

    /// `previewReady`: this exact pair's preview is in hand.
    public var previewReady: Bool {
        guard let targetId, case .loaded(let data)? = preview else { return false }
        return data.source == source.id && data.into == targetId
    }

    /// The acknowledgement checkbox is enabled.
    public var canAcknowledge: Bool { previewReady && !isMerging }

    /// The Merge button.
    public var canMerge: Bool { targetId != nil && acknowledged && previewReady && !isMerging }
}

/// The destination of `PortfolioLotRetagChoice`.
public enum LotDestination: Equatable, Hashable, Sendable {
    /// `KEEP_PORTFOLIO_LOTS` (Close account only).
    case keep
    /// `UNASSIGNED_PORTFOLIO_LOTS`.
    case unassigned
    case account(AccountID)

    /// The request's `to_account_id`.
    public var toAccountId: AccountID? {
        if case .account(let id) = self { return id }
        return nil
    }
}

/// The idempotency key of one lot move, reused while the same move is retried.
public struct LotMoveKey: Equatable, Sendable {
    public let fingerprint: String
    public let key: String

    /// `${transaction_ids.join(",")}|${account.id}|${destination ?? "unassigned"}`.
    public static func fingerprint(ids: [TransactionID], from accountId: AccountID, to destination: AccountID?) -> String {
        "\(ids.map { String($0.rawValue) }.joined(separator: ","))|\(accountId)|\(destination.map { String($0.rawValue) } ?? "unassigned")"
    }
}

/// One currency part of a residual balance.
public struct AccountResidual: Equatable, Sendable {
    public let currency: CurrencyCode
    public let balance: Decimal
}

/// The Close account dialog (`CloseAccountDialog` with `PortfolioLotRetagChoice`).
public struct CloseDraft: Equatable, Sendable {
    public let account: OpenAPI.Account
    /// `zeroOut`, checked by default.
    public var zeroOut = true
    public var lotChoice: LotDestination = .keep
    /// The lot preview of a portfolio-type account; `nil` for other types.
    public var lotPreview: AccountLoad<AccountLotPreview>?
    /// The active broker accounts the lots can move to (`useAccounts({ active: "true" })`).
    public var brokers: [OpenAPI.Account] = []
    public var moveKey: LotMoveKey?
    public var isClosing = false

    public init(account: OpenAPI.Account) {
        self.account = account
        lotPreview = AccountKinds.isPortfolio(account) ? .loading : nil
    }

    public var isPortfolio: Bool { AccountKinds.isPortfolio(account) }
    public var isHoldingsOnly: Bool { AccountKinds.isHoldingsOnly(account) }

    /// The broker destinations without the account itself.
    public var destinations: [OpenAPI.Account] { brokers.filter { $0.id != account.id } }

    /// The non-zero parts the residual warning lists.
    public var residualParts: [AccountResidual] {
        if isHoldingsOnly { return [] }
        if let parts = account.balanceParts {
            return parts.filter { AccountMoney.magnitude($0.balance) >= AccountMoney.epsilon }.map { part in
                AccountResidual(currency: part.currency, balance: part.balance)
            }
        }
        let computed = account.computedBalance ?? 0
        return AccountMoney.magnitude(computed) >= AccountMoney.epsilon
            ? [AccountResidual(currency: account.currency, balance: computed)] : []
    }

    /// The lot card shows: assigned lots exist.
    public var showsLotChoice: Bool { (lotPreview?.value?.eligibleCount ?? 0) > 0 }

    /// `shouldRetag`.
    public var shouldRetag: Bool {
        isPortfolio && lotChoice != .keep && (lotPreview?.value?.eligibleCount ?? 0) > 0
    }

    /// `retagUnavailable`.
    public var retagUnavailable: Bool {
        guard shouldRetag else { return false }
        guard let preview = lotPreview?.value else { return true }
        return preview.isOverLimit
    }

    /// The Close account button.
    public var canClose: Bool { !isClosing && !retagUnavailable }

    /// `!holdingsOnly && zeroOut ? "adjustment" : "preserve"`.
    public var balanceHandling: CloseBalanceHandling {
        !isHoldingsOnly && zeroOut ? .adjustment : .preserve
    }
}

/// The Transfer portfolio lots dialog (`BrokerTransferDialog`).
public struct BrokerTransferDraft: Equatable, Sendable {
    public let account: OpenAPI.Account
    /// `nil` until a destination is chosen.
    public var destination: LotDestination?
    public var preview: AccountLoad<AccountLotPreview> = .loading
    /// The active broker accounts (its own `useAccounts({ active: "true" })`).
    public var accounts: AccountLoad<[OpenAPI.Account]> = .loading
    /// After a transfer: the receipt card and a single Close button.
    public var receipt: LotRetagReceipt?
    public var moveKey: LotMoveKey?
    public var isTransferring = false

    public init(account: OpenAPI.Account) {
        self.account = account
    }

    /// The broker destinations without the account itself.
    public var destinations: [OpenAPI.Account] { (accounts.value ?? []).filter { $0.id != account.id } }

    public var isOverLimit: Bool { preview.value?.isOverLimit ?? false }

    /// The Transfer lots button.
    public var canTransfer: Bool {
        guard destination != nil, accounts.value != nil, let preview = preview.value else { return false }
        return preview.eligibleCount > 0 && !preview.isOverLimit && !isTransferring
    }
}
