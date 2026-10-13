import Foundation
import Observation

/// The calls of the export card and the Setup and reference cards (apps/frontend/src/lib/api
/// imports.ts and info.ts, `requestBlob`), so tests can use a fake.
public protocol ImportExportService: Sendable {
    /// `requestBlob("/api/transactions/export/{csv|json}?…filters")`: the file's bytes.
    func exportTransactions(_ format: ExportFormat, filters: ExportFilters) async throws -> Data
    /// `useBankAccounts()` (`GET /api/info/banks`): the account labels the export filters on.
    func bankAccountLabels() async throws -> [String]
    /// `importRecipients(file, separator, encoding)`.
    func importRecipientsCSV(file: ImportFile, separator: String, encoding: String) async throws -> SimpleImportResult
    /// `importCategories(file, separator)`: the encoding is the web's default, UTF-8.
    func importCategoriesCSV(file: ImportFile, separator: String, encoding: String) async throws -> SimpleImportResult
}

extension APIClient: ImportExportService {
    public func exportTransactions(_ format: ExportFormat, filters: ExportFilters) async throws -> Data {
        switch format {
        case .csv:
            return try await download(
                OpenAPIOperations.ExportTransactionsCsv(
                    startDate: filters.startDate?.ymd, endDate: filters.endDate?.ymd,
                    bankAccounts: filters.bankAccountsParameter, categoryIds: filters.categoryIdsParameter))
        case .json:
            return try await download(
                OpenAPIOperations.ExportTransactionsJson(
                    startDate: filters.startDate?.ymd, endDate: filters.endDate?.ymd,
                    bankAccounts: filters.bankAccountsParameter, categoryIds: filters.categoryIdsParameter))
        }
    }

    public func bankAccountLabels() async throws -> [String] {
        try await send(OpenAPIOperations.GetInfoBanks()).items
    }

    public func importRecipientsCSV(file: ImportFile, separator: String, encoding: String) async throws
        -> SimpleImportResult
    {
        try await send(ImportRecipientsRequest(file: file, separator: separator, encoding: encoding))
    }

    public func importCategoriesCSV(file: ImportFile, separator: String, encoding: String) async throws
        -> SimpleImportResult
    {
        try await send(ImportCategoriesRequest(file: file, separator: separator, encoding: encoding))
    }
}

// MARK: - Export

/// The two export buttons.
public enum ExportFormat: String, CaseIterable, Sendable, Identifiable {
    case csv
    case json

    public var id: String { rawValue }

    /// `importPage.exportBtn` / `importPage.exportJsonBtn`.
    public var labelKey: String {
        switch self {
        case .csv: return "importPage.exportBtn"
        case .json: return "importPage.exportJsonBtn"
        }
    }

    /// The download name: `transactions_<today>.csv`, or `.ndjson` for JSON.
    public func fileName(today: PlannedDay) -> String {
        switch self {
        case .csv: return "transactions_\(today.ymd).csv"
        case .json: return "transactions_\(today.ymd).ndjson"
        }
    }
}

/// `ExportFilters` of `ExportCard`; empty fields include every record.
public struct ExportFilters: Equatable, Sendable {
    public var startDate: PlannedDay?
    public var endDate: PlannedDay?
    /// The account labels, in the order they were picked.
    public var bankAccounts: [String] = []
    /// The category ids, ascending (descendants of a picked parent included).
    public var categoryIds: [Int] = []

    public init(
        startDate: PlannedDay? = nil, endDate: PlannedDay? = nil, bankAccounts: [String] = [], categoryIds: [Int] = []
    ) {
        self.startDate = startDate
        self.endDate = endDate
        self.bankAccounts = bankAccounts
        self.categoryIds = categoryIds
    }

    /// `bank_accounts`, comma-joined; `nil` when none is picked.
    public var bankAccountsParameter: String? {
        bankAccounts.isEmpty ? nil : bankAccounts.joined(separator: ",")
    }

    /// `category_ids`, comma-joined; `nil` when none is picked.
    public var categoryIdsParameter: String? {
        categoryIds.isEmpty ? nil : categoryIds.map(String.init).joined(separator: ",")
    }

    /// The query the web builds, in its order (only the set filters).
    public var queryItems: [URLQueryItem] {
        var items: [URLQueryItem] = []
        if let startDate { items.append(URLQueryItem(name: "start_date", value: startDate.ymd)) }
        if let endDate { items.append(URLQueryItem(name: "end_date", value: endDate.ymd)) }
        if let bankAccountsParameter { items.append(URLQueryItem(name: "bank_accounts", value: bankAccountsParameter)) }
        if let categoryIdsParameter { items.append(URLQueryItem(name: "category_ids", value: categoryIdsParameter)) }
        return items
    }
}

/// `MultiCombobox`'s list rules: a click toggles an item, the picked items list first, and
/// the search keeps the items whose text contains it (any case).
public enum MultiSelection {
    /// `toggle(v)`: a picked value goes, another one is added at the end.
    public static func toggle<Value: Equatable>(_ value: Value, in selection: [Value]) -> [Value] {
        if selection.contains(value) { return selection.filter { $0 != value } }
        return selection + [value]
    }

    /// The listed items: the picked ones first, each group in the list's order, then the
    /// search filter.
    public static func ordered<Item, Value: Hashable>(
        _ items: [Item], selection: [Value], value: (Item) -> Value, searchText: (Item) -> String, search: String
    ) -> [Item] {
        let picked = Set(selection)
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let sorted = items.filter { picked.contains(value($0)) } + items.filter { !picked.contains(value($0)) }
        guard !query.isEmpty else { return sorted }
        return sorted.filter { searchText($0).lowercased().contains(query) }
    }

    /// `selectWithDescendants` of `CategoryMultiCombobox`: every node under a picked one is
    /// picked too, and the ids come back ascending.
    public static func withDescendants(_ ids: [Int], nodes: [OpenAPI.CategoryNode]) -> [Int] {
        var expanded = Set(ids)
        for node in nodes where node.pathIds.contains(where: { expanded.contains($0) }) {
            expanded.insert(node.id)
        }
        return expanded.sorted()
    }
}

/// `ExportCard`: the filter panel (dates, bank accounts, categories) and Export CSV / Export
/// JSON. The file is fetched first, then handed to `save`, which the app answers with a
/// Save panel (`downloadBlob`'s name as the suggestion) and writes it.
@MainActor
@Observable
public final class TransactionExportModel {
    public var filters = ExportFilters()
    /// Show filters / Hide filters.
    public private(set) var showsFilters = false
    /// The export running (`exportingFormat`); both buttons wait for it.
    public private(set) var exportingFormat: ExportFormat?
    /// `useBankAccounts()`; empty until loaded.
    public private(set) var bankAccounts: [String] = []
    /// `useCategoryTree()`, every node; the picker lists the active ones.
    public private(set) var categories: [OpenAPI.CategoryNode] = []

    /// Saves the exported bytes under a suggested name: `true` once written, `false` when the
    /// user cancelled. The app target sets it (a Save panel); Core stays testable.
    @ObservationIgnored public var save: @MainActor (Data, String) async throws -> Bool = { _, _ in false }

    @ObservationIgnored private let service: any ImportExportService
    @ObservationIgnored private let pickers: any PickerDataService
    @ObservationIgnored private let toasts: ImportNoticeCenter
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let calendar: Calendar
    @ObservationIgnored private var listsInFlight: Task<Void, Never>?
    @ObservationIgnored private var listsLoaded = false

    public init(
        service: any ImportExportService, pickers: any PickerDataService, toasts: ImportNoticeCenter,
        now: @escaping @Sendable () -> Date = { Date() }, calendar: Calendar = .current
    ) {
        self.service = service
        self.pickers = pickers
        self.toasts = toasts
        self.now = now
        self.calendar = calendar
    }

    public var isExporting: Bool { exportingFormat != nil }

    /// Show filters / Hide filters. The pickers' lists load when the panel first shows, as
    /// the web's comboboxes mount with it.
    public func toggleFilters() async {
        showsFilters.toggle()
        if showsFilters { await loadLists() }
    }

    /// The bank accounts and the category tree, once per visit; a list that fails stays
    /// empty (`data ?? []`).
    public func loadLists() async {
        if listsLoaded { return }
        if let listsInFlight {
            await listsInFlight.value
            return
        }
        let service = service
        let pickers = pickers
        let task = Task {
            async let accounts = service.bankAccountLabels()
            async let tree = pickers.categories()
            self.bankAccounts = (try? await accounts) ?? []
            self.categories = (try? await tree) ?? []
        }
        listsInFlight = task
        await task.value
        listsInFlight = nil
        listsLoaded = true
    }

    /// The active categories the Categories picker lists.
    public var activeCategories: [OpenAPI.CategoryNode] { categories.filter { $0.isActive } }

    /// The Bank accounts face: `combobox.bankAccount.allSelected` or `.nSelected`.
    public func bankAccountsLabel(_ strings: any Localizing) -> String {
        filters.bankAccounts.isEmpty
            ? strings.t("combobox.bankAccount.allSelected")
            : strings.t("combobox.bankAccount.nSelected", ["n": String(filters.bankAccounts.count)])
    }

    /// The Categories face: `combobox.categoryMulti.allSelected` or `.nSelected`.
    public func categoriesLabel(_ strings: any Localizing) -> String {
        filters.categoryIds.isEmpty
            ? strings.t("combobox.categoryMulti.allSelected")
            : strings.t("combobox.categoryMulti.nSelected", ["n": String(filters.categoryIds.count)])
    }

    public func toggleBankAccount(_ label: String) {
        filters.bankAccounts = MultiSelection.toggle(label, in: filters.bankAccounts)
    }

    /// A category click: toggled, then every descendant of a picked category joins.
    public func toggleCategory(_ id: Int) {
        filters.categoryIds = MultiSelection.withDescendants(
            MultiSelection.toggle(id, in: filters.categoryIds), nodes: categories)
    }

    /// Export CSV / Export JSON: the file with the filters, saved under
    /// `transactions_<today>.<csv|ndjson>`. Toasts `importPage.toast.exportSuccess` once
    /// written, or `importPage.toast.exportFailed` with the reason.
    public func export(_ format: ExportFormat, strings: any Localizing) async {
        guard exportingFormat == nil else { return }
        exportingFormat = format
        defer { exportingFormat = nil }
        let name = format.fileName(today: PlannedDay(now(), calendar: calendar))
        do {
            let data = try await service.exportTransactions(format, filters: filters)
            if try await save(data, name) {
                toasts.post(.success, "importPage.toast.exportSuccess")
            }
        } catch is CancellationError {
            return
        } catch {
            toasts.post(.error, "importPage.toast.exportFailed", detail: ImportErrorText.text(error, strings: strings))
        }
    }

    /// The page went away: the card's state resets like an unmounted component.
    public func reset() {
        filters = ExportFilters()
        showsFilters = false
        listsLoaded = false
    }
}

// MARK: - Payees and Categories from CSV

/// `POST /api/import/recipients` and `/categories` (`SimpleImportResultSchema`).
public struct SimpleImportResult: Decodable, Equatable, Sendable {
    public let totalProcessed: Int
    public let imported: Int
    public let skipped: Int
    public let errors: Int

    public init(totalProcessed: Int, imported: Int, skipped: Int, errors: Int) {
        self.totalProcessed = totalProcessed
        self.imported = imported
        self.skipped = skipped
        self.errors = errors
    }

    enum CodingKeys: String, CodingKey {
        case totalProcessed = "total_processed"
        case imported, skipped, errors
    }
}

/// The multipart body of `importRecipients` / `importCategories` (`postMultipartImport`):
/// the file, then `separator` and `encoding`.
enum SimpleImportForm {
    static func make(file: ImportFile, separator: String, encoding: String, boundary: String?) -> MultipartFormData {
        var form = boundary.map { MultipartFormData(boundary: $0) } ?? MultipartFormData()
        form.append(file: "file", filename: file.name, contentType: file.uploadType, data: file.data)
        form.append("separator", separator)
        form.append("encoding", encoding)
        return form
    }
}

/// `POST /api/import/recipients` (operationId `importRecipients`), multipart.
public struct ImportRecipientsRequest: APIOperation {
    public typealias Response = SimpleImportResult
    public static let operationId = "importRecipients"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/import/recipients"

    public let form: MultipartFormData

    public init(file: ImportFile, separator: String, encoding: String, boundary: String? = nil) {
        form = SimpleImportForm.make(file: file, separator: separator, encoding: encoding, boundary: boundary)
    }

    public var path: String { Self.pathTemplate }
    public var contentType: String { form.contentType }

    public func encodedBody() throws -> Data? {
        form.encoded()
    }
}

/// `POST /api/import/categories` (operationId `importCategories`), multipart.
public struct ImportCategoriesRequest: APIOperation {
    public typealias Response = SimpleImportResult
    public static let operationId = "importCategories"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/import/categories"

    public let form: MultipartFormData

    public init(file: ImportFile, separator: String, encoding: String, boundary: String? = nil) {
        form = SimpleImportForm.make(file: file, separator: separator, encoding: encoding, boundary: boundary)
    }

    public var path: String { Self.pathTemplate }
    public var contentType: String { form.contentType }

    public func encodedBody() throws -> Data? {
        form.encoded()
    }
}

/// The two `SimpleImportCard`s of Setup and reference.
public enum SimpleCSVImportKind: String, Sendable, CaseIterable {
    /// Payees from CSV (`RecipientsImportCard`): separator and encoding.
    case recipients
    /// Categories from CSV (`CategoriesImportCard`): separator only.
    case categories

    public var titleKey: String {
        switch self {
        case .recipients: return "importPage.recipientsImport"
        case .categories: return "importPage.categoriesImport"
        }
    }

    public var descriptionKey: String {
        switch self {
        case .recipients: return "importPage.recipientsImportDesc"
        case .categories: return "importPage.categoriesImportDesc"
        }
    }

    public var importKey: String {
        switch self {
        case .recipients: return "importPage.importRecipientsBtn"
        case .categories: return "importPage.importCategoriesBtn"
        }
    }

    public var importingKey: String {
        switch self {
        case .recipients: return "importPage.importingRecipients"
        case .categories: return "importPage.importingCategories"
        }
    }

    public var failedKey: String {
        switch self {
        case .recipients: return "importPage.toast.recipientsImportFailed"
        case .categories: return "importPage.toast.categoriesImportFailed"
        }
    }

    /// `showEncoding`: only the payee import has the Encoding select.
    public var showsEncoding: Bool { self == .recipients }
}

/// `SimpleImportCard`: a separator (and for payees an encoding), a compact dropzone, the
/// result line and the import button.
@MainActor
@Observable
public final class SimpleCSVImportModel {
    public let kind: SimpleCSVImportKind
    public private(set) var file: ImportFile?
    public var separator = ","
    public var encoding = "utf-8"
    public private(set) var isImporting = false
    /// The result line of the last import; a new file clears it.
    public private(set) var result: SimpleImportResult?

    @ObservationIgnored private let service: any ImportExportService
    @ObservationIgnored private let toasts: ImportNoticeCenter

    public init(kind: SimpleCSVImportKind, service: any ImportExportService, toasts: ImportNoticeCenter) {
        self.kind = kind
        self.service = service
        self.toasts = toasts
    }

    /// The compact dropzone's drop or Open panel choice: a file that is not a CSV is refused
    /// with `importPage.toast.noFile`; a new file clears the last result.
    public func chooseFile(_ next: ImportFile) {
        guard next.isCSV else {
            toasts.post(.error, "importPage.toast.noFile")
            return
        }
        file = next
        result = nil
    }

    /// Remove: the file and the last result go.
    public func removeFile() {
        file = nil
        result = nil
    }

    public var canImport: Bool { file != nil && !isImporting }

    /// Import payees / Import categories: the result line and a toast, then the file clears;
    /// a failure toasts the card's failure key with the reason.
    public func startImport(strings: any Localizing) async {
        guard let file else {
            toasts.post(.error, "importPage.toast.noFileSel")
            return
        }
        guard !isImporting else { return }
        isImporting = true
        result = nil
        defer { isImporting = false }
        do {
            let data: SimpleImportResult
            switch kind {
            case .recipients:
                data = try await service.importRecipientsCSV(file: file, separator: separator, encoding: encoding)
            case .categories:
                data = try await service.importCategoriesCSV(file: file, separator: separator, encoding: "utf-8")
            }
            result = data
            switch kind {
            case .recipients:
                toasts.post(
                    .success, "importPage.recipientsResult",
                    ["n": String(data.imported), "e": String(data.skipped), "x": String(data.errors)])
            case .categories:
                toasts.post(
                    .success, "importPage.toast.importSuccess",
                    ["n": String(data.imported), "dups": String(data.skipped), "total": String(data.totalProcessed)])
            }
            self.file = nil
        } catch is CancellationError {
            return
        } catch {
            toasts.post(.error, kind.failedKey, detail: ImportErrorText.text(error, strings: strings))
        }
    }

    /// The page went away: the card resets like an unmounted component.
    public func reset() {
        file = nil
        separator = ","
        encoding = "utf-8"
        result = nil
    }
}
