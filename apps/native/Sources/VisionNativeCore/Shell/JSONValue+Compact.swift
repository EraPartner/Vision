import Foundation

extension JSONValue {
    /// Single-line JSON with sorted keys, for replies and persisted payloads.
    public func compactJSONString() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(self), as: UTF8.self)
    }
}
