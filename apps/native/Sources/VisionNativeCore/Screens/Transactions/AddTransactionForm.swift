import Foundation
import Observation

/// What the Add transaction sheet records (`TransactionKind` of addTransactionForm.ts): the
/// sign of the amount follows from it.
public enum TransactionKind: String, CaseIterable, Sendable {
    case expense
    case income
    case transfer

    /// `addTxn.kind.{kind}`.
    public var labelKey: String { "addTxn.kind.\(rawValue)" }

    /// The primary button: `addTxn.addExpense` / `addTxn.addIncome` / `addTxn.addTransfer`.
    public var submitKey: String {
        switch self {
        case .expense: return "addTxn.addExpense"
        case .income: return "addTxn.addIncome"
        case .transfer: return "addTxn.addTransfer"
        }
    }

    /// The glyph before the amount: `−` for an expense, `+` for income, none for a transfer.
    public var signGlyph: String {
        switch self {
        case .expense: return "−"
        case .income: return "+"
        case .transfer: return ""
        }
    }

    /// `signedAmount`: income arrives, expenses and transfers leave.
    public func signed(_ magnitude: Decimal) -> Decimal {
        let absolute = magnitude < 0 ? -magnitude : magnitude
        return self == .income ? absolute : -absolute
    }
}

/// The sheet's Date segmented control.
public enum AddTransactionDateChoice: String, CaseIterable, Sendable {
    case today
    case yesterday
    case other

    /// `addTxn.date.{choice}`.
    public var labelKey: String { "addTxn.date.\(rawValue)" }
}

/// The validated fields in visual order (`ADD_TRANSACTION_FIELD_ORDER`): a blocked submit
/// focuses the first one with an error.
public enum AddTransactionField: String, CaseIterable, Sendable {
    case amount
    case recipient
    case account
    case toAccount
    case date
}

/// `AddTransactionFormState`.
public struct AddTransactionDraft: Equatable, Sendable {
    public var kind: TransactionKind
    /// `transaction_date`, `YYYY-MM-DD`, or empty.
    public var date: String
    /// The chosen account's name (`bank_account`).
    public var accountName = ""
    public var accountId: Int?
    /// Transfer only: the receiving account.
    public var toAccountName = ""
    public var toAccountId: Int?
    public var recipientId: Int?
    public var categoryId: Int?
    public var memo = ""
    /// The magnitude as typed; the kind decides the sign.
    public var amount = ""
    public var currency: String
    public var comment = ""

    /// `createAddTransactionFormState(defaultCurrency, kind)`.
    public init(defaultCurrency: String, kind: TransactionKind = .expense, today: PlannedDay) {
        self.kind = kind
        date = today.ymd
        currency = defaultCurrency.isEmpty ? "EUR" : defaultCurrency
    }
}

/// The state of the Add transaction sheet (`AddTransactionSheet`): the form, the category a
/// payee's usual category filled, the Other date choice, the field errors a blocked submit
/// revealed (they then stay live), the duplicate prompt and the pending flag. The form stays
/// when the sheet closes without adding; a successful add resets it.
@MainActor
@Observable
public final class AddTransactionModel {
    /// `maxLength` of the inputs.
    public nonisolated static let currencyMaxLength = 10
    public nonisolated static let memoMaxLength = 500
    public nonisolated static let commentMaxLength = 1000

    public private(set) var draft: AddTransactionDraft
    /// The category came from the payee's usual category (`categoryAuto`).
    public private(set) var categoryAuto = false
    /// The payee whose usual category filled the field, for `addTxn.usualCategory`.
    public private(set) var usualCategorySource: OpenAPI.Recipient?
    /// Other date… was chosen, so the date picker shows.
    public private(set) var customDate = false
    /// A submit was blocked: the field errors show, and update as the form changes.
    public private(set) var errorsRevealed = false
    /// The server answered 409: the duplicate prompt with Add anyway shows. Any change to
    /// the form hides it.
    public private(set) var duplicateDetected = false
    /// The create (or the transfer's calls) is running.
    public internal(set) var isPending = false
    /// The field a blocked submit moves focus to; the view clears it once moved.
    public private(set) var focusRequest: AddTransactionField?

    @ObservationIgnored public let defaultCurrency: String
    @ObservationIgnored private let pickers: PickerDataModel
    @ObservationIgnored private let calendar: Calendar
    @ObservationIgnored private let today: @MainActor () -> PlannedDay

    public init(
        defaultCurrency: String, pickers: PickerDataModel, calendar: Calendar,
        today: @escaping @MainActor () -> PlannedDay
    ) {
        self.defaultCurrency = defaultCurrency
        self.pickers = pickers
        self.calendar = calendar
        self.today = today
        draft = AddTransactionDraft(defaultCurrency: defaultCurrency, today: today())
    }

    // MARK: Editing

    /// Every change goes through here: a changed form hides the duplicate prompt.
    private func edit(_ change: (inout AddTransactionDraft) -> Void) {
        var next = draft
        change(&next)
        guard next != draft else { return }
        draft = next
        duplicateDetected = false
    }

    /// The kind control; the revealed errors reset (`resetErrors`).
    public func setKind(_ kind: TransactionKind) {
        edit { $0.kind = kind }
        errorsRevealed = false
        focusRequest = nil
    }

    public func setAmount(_ text: String) {
        edit { $0.amount = text }
    }

    /// Upper-cased, at most 10 characters.
    public func setCurrency(_ text: String) {
        edit { $0.currency = String(text.uppercased().prefix(Self.currencyMaxLength)) }
    }

    public func setMemo(_ text: String) {
        edit { $0.memo = String(text.prefix(Self.memoMaxLength)) }
    }

    public func setComment(_ text: String) {
        edit { $0.comment = String(text.prefix(Self.commentMaxLength)) }
    }

    /// A payee pick: it clears a category the previous payee filled, then the new payee's
    /// usual category fills an empty (or auto-filled) category.
    public func selectRecipient(_ id: Int?) async {
        let wasAuto = categoryAuto
        edit { draft in
            draft.recipientId = id
            if wasAuto { draft.categoryId = nil }
        }
        if wasAuto {
            categoryAuto = false
            usualCategorySource = nil
        }
        guard let id else { return }
        await pickers.resolveRecipient(id)
        guard draft.recipientId == id, let recipient = pickers.knownRecipient(id) else { return }
        if draft.categoryId != nil && !categoryAuto { return }
        let usual = recipient.defaultCategoryId
        edit { $0.categoryId = usual }
        categoryAuto = usual != nil
        usualCategorySource = usual == nil ? nil : recipient
    }

    /// A category pick stops the auto-fill.
    public func selectCategory(_ id: Int?) {
        categoryAuto = false
        usualCategorySource = nil
        edit { $0.categoryId = id }
    }

    /// The (From) account: its name and id, and its currency.
    public func pickAccount(name: String, id: Int) {
        let currency = account(named: name)?.currency
        edit { draft in
            draft.accountName = name
            draft.accountId = id
            if let currency { draft.currency = currency }
        }
    }

    /// The To account of a transfer.
    public func pickToAccount(name: String, id: Int) {
        edit { draft in
            draft.toAccountName = name
            draft.toAccountId = id
        }
    }

    /// The Date control: Today and Yesterday set the date; Other date… shows the picker.
    public func setDateChoice(_ choice: AddTransactionDateChoice) {
        switch choice {
        case .other:
            customDate = true
        case .today:
            customDate = false
            let day = today().ymd
            edit { $0.date = day }
        case .yesterday:
            customDate = false
            let day = today().adding(days: -1, calendar: calendar).ymd
            edit { $0.date = day }
        }
    }

    /// The date picker; `nil` clears the date.
    public func setCustomDay(_ day: PlannedDay?) {
        edit { $0.date = day?.ymd ?? "" }
    }

    /// The segment the Date control shows.
    public var dateChoice: AddTransactionDateChoice {
        guard !customDate else { return .other }
        if draft.date == today().ymd { return .today }
        if draft.date == today().adding(days: -1, calendar: calendar).ymd { return .yesterday }
        return .other
    }

    /// The day the picker shows.
    public var day: PlannedDay? { PlannedDay(ymd: draft.date, calendar: calendar) }

    /// The view moved focus.
    public func focusHandled() {
        focusRequest = nil
    }

    // MARK: Derived

    /// `findAccount`: the active account with this name (trimmed, any case).
    private func account(named name: String) -> OpenAPI.Account? {
        let wanted = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !wanted.isEmpty else { return nil }
        return pickers.accounts.first { $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == wanted }
    }

    /// The chosen account's statement anchor, when the date is on or before it
    /// (`addTxn.backdatedBeforeAnchor`).
    public var backdatedAnchorDate: String? {
        guard let anchor = account(named: draft.accountName)?.anchorDate, !anchor.isEmpty, !draft.date.isEmpty,
            draft.date <= anchor
        else { return nil }
        return anchor
    }

    /// The form differs from a fresh one of the same kind (`useUnsavedChanges`).
    public var isDirty: Bool {
        draft != AddTransactionDraft(defaultCurrency: defaultCurrency, kind: draft.kind, today: today())
    }

    /// The parsed magnitude, when the amount reads as a non-zero number.
    public func magnitude(format: NumberFormat) -> Decimal? {
        guard !draft.amount.isEmpty, let value = LocaleNumber.parse(draft.amount, format: format), value != 0 else {
            return nil
        }
        return value < 0 ? -value : value
    }

    /// `createAddTransactionSchema`: each field's message key. The transfer's same-account
    /// check runs once every other field passes, as Zod skips refinements while the base
    /// shape has issues.
    public func errors(format: NumberFormat) -> [AddTransactionField: String] {
        var errors: [AddTransactionField: String] = [:]
        if draft.amount.isEmpty {
            errors[.amount] = "validation.required"
        } else if let value = LocaleNumber.parse(draft.amount, format: format) {
            if value == 0 { errors[.amount] = "addTxn.zeroAmount" }
        } else {
            errors[.amount] = "addTxn.invalidAmount"
        }
        if draft.kind != .transfer && draft.recipientId == nil {
            errors[.recipient] = "validation.required"
        }
        if (draft.accountId ?? 0) <= 0 {
            errors[.account] = "portfolio.move.selectAccount"
        }
        if draft.kind == .transfer && (draft.toAccountId ?? 0) <= 0 {
            errors[.toAccount] = "portfolio.move.selectAccount"
        }
        if draft.date.isEmpty {
            errors[.date] = "validation.required"
        }
        if errors.isEmpty, draft.kind == .transfer, draft.toAccountId == draft.accountId {
            errors[.toAccount] = "addTxn.transferSameAccount"
        }
        return errors
    }

    /// The errors the fields show: none until a submit was blocked.
    public func visibleErrors(format: NumberFormat) -> [AddTransactionField: String] {
        errorsRevealed ? errors(format: format) : [:]
    }

    /// The footer hint: what is still missing, else `addTxn.hint.ready`.
    public var hintKey: String {
        if draft.amount.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "addTxn.hint.amount" }
        if draft.kind != .transfer && draft.recipientId == nil {
            return draft.kind == .income ? "addTxn.hint.recipientIncome" : "addTxn.hint.recipient"
        }
        if draft.accountId == nil { return "addTxn.hint.account" }
        if draft.kind == .transfer && draft.toAccountId == nil { return "addTxn.hint.toAccount" }
        return "addTxn.hint.ready"
    }

    /// The payee label: `addTxn.recipientIncome` ("From") for income, else
    /// `form.addTransaction.recipient`.
    public var recipientLabelKey: String {
        draft.kind == .income ? "addTxn.recipientIncome" : "form.addTransaction.recipient"
    }

    // MARK: Submit

    /// `checkValid`: `false` reveals the errors and asks for focus on the first one.
    func checkValid(format: NumberFormat) -> Bool {
        let errors = errors(format: format)
        guard !errors.isEmpty else { return true }
        errorsRevealed = true
        focusRequest = AddTransactionField.allCases.first { errors[$0] != nil }
        return false
    }

    /// The create body of an expense or income (`transactionFromForm`).
    func transactionBody(format: NumberFormat, allowDuplicate: Bool) -> OpenAPI.TransactionCreate? {
        guard let magnitude = magnitude(format: format), let accountId = draft.accountId,
            let recipientId = draft.recipientId
        else { return nil }
        return OpenAPI.TransactionCreate(
            transactionDate: draft.date, accountId: accountId, recipientId: recipientId,
            memo: Self.trimmedOrNil(draft.memo), amount: draft.kind.signed(magnitude), currency: currencyOrDefault,
            categoryId: draft.categoryId, comment: Self.trimmedOrNil(draft.comment),
            allowDuplicate: allowDuplicate ? true : nil)
    }

    /// `form.currency || defaultCurrency`.
    var currencyOrDefault: String {
        draft.currency.isEmpty ? defaultCurrency : draft.currency
    }

    /// The 409 answer: the duplicate prompt shows.
    func markDuplicate() {
        duplicateDetected = true
    }

    static func trimmedOrNil(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
