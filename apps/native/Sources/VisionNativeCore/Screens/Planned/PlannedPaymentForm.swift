import Foundation
import Observation

/// The Direction control: it owns the sign of the stored amount (money out is negative).
public enum PlannedDirection: String, CaseIterable, Sendable {
    case expense
    case income

    public var labelKey: String { "plannedForm.direction.\(rawValue)" }
}

/// The validated fields of the planned-payment sheet in `FIELD_ORDER`: a blocked submit
/// focuses the first invalid one.
public enum PlannedFormField: String, CaseIterable, Sendable {
    case name = "pp-name"
    case amount = "pp-amount"
    case dueDate = "pp-due-date"
    case bank = "pp-bank"
    case loanPrincipal = "pp-loan-principal"
    case loanRate = "pp-loan-rate"
    case loanTerm = "pp-loan-term"
    case customDays = "pp-custom-days"
}

/// What a valid submit sends: the create body for a new payment, the patch for an edit.
public struct PlannedFormSubmission: Equatable, Sendable {
    /// The trimmed name, for the success toast.
    public let name: String
    public let create: OpenAPI.PlannedTransactionCreate
    public let patch: PlannedPaymentPatch
}

/// `PlannedPaymentForm`: the New payment / Edit payment sheet's fields, validation, footer
/// hint, dirty state and the payload `handleSubmit` builds (then `mapToCreateAPI` or
/// `mapToUpdateAPI`).
@MainActor
@Observable
public final class PlannedPaymentFormModel: Identifiable {
    /// The Currency select's options.
    public static let currencies = ["EUR", "USD", "GBP", "CHF", "CZK", "PLN"]
    /// The Frequency select's options in order.
    public static let frequencies: [PlannedFrequency] = [.daily, .weekly, .biweekly, .monthly, .quarterly, .yearly, .custom]
    /// The Loan type select's options in order.
    public static let loanTypes: [OpenAPI.PlannedLoanType] = [.amortizing, .fixedPrincipal, .interestOnly]

    /// Each Add payment opens a fresh form (the web remounts it); an edit is keyed by its row.
    /// A stored `let` of a Sendable type satisfies the nonisolated `Identifiable.id` requirement.
    public let id: Int
    /// The row being edited, or `nil` for a new payment.
    public let initial: PlannedPayment?
    public let numberFormat: NumberFormat

    public var name: String
    /// The unsigned magnitude as typed.
    public var amount: String
    public var direction: PlannedDirection
    public var currency: String
    public var dueDate: PlannedDay?
    public var isRecurring: Bool
    public var frequency: PlannedFrequency
    public var isLoan: Bool
    /// The generated `PlannedTransaction.loanType` is an empty struct (the generator drops the
    /// `allOf` reference of a nullable enum), so an existing loan's stored type cannot be read: the
    /// picker starts at Amortizing and an edit keeps the stored value unless this is changed.
    public var loanType: OpenAPI.PlannedLoanType {
        get { storedLoanType }
        set {
            storedLoanType = newValue
            loanTypeEdited = true
        }
    }
    private var storedLoanType: OpenAPI.PlannedLoanType
    private var loanTypeEdited = false
    public var loanPrincipal: String
    public var loanRate: String
    public var loanTermMonths: String
    public var loanPaymentDay: String
    public var customDays: String
    public var endDate: PlannedDay?
    public var maxOccurrences: String
    public var recipientId: Int?
    public var categoryId: Int?
    /// The account's name as the combobox shows it.
    public var bankAccount: String
    public var accountId: Int?
    public var tags: [String]
    public var notes: String
    public var url: String

    /// A submit was blocked: the field errors show until a successful submit or Cancel.
    public private(set) var errorsRevealed = false
    /// The field a blocked submit moves focus to, and a counter that changes on every block.
    public private(set) var focusField: PlannedFormField?
    public private(set) var focusToken = 0

    private let initialSnapshot: Snapshot

    public init(id: Int, initial: PlannedPayment?, settings: NativeAppSettings, today: PlannedDay, calendar: Calendar) {
        let wire = initial?.wire
        let format = settings.numberFormat
        var due: PlannedDay? = today
        if let initial { due = PlannedDay(ymd: initial.dueDate, calendar: calendar) }
        let storedEnd = wire?.recurrenceEndDate.flatMap { $0.isEmpty ? nil : $0 }
        let start = Snapshot(
            name: initial?.name ?? "",
            amount: initial.map { LocaleNumber.editable(Self.magnitude($0.amount), format: format) } ?? "",
            direction: (initial?.amount ?? 0) > 0 ? .income : .expense,
            currency: initial?.currency ?? settings.defaultCurrency,
            // `initialFingerprint`: the stored string, or today for a new payment.
            dueDate: initial?.dueDate ?? today.ymd,
            isRecurring: initial?.isRecurring ?? false, frequency: initial?.frequency ?? .monthly,
            isLoan: initial?.isLoan ?? false, loanType: .amortizing,
            loanPrincipal: LocaleNumber.editable(wire?.loanPrincipal, format: format),
            loanRate: LocaleNumber.editable(wire?.loanAnnualInterestRate, format: format),
            loanTermMonths: wire?.loanTermMonths.map { String($0) } ?? "",
            loanPaymentDay: wire?.loanPaymentDay.map { String($0) } ?? "",
            customDays: initial?.customIntervalDays.map { String($0) } ?? "",
            endDate: storedEnd, maxOccurrences: wire?.maxOccurrences.map { String($0) } ?? "",
            recipientId: wire?.recipientId, categoryId: wire?.categoryId, bankAccount: wire?.bankAccount ?? "",
            tags: wire?.tags?.map { $0.slug } ?? [], notes: wire?.comment ?? "", url: wire?.url ?? "")
        self.id = id
        self.initial = initial
        numberFormat = format
        initialSnapshot = start
        name = start.name
        amount = start.amount
        direction = start.direction
        currency = start.currency
        dueDate = due
        isRecurring = start.isRecurring
        frequency = start.frequency
        isLoan = start.isLoan
        storedLoanType = start.loanType
        loanPrincipal = start.loanPrincipal
        loanRate = start.loanRate
        loanTermMonths = start.loanTermMonths
        loanPaymentDay = start.loanPaymentDay
        customDays = start.customDays
        endDate = storedEnd.flatMap { PlannedDay(ymd: $0, calendar: calendar) }
        maxOccurrences = start.maxOccurrences
        recipientId = start.recipientId
        categoryId = start.categoryId
        bankAccount = start.bankAccount
        accountId = wire?.accountId
        tags = start.tags
        notes = start.notes
        url = start.url
    }

    private static func magnitude(_ value: Decimal) -> Decimal { value < 0 ? -value : value }

    /// `isEditing`: Edit payment rather than New payment.
    public var isEditing: Bool { initial != nil }

    public var titleKey: String { isEditing ? "plannedForm.editTitle" : "plannedForm.newTitle" }
    public var submitKey: String { isEditing ? "plannedForm.saveChanges" : "plannedForm.createPayment" }

    // MARK: Dirty state

    /// `formFingerprint`: every field as the web serialises it.
    struct Snapshot: Equatable {
        var name: String
        var amount: String
        var direction: PlannedDirection
        var currency: String
        var dueDate: String?
        var isRecurring: Bool
        var frequency: PlannedFrequency
        var isLoan: Bool
        var loanType: OpenAPI.PlannedLoanType
        var loanPrincipal: String
        var loanRate: String
        var loanTermMonths: String
        var loanPaymentDay: String
        var customDays: String
        var endDate: String?
        var maxOccurrences: String
        var recipientId: Int?
        var categoryId: Int?
        var bankAccount: String
        var tags: [String]
        var notes: String
        var url: String
    }

    private var snapshot: Snapshot {
        Snapshot(
            name: name, amount: amount, direction: direction, currency: currency, dueDate: dueDate?.ymd,
            isRecurring: isRecurring, frequency: frequency, isLoan: isLoan, loanType: loanType,
            loanPrincipal: loanPrincipal, loanRate: loanRate, loanTermMonths: loanTermMonths,
            loanPaymentDay: loanPaymentDay, customDays: customDays, endDate: endDate?.ymd,
            maxOccurrences: maxOccurrences, recipientId: recipientId, categoryId: categoryId,
            bankAccount: bankAccount, tags: tags, notes: notes, url: url)
    }

    /// The edits differ from the values the sheet opened with: navigation away asks first.
    public var isDirty: Bool { snapshot != initialSnapshot }

    // MARK: Fields that follow the Loan switch

    /// A loan is always money out: the Direction control shows Expense and is disabled.
    public var effectiveDirection: PlannedDirection { isLoan ? .expense : direction }

    /// The Recurring switch is on and disabled for a loan.
    public var effectiveRecurring: Bool { isLoan ? true : isRecurring }

    /// Frequency, End date and Max occurrences show for a recurring non-loan payment.
    public var showsRecurrenceFields: Bool { !isLoan && isRecurring }

    /// Repeat every N days shows for the Custom interval.
    public var showsCustomDays: Bool { showsRecurrenceFields && frequency == .custom }

    public var directionHelpKey: String { isLoan ? "plannedForm.directionLoanDesc" : "plannedForm.directionDesc" }

    /// The Payment day placeholder: the due date's day.
    public var loanPaymentDayPlaceholder: String { dueDate.map { String($0.day) } ?? "1" }

    /// The Amount placeholder in the app number format.
    public var amountPlaceholder: String { LocaleNumber.placeholder(format: numberFormat) }

    // MARK: Validation

    /// The message key a field fails with now (`fieldErrors`), shown or not.
    public func errorKey(_ field: PlannedFormField) -> String? {
        switch field {
        case .name:
            return name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "plannedForm.nameRequired" : nil
        case .amount:
            return !isLoan && amount.isEmpty ? "plannedForm.amountRequired" : nil
        case .dueDate:
            return dueDate == nil ? "validation.required" : nil
        case .bank:
            return accountId == nil ? "portfolio.move.selectAccount" : nil
        case .loanPrincipal:
            return isLoan && loanPrincipal.isEmpty ? "validation.required" : nil
        case .loanRate:
            return isLoan && loanRate.isEmpty ? "validation.required" : nil
        case .loanTerm:
            guard isLoan else { return nil }
            if loanTermMonths.isEmpty { return "validation.required" }
            guard let term = JSInteger.parse(loanTermMonths), (1...600).contains(term) else {
                return "plannedForm.loanTermInvalid"
            }
            return nil
        case .customDays:
            guard !isLoan, isRecurring, frequency == .custom else { return nil }
            guard let days = JSInteger.parse(customDays), days >= 1 else { return "plannedForm.customDaysInvalid" }
            return nil
        }
    }

    /// The message a field shows: only after a blocked submit, and only while still wrong.
    public func visibleErrorKey(_ field: PlannedFormField) -> String? {
        errorsRevealed ? errorKey(field) : nil
    }

    /// The footer hint: the first missing required field, else how to submit.
    public var hintKey: String {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "plannedForm.hint.name" }
        if !isLoan && amount.isEmpty { return "plannedForm.hint.amount" }
        if accountId == nil { return "plannedForm.hint.bank" }
        return isEditing ? "plannedForm.hint.readyEdit" : "plannedForm.hint.readyAdd"
    }

    /// Cancel, or a successful submit, hides the errors again.
    public func resetErrors() {
        errorsRevealed = false
    }

    /// `checkValid()` then the payload: `nil` when a field blocks the submit, which reveals
    /// the errors and focuses the first invalid field.
    public func submit() -> PlannedFormSubmission? {
        if let first = PlannedFormField.allCases.first(where: { errorKey($0) != nil }) {
            errorsRevealed = true
            focusField = first
            focusToken += 1
            return nil
        }
        guard let dueDate, let accountId else { return nil }
        return payload(dueDate: dueDate, accountId: accountId)
    }

    // MARK: Payload

    private func payload(dueDate: PlannedDay, accountId: Int) -> PlannedFormSubmission {
        let due = dueDate.ymd
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let magnitude = Self.magnitude(LocaleNumber.parseOrZero(amount, format: numberFormat))
        let signed = magnitude.isZero || effectiveDirection == .income ? magnitude : -magnitude
        let trimmedURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let link = trimmedURL.isEmpty ? nil : trimmedURL
        let recipient = recipientId.flatMap { $0 == 0 ? nil : $0 }
        let tagList = tags.isEmpty ? nil : tags
        let comment = notes.isEmpty ? nil : notes
        let recurring = isLoan ? true : isRecurring

        // Loans: the server derives the schedule; recurrence fields are not sent.
        var loanType: OpenAPI.PlannedLoanType?
        var principal: Decimal?
        var rate: Decimal?
        var term: Int?
        var startDate: String?
        var paymentDay: Int?
        if isLoan {
            loanType = self.loanType
            principal = LocaleNumber.parseOrZero(loanPrincipal, format: numberFormat)
            rate = LocaleNumber.parseOrZero(loanRate, format: numberFormat)
            term = JSInteger.parse(loanTermMonths)
            startDate = due
            paymentDay = loanPaymentDay.isEmpty ? dueDate.day : JSInteger.parse(loanPaymentDay)
        }

        var pattern: String?
        var endDate: String??
        var maximum: Int??
        if !isLoan && isRecurring {
            let days = frequency == .custom && !customDays.isEmpty ? JSInteger.parse(customDays) : nil
            if frequency == .custom, let days, days != 0 {
                pattern = "every \(days) days"
            } else {
                pattern = frequency.rawValue
            }
            // Sent as `null` when cleared, so an edit drops an old bound.
            endDate = .some(self.endDate?.ymd)
            maximum = .some(maxOccurrences.isEmpty ? nil : JSInteger.parse(maxOccurrences))
        }

        let create = OpenAPI.PlannedTransactionCreate(
            plannedDate: due, accountId: accountId, recipientId: recipient, memo: trimmedName, amount: signed,
            currency: currency, categoryId: categoryId, comment: comment, url: link, isRecurring: recurring,
            recurrencePattern: pattern, recurrenceEndDate: endDate ?? nil, maxOccurrences: maximum ?? nil,
            isLoan: isLoan, loanType: loanType, loanPrincipal: principal, loanAnnualInterestRate: rate,
            loanTermMonths: term, loanStartDate: startDate, loanPaymentDay: paymentDay, tags: tagList)

        var patch = PlannedPaymentPatch()
        patch.plannedDate = due
        patch.accountId = accountId
        patch.recipientId = recipient
        patch.memo = trimmedName
        patch.amount = signed
        patch.currency = currency
        patch.categoryId = categoryId
        patch.comment = comment
        patch.url = link
        patch.isRecurring = recurring
        patch.recurrencePattern = pattern
        patch.recurrenceEndDate = endDate
        patch.maxOccurrences = maximum
        patch.isActive = initial?.isActive ?? true
        patch.isLoan = isLoan
        // Saving an existing loan without touching the picker must not overwrite its stored type.
        patch.loanType = initial?.isLoan == true && !loanTypeEdited ? nil : loanType
        patch.loanPrincipal = principal
        patch.loanAnnualInterestRate = rate
        patch.loanTermMonths = term
        patch.loanStartDate = startDate
        patch.loanPaymentDay = paymentDay
        patch.tags = tagList
        return PlannedFormSubmission(name: trimmedName, create: create, patch: patch)
    }

    // MARK: Pickers

    /// The Due date picker cleared or set.
    public func setDueDate(_ day: PlannedDay?) { dueDate = day }

    /// The account combobox picked an existing account.
    public func pickAccount(name: String, id: Int) {
        bankAccount = name
        accountId = id
    }
}
