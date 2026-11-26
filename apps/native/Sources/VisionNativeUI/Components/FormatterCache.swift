import Foundation
import VisionNativeCore

/// Foundation formatters are expensive to create, and chart axis labels and list rows format
/// on every body pass (every frame while a sidebar or window resize relays out a chart).
/// Views build each configuration once, keyed by everything that configures it, and never
/// mutate a formatter they get back. The store is `SharedFormatters`, which Core shares too.
@MainActor
enum FormatterCache {
    static func shared<F: Formatter>(_ key: String, make: () -> F) -> F {
        SharedFormatters.shared(key, make: make)
    }
}
