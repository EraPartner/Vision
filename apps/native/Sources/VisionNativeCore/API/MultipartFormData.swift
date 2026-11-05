import Foundation

/// A `multipart/form-data` body, the `FormData` the web app posts for its CSV uploads
/// (`postMultipartImport` and `importCSVWithProgress` in apps/frontend/src/lib/api): text
/// fields and files in the order they were appended, between one boundary.
public struct MultipartFormData: Equatable, Sendable {
    public struct Part: Equatable, Sendable {
        public let name: String
        /// Set for a file part.
        public let filename: String?
        public let contentType: String?
        public let data: Data
    }

    public let boundary: String
    public private(set) var parts: [Part] = []

    /// - Parameter boundary: random by default; tests pass a fixed one.
    public init(boundary: String = "VisionNativeBoundary\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))") {
        self.boundary = boundary
    }

    /// `formData.append(name, value)`.
    public mutating func append(_ name: String, _ value: String) {
        parts.append(Part(name: name, filename: nil, contentType: nil, data: Data(value.utf8)))
    }

    /// `formData.append(name, file)`: the browser sends the file's name and type.
    public mutating func append(file name: String, filename: String, contentType: String, data: Data) {
        parts.append(Part(name: name, filename: filename, contentType: contentType, data: data))
    }

    /// The request's `Content-Type`.
    public var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    /// The body: each part as `--boundary`, its headers, a blank line and its bytes, then the
    /// closing `--boundary--` (RFC 7578).
    public func encoded() -> Data {
        var body = Data()
        let lineBreak = "\r\n"
        for part in parts {
            body.append(Data("--\(boundary)\(lineBreak)".utf8))
            var disposition = "Content-Disposition: form-data; name=\"\(Self.escape(part.name))\""
            if let filename = part.filename {
                disposition += "; filename=\"\(Self.escape(filename))\""
            }
            body.append(Data("\(disposition)\(lineBreak)".utf8))
            if let contentType = part.contentType {
                body.append(Data("Content-Type: \(contentType)\(lineBreak)".utf8))
            }
            body.append(Data(lineBreak.utf8))
            body.append(part.data)
            body.append(Data(lineBreak.utf8))
        }
        body.append(Data("--\(boundary)--\(lineBreak)".utf8))
        return body
    }

    /// The HTML form encoding of a name or file name inside its quotes: a line break and a
    /// double quote are percent-escaped, so neither can end the header.
    static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "\r", with: "%0D")
            .replacingOccurrences(of: "\n", with: "%0A")
            .replacingOccurrences(of: "\"", with: "%22")
    }
}
