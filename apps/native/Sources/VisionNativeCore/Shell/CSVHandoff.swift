import Foundation

/// Finder "open with" and dock drops of a CSV (`forwardCsvOpen` in packaging/electron/main.ts):
/// the shell reads the file and hands its contents to the import page as `app:csv-opened`,
/// so the page never needs file system access.
public enum CSVHandoff {
    /// `CSV_OPEN_MAX_BYTES`.
    public static let maximumBytes = 25 * 1024 * 1024

    public static func accepts(path: String, isRegularFile: Bool, size: Int?) -> Bool {
        guard path.lowercased().hasSuffix(".csv"), isRegularFile, let size else { return false }
        return size <= maximumBytes
    }

    /// The `app:csv-opened` payload, `{ name, content }`; invalid UTF-8 is replaced.
    public static func payload(name: String, data: Data) -> JSONValue {
        .object(["name": .string(name), "content": .string(String(decoding: data, as: UTF8.self))])
    }
}
