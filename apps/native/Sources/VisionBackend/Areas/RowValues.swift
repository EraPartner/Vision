import Foundation
import VisionNativeCore

extension SQLRow {
    /// An `INTEGER` id column as the generated identifier types hold it.
    func integerId(_ column: String) throws -> Int {
        let value = try int64(column)
        guard let id = Int(exactly: value) else {
            throw SQLRowDecodingError(column: column, problem: "id \(value) is out of range")
        }
        return id
    }

    /// A `TIMESTAMPTZ_TEXT` column as `res.json` writes the `Date` node:sqlite's reader made of
    /// it (`sqlite/values.ts`): the canonical text cut to milliseconds, `YYYY-MM-DDTHH:mm:ss.sssZ`.
    func instant(_ column: String) throws -> Instant {
        let text = try self.text(column)
        guard let iso = Self.isoMilliseconds(fromCanonical: text), let instant = Instant(iso) else {
            throw SQLRowDecodingError(column: column, problem: "\(text) is not a canonical timestamp")
        }
        return instant
    }

    /// `CANONICAL_TS` of `sqlite/values.ts`: `YYYY-MM-DDTHH:MM:SS.ffffffZ`.
    static func isoMilliseconds(fromCanonical text: String) -> String? {
        let bytes = Array(text.utf8)
        guard bytes.count == 27 else { return nil }
        let digitPositions = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18] + Array(20...25)
        let separators: [Int: UInt8] = [4: 45, 7: 45, 10: 84, 13: 58, 16: 58, 19: 46, 26: 90]
        guard digitPositions.allSatisfy({ (48...57).contains(bytes[$0]) }),
            separators.allSatisfy({ bytes[$0.key] == $0.value })
        else { return nil }
        return String(decoding: bytes[0..<23], as: UTF8.self) + "Z"
    }
}
