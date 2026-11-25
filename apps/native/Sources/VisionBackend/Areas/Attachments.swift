import Foundation
import VisionNativeCore

/// `routes/attachments.ts`: the transaction attachment routes the client reads — the list of a
/// transaction's attachments, the raw-file download and the delete. The multipart upload has
/// no client operation and stays on Bun; it keeps running beside this backend for it.
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
