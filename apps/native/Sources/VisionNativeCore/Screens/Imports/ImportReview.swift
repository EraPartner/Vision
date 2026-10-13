import Foundation
import Observation

/// The calls of the Review import page (apps/frontend/src/lib/api/imports.ts,
/// `useImportReviewData`), so tests can use a fake.
public protocol ImportReviewService: Sendable {
    /// `getImportPreview(batchId)`.
    func importPreview(batchId: Int) async throws -> ImportPreview
    /// `overrideImportRow(batchId, rowId, recipientId)`; `nil` clears the override.
    func overrideImportRow(batchId: Int, rowId: String, recipientId: Int?) async throws
    /// `overrideImportRowCategory(batchId, rowId, categoryId)`; `nil` clears the override.
    func overrideImportRowCategory(batchId: Int, rowId: String, categoryId: Int?) async throws
    /// `updateRecipient(recipientId, { default_category_id })`.
    func setRecipientDefaultCategory(recipientId: Int, categoryId: Int) async throws
    /// `commitImportBatch(batchId)`.
    func commitImportBatch(batchId: Int) async throws -> ImportCommitResult
    /// `rollbackImportBatch(batchId)`: a parked batch has committed nothing, so this only
    /// clears its staging rows.
    func discardImportBatch(batchId: Int) async throws
    /// `useAccounts({ active: "all" })`: every account, for the new-account badges.
    func allAccounts() async throws -> [OpenAPI.Account]
}

extension APIClient: ImportReviewService {
    public func importPreview(batchId: Int) async throws -> ImportPreview {
        try await send(ImportPreviewRequest(batchId: batchId))
    }

    public func overrideImportRow(batchId: Int, rowId: String, recipientId: Int?) async throws {
        _ = try await send(ImportRowOverrideRequest(batchId: batchId, rowId: rowId, recipientId: recipientId))
    }

    public func overrideImportRowCategory(batchId: Int, rowId: String, categoryId: Int?) async throws {
        _ = try await send(ImportRowCategoryOverrideRequest(batchId: batchId, rowId: rowId, categoryId: categoryId))
    }

    public func setRecipientDefaultCategory(recipientId: Int, categoryId: Int) async throws {
        _ = try await send(
            OpenAPIOperations.UpdateRecipient(id: recipientId, body: OpenAPI.RecipientUpdate(defaultCategoryId: categoryId)))
    }

    public func commitImportBatch(batchId: Int) async throws -> ImportCommitResult {
        try await send(ImportCommitRequest(batchId: batchId))
    }

    public func discardImportBatch(batchId: Int) async throws {
        _ = try await send(OpenAPIOperations.DeleteImportBatch(id: batchId))
    }

    public func allAccounts() async throws -> [OpenAPI.Account] {
        try await send(OpenAPIOperations.GetAccounts(active: "all")).items
    }
}

// MARK: - Wire types

/// One staged row of the preview (`ImportStagingRowSchema`): the BIGSERIAL id and the
/// NUMERIC amount arrive as text.
public struct ImportStagingRow: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let rowIndex: Int
    public let recipientRaw: String?
    /// The amount as the backend writes it (`"-4.50"`).
    public let amount: String?
    public let currency: String?
    /// `YYYY-MM-DD`.
    public let txDate: String?
    public let memo: String?
    /// The account label parsed from the CSV; absent on older servers.
    public let bankAccount: String?
    public let matchSource: String?
    public let matchSimilarity: Double?
    public let matchedPatternId: Int?
    public let userOverrideRecipientId: Int?
    public let overrideCategoryId: Int?

    public init(
        id: String, rowIndex: Int = 0, recipientRaw: String? = nil, amount: String? = nil, currency: String? = nil,
        txDate: String? = nil, memo: String? = nil, bankAccount: String? = nil, matchSource: String? = nil,
        matchSimilarity: Double? = nil, matchedPatternId: Int? = nil, userOverrideRecipientId: Int? = nil,
        overrideCategoryId: Int? = nil
    ) {
        self.id = id
        self.rowIndex = rowIndex
        self.recipientRaw = recipientRaw
        self.amount = amount
        self.currency = currency
        self.txDate = txDate
        self.memo = memo
        self.bankAccount = bankAccount
        self.matchSource = matchSource
        self.matchSimilarity = matchSimilarity
        self.matchedPatternId = matchedPatternId
        self.userOverrideRecipientId = userOverrideRecipientId
        self.overrideCategoryId = overrideCategoryId
    }

    enum CodingKeys: String, CodingKey {
        case id
        case rowIndex = "row_index"
        case recipientRaw = "recipient_raw"
        case amount, currency
        case txDate = "tx_date"
        case memo
        case bankAccount = "bank_account"
        case matchSource = "match_source"
        case matchSimilarity = "match_similarity"
        case matchedPatternId = "matched_pattern_id"
        case userOverrideRecipientId = "user_override_recipient_id"
        case overrideCategoryId = "override_category_id"
    }

    /// `Number(row.amount)`: zero when absent or unreadable.
    public var amountValue: Decimal {
        guard let amount else { return 0 }
        return Decimal(string: amount, locale: Locale(identifier: "en_US_POSIX")) ?? 0
    }

    /// `row.currency ?? "EUR"`.
    public var currencyCode: String { currency ?? "EUR" }

    public var matchKind: ImportMatchKind { ImportMatchKind(source: matchSource) }
}

/// One payee group of the preview.
public struct ImportPreviewGroup: Decodable, Equatable, Sendable {
    public let recipientId: Int?
    public let recipientName: String?
    public let recipientDefaultCategoryId: Int?
    public let recipientDefaultCategoryLabel: String?
    public let overrideCategoryId: Int?
    public let currentCategoryId: Int?
    public let currentCategoryLabel: String?
    public let matchedPatternId: Int?
    public let matchedPatternText: String?
    public let matchedPatternKind: String?
    public let rowCount: Int
    public let rows: [ImportStagingRow]

    public init(
        recipientId: Int? = nil, recipientName: String? = nil, recipientDefaultCategoryId: Int? = nil,
        recipientDefaultCategoryLabel: String? = nil, overrideCategoryId: Int? = nil, currentCategoryId: Int? = nil,
        currentCategoryLabel: String? = nil, matchedPatternId: Int? = nil, matchedPatternText: String? = nil,
        matchedPatternKind: String? = nil, rowCount: Int, rows: [ImportStagingRow]
    ) {
        self.recipientId = recipientId
        self.recipientName = recipientName
        self.recipientDefaultCategoryId = recipientDefaultCategoryId
        self.recipientDefaultCategoryLabel = recipientDefaultCategoryLabel
        self.overrideCategoryId = overrideCategoryId
        self.currentCategoryId = currentCategoryId
        self.currentCategoryLabel = currentCategoryLabel
        self.matchedPatternId = matchedPatternId
        self.matchedPatternText = matchedPatternText
        self.matchedPatternKind = matchedPatternKind
        self.rowCount = rowCount
        self.rows = rows
    }

    enum CodingKeys: String, CodingKey {
        case recipientId = "recipient_id"
        case recipientName = "recipient_name"
        case recipientDefaultCategoryId = "recipient_default_category_id"
        case recipientDefaultCategoryLabel = "recipient_default_category_label"
        case overrideCategoryId = "override_category_id"
        case currentCategoryId = "current_category_id"
        case currentCategoryLabel = "current_category_label"
        case matchedPatternId = "matched_pattern_id"
        case matchedPatternText = "matched_pattern_text"
        case matchedPatternKind = "matched_pattern_kind"
        case rowCount = "row_count"
        case rows
    }

    /// The group's identity on the page (`groupKey`): the recipient id, else the unresolved
    /// name and the first row's memo.
    public var key: String {
        if let recipientId { return String(recipientId) }
        return "__unresolved__:\(recipientName ?? ""):\(rows.first?.memo ?? "")"
    }

    /// `dominantMatchSource`: new, then fuzzy, pattern and exact; else unresolved.
    public var dominantKind: ImportMatchKind {
        for kind in [ImportMatchKind.new, .fuzzy, .pattern, .exact] where rows.contains(where: { $0.matchSource == kind.rawValue }) {
            return kind
        }
        return .unresolved
    }

    /// No recipient yet, or a new payee will be created.
    public var isNew: Bool { recipientId == nil || dominantKind == .new }
}

/// `GET /api/import/batches/:id/preview` (`ImportPreviewSchema`).
public struct ImportPreview: Decodable, Equatable, Sendable {
    public let batchId: Int
    public let groups: [ImportPreviewGroup]
    /// Rows per match kind (`exact`, `fuzzy`, `pattern`, `new`, `unresolved`).
    public let totals: [String: Int]

    public init(batchId: Int, groups: [ImportPreviewGroup], totals: [String: Int]) {
        self.batchId = batchId
        self.groups = groups
        self.totals = totals
    }

    enum CodingKeys: String, CodingKey {
        case batchId = "batch_id"
        case groups, totals
    }

    /// The sum of the groups' row counts (the subtitle, Approve and Discard).
    public var totalRows: Int { groups.reduce(0) { $0 + $1.rowCount } }

    public var rows: [ImportStagingRow] { groups.flatMap(\.rows) }

    /// The staged rows' first and last `tx_date` (the receipt's link span).
    public var dateRange: (from: String, to: String)? {
        let dates = rows.compactMap(\.txDate).filter { !$0.isEmpty }.map { String($0.prefix(10)) }.sorted()
        guard let first = dates.first, let last = dates.last else { return nil }
        return (first, last)
    }
}

/// `POST /api/import/batches/:id/commit` (`ImportCsvResultSchema`): the counts the toasts and
/// the receipt show.
public struct ImportCommitResult: Decodable, Equatable, Sendable {
    public let imported: Int
    public let duplicates: Int
    public let errors: Int
    /// Planned payments marked as paid by the imported rows.
    public let autoLinkedCount: Int?

    public init(imported: Int, duplicates: Int, errors: Int, autoLinkedCount: Int? = nil) {
        self.imported = imported
        self.duplicates = duplicates
        self.errors = errors
        self.autoLinkedCount = autoLinkedCount
    }

    enum CodingKeys: String, CodingKey {
        case imported, duplicates, errors
        case autoLinkedCount = "auto_linked_count"
    }
}

/// The badge kinds (`MATCH_KINDS`), in the legend's order.
public enum ImportMatchKind: String, CaseIterable, Sendable, Identifiable {
    case exact
    case fuzzy
    case pattern
    case new
    case unresolved

    public var id: String { rawValue }

    /// `match_source ?? "unresolved"`.
    public init(source: String?) {
        self = source.flatMap { ImportMatchKind(rawValue: $0) } ?? .unresolved
    }

    public var labelKey: String { "importReview.match.\(rawValue)" }
    public var legendKey: String { "importReview.legend.\(rawValue)" }
}

/// `GET /api/import/batches/{id}/preview`: the generated operation answers untyped JSON.
public struct ImportPreviewRequest: APIOperation {
    public typealias Response = ImportPreview
    public static let operationId = "previewImportBatch"
    public static let method = HTTPMethod.get
    public static let pathTemplate = "/api/import/batches/{id}/preview"

    public let batchId: Int

    public init(batchId: Int) {
        self.batchId = batchId
    }

    public var path: String { "/api/import/batches/\(APIPath.segment(String(batchId)))/preview" }
}

/// `POST /api/import/batches/{id}/commit`, typed.
public struct ImportCommitRequest: APIOperation {
    public typealias Response = ImportCommitResult
    public static let operationId = "commitImportBatch"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/import/batches/{id}/commit"

    public let batchId: Int

    public init(batchId: Int) {
        self.batchId = batchId
    }

    public var path: String { "/api/import/batches/\(APIPath.segment(String(batchId)))/commit" }
}

/// `POST /api/import/batches/{id}/rows/{rowId}/override` with `{ recipient_id }`: the web
/// sends an explicit `null` to clear, which the generated body (absent keys) drops.
public struct ImportRowOverrideRequest: APIOperation {
    public typealias Response = JSONValue
    public static let operationId = "overrideImportRow"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/import/batches/{id}/rows/{rowId}/override"

    public let batchId: Int
    public let rowId: String
    public let recipientId: Int?

    public init(batchId: Int, rowId: String, recipientId: Int?) {
        self.batchId = batchId
        self.rowId = rowId
        self.recipientId = recipientId
    }

    public var path: String {
        "/api/import/batches/\(APIPath.segment(String(batchId)))/rows/\(APIPath.segment(rowId))/override"
    }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(NullableIdBody(key: "recipient_id", value: recipientId))
    }
}

/// `POST /api/import/batches/{id}/rows/{rowId}/category-override` with `{ category_id }`,
/// `null` included.
public struct ImportRowCategoryOverrideRequest: APIOperation {
    public typealias Response = JSONValue
    public static let operationId = "overrideImportRowCategory"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/import/batches/{id}/rows/{rowId}/category-override"

    public let batchId: Int
    public let rowId: String
    public let categoryId: Int?

    public init(batchId: Int, rowId: String, categoryId: Int?) {
        self.batchId = batchId
        self.rowId = rowId
        self.categoryId = categoryId
    }

    public var path: String {
        "/api/import/batches/\(APIPath.segment(String(batchId)))/rows/\(APIPath.segment(rowId))/category-override"
    }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(NullableIdBody(key: "category_id", value: categoryId))
    }
}

/// `{ "<key>": <id or null> }`.
struct NullableIdBody: Encodable {
    let key: String
    let value: Int?

    struct Key: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        if let value {
            try container.encode(value, forKey: Key(stringValue: key))
        } else {
            try container.encodeNil(forKey: Key(stringValue: key))
        }
    }
}

// MARK: - Page state

/// One payee group's local state (`GroupState`): the picked payee and category, the
/// Save as default checkbox and the saves in flight.
public struct ImportReviewGroupState: Equatable, Sendable {
    public var recipientId: Int?
    public var recipientName: String?
    public var categoryId: Int?
    public var categoryLabel: String?
    public var persistAsDefault: Bool
    public var recipientSaving = false
    public var categorySaving = false

    /// `groupStateFor`: the group's own values; the checkbox starts on when the payee has no
    /// default category.
    public init(group: ImportPreviewGroup) {
        recipientId = group.recipientId
        recipientName = group.recipientName
        categoryId = group.currentCategoryId
        categoryLabel = group.currentCategoryLabel
        persistAsDefault = group.recipientDefaultCategoryId == nil
    }

    public var isSaving: Bool { recipientSaving || categorySaving }
}

/// One line of the Accounts card (`AccountDisclosureEntry`).
public struct ImportAccountDisclosure: Equatable, Sendable, Identifiable {
    /// The normalized label; empty for rows without one.
    public let key: String
    /// The label as the CSV first spelled it.
    public let label: String
    public let count: Int
    /// No existing account has this label: the commit creates one.
    public let isNew: Bool

    public var id: String { key.isEmpty ? "__unspecified__" : key }
    public var isUnspecified: Bool { key.isEmpty }

    /// Account identity ignores case and surrounding whitespace (`lower(btrim(name))`).
    public static func normalize(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// The staged rows per account label, most rows first; `isNew` only once the accounts
    /// have loaded.
    public static func entries(rows: [ImportStagingRow], accounts: [OpenAPI.Account]?) -> [ImportAccountDisclosure] {
        var order: [String] = []
        var buckets: [String: (label: String, count: Int)] = [:]
        for row in rows {
            let label = (row.bankAccount ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let key = normalize(label)
            if let bucket = buckets[key] {
                buckets[key] = (bucket.label, bucket.count + 1)
            } else {
                buckets[key] = (label, 1)
                order.append(key)
            }
        }
        let existing = Set((accounts ?? []).map { normalize($0.name) })
        let entries = order.compactMap { key -> ImportAccountDisclosure? in
            guard let bucket = buckets[key] else { return nil }
            return ImportAccountDisclosure(
                key: key, label: bucket.label, count: bucket.count,
                isNew: !key.isEmpty && accounts != nil && !existing.contains(key))
        }
        return entries.sorted { left, right in
            if left.count != right.count { return left.count > right.count }
            return left.label.localizedCompare(right.label) == .orderedAscending
        }
    }
}

/// Where the review page sends the shell.
public enum ImportReviewNavigation: Equatable, Sendable {
    /// Back to import (a push).
    case push(String)
    /// After Commit or Discard (`replace: true`).
    case replace(String)
}

/// `ImportReviewPage`: the preview of a parked batch, per-group payee and category changes
/// (one request per staged row), Discard with its confirm, and Commit, which hands the
/// receipt to `/import`.
@MainActor
@Observable
public final class ImportReviewModel {
    /// The route of the new-accounts toast's action.
    public nonisolated static let accountsRoute = "/accounts"
    /// How long the new-accounts toast stays (10 s).
    public nonisolated static let newAccountsDuration: Duration = .seconds(10)

    public private(set) var batchId: Int?
    public private(set) var preview: ImportPreview?
    /// The preview failed to load; the page shows the error state with Retry.
    public private(set) var error: APIError?
    public private(set) var isFetching = false
    /// `useAccounts({ active: "all" })`; `nil` until loaded.
    public private(set) var accounts: [OpenAPI.Account]?
    /// The groups the user changed, by `ImportPreviewGroup.key`.
    public private(set) var groupStates: [String: ImportReviewGroupState] = [:]
    /// The open accordion items (all start collapsed).
    public private(set) var expandedGroups: Set<String> = []
    public private(set) var isCommitting = false
    public private(set) var isDiscarding = false
    /// The Discard this import? alert is up.
    public private(set) var isDiscardConfirmationPresented = false
    /// A navigation the view performs, then calls `didHandleNavigation()`.
    public private(set) var navigationRequest: ImportReviewNavigation?
    /// The payee and category picker lists.
    public let pickers: PickerDataModel

    /// The commit's receipt for `/import` (`importCommitReceipt`).
    @ObservationIgnored public var onCommitted: @MainActor (ImportCommitReceipt) -> Void = { _ in }
    /// Commit or Discard changed Import history (`invalidateQueries(batchesAll)`).
    @ObservationIgnored public var onHistoryChanged: @MainActor () -> Void = {}

    @ObservationIgnored private let service: any ImportReviewService
    @ObservationIgnored private let toasts: ImportNoticeCenter
    @ObservationIgnored private var loading: (batchId: Int, task: Task<Void, Never>)?

    public init(service: any ImportReviewService, pickers: any PickerDataService, toasts: ImportNoticeCenter) {
        self.service = service
        self.pickers = PickerDataModel(service: pickers)
        self.toasts = toasts
    }

    // MARK: Lifecycle

    /// The page showed for a batch: the preview, the accounts and the picker lists load.
    /// Another batch starts from a clean page.
    public func appear(batchId: Int) async {
        if self.batchId != batchId {
            self.batchId = batchId
            preview = nil
            error = nil
            accounts = nil
            groupStates = [:]
            expandedGroups = []
        }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.load() }
            group.addTask { await self.loadAccounts() }
            group.addTask { await self.pickers.load() }
        }
    }

    /// The page went away: its local state resets like an unmounted page; the preview stays
    /// cached for the next visit.
    public func disappear() {
        groupStates = [:]
        expandedGroups = []
        isDiscardConfirmationPresented = false
        pickers.reset()
    }

    /// The preview, one request per batch at a time; a second caller awaits the first.
    public func load() async {
        guard let batchId else { return }
        if let loading, loading.batchId == batchId {
            await loading.task.value
            return
        }
        let service = service
        let task = Task {
            self.isFetching = true
            do {
                let next = try await service.importPreview(batchId: batchId)
                if self.batchId == batchId {
                    self.preview = next
                    self.error = nil
                }
            } catch is CancellationError {
            } catch {
                if self.batchId == batchId { self.error = APIError.wrapping(error) }
            }
            self.isFetching = false
        }
        loading = (batchId, task)
        await task.value
        if loading?.batchId == batchId { loading = nil }
    }

    /// Retry on the error state.
    public func retry() async {
        await load()
    }

    private func loadAccounts() async {
        if let list = try? await service.allAccounts() { accounts = list }
    }

    /// The loader shows until the first answer.
    public var isLoading: Bool { preview == nil && error == nil }

    /// The error state (`error || !preview`).
    public var showsError: Bool { error != nil }

    public func didHandleNavigation() {
        navigationRequest = nil
    }

    /// Back to import (header or error state): a push; the batch stays parked.
    public func goBack() {
        navigationRequest = .push(ImportRoutes.path)
    }

    // MARK: Derived

    public var totalRows: Int { preview?.totalRows ?? 0 }

    public var accountDisclosure: [ImportAccountDisclosure] {
        ImportAccountDisclosure.entries(rows: preview?.rows ?? [], accounts: accounts)
    }

    public var newAccountCount: Int { accountDisclosure.filter(\.isNew).count }

    public var isBusy: Bool { isCommitting || isDiscarding }

    public func state(for group: ImportPreviewGroup) -> ImportReviewGroupState {
        groupStates[group.key] ?? ImportReviewGroupState(group: group)
    }

    /// The group's heading: its payee, `importReview.newRecipient` for a new one without a
    /// name, else `importReview.unresolved`.
    public func heading(for group: ImportPreviewGroup, strings: any Localizing) -> String {
        let name = state(for: group).recipientName ?? group.recipientName
        if group.isNew && name == nil { return strings.t("importReview.newRecipient") }
        return name ?? strings.t("importReview.unresolved")
    }

    public func isExpanded(_ group: ImportPreviewGroup) -> Bool {
        expandedGroups.contains(group.key)
    }

    public func setExpanded(_ group: ImportPreviewGroup, _ expanded: Bool) {
        if expanded {
            expandedGroups.insert(group.key)
        } else {
            expandedGroups.remove(group.key)
        }
    }

    private func update(_ group: ImportPreviewGroup, _ change: (inout ImportReviewGroupState) -> Void) {
        var next = state(for: group)
        change(&next)
        groupStates[group.key] = next
    }

    // MARK: Payee

    /// A payee pick (or No payee): one override per staged row, then the preview again. A
    /// failure toasts and drops the group's local state.
    public func setRecipient(_ recipientId: Int?, name: String?, for group: ImportPreviewGroup, strings: any Localizing)
        async
    {
        guard let batchId else { return }
        update(group) { state in
            state.recipientId = recipientId
            state.recipientName = name
            state.recipientSaving = true
        }
        let service = service
        let rowIds = group.rows.map(\.id)
        do {
            try await withThrowingTaskGroup(of: Void.self) { tasks in
                for rowId in rowIds {
                    tasks.addTask { try await service.overrideImportRow(batchId: batchId, rowId: rowId, recipientId: recipientId) }
                }
                try await tasks.waitForAll()
            }
            await load()
            update(group) { $0.recipientSaving = false }
        } catch {
            toasts.post(.error, "importReview.toast.overrideFailed", detail: ImportErrorText.text(error, strings: strings))
            groupStates[group.key] = nil
        }
    }

    // MARK: Category

    /// A category pick (or No category): one override per staged row; with Save as default
    /// on and a payee, a picked category also becomes the payee's default.
    public func setCategory(_ categoryId: Int?, label: String?, for group: ImportPreviewGroup, strings: any Localizing)
        async
    {
        guard let batchId else { return }
        let before = state(for: group)
        update(group) { state in
            state.categoryId = categoryId
            state.categoryLabel = label
            state.categorySaving = true
        }
        let service = service
        let rowIds = group.rows.map(\.id)
        do {
            try await withThrowingTaskGroup(of: Void.self) { tasks in
                for rowId in rowIds {
                    tasks.addTask {
                        try await service.overrideImportRowCategory(batchId: batchId, rowId: rowId, categoryId: categoryId)
                    }
                }
                try await tasks.waitForAll()
            }
            update(group) { $0.categorySaving = false }
            if before.persistAsDefault, let recipientId = before.recipientId, let categoryId {
                do {
                    try await service.setRecipientDefaultCategory(recipientId: recipientId, categoryId: categoryId)
                } catch {
                    toasts.post(
                        .error, "importReview.toast.persistDefaultFailed", detail: ImportErrorText.text(error, strings: strings))
                }
            }
        } catch {
            toasts.post(
                .error, "importReview.toast.categoryOverrideFailed", detail: ImportErrorText.text(error, strings: strings))
            update(group) { $0.categorySaving = false }
        }
    }

    /// Save as the payee's default: only remembered for the next category pick.
    public func setPersistDefault(_ on: Bool, for group: ImportPreviewGroup) {
        update(group) { $0.persistAsDefault = on }
    }

    // MARK: Discard

    public func requestDiscard() {
        guard !isBusy else { return }
        isDiscardConfirmationPresented = true
    }

    /// The alert's Cancel or Escape: the batch stays parked.
    public func cancelDiscard() {
        isDiscardConfirmationPresented = false
    }

    /// Discard import: the staged rows go, Import history refreshes and the page returns to
    /// `/import` (replacing this entry).
    public func confirmDiscard(strings: any Localizing) async {
        guard isDiscardConfirmationPresented, let batchId else { return }
        isDiscardConfirmationPresented = false
        isDiscarding = true
        defer { isDiscarding = false }
        do {
            try await service.discardImportBatch(batchId: batchId)
            toasts.post(.success, "importReview.toast.discarded")
            onHistoryChanged()
            forget(batchId)
            navigationRequest = .replace(ImportRoutes.path)
        } catch {
            toasts.post(.error, "importReview.toast.discardFailed", detail: ImportErrorText.text(error, strings: strings))
        }
    }

    // MARK: Commit

    /// Import {n} rows: the batch commits; the toasts follow (counts, planned payments paid,
    /// new accounts with Review accounts), and `/import` shows the receipt.
    public func commit(strings: any Localizing) async {
        guard let batchId, !isBusy else { return }
        let range = preview?.dateRange
        let newAccounts = newAccountCount
        isCommitting = true
        defer { isCommitting = false }
        do {
            let result = try await service.commitImportBatch(batchId: batchId)
            toasts.post(
                .success, "importReview.toast.success",
                [
                    "imported": String(result.imported), "duplicates": String(result.duplicates),
                    "errors": String(result.errors),
                ])
            if let linked = result.autoLinkedCount, linked > 0 {
                toasts.post(.success, "importReview.toast.autoLinked", ["n": String(linked)])
            }
            if newAccounts > 0 {
                toasts.post(
                    .success, "importReview.toast.newAccounts", ["n": String(newAccounts)],
                    action: ImportNoticeCenter.Action(
                        titleKey: "importReview.toast.reviewAccounts", route: Self.accountsRoute,
                        duration: Self.newAccountsDuration))
            }
            onHistoryChanged()
            if let receipt = ImportCommitReceipt(
                imported: result.imported, duplicates: result.duplicates, errors: result.errors,
                dateFrom: range?.from, dateTo: range?.to)
            {
                onCommitted(receipt)
            }
            forget(batchId)
            navigationRequest = .replace(ImportRoutes.path)
        } catch {
            toasts.post(.error, "importReview.toast.commitFailed", detail: ImportErrorText.text(error, strings: strings))
        }
    }

    /// A committed or discarded batch is not reviewed again.
    private func forget(_ id: Int) {
        guard batchId == id else { return }
        groupStates = [:]
        expandedGroups = []
    }
}
