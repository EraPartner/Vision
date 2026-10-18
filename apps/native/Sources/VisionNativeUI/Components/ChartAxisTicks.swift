import Foundation

/// Tick values for a categorical (String-keyed) chart axis. Swift Charts labels every
/// category of such an axis whatever `.automatic(desiredCount:)` asks for, so a daily
/// series drew one grid line and one overlapping label per day.
enum ChartAxisTicks {
    /// At most `count` keys spread evenly over `keys`, always including the first and last.
    static func evenlySpaced<Key>(_ keys: [Key], count: Int = 6) -> [Key] {
        guard count > 1, keys.count > count else { return keys }
        let step = Double(keys.count - 1) / Double(count - 1)
        return (0..<count).map { keys[Int((Double($0) * step).rounded())] }
    }
}
