import Foundation

/// Foundation formatters are expensive to create, and chart axis labels and list rows format
/// on every body pass (every frame while a sidebar or window resize relays out a chart).
/// Views build each configuration once here, keyed by everything that configures it, and
/// never mutate a formatter they get back.
@MainActor
enum FormatterCache {
    private static var formatters: [String: Formatter] = [:]

    static func shared<F: Formatter>(_ key: String, make: () -> F) -> F {
        let key = "\(F.self)|\(key)"
        if let cached = formatters[key] as? F { return cached }
        let formatter = make()
        formatters[key] = formatter
        return formatter
    }
}
