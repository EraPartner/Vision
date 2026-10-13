import Foundation
import Observation

/// Money rounding of `@vision/shared-utils/money`.
public enum MoneyMath {
    /// `roundMoney(value, places)`: half to even, like Decimal.js `ROUND_HALF_EVEN`.
    public static func round(_ value: Decimal, places: Int = 2) -> Decimal {
        rounded(value, places: places, mode: .bankers)
    }

    static func rounded(_ value: Decimal, places: Int, mode: NSDecimalNumber.RoundingMode) -> Decimal {
        var input = value
        var result = Decimal()
        NSDecimalRound(&result, &input, places, mode)
        return result
    }

    /// `allocateEvenly(total, parts)`: `parts` cent-exact shares that add up to `total`; the
    /// remaining cents go to the first shares. `allocateEvenly(10, 3)` is `[3.34, 3.33, 3.33]`.
    public static func allocateEvenly(_ total: Decimal, parts: Int) -> [Decimal] {
        guard parts > 0 else { return [] }
        let cents = rounded(total * 100, places: 0, mode: .plain)
        let whole = NSDecimalNumber(decimal: cents).intValue
        let base = whole / parts
        let remainder = whole - base * parts
        return (0..<parts).map { index in
            round(Decimal(base + (index < remainder ? 1 : 0)) / 100)
        }
    }
}

/// The Split transaction dialog's split type.
public enum SplitType: String, CaseIterable, Sendable {
    /// Everyone, you included, pays the same share.
    case equal
    /// Others pay all (0/100): the others cover the whole amount between them.
    case full
    /// Each person's amount is typed.
    case custom

    /// `splitDialog.equalSplit` / `splitDialog.othersPayAll` / `splitDialog.customAmounts`.
    public var labelKey: String {
        switch self {
        case .equal: return "splitDialog.equalSplit"
        case .full: return "splitDialog.othersPayAll"
        case .custom: return "splitDialog.customAmounts"
        }
    }
}

/// One person card of the dialog.
public struct SplitEntry: Equatable, Sendable, Identifiable {
    public let id: Int
    public var recipientId: Int?
    /// The amount owed as typed (custom only).
    public var amount = ""
    public var note = ""

    public init(id: Int) {
        self.id = id
    }
}

/// The state of the Split transaction dialog (`SplitTransactionDialog`): the split type, the
/// person cards, the transaction's existing splits and the shares the Split button sends.
/// Money math is Decimal and rounds to cents, so the over-allocation gate compares exact
/// cent values.
@MainActor
@Observable
public final class SplitDialogModel {
    public let row: TransactionRow
    public private(set) var splitType: SplitType = .equal
    public private(set) var entries: [SplitEntry]
    /// `useSplitsByTransaction`.
    public private(set) var existing: [OpenAPI.Split] = []
    public private(set) var isLoadingExisting = true
    public internal(set) var isPending = false

    @ObservationIgnored private var nextEntryId = 2
    @ObservationIgnored private let service: any SplitsService
    @ObservationIgnored private var loading: Task<Void, Never>?

    public init(row: TransactionRow, service: any SplitsService) {
        self.row = row
        self.service = service
        entries = [SplitEntry(id: 1)]
    }

    /// The transaction's existing splits, once; a second caller awaits the first.
    public func load() async {
        if let loading {
            await loading.value
            return
        }
        guard isLoadingExisting else { return }
        let service = service
        let id = row.id
        let task = Task { [weak self] in
            let found = (try? await service.splits(transactionId: id)) ?? []
            self?.existing = found
            self?.isLoadingExisting = false
        }
        loading = task
        await task.value
    }

    // MARK: Editing

    public func setSplitType(_ type: SplitType) {
        splitType = type
    }

    public func setRecipient(_ entryId: Int, to recipientId: Int?) {
        guard let index = entries.firstIndex(where: { $0.id == entryId }) else { return }
        entries[index].recipientId = recipientId
    }

    public func setAmount(_ entryId: Int, to text: String) {
        guard let index = entries.firstIndex(where: { $0.id == entryId }) else { return }
        entries[index].amount = text
    }

    public func setNote(_ entryId: Int, to text: String) {
        guard let index = entries.firstIndex(where: { $0.id == entryId }) else { return }
        entries[index].note = text
    }

    /// Add person.
    public func addEntry() {
        entries.append(SplitEntry(id: nextEntryId))
        nextEntryId += 1
    }

    /// Remove entry, shown with two or more cards.
    public func removeEntry(_ entryId: Int) {
        guard entries.count > 1 else { return }
        entries.removeAll { $0.id == entryId }
    }

    /// After a split: one empty card again.
    func resetEntries() {
        entries = [SplitEntry(id: nextEntryId)]
        nextEntryId += 1
    }

    // MARK: Shares

    /// `Math.abs(transactionAmount)`.
    public var absoluteAmount: Decimal { row.amount < 0 ? -row.amount : row.amount }

    /// The transaction's currency for the amounts.
    public var currency: String { row.displayCurrency }

    /// The cards with a person chosen.
    public var validEntries: [SplitEntry] { entries.filter { $0.recipientId != nil } }

    /// Everyone you included.
    public var totalPeople: Int { validEntries.count + 1 }

    /// The equal share: the amount over everyone, rounded to cents.
    public var equalShare: Decimal {
        totalPeople > 1 ? MoneyMath.round(absoluteAmount / Decimal(totalPeople)) : 0
    }

    /// Others pay all: one cent-exact share per chosen person.
    public var fullShares: [Decimal] {
        splitType == .full ? MoneyMath.allocateEvenly(absoluteAmount, parts: validEntries.count) : []
    }

    /// The share Others pay all gives a card, while it has a person.
    public func fullShare(for entryId: Int) -> Decimal? {
        guard splitType == .full, let index = validEntries.firstIndex(where: { $0.id == entryId }) else { return nil }
        let shares = fullShares
        return index < shares.count ? shares[index] : 0
    }

    /// The typed amounts of the chosen people.
    public func customTotal(format: NumberFormat) -> Decimal {
        MoneyMath.round(validEntries.reduce(Decimal(0)) { $0 + LocaleNumber.parseOrZero($1.amount, format: format) })
    }

    public var existingTotal: Decimal {
        MoneyMath.round(existing.reduce(Decimal(0)) { $0 + $1.amount })
    }

    /// `splitDialog.existingRecipients`' names.
    public var existingRecipientNames: String {
        existing.compactMap { split in split.recipientName.flatMap { $0.isEmpty ? nil : $0 } }.joined(separator: ", ")
    }

    /// What the new splits add.
    public func newSplitTotal(format: NumberFormat) -> Decimal {
        switch splitType {
        case .equal: return MoneyMath.round(equalShare * Decimal(validEntries.count))
        case .full: return MoneyMath.round(fullShares.reduce(Decimal(0), +))
        case .custom: return customTotal(format: format)
        }
    }

    /// A share of zero or less blocks the Split button.
    public func hasNonPositiveShare(format: NumberFormat) -> Bool {
        switch splitType {
        case .equal: return !validEntries.isEmpty && equalShare <= 0
        case .full: return fullShares.contains { $0 <= 0 }
        case .custom: return validEntries.contains { LocaleNumber.parseOrZero($0.amount, format: format) <= 0 }
        }
    }

    /// How much more may still be split (`splitDialog.exceedsTotal`).
    public var remainingCapacity: Decimal {
        max(MoneyMath.round(absoluteAmount - existingTotal), 0)
    }

    /// The existing and new splits add up to more than the transaction.
    public func exceedsTotal(format: NumberFormat) -> Bool {
        MoneyMath.round(existingTotal + newSplitTotal(format: format)) > MoneyMath.round(absoluteAmount)
    }

    /// The Split button's state.
    public func canSubmit(format: NumberFormat) -> Bool {
        !validEntries.isEmpty && !hasNonPositiveShare(format: format) && !exceedsTotal(format: format) && !isPending
    }

    /// The batch the Split button sends: one share per chosen person; `nil` while there is
    /// nothing to send.
    public func shares(format: NumberFormat) -> [SplitShare]? {
        let valid = validEntries
        let full = fullShares
        var shares: [SplitShare] = []
        for (index, entry) in valid.enumerated() {
            guard let recipientId = entry.recipientId else { continue }
            let amount: Decimal
            switch splitType {
            case .equal:
                amount = equalShare
            case .full:
                guard index < full.count else { return nil }
                amount = full[index]
            case .custom:
                amount = LocaleNumber.parseOrZero(entry.amount, format: format)
            }
            shares.append(SplitShare(recipientId: recipientId, amount: amount, note: entry.note.isEmpty ? nil : entry.note))
        }
        return shares.isEmpty ? nil : shares
    }
}
