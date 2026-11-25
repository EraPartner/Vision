import Foundation
import VisionNativeCore

/// `routes/attachments.ts`: the transaction attachment routes the client calls — the list of
/// a transaction's attachments, the raw-file download, the delete and the hand-written
/// multipart upload (`uploadAttachment`: the client's `AttachmentUploadRequest`).
enum AttachmentsArea {
    // MARK: - Register

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.GetTransactionAttachments.self) { request in
            try await database.run { session in try AttachmentsArea.list(session, request: request) }
        }
        backend.serve(OpenAPIOperations.DownloadAttachment.self) { request in
            let root = await database.attachmentsDirectory
            return try await database.run { session in
                try AttachmentsArea.download(session, request: request, root: root)
            }
        }
        backend.serve(OpenAPIOperations.DeleteAttachment.self) { request in
            let root = await database.attachmentsDirectory
            return try await database.run { session in
                try AttachmentsArea.delete(session, request: request, root: root)
            }
        }
        backend.serve(AttachmentUploadRequest.self) { request in
            let root = await database.attachmentsDirectory
            return try await database.run { session in
                try AttachmentsArea.upload(session, request: request, root: root)
            }
        }
    }

    // MARK: - Request input

    /// `entityIdParamsSchema`: the strict id parse of every path segment.
    static func pathId(_ request: InProcessRequest) throws -> Int {
        guard let raw = request.pathParameters["id"], let id = RequestID.valid(.string(raw)) else {
            throw BackendHTTPError.validation("id: must be a positive integer")
        }
        return Int(id)
    }

    /// One attachment row as `formatRow` answers it: the row id serialises as a string and
    /// `created_at` as the timestamp's text form.
    static func row(_ row: SQLRow) throws -> JSONValue {
        .object([
            "id": .string(String(try row.integerId("id"))),
            "transaction_id": .int(try row.integerId("transaction_id")),
            "filename": .string(try row.text("filename")),
            "stored_path": .string(try row.text("stored_path")),
            "mime_type": .string(try row.text("mime_type")),
            "size_bytes": .int(Int(try row.int64("size_bytes"))),
            "created_at": .string(try row.instant("created_at").text),
        ])
    }

    // MARK: - The routes

    /// `GET /transaction/:id`: newest first, unbounded without limit/offset.
    static func list(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let id = try pathId(request)
        let page = PageParams.optional(
            limit: request.query("limit"), offset: request.query("offset"), maxLimit: 1000)
        var sql = "SELECT * FROM attachments WHERE transaction_id = ? ORDER BY created_at DESC"
        var arguments: [SQLValue] = [.integer(Int64(id))]
        if let page {
            sql += " LIMIT ? OFFSET ?"
            arguments += [page.limit.sqlValue, page.offset.sqlValue]
        }
        let items = try session.rows(sql, arguments).map { try AttachmentsArea.row($0) }
        let total: Int
        if page != nil {
            let countRows = try session.rows(
                "SELECT COUNT(*) AS \"count\" FROM attachments WHERE transaction_id = ?",
                [.integer(Int64(id))])
            total = Int(try countRows[0].int64("count"))
        } else {
            total = items.count
        }
        return HandlerResult(data: .object(listBody(items, total: total, page: page)))
    }

    // MARK: - Upload

    /// `ATTACHMENT_MAX_SIZE_BYTES` (`attachmentUpload` middleware): multer's `fileSize` limit,
    /// the env default of 10 MB.
    static let maxUploadBytes = 10 * 1024 * 1024

    /// The root the upload must store files under; the route can only run with one, as the
    /// app always hands the backend its `layout.attachments`.
    struct StorageRootMissing: Error {}

    /// `POST /transaction/:id` (`uploadAttachment`): the path id first (the route validates
    /// it before multer buffers anything), then multer's own checks in stream order — the
    /// file filter, the size limit, an unexpected file field — then the content verification,
    /// the transaction's existence, the stored file and its row.
    static func upload(
        _ session: BackendSession, request: InProcessRequest, root: String?
    ) throws -> HandlerResult {
        let id = try pathId(request)
        let parts = MultipartParts.parse(headers: request.headers, body: request.body) ?? []
        for part in parts where part.filename != nil {
            // `upload.single("file")`: a file part under another field name is multer's
            // `LIMIT_UNEXPECTED_FILE`.
            guard part.name == "file" else {  // lint:allow string-literal-compare the upload form field name, as multer reads it
                throw BackendHTTPError.validation("Upload error: Unexpected field")
            }
            // The middleware's fileFilter: only images and PDFs.
            guard part.contentType.hasPrefix("image/") || part.contentType == "application/pdf" else {  // lint:allow string-literal-compare the allowed MIME kinds, as the middleware filter reads them
                throw BackendHTTPError.validation(
                    "Unsupported file type: \(part.contentType). Allowed: images and PDF.")
            }
            // The middleware's `limits.fileSize`; busboy rejects the file while streaming it,
            // after the filter has accepted the part.
            guard part.data.count <= maxUploadBytes else {
                throw BackendHTTPError.validation("Upload error: File too large")
            }
        }
        guard let file = parts.first(where: { $0.filename != nil && $0.name == "file" }) else {  // lint:allow string-literal-compare the upload form field name, as multer reads it
            throw BackendHTTPError.validation(
                "No file uploaded. Send a file as multipart/form-data with field name \"file\".")
        }
        let filename = file.filename ?? ""
        let sniffed = try verifyAttachmentContent(bytes: file.data, filename: filename)
        guard
            try session.row("SELECT id FROM transactions WHERE id = ?", [.integer(Int64(id))]) != nil
        else { throw BackendHTTPError.notFound("Transaction not found") }
        guard let root else { throw StorageRootMissing() }
        let storedPath = try storeAttachment(
            bytes: file.data, transactionId: TransactionID(rawValue: id), filename: filename, root: root)
        do {
            let row = try session.row(
                "INSERT INTO attachments (transaction_id, filename, stored_path, mime_type, size_bytes)\n"
                    + "VALUES (?, ?, ?, ?, ?) RETURNING *",
                [
                    .integer(Int64(id)), .text(filename), .text(storedPath), .text(sniffed),
                    .integer(Int64(file.data.count)),
                ])
            guard let row else { throw StorageRootMissing() }
            return HandlerResult(status: 201, data: try AttachmentsArea.row(row))
        } catch {
            // The insert failed (the route's own race with a concurrent hard delete): the
            // stored file must not sit on disk with no row pointing at it.
            let absolute = URL(fileURLWithPath: root).appendingPathComponent(storedPath).standardized
            try? FileManager.default.removeItem(at: absolute)
            throw error
        }
    }

    /// `storeAttachment` (`attachmentService.ts`): the bytes under `{root}/{id}/{uuid}{ext}`
    /// (the uuid lowercased, as Node's `randomUUID`), and the forward-slash relative path it
    /// returns for the row.
    static func storeAttachment(
        bytes: Data, transactionId: TransactionID, filename: String, root: String
    ) throws -> String {
        let ext = pathExtension(of: filename).lowercased()
        let storedPath = "\(transactionId.rawValue)/\(UUID().uuidString.lowercased())\(ext)"
        let directory = URL(fileURLWithPath: root, isDirectory: true)
            .appendingPathComponent(String(transactionId), isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try bytes.write(
            to: directory.appendingPathComponent(String(storedPath.split(separator: "/").last ?? "")))
        return storedPath
    }

    /// `verifyAttachmentContent` (`attachmentService.ts`): the sniffed MIME of the actual
    /// bytes, with the checks and wording of the route's validation errors.
    static func verifyAttachmentContent(bytes: Data, filename: String) throws -> String {
        guard let sniffed = sniffMime(bytes) else {
            throw BackendHTTPError.validation(
                "Unsupported or unrecognised file content. Allowed: PNG, JPEG, GIF, WEBP, PDF.")
        }
        guard sniffed.hasPrefix("image/") || sniffed == "application/pdf" else {  // lint:allow string-literal-compare the allowed MIME kinds, as the service filter reads them
            throw BackendHTTPError.validation(
                "Unsupported file type: \(sniffed). Allowed: images and PDF.")
        }
        let ext = pathExtension(of: filename).lowercased()
        let expected = extensionMime(ext)
        // An unrecognised extension is a mismatch, not a free pass; a missing one stays allowed.
        if !ext.isEmpty && expected == nil {
            throw BackendHTTPError.validation(
                "Unsupported file extension \(ext). Allowed: .png, .jpg, .jpeg, .gif, .webp, .pdf.")
        }
        if let expected, expected != sniffed {
            throw BackendHTTPError.validation(
                "File extension \(ext) does not match content (\(sniffed)).")
        }
        return sniffed
    }

    /// `sniffMime` (`lib/fileSniff.ts`): the magic-byte signatures.
    static func sniffMime(_ bytes: Data) -> String? {
        let png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        let jpeg = Data([0xff, 0xd8, 0xff])
        let pdf = Data("%PDF-".utf8)
        if bytes.count >= 4 {
            if bytes.prefix(png.count) == png { return "image/png" }
            if bytes.prefix(jpeg.count) == jpeg { return "image/jpeg" }
            if bytes.prefix(6) == Data("GIF87a".utf8) || bytes.prefix(6) == Data("GIF89a".utf8) {
                return "image/gif"
            }
            if bytes.count >= 12, bytes.prefix(4) == Data("RIFF".utf8),
                bytes.dropFirst(8).prefix(4) == Data("WEBP".utf8)
            {
                return "image/webp"
            }
            if bytes.prefix(pdf.count) == pdf { return "application/pdf" }
        }
        return nil
    }

    /// `extensionMime` (`lib/fileSniff.ts`): an allowed extension's canonical MIME.
    static func extensionMime(_ ext: String) -> String? {
        switch ext {
        case ".png": return "image/png"  // lint:allow string-literal-compare the canonical MIME of an allowed extension
        case ".jpg", ".jpeg": return "image/jpeg"  // lint:allow string-literal-compare the canonical MIME of an allowed extension
        case ".gif": return "image/gif"  // lint:allow string-literal-compare the canonical MIME of an allowed extension
        case ".webp": return "image/webp"  // lint:allow string-literal-compare the canonical MIME of an allowed extension
        case ".pdf": return "application/pdf"  // lint:allow string-literal-compare the canonical MIME of an allowed extension
        default: return nil
        }
    }

    /// Node's `path.extname`: the suffix from the last dot of the final path segment.
    static func pathExtension(of filename: String) -> String {
        guard let slash = filename.lastIndex(of: "/") else {
            guard let dot = filename.lastIndex(of: ".") else { return "" }
            return String(filename[dot...])
        }
        guard let dot = filename[slash...].lastIndex(of: ".") else { return "" }
        return String(filename[dot...])
    }

    /// `GET /:id/download`: the raw bytes with `Content-Disposition: inline`; a missing file
    /// on disk answers the clean 404 of the route's sendFile callback.
    static func download(
        _ session: BackendSession, request: InProcessRequest, root: String?
    ) throws -> HandlerResult {
        let id = try pathId(request)
        guard let row = try session.row("SELECT * FROM attachments WHERE id = ?", [.integer(Int64(id))])
        else {
            throw BackendHTTPError.notFound("Attachment not found")
        }
        let storedPath = try row.text("stored_path")
        let filename = try row.text("filename")
        let mime = try row.text("mime_type")
        guard let root else {
            throw BackendHTTPError.notFound("Attachment file not found")
        }
        let absolute = URL(fileURLWithPath: root).appendingPathComponent(storedPath).standardized
        let rootUrl = URL(fileURLWithPath: root).standardized
        let isInside = absolute == rootUrl
            || absolute.path.hasPrefix(rootUrl.path + "/")
        guard isInside, let bytes = try? Data(contentsOf: absolute) else {
            throw BackendHTTPError.notFound("Attachment file not found")
        }
        // `asciiFallback`/`filename*` of the route, with the separator-escaped filename.
        let fallback = String(
            String.UnicodeScalarView(filename.unicodeScalars.map { scalar in
                (0x20...0x7e).contains(scalar.value) && scalar != "\"" && scalar != "\\" ? scalar : "_"
            }))
        let encoded = filename.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        return HandlerResult.fileAnswer(bytes, headers: [
            "Content-Type": mime,
            "Content-Disposition": "inline; filename=\"\(fallback)\"; filename*=UTF-8''\(encoded)",
        ])
    }

    /// `DELETE /:id`: the DB row first, then the file removed best-effort; a file-removal
    /// failure does not fail the request — the row is already gone.
    static func delete(
        _ session: BackendSession, request: InProcessRequest, root: String?
    ) throws -> HandlerResult {
        let id = try pathId(request)
        guard let row = try session.row("SELECT stored_path FROM attachments WHERE id = ?", [.integer(Int64(id))])
        else {
            throw BackendHTTPError.notFound("Attachment not found")
        }
        _ = try session.rows("DELETE FROM attachments WHERE id = ?", [.integer(Int64(id))])
        if let root, let storedPath = try? row.text("stored_path") {
            let absolute = URL(fileURLWithPath: root).appendingPathComponent(storedPath).standardized
            let rootUrl = URL(fileURLWithPath: root).standardized
            if absolute == rootUrl || absolute.path.hasPrefix(rootUrl.path + "/") {
                try? FileManager.default.removeItem(at: absolute)
            }
        }
        return HandlerResult.noContent
    }
}
