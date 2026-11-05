import Foundation
import Observation

// MARK: - Merge payees

/// The Merge payees dialog (`MergeRecipientsDialog`): every payee (loaded in pages of 1000,
/// by name), the payee to keep (not an alias itself) and the payees to merge into it. The
/// selection survives Escape and a click outside; only Cancel and a successful merge reset
/// it, and while it exists, leaving the page asks first.
@MainActor
@Observable
public final class PayeeMergeState {
    public var isOpen = false
    /// Every payee by name; `nil` until loaded.
    public private(set) var payees: [OpenAPI.Recipient]?
    /// `merge.loadFailed` with Retry.
    public private(set) var loadFailed = false
    public private(set) var isLoadingList = false
    public private(set) var primaryId: RecipientID?
    public private(set) var aliasIds: [RecipientID] = []
    public var primarySearch = ""
    public var aliasSearch = ""
    public private(set) var isMerging = false

    @ObservationIgnored weak var owner: RecipientsModel?
    @ObservationIgnored let service: any RecipientsService
    @ObservationIgnored let now: @Sendable () -> Date
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var inFlight: Task<Void, Never>?

    init(service: any RecipientsService, now: @escaping @Sendable () -> Date) {
        self.service = service
        self.now = now
    }

    /// A primary or an alias is chosen (`useUnsavedChanges`).
    public var hasSelection: Bool { primaryId != nil || !aliasIds.isEmpty }

    /// The skeleton shows while the first list loads.
    public var showsLoading: Bool { payees == nil && !loadFailed }

    /// Step 1's list: payees that are not aliases, matching the search.
    public var primaryOptions: [OpenAPI.Recipient] {
        Self.matching((payees ?? []).filter { $0.primaryRecipientId == nil }, primarySearch)
    }

    /// The chosen payee to keep.
    public var primary: OpenAPI.Recipient? {
        guard let primaryId else { return nil }
        return (payees ?? []).first { $0.id == primaryId && $0.primaryRecipientId == nil }
    }

    /// Step 2's list: every payee but the primary (aliases labelled), matching the search.
    public var aliasOptions: [OpenAPI.Recipient] {
        Self.matching((payees ?? []).filter { $0.id != primaryId }, aliasSearch)
    }

    /// The chips: the chosen aliases that are in the list.
    public var selectedAliases: [OpenAPI.Recipient] {
        let list = payees ?? []
        return aliasIds.compactMap { id in list.first { $0.id == id } }
    }

    /// The list's filter: the name contains the typed text, any case.
    nonisolated static func matching(_ payees: [OpenAPI.Recipient], _ search: String) -> [OpenAPI.Recipient] {
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return payees }
        return payees.filter { $0.name.lowercased().contains(needle) }
    }

    /// Merge is disabled without a primary and an alias, while it runs, and while the list
    /// loads or failed.
    public var canMerge: Bool {
        primaryId != nil && !aliasIds.isEmpty && !isMerging && payees != nil && !loadFailed && !isLoadingList
    }

    /// `merge.merging` while it runs, else `merge.mergeCount` for the alias count.
    public func confirmTitle(_ strings: any Localizing) -> String {
        isMerging ? strings.t("merge.merging") : strings.tc("merge.mergeCount", aliasIds.count)
    }

    public func selectPrimary(_ id: RecipientID) {
        primaryId = id
        aliasIds.removeAll { $0 == id }
    }

    /// The primary's ×: the primary and the aliases go.
    public func clearPrimary() {
        primaryId = nil
        aliasIds = []
    }

    /// A list item adds or removes the alias; a chip's × removes it.
    public func toggleAlias(_ id: RecipientID) {
        guard id != primaryId else { return }
        if let index = aliasIds.firstIndex(of: id) {
            aliasIds.remove(at: index)
        } else {
            aliasIds.append(id)
        }
    }

    /// Cancel: the selection resets and the dialog closes.
    public func cancel() {
        reset()
        isOpen = false
    }

    /// Escape or a click outside: the dialog closes and the selection stays.
    public func dismiss() {
        isOpen = false
    }

    public func reset() {
        primaryId = nil
        aliasIds = []
        primarySearch = ""
        aliasSearch = ""
    }

    func invalidate() {
        fetchedAt = nil
    }

    /// `useAllRecipientsForMerge(open)`: every page of `active=false`, by name; fresh for
    /// two minutes.
    public func loadList(force: Bool = false) async {
        if let inFlight {
            await inFlight.value
            if !force { return }
        }
        if !force, payees != nil, !loadFailed, let fetchedAt,
            now().timeIntervalSince(fetchedAt) < RecipientsModel.mergeListStaleAfter
        {
            return
        }
        let service = service
        isLoadingList = true
        let task = Task { [weak self] in
            do {
                var collected: [OpenAPI.Recipient] = []
                var offset = 0
                var total = 0
                repeat {
                    let page = try await service.payeePage(
                        PayeePageQuery(active: false, sortBy: "name", sortDir: "asc"), offset: offset,
                        limit: RecipientsModel.mergePageSize)
                    collected.append(contentsOf: page.items)
                    total = page.total
                    offset += page.items.count
                    if page.items.isEmpty { break }
                } while offset < total
                self?.payees = collected
                self?.loadFailed = false
                self?.fetchedAt = self?.now()
            } catch is CancellationError {
                return
            } catch {
                self?.loadFailed = true
                self?.fetchedAt = nil
            }
        }
        inFlight = task
        await task.value
        if inFlight == task {
            inFlight = nil
            isLoadingList = false
        }
    }

    /// The load error's Retry.
    public func retryList() async {
        await loadList(force: true)
    }

    /// Merge {count} payees: `POST /api/recipients/:primaryId/merge`.
    public func confirm() async {
        guard canMerge, let primaryId else { return }
        let aliases = aliasIds
        isMerging = true
        let result: PayeeMergeResult
        do {
            result = try await service.mergePayees(primaryId: primaryId, aliasIds: aliases)
        } catch {
            isMerging = false
            owner?.mergeFailed(error)
            return
        }
        isMerging = false
        reset()
        isOpen = false
        invalidate()
        await owner?.merged(result)
    }
}

// MARK: - Match rules

/// The inline add / edit form of Match rules.
public struct MatchRuleForm: Equatable, Sendable {
    /// `DEFAULT_FORM.priority`.
    public static let defaultPriority = 100

    public var pattern = ""
    public var kind: MatchRuleKind = .literalPrefix
    public var caseSensitive = false
    /// The Priority input as typed (min 1, max 999).
    public var priorityText = String(MatchRuleForm.defaultPriority)
    public var notes = ""

    public init() {}

    /// Edit: the rule's values.
    public init(rule: OpenAPI.RecipientPattern) {
        pattern = rule.pattern
        kind = MatchRuleKind(rule.patternKind) ?? .literalPrefix
        caseSensitive = rule.caseSensitive
        priorityText = String(rule.priority)
        notes = rule.notes ?? ""
    }

    /// `parseInt(value) || 100`: the leading whole number; `0` or none is 100.
    public var priority: Int {
        var text = Substring(priorityText.trimmingCharacters(in: .whitespacesAndNewlines))
        var sign = 1
        if let first = text.first, first == "-" || first == "+" {
            sign = first == "-" ? -1 : 1
            text = text.dropFirst()
        }
        let digits = text.prefix { $0.isASCII && $0.isNumber }
        guard let value = Int(digits), value != 0 else { return Self.defaultPriority }
        return sign * value
    }

    /// Save is disabled while the trimmed pattern is empty.
    public var canSave: Bool {
        !pattern.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The web input's `min={1} max={999}`: the browser blocks a submit outside that range.
    public var priorityIsValid: Bool {
        (1...999).contains(priority)
    }

    /// `{ pattern: trimmed, pattern_kind, case_sensitive, priority, notes: notes || null }`.
    public var body: MatchRuleBody? {
        let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, priorityIsValid else { return nil }
        return MatchRuleBody(
            pattern: trimmed, kind: kind, caseSensitive: caseSensitive, priority: priority,
            notes: notes.isEmpty ? nil : notes)
    }
}

/// The Match rules dialog (`RecipientPatternsDialog`) of one payee.
public struct MatchRulesState: Equatable, Sendable {
    /// Identifies this opening of the dialog, so an answer that lands after it was closed and
    /// reopened is dropped.
    let session = UUID()
    public let recipientId: RecipientID
    public let recipientName: String
    /// The rules; `nil` while loading.
    public internal(set) var patterns: [OpenAPI.RecipientPattern]?
    /// The form, while adding or editing.
    public internal(set) var form: MatchRuleForm?
    /// The rule in the form (its row is highlighted).
    public internal(set) var editingId: RecipientPatternID?
    /// `recipientPatterns.previewCount` / `previewZero` after Preview.
    public internal(set) var previewCount: Int?
    public internal(set) var isPreviewing = false
    /// Bumped by every change that makes a preview stale.
    public internal(set) var previewVersion = 0
    public internal(set) var isSaving = false
    public internal(set) var isDeleting = false
    /// The Delete pattern alert, for this rule.
    public internal(set) var pendingDelete: OpenAPI.RecipientPattern?

    public init(recipientId: RecipientID, recipientName: String) {
        self.recipientId = recipientId
        self.recipientName = recipientName
    }

    /// The empty state shows with no rules and no form.
    public var showsEmpty: Bool { patterns?.isEmpty == true && form == nil }

    mutating func startNew() {
        form = MatchRuleForm()
        editingId = nil
        stalePreview()
    }

    mutating func startEdit(_ rule: OpenAPI.RecipientPattern) {
        form = MatchRuleForm(rule: rule)
        editingId = rule.id
        stalePreview()
    }

    mutating func resetForm() {
        form = nil
        editingId = nil
        stalePreview()
    }

    /// The pattern input: the preview clears.
    public mutating func setPattern(_ text: String) {
        form?.pattern = text
        stalePreview()
    }

    /// The kind select: the preview clears.
    public mutating func setKind(_ kind: MatchRuleKind) {
        form?.kind = kind
        stalePreview()
    }

    /// The case-sensitive switch: the preview clears.
    public mutating func setCaseSensitive(_ on: Bool) {
        form?.caseSensitive = on
        stalePreview()
    }

    public mutating func setPriority(_ text: String) {
        form?.priorityText = text
    }

    public mutating func setNotes(_ text: String) {
        form?.notes = text
    }

    private mutating func stalePreview() {
        previewVersion += 1
        previewCount = nil
        isPreviewing = false
    }
}
