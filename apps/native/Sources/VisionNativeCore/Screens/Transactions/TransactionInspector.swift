import Foundation
import Observation

/// An editable row of the inspector's Details (`InfoEditableField`).
public enum TransactionDetailField: String, CaseIterable, Sendable {
    case date
    case memo
    case amount
    case currency
    case bank
    case comment

    /// `txPage.field.*`.
    public var labelKey: String {
        switch self {
        case .date: return "txPage.field.date"
        case .memo: return "txPage.field.description"
        case .amount: return "txPage.field.amount"
        case .currency: return "txPage.field.currency"
        case .bank: return "txPage.field.bankAccount"
        case .comment: return "txPage.field.comment"
        }
    }
}

/// The Transaction inspector of one row (`TransactionInspector`): the Details field being
/// edited, the local tag chips, the payee and its uncategorised count behind the category
/// tips, and the Attachments panel. Saving goes through `TransactionsModel`, which owns the
/// row.
@MainActor
@Observable
public final class TransactionInspectorModel: Identifiable {
    public let id: TransactionID
    public private(set) var editingField: TransactionDetailField?
    /// The text of the field being edited (description, amount, currency, comment, account).
    public var editingValue = ""
    /// The date being edited.
    public var editingDate: PlannedDay?
    /// The account picked while editing Account.
    public var editingAccountId: AccountID?
    /// `addTxn.invalidAmount` under the amount field.
    public private(set) var amountError = false
    public internal(set) var isSaving = false
    /// The chips shown, ahead of the row while a tag change is saved.
    public internal(set) var tagSlugs: [String]
    /// `useRecipient(recipientId)`.
    public private(set) var recipient: OpenAPI.Recipient?
    /// `useUncategorisedCountForRecipient(recipientId)`.
    public private(set) var uncategorisedCount: Int?
    public let attachments: TransactionAttachmentsModel

    @ObservationIgnored private let service: any TransactionsService
    @ObservationIgnored private var loadedRecipientId: RecipientID?
    @ObservationIgnored private var inFlight: (recipientId: RecipientID?, task: Task<Void, Never>)?

    init(
        row: TransactionRow, service: any TransactionsService, attachments: any TransactionAttachmentsService,
        save: @escaping @MainActor (Data, String) async throws -> Bool
    ) {
        id = row.id
        tagSlugs = row.tags.map(\.slug)
        self.service = service
        self.attachments = TransactionAttachmentsModel(transactionId: row.id, service: attachments, save: save)
    }

    // MARK: Payee tips

    /// The payee and its uncategorised count for the row's payee; one request per payee at a
    /// time, `force` after a change on the server.
    public func load(recipientId: RecipientID?, force: Bool = false) async {
        if let inFlight, inFlight.recipientId == recipientId {
            await inFlight.task.value
            if !force { return }
        }
        if !force, loadedRecipientId == recipientId, recipientId == nil || recipient != nil { return }
        let service = service
        let task = Task { [weak self] in
            guard let recipientId else {
                self?.recipient = nil
                self?.uncategorisedCount = nil
                self?.loadedRecipientId = nil
                return
            }
            async let found = service.recipient(id: recipientId)
            async let count = service.uncategorisedCount(recipientId: recipientId)
            let recipient = try? await found
            let total = try? await count
            guard let self else { return }
            self.recipient = recipient
            self.uncategorisedCount = total
            self.loadedRecipientId = recipientId
        }
        inFlight = (recipientId, task)
        await task.value
        if inFlight?.task == task { inFlight = nil }
    }

    /// The tips of the Category and payee section.
    public struct Tips: Equatable, Sendable {
        /// `txPage.inspector.othersNeedCategory` with Use for all.
        public let othersNeedingCategory: Int
        public let showsUseForAll: Bool
        /// `txPage.inspector.alwaysUseQuestion` with Always use.
        public let canSetUsual: Bool
        /// `txPage.inspector.ruleApplies` with Edit rule….
        public let ruleApplies: Bool

        public var showsTipBox: Bool { canSetUsual || othersNeedingCategory > 0 }
    }

    public func tips(for row: TransactionRow, labels: TransactionLabels) -> Tips? {
        guard let recipient, recipient.id == row.recipientId else { return nil }
        let others = max(0, (uncategorisedCount ?? 0) - (row.isUncategorised(labels) ? 1 : 0))
        let canSetUsual = row.categoryId != nil && recipient.defaultCategoryId != row.categoryId
        let ruleApplies = recipient.defaultCategoryId != nil && recipient.defaultCategoryId == row.categoryId
        return Tips(
            othersNeedingCategory: others, showsUseForAll: others > 0 && row.categoryId != nil,
            canSetUsual: canSetUsual, ruleApplies: ruleApplies)
    }

    // MARK: Details

    /// The pencil: the field switches to an editor with the row's value.
    public func startEdit(_ field: TransactionDetailField, row: TransactionRow, format: NumberFormat) {
        amountError = false
        editingField = field
        editingAccountId = field == .bank ? row.accountId : nil
        editingDate = nil
        switch field {
        case .date:
            editingValue = row.day
            editingDate = PlannedDay(ymd: row.day, calendar: PlannedDates.local)
        case .memo: editingValue = row.memo ?? ""
        case .amount: editingValue = LocaleNumber.editable(row.amount, format: format)
        case .currency: editingValue = row.currency?.rawValue ?? ""
        case .bank: editingValue = row.bank ?? ""
        case .comment: editingValue = row.comment ?? ""
        }
    }

    /// Cancel: the field leaves edit mode.
    public func cancelEdit() {
        amountError = false
        editingField = nil
        editingValue = ""
        editingDate = nil
        editingAccountId = nil
    }

    /// The PATCH of the field being edited, or `nil` when the value does not validate (the
    /// amount shows its error; an unknown account or an invalid date does nothing).
    public func patch(accounts: [OpenAPI.Account], format: NumberFormat) -> TransactionPatch? {
        guard let field = editingField else { return nil }
        let trimmed = editingValue.trimmingCharacters(in: .whitespacesAndNewlines)
        var patch = TransactionPatch()
        switch field {
        case .amount:
            guard let amount = LocaleNumber.parse(trimmed, format: format) else {
                amountError = true
                return nil
            }
            amountError = false
            patch.amount = amount
        case .date:
            guard let day = editingDate else { return nil }
            patch.transactionDate = day.ymd
        case .memo:
            patch.memo = .some(trimmed.isEmpty ? nil : trimmed)
        case .currency:
            // currency is NOT NULL: a blank entry changes nothing.
            if !trimmed.isEmpty {
                // Like the web's `isCurrencyCode`: anything but three capitals changes nothing.
                guard let code = CurrencyCode(rawValue: trimmed) else { return nil }
                patch.currency = code
            }
        case .bank:
            if trimmed.isEmpty {
                patch.accountId = .some(nil)
            } else {
                let lowered = trimmed.lowercased()
                guard
                    let account = accounts.first(where: { $0.id == editingAccountId })
                        ?? accounts.first(where: {
                            $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == lowered
                        })
                else { return nil }
                patch.accountId = .some(account.id)
            }
        case .comment:
            patch.comment = .some(trimmed.isEmpty ? nil : trimmed)
        }
        return patch
    }
}

/// `AttachmentPanel`: the transaction's files, Upload (images and PDFs, one at a time),
/// Quick Look over a downloaded copy, Download through the Save panel and Delete behind a
/// confirmation.
@MainActor
@Observable
public final class TransactionAttachmentsModel {
    /// `ALLOWED_MIME`.
    public nonisolated static let allowedTypes = ["image/*", "application/pdf"]

    public let transactionId: TransactionID
    /// `nil` until the first answer.
    public private(set) var items: [OpenAPI.Attachment]?
    /// `txPage.attachmentsError`.
    public private(set) var loadFailed = false
    public private(set) var isUploading = false
    /// `txPage.uploadError` until the next upload.
    public private(set) var uploadFailed = false
    /// The attachment the Delete attachment alert asks about.
    public private(set) var pendingDelete: OpenAPI.Attachment?
    public private(set) var deletingId: AttachmentID?
    /// `txPage.deleteAttachmentError` with the reason, for the page's toast.
    public private(set) var deleteError: APIError?
    /// `txPage.downloadAttachmentError` with the reason, for the page's toast (#342).
    public private(set) var downloadError: APIError?
    /// The attachment whose bytes are being fetched; React's `downloading` state.
    public private(set) var downloadingId: AttachmentID?
    /// The local copy Quick Look shows.
    public private(set) var previewURL: URL?
    /// Image bytes for the thumbnails, by attachment id.
    public private(set) var thumbnails: [AttachmentID: Data] = [:]

    @ObservationIgnored private let service: any TransactionAttachmentsService
    @ObservationIgnored private let save: @MainActor (Data, String) async throws -> Bool
    @ObservationIgnored private var inFlight: Task<Void, Never>?

    init(
        transactionId: TransactionID, service: any TransactionAttachmentsService,
        save: @escaping @MainActor (Data, String) async throws -> Bool
    ) {
        self.transactionId = transactionId
        self.service = service
        self.save = save
    }

    public var isLoading: Bool { items == nil && !loadFailed }

    /// `useAttachments(transactionId)`; a second caller awaits the request in flight, and
    /// `force` refetches after an upload or delete.
    public func load(force: Bool = false) async {
        if let inFlight {
            await inFlight.value
            if !force { return }
        }
        if !force, items != nil { return }
        let service = service
        let id = transactionId
        let task = Task { [weak self] in
            do {
                let answer = try await service.attachments(transactionId: id)
                self?.items = answer
                self?.loadFailed = false
            } catch is CancellationError {
                return
            } catch {
                self?.loadFailed = true
            }
        }
        inFlight = task
        await task.value
        if inFlight == task { inFlight = nil }
    }

    /// `attachment.mime_type.startsWith("image/")`.
    public static func isImage(_ attachment: OpenAPI.Attachment) -> Bool {
        attachment.mimeType.hasPrefix("image/")
    }

    /// `formatBytes`: B, KB or MB with one decimal.
    public static func size(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        let kilobytes = Double(bytes) / 1024
        if bytes < 1024 * 1024 { return String(format: "%.1f KB", kilobytes) }
        return String(format: "%.1f MB", kilobytes / 1024)
    }

    /// Upload: the file goes up, then the list refetches. A failure shows
    /// `txPage.uploadError` until the next upload.
    public func upload(_ file: AttachmentUpload) async {
        guard !isUploading else { return }
        isUploading = true
        uploadFailed = false
        defer { isUploading = false }
        do {
            _ = try await service.uploadAttachment(transactionId: transactionId, file: file)
            await load(force: true)
        } catch is CancellationError {
            return
        } catch {
            uploadFailed = true
        }
    }

    /// The thumbnail bytes of an image attachment, fetched once.
    public func loadThumbnail(_ attachment: OpenAPI.Attachment) async {
        guard Self.isImage(attachment), thumbnails[attachment.id] == nil else { return }
        if let data = try? await service.downloadAttachment(id: attachment.id) {
            thumbnails[attachment.id] = data
        }
    }

    /// The file name or thumbnail: Quick Look over a copy in the temporary folder (the web
    /// opens the download URL in a new tab).
    public func preview(_ attachment: OpenAPI.Attachment) async {
        guard let data = try? await service.downloadAttachment(id: attachment.id) else { return }
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("VisionAttachments", isDirectory: true)
            .appendingPathComponent(attachment.id.rawValue, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent(Self.safeName(attachment.filename))
            try data.write(to: file, options: .atomic)
            previewURL = file
        } catch {
            previewURL = nil
        }
    }

    /// Quick Look closed.
    public func closePreview() {
        previewURL = nil
    }

    /// Download: the file's bytes, saved where the Save panel says under its own name. A
    /// second tap while one runs is ignored (#342 `downloading`); a failure is reported
    /// through `downloadError` for the toast.
    public func download(_ attachment: OpenAPI.Attachment) async {
        guard downloadingId == nil else { return }
        downloadingId = attachment.id
        defer { downloadingId = nil }
        do {
            let data = try await service.downloadAttachment(id: attachment.id)
            _ = try await save(data, Self.safeName(attachment.filename))
        } catch is CancellationError {
            return
        } catch {
            downloadError = APIError.wrapping(error)
        }
    }

    /// The page showed the download failure.
    public func clearDownloadError() {
        downloadError = nil
    }

    /// A file name without path separators.
    static func safeName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        return cleaned.isEmpty ? "attachment" : cleaned
    }

    /// The row's Delete: asks first.
    public func requestDelete(_ attachment: OpenAPI.Attachment) {
        pendingDelete = attachment
    }

    public func cancelDelete() {
        pendingDelete = nil
    }

    /// The alert's Delete: the file goes, then the list refetches; a failure is reported
    /// through `deleteError` for the toast.
    public func confirmDelete() async {
        guard let attachment = pendingDelete else { return }
        pendingDelete = nil
        deletingId = attachment.id
        defer { deletingId = nil }
        do {
            try await service.deleteAttachment(id: attachment.id)
            thumbnails[attachment.id] = nil
            await load(force: true)
        } catch is CancellationError {
            return
        } catch {
            deleteError = APIError.wrapping(error)
        }
    }

    /// The page showed the delete failure.
    public func clearDeleteError() {
        deleteError = nil
    }
}
