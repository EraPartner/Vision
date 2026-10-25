import Foundation
import UniformTypeIdentifiers

extension StringIdentifier where Tag == ImportBatchIDTag {
    /// The batch a numeric route or stream event names; the API carries BIGINT ids as text.
    public init(numeric id: Int) {
        self.init(String(id))
    }

    /// The batch id as a number, `nil` when it is not one.
    public var numericValue: Int? { Int(rawValue) }
}

/// The routes of the Import & export page and the Review import page.
public enum ImportRoutes {
    public static let path = "/import"

    /// `/import/:batchId/review` draws natively (phase 3d part B).
    public static let reviewIsNative = true

    /// `/import/{batchId}/review`.
    public static func reviewPath(_ batchId: Int) -> String {
        "\(path)/\(batchId)/review"
    }

    /// The batch of a review path: a positive whole number, the only ids the preview query
    /// runs for (`Number(batchId)` must be finite); anything else is not a review route.
    public static func reviewBatchId(forPath path: String) -> Int? {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 4, parts[0].isEmpty, parts[1] == "import", parts[3] == "review" else { return nil }
        let raw = parts[2]
        guard !raw.isEmpty, raw.allSatisfy({ $0.isASCII && $0.isNumber }), let id = Int(raw), id > 0 else {
            return nil
        }
        return id
    }
}

/// A CSV the user chose, dropped or opened from Finder, read into memory: the upload sends
/// its bytes and the column preview reads its start.
public struct ImportFile: Sendable, Identifiable, Equatable {
    public let id: UUID
    public let name: String
    /// The MIME type the system reports, if any (`File.type`).
    public let mimeType: String?
    public let data: Data

    public init(name: String, data: Data, mimeType: String? = nil, id: UUID = UUID()) {
        self.id = id
        self.name = name
        self.data = data
        self.mimeType = mimeType
    }

    public static func == (left: ImportFile, right: ImportFile) -> Bool {
        left.id == right.id
    }

    public var size: Int { data.count }

    /// `(file.size / 1024).toFixed(1)`.
    public var sizeInKilobytes: String {
        String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), Double(size) / 1024)
    }

    /// `isCsvFile`: a `text/csv` type or a `.csv` name, in any case.
    public var isCSV: Bool {
        Self.isCSV(name: name, mimeType: mimeType)
    }

    public static func isCSV(name: String, mimeType: String?) -> Bool {
        mimeType == "text/csv" || name.lowercased().hasSuffix(".csv")
    }

    /// Reads a file the user picked or dropped. `nil` for a folder, an unreadable file or one
    /// above `CSVHandoff.maximumBytes`.
    public static func read(_ url: URL) async -> ImportFile? {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentTypeKey])
        guard values?.isRegularFile == true, let size = values?.fileSize, size <= CSVHandoff.maximumBytes,
            let data = try? Data(contentsOf: url)
        else { return nil }
        return ImportFile(name: url.lastPathComponent, data: data, mimeType: values?.contentType?.preferredMIMEType)
    }
}

/// The CSV delimiters the format selects offer (`CANDIDATE_SEPARATORS`).
public enum CSVSeparator {
    public static let candidates = [",", ";", "\t", "|"]

    /// `SEPARATOR_LABEL_KEYS`.
    public static func labelKey(_ separator: String) -> String? {
        switch separator {
        case ",": return "importPage.sep.comma"
        case ";": return "importPage.sep.semicolon"
        case "\t": return "importPage.sep.tab"
        case "|": return "importPage.sep.pipe"
        default: return nil
        }
    }

    /// `SEPARATOR_LABELS`: the character, with tab drawn as `⇥`.
    public static func symbol(_ separator: String) -> String {
        separator == "\t" ? "⇥" : separator
    }

    /// `detectSeparator`: the candidate that splits the header line into the most columns;
    /// a tie keeps the earlier one (comma first).
    public static func detect(_ headerLine: String) -> String {
        var best = ","
        var bestCount = 1
        for separator in candidates {
            let count = headerLine.components(separatedBy: separator).count
            if count > bestCount {
                best = separator
                bestCount = count
            }
        }
        return best
    }
}

/// The literal options of the encoding and date format selects (`ENCODING_OPTIONS`,
/// `DATE_FORMAT_OPTIONS`).
public enum CSVFormatOptions {
    public static let encodings: [(value: String, label: String)] = [
        ("utf-8", "UTF-8"), ("latin1", "Latin-1"), ("iso-8859-1", "ISO-8859-1"), ("windows-1252", "Windows-1252"),
    ]

    public static let dateFormats: [(value: String, label: String)] = [
        ("%Y-%m-%d", "YYYY-MM-DD (2024-12-31)"),
        ("%d/%m/%Y", "DD/MM/YYYY (31/12/2024)"),
        ("%m/%d/%Y", "MM/DD/YYYY (12/31/2024)"),
        ("%d-%m-%Y", "DD-MM-YYYY (31-12-2024)"),
        ("%Y-%m-%d %H:%M:%S", "YYYY-MM-DD HH:MM:SS"),
    ]

    /// The encoding select's value: a stored `latin-1` shows as Latin-1.
    public static func selectedEncoding(_ value: String) -> String {
        value == "latin-1" ? "latin1" : value
    }

    /// `importPage.numberFormat.<format>`.
    public static func numberFormatKey(_ format: OpenAPI.CsvNumberFormat) -> String {
        "importPage.numberFormat.\(format.rawValue)"
    }
}

/// `CustomConfig` of `TransactionImportCard`: the custom CSV setup a custom import sends and a
/// saved parser stores.
public struct CSVParserConfig: Equatable, Sendable {
    public var dateColumn = ""
    public var dateFormat = "%Y-%m-%d"
    public var recipientColumn = ""
    public var amountColumn = ""
    public var memoColumn = ""
    public var separator = ","
    public var encoding = "utf-8"
    public var skipRows = 0
    public var numberFormat: OpenAPI.CsvNumberFormat = .auto

    /// `DEFAULT_CUSTOM_CONFIG`.
    public init() {}

    /// `{ ...DEFAULT_CUSTOM_CONFIG, ...parser.config }`: a stored key wins, an absent one keeps
    /// its default.
    public init(saved config: OpenAPI.TransactionParserConfig) {
        self.init()
        if let value = config.dateColumn { dateColumn = value }
        if let value = config.dateFormat { dateFormat = value }
        if let value = config.recipientColumn { recipientColumn = value }
        if let value = config.amountColumn { amountColumn = value }
        if let value = config.memoColumn { memoColumn = value }
        if let value = config.separator { separator = value }
        if let value = config.encoding { encoding = value }
        if let value = config.skipRows { skipRows = value }
        if let value = config.numberFormat { numberFormat = value }
    }

    /// The date, payee and amount columns are mapped (`hasRequiredMapping`).
    public var hasRequiredMapping: Bool {
        !dateColumn.isEmpty && !recipientColumn.isEmpty && !amountColumn.isEmpty
    }

    /// The four mapped headers the column panel highlights.
    public var mappedColumns: [String] {
        [dateColumn, recipientColumn, amountColumn, memoColumn]
    }

    /// The saved parser body (`CustomParserConfigPayload`).
    public var payload: OpenAPI.TransactionParserConfig {
        OpenAPI.TransactionParserConfig(
            dateColumn: dateColumn, recipientColumn: recipientColumn, amountColumn: amountColumn,
            memoColumn: memoColumn, dateFormat: dateFormat, separator: separator, encoding: encoding,
            skipRows: skipRows, numberFormat: numberFormat)
    }

    /// The Skip rows field: `parseInt(value) || 0`, never below zero.
    public static func skipRows(from text: String) -> Int {
        let trimmed = text.drop(while: { $0.isWhitespace })
        var digits = ""
        var sign = 1
        for (index, character) in trimmed.enumerated() {
            if index == 0, character == "-" || character == "+" {
                sign = character == "-" ? -1 : 1
                continue
            }
            guard character.isASCII, character.isNumber else { break }
            digits.append(character)
        }
        guard let value = Int(digits.prefix(9)) else { return 0 }
        return max(0, sign * value)
    }
}

/// The four mapped columns of the column mapper (`COLUMN_FIELDS`), in order.
public enum CSVColumnField: String, CaseIterable, Sendable, Identifiable {
    case date
    case recipient
    case amount
    case memo

    public var id: String { rawValue }

    public var labelKey: String {
        switch self {
        case .date: return "importPage.dateCol"
        case .recipient: return "importPage.recipientCol"
        case .amount: return "importPage.amountCol"
        case .memo: return "importPage.memoCol"
        }
    }

    public var placeholderKey: String {
        switch self {
        case .date: return "importPage.dateColPlaceholder"
        case .recipient: return "importPage.recipientColPlaceholder"
        case .amount: return "importPage.amountColPlaceholder"
        case .memo: return "importPage.memoColPlaceholder"
        }
    }

    public var isRequired: Bool { self != .memo }

    public var keyPath: WritableKeyPath<CSVParserConfig, String> {
        switch self {
        case .date: return \.dateColumn
        case .recipient: return \.recipientColumn
        case .amount: return \.amountColumn
        case .memo: return \.memoColumn
        }
    }
}

/// The parser name and setup a saved-parser edit starts from (`parserBaseline`).
public struct CSVParserDraft: Equatable, Sendable {
    public var name: String
    public var config: CSVParserConfig

    public init(name: String = "", config: CSVParserConfig = CSVParserConfig()) {
        self.name = name
        self.config = config
    }
}

/// The Bank source select's value: a built-in adapter, a saved parser (`saved:<id>`) or Custom
/// or other.
public enum ImportSource: Hashable, Sendable {
    case adapter(String)
    case saved(CustomParserConfigID)
    case custom

    /// The web select's value string.
    public var value: String {
        switch self {
        case .adapter(let key): return key
        case .saved(let id): return "saved:\(id.rawValue)"
        case .custom: return "custom"
        }
    }

    public var isCustomLike: Bool {
        switch self {
        case .adapter: return false
        case .saved, .custom: return true
        }
    }
}

/// A built-in bank adapter of `GET /api/info/supported-adapters`.
public typealias ImportAdapter = OpenAPIOperations.GetSupportedAdapters.ResponseData.ItemsItem

/// `ImportProgress`: one `progress` event of the import stream, or the panel state the card
/// sets itself (`connecting`, `complete`, `error`).
public struct ImportProgress: Equatable, Sendable, Decodable {
    public var phase: String
    public var current: Int
    public var total: Int
    public var imported: Int
    public var duplicates: Int
    public var errors: Int
    public var percent: Int

    public init(
        phase: String, current: Int = 0, total: Int = 0, imported: Int = 0, duplicates: Int = 0, errors: Int = 0,
        percent: Int = 0
    ) {
        self.phase = phase
        self.current = current
        self.total = total
        self.imported = imported
        self.duplicates = duplicates
        self.errors = errors
        self.percent = percent
    }

    /// The panel the card shows as soon as Import is pressed.
    public static let connecting = ImportProgress(phase: "connecting")

    enum CodingKeys: String, CodingKey {
        case phase, current, total, imported, duplicates, errors, percent
    }

    /// `importProgressSchema`: every field required, numbers in any JSON form.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        phase = try container.decode(String.self, forKey: .phase)
        current = try Self.count(container, .current)
        total = try Self.count(container, .total)
        imported = try Self.count(container, .imported)
        duplicates = try Self.count(container, .duplicates)
        errors = try Self.count(container, .errors)
        percent = try Self.count(container, .percent)
    }

    static func count(_ container: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) throws -> Int {
        let value = try container.decode(Double.self, forKey: key)
        guard value.isFinite, abs(value) < 1e15 else {
            throw DecodingError.dataCorruptedError(forKey: key, in: container, debugDescription: "Not a count")
        }
        return Int(value.rounded())
    }

    /// The phase label (`importPage.analyzing`, `parsingCSV`, `importingTxns`, `connecting`).
    /// The backend's own phases (staging, validating, matching, committing) have none, like
    /// the web panel.
    public var labelKey: String? {
        switch phase {
        case "counting": return "importPage.analyzing"
        case "parsing": return "importPage.parsingCSV"
        case "importing": return "importPage.importingTxns"
        case "connecting": return "importPage.connecting"
        default: return nil
        }
    }

    /// The row and count line shows only while `importing` with a known total.
    public var showsCounts: Bool { phase == "importing" && total > 0 }

    /// `min(100, max(0, percent))` for the bar.
    public var fraction: Double { Double(min(100, max(0, percent))) / 100 }
}

/// A committed import's counts: the `complete` event of the stream (`total_processed`) or
/// the 201 answer of the custom import (`total`).
public struct ImportCompletion: Equatable, Sendable {
    public let total: Int
    public let imported: Int
    public let duplicates: Int
    public let errors: Int
    public let batchId: Int?

    public init(total: Int, imported: Int, duplicates: Int, errors: Int, batchId: Int? = nil) {
        self.total = total
        self.imported = imported
        self.duplicates = duplicates
        self.errors = errors
        self.batchId = batchId
    }
}

/// How an import ended: committed, or parked for review (HTTP 202 / `review_required`).
public enum ImportOutcome: Equatable, Sendable {
    case completed(ImportCompletion)
    case reviewRequired(batchId: Int)
}

/// The stream's `error` event (`extractErrorDetail`): its `detail`, or "Import failed".
public struct ImportStreamFailure: Error, Equatable, Sendable, LocalizedError {
    public let detail: String

    public init(detail: String) {
        self.detail = detail
    }

    public var errorDescription: String? { detail }
}

/// The commit receipt the review page hands to `/import` (`readCommitReceipt`).
public struct ImportCommitReceipt: Equatable, Sendable {
    public let imported: Int
    public let duplicates: Int
    public let errors: Int
    /// `YYYY-MM-DD` of the earliest and latest imported row, when known.
    public let dateFrom: String?
    public let dateTo: String?

    /// `nil` unless every count is non-negative; a date that is not `YYYY-MM-DD` is dropped.
    public init?(imported: Int, duplicates: Int, errors: Int, dateFrom: String? = nil, dateTo: String? = nil) {
        guard imported >= 0, duplicates >= 0, errors >= 0 else { return nil }
        self.imported = imported
        self.duplicates = duplicates
        self.errors = errors
        self.dateFrom = dateFrom.flatMap { Self.isDay($0) ? $0 : nil }
        self.dateTo = dateTo.flatMap { Self.isDay($0) ? $0 : nil }
    }

    static func isDay(_ text: String) -> Bool {
        text.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil
    }

    /// `importedTransactionsHref`: the Transactions page narrowed to the imported rows' date
    /// span, labelled `importPage.importedFilterLabel`; plain `/transactions` without dates.
    public func transactionsRoute(filterLabel: String) -> String {
        var route = NativeRoute(path: "/transactions")
        if let dateFrom { route = route.setting("start_date", to: dateFrom) }
        if let dateTo { route = route.setting("end_date", to: dateTo) }
        if dateFrom != nil || dateTo != nil { route = route.setting("filter_label", to: filterLabel) }
        return route.string
    }
}

/// The badge of an import batch's status (`STATUS_LABEL_KEY`, `STATUS_VARIANT`).
public enum ImportBatchStatus {
    public enum Tone: Sendable {
        case primary
        case secondary
        case destructive
        case outline
    }

    public static func labelKey(_ status: OpenAPI.ImportBatch.Status) -> String {
        "importHistory.status.\(status.rawValue)"
    }

    public static func tone(_ status: OpenAPI.ImportBatch.Status) -> Tone {
        switch status {
        case .pending, .aborted: return .outline
        case .complete: return .primary
        case .failed: return .destructive
        default: return .secondary
        }
    }
}

extension OpenAPI.ImportBatch {
    /// The source file name, or `importHistory.batchFallback`.
    public func title(_ strings: any Localizing) -> String {
        sourceFilename ?? strings.t("importHistory.batchFallback", ["id": id.rawValue])
    }

    /// The batch id as a number (BIGINT arrives as a string).
    public var numericId: Int? { id.numericValue }

    /// Resume review: only a parked batch.
    public var canResumeReview: Bool { status == .awaitingReview }

    /// Roll back: a completed batch with transactions left.
    public var canRollBack: Bool { status == .complete && transactionsRemaining > 0 }

    /// `formatDate(parseISO(started_at), "yyyy-MM-dd HH:mm")` in the local time zone.
    public func startedText(timeZone: TimeZone = .current) -> String {
        guard let date = Self.parseTimestamp(startedAt) else { return startedAt }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return String(
            format: "%04ld-%02ld-%02ld %02ld:%02ld", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0, parts.hour ?? 0,
            parts.minute ?? 0)
    }

    static func parseTimestamp(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: text) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: text)
    }
}
