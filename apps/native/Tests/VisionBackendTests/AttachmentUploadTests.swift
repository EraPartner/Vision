import Foundation
import Testing
import VisionNativeCore

@testable import VisionBackend

/// The upload route's own helpers (`uploadAttachment`): the multipart parse and the content
/// checks, and the size-limit branch the corpus cannot carry (a 10 MB payload would outweigh
/// every corpus file).
@Suite struct AttachmentUploadTests {
    /// One multipart request body, as the client's `MultipartFormData` writes it.
    static func body(boundary: String, parts: [(name: String, filename: String?, contentType: String?, data: Data)]) -> Data {
        var body = Data()
        for part in parts {
            var disposition = "Content-Disposition: form-data; name=\"\(part.name)\""
            if let filename = part.filename { disposition += "; filename=\"\(filename)\"" }
            body.append(Data("--\(boundary)\r\n\(disposition)\r\n".utf8))
            if let contentType = part.contentType { body.append(Data("Content-Type: \(contentType)\r\n".utf8)) }
            body.append(Data("\r\n".utf8))
            body.append(part.data)
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        return body
    }

    static func request(path: String, contentType: String, body: Data) -> InProcessRequest {
        InProcessRequest(
            operationId: "uploadAttachment", method: .post,
            pathParameters: ["id": path],
            queryItems: [], headers: ["Content-Type": contentType], body: body)
    }

    static let png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0a])

    /// A migrated database with one transaction (id 1) to upload against.
    static func uploadDatabase() throws -> BackendDatabase {
        let file = try ParityTests.migratedDatabase(seed: [
            "INSERT INTO accounts (id, name, currency, type, created_at, updated_at, import_identity) VALUES"
                + " (1, 'Main', 'EUR', 'checking', '2025-03-01T09:00:00.000000Z', '2025-03-01T09:00:00.000000Z',"
                + " '00000000-0000-4000-8000-000000000001')",
            "INSERT INTO transactions (id, date, amount, currency, recipient_id, account_id, is_active, created_at, updated_at) VALUES"
                + " (1, '2024-01-05', vision_numeric('-12.5', 18, 4), 'EUR', NULL, 1, 1,"
                + " '2025-03-01T09:00:00.000000Z', '2025-03-01T09:00:00.000000Z')",
        ])
        return BackendDatabase(path: file.path, attachmentsDirectory: file.deletingLastPathComponent().path + "/attachments")
    }

    // MARK: - The multipart parse

    @Test func parsesFileAndFieldParts() throws {
        let body = Self.body(boundary: "VisionBoundary", parts: [
            ("caption", nil, nil, Data("with a caption".utf8)),
            ("file", "receipt.png", "image/png", Self.png),
        ])
        let parts = try #require(
            MultipartParts.parse(
                headers: ["Content-Type": "multipart/form-data; boundary=VisionBoundary"], body: body))
        #expect(parts.count == 2)
        #expect(parts[0].filename == nil)
        #expect(parts[0].data == Data("with a caption".utf8))
        #expect(parts[1].name == "file")
        #expect(parts[1].filename == "receipt.png")
        #expect(parts[1].contentType == "image/png")
        #expect(parts[1].data == Self.png)
    }

    @Test func quotedBoundaryAndMissingFields() {
        #expect(
            MultipartParts.parse(
                headers: ["Content-Type": "multipart/form-data; boundary=\"quoted\""], body: Data("--quoted--\r\n".utf8))
                == [])
        #expect(MultipartParts.parse(headers: ["Content-Type": "application/json"], body: Data("{}".utf8)) == nil)
        #expect(
            MultipartParts.parse(headers: ["Content-Type": "multipart/form-data"], body: Data("--x\r\n\r\n\r\n--x--".utf8))
                == nil)
        #expect(
            MultipartParts.parse(
                headers: ["Content-Type": "multipart/form-data; boundary=""], body: Data("--\r\n\r\n\r\n--".utf8)) == nil)
    }

    // MARK: - The content checks

    @Test func sniffMatchesEveryAllowedSignature() throws {
        #expect(AttachmentsArea.sniffMime(Self.png) == "image/png")
        #expect(AttachmentsArea.sniffMime(Data([0xff, 0xd8, 0xff, 0xe0])) == "image/jpeg")
        #expect(AttachmentsArea.sniffMime(Data("GIF89a".utf8)) == "image/gif")
        #expect(AttachmentsArea.sniffMime(Data("GIF87a".utf8)) == "image/gif")
        #expect(
            AttachmentsArea.sniffMime(Data("RIFF1234WEBPVP8 ".utf8)) == "image/webp")
        #expect(AttachmentsArea.sniffMime(Data("%PDF-1.4".utf8)) == "application/pdf")
        #expect(AttachmentsArea.sniffMime(Data("%PD".utf8)) == nil)
        #expect(AttachmentsArea.sniffMime(Data("RIFF1234VP8".utf8)) == nil)
    }

    @Test func extensionChecks() throws {
        #expect(try AttachmentsArea.verifyAttachmentContent(bytes: Self.png, filename: "photo.JPG") == "image/png")
        #expect(try AttachmentsArea.verifyAttachmentContent(bytes: Self.png, filename: "no-file-name") == "image/png")
        do {
            _ = try AttachmentsArea.verifyAttachmentContent(bytes: Self.png, filename: "x.exe")
            Issue.record("the .exe extension must be rejected")
        } catch let error as BackendHTTPError {
            #expect(
                error.message
                    == "Unsupported file extension .exe. Allowed: .png, .jpg, .jpeg, .gif, .webp, .pdf.")
        }
        do {
            _ = try AttachmentsArea.verifyAttachmentContent(bytes: Self.png, filename: "x.pdf")
            Issue.record("a mismatching extension must be rejected")
        } catch let error as BackendHTTPError {
            #expect(error.message == "File extension .pdf does not match content (image/png).")
        }
    }

    // MARK: - The route, on the size limit and the unexpected field

    @Test func rejectsOversizeAndUnexpectedFields() throws {
        let database = try Self.uploadDatabase()
        let oversize = Data(repeating: 0x89, count: AttachmentsArea.maxUploadBytes + 1)
        let contentType = "multipart/form-data; boundary=VisionBoundary"
        let oversizeBody = Self.body(boundary: "VisionBoundary", parts: [
            ("file", "big.png", "image/png", oversize),
        ])
        do {
            _ = try database.run { session in
                try AttachmentsArea.upload(
                    session,
                    request: Self.request(path: "1", contentType: contentType, body: oversizeBody), root: nil)
            }
            Issue.record("an oversize file must be rejected")
        } catch let error as BackendHTTPError {
            #expect(
                error.message == "Upload error: File too large",
                "the corpus cannot carry a 10 MB payload, the size branch runs here")
        }
        let unexpectedField = Self.body(boundary: "VisionBoundary", parts: [
            ("other", "a.png", "image/png", Self.png),
        ])
        do {
            _ = try database.run { session in
                try AttachmentsArea.upload(
                    session,
                    request: Self.request(path: "1", contentType: contentType, body: unexpectedField), root: nil)
            }
            Issue.record("a file part under another field name must be rejected")
        } catch let error as BackendHTTPError {
            #expect(error.message == "Upload error: Unexpected field")
        }
    }
}
