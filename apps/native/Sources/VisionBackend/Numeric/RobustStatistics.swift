import Foundation

/// The numeric helpers of `apps/node-backend/src/lib/math.ts`, on doubles as there.
enum RobustStatistics {
    /// `median(values)`: `nil` for no values. The values must not be NaN, which JavaScript's
    /// comparator sort orders by its own algorithm.
    static func median(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        let sorted = values.sorted()
        let middle = sorted.count / 2
        return sorted.count % 2 == 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
    }

    /// `MadReturnStats`.
    struct ReturnStatistics: Equatable, Sendable {
        var medianReturn: Double
        var robustSigma: Double
        var spikeThreshold: Double
        var bridgeThreshold: Double
        var minimumSpikeMove: Double
    }

    /// `madReturnStats(logReturns)`: median, MAD-based sigma (floored at 0.0015) and the
    /// needle thresholds derived from them.
    static func returnStatistics(_ logReturns: [Double]) -> ReturnStatistics {
        let medianReturn = median(logReturns) ?? 0
        let deviation = median(logReturns.map { ($0 - medianReturn).magnitude }) ?? 0
        let robustSigma = Swift.max(1.4826 * deviation, 0.0015)
        return ReturnStatistics(
            medianReturn: medianReturn, robustSigma: robustSigma, spikeThreshold: 6 * robustSigma,
            bridgeThreshold: 4 * robustSigma, minimumSpikeMove: log(1.18))
    }

    /// `isRobustNeedle(prev, current, next, stats)`: the middle price jumps away and reverts
    /// while the bridge from `previous` to `next` looks normal. Prices must be positive.
    static func isNeedle(previous: Double, current: Double, next: Double, _ statistics: ReturnStatistics) -> Bool {
        let jump = log(current / previous)
        let revert = log(next / current)
        let bridge = log(next / previous)
        func large(_ move: Double) -> Bool {
            (move - statistics.medianReturn).magnitude > statistics.spikeThreshold
                && move.magnitude > statistics.minimumSpikeMove
        }
        let opposite = (jump > 0 && revert < 0) || (jump < 0 && revert > 0)
        return large(jump) && large(revert) && opposite
            && (bridge - statistics.medianReturn).magnitude <= statistics.bridgeThreshold
    }

    /// `nanToZero(value)`: NaN and a missing value read as 0.
    static func nanToZero(_ value: Double?) -> Double {
        guard let value, !value.isNaN else { return 0 }
        return value
    }

    /// `nonZeroOr(value, fallback)`: `fallback` for 0, NaN and a missing value.
    static func nonZero(_ value: Double?, or fallback: Double) -> Double {
        guard let value, value != 0, !value.isNaN else { return fallback }
        return value
    }

    /// `firstNonZero(...comparisons)`: the first comparison result that decides, or 0.
    static func firstNonZero(_ comparisons: Double...) -> Double {
        comparisons.first { $0 != 0 && !$0.isNaN } ?? 0
    }
}
