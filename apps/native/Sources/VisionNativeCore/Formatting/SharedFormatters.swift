import Foundation

/// The one process-wide cache of Foundation formatters. Creating a `DateFormatter` or
/// `NumberFormatter` costs far more than using one, and period labels, axis ticks and list rows
/// format on every body pass. Each configuration is built once, keyed by everything that
/// configures it; callers never mutate a formatter they get back, and formatting with a shared
/// one is thread-safe, so any actor may read the cache.
public enum SharedFormatters {
    private static let lock = NSLock()
    // lint:allow nonisolated-unsafe every read and write holds `lock`
    private nonisolated(unsafe) static var formatters: [String: Formatter] = [:]

    public static func shared<F: Formatter>(_ key: String, make: () -> F) -> F {
        let key = "\(F.self)|\(key)"
        lock.lock()
        defer { lock.unlock() }
        if let cached = formatters[key] as? F { return cached }
        let formatter = make()
        formatters[key] = formatter
        return formatter
    }
}
