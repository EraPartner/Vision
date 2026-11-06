import Foundation

/// The range of a chart's range compare, normalized so it always reads earlier to later.
public struct ChartScrubRange: Equatable, Sendable {
    public let startIndex: Int
    public let endIndex: Int
}

/// `useChartScrub` (scrub.ts): the range-compare gesture of the time-series charts. The chart
/// owns hit-testing (x to index); this state owns the gesture:
///
/// - press, drag, release: compare the dragged range; it stays after release until the next
///   click, Escape or focus loss.
/// - click, move, click: the first click anchors a point, the range follows the pointer, the
///   second click pins it.
///
/// Leaving the chart keeps both. Shift+arrow anchors and extends from the keyboard. The range
/// is held as indices, so `sync(timeline:)` drops it when the data moves to another timeline.
public struct ChartScrub: Equatable, Sendable {
    /// `drag`: button held, the head follows the pointer. `follow`: a click anchored a point and
    /// the head follows the hover. `pinned`: the pointer no longer moves the range.
    public enum Phase: Equatable, Sendable { case idle, drag, follow, pinned }

    /// `CLICK_SLOP_PX`: points a press may wander and still be a click, on any data density.
    public static let clickSlop: Double = 4

    public private(set) var phase: Phase = .idle
    public private(set) var anchor: Int?
    public private(set) var head: Int?
    /// The x of the press that set the anchor; `nil` for a keyboard anchor.
    private var anchorX: Double?
    /// The current drag started on a pinned range: a plain click dismisses it.
    private var fromPinned = false
    /// The timeline the indices belong to.
    private var timeline: String?

    public init() {}

    public var scrubbing: Bool { anchor != nil }
    /// The pointer moves the head (`drag` or `follow`).
    public var tracking: Bool { phase == .drag || phase == .follow }

    public var range: ChartScrubRange? {
        guard let anchor, let head, anchor != head else { return nil }
        return ChartScrubRange(startIndex: min(anchor, head), endIndex: max(anchor, head))
    }

    private func nearAnchor(_ x: Double) -> Bool {
        guard let anchorX else { return false }
        return abs(x - anchorX) <= Self.clickSlop
    }

    /// A primary-button press at `index`, at plot x `x`.
    public mutating func press(_ index: Int, x: Double) {
        if phase == .follow {
            // Second click of click-move-click: pin, or cancel on the anchor.
            if index == anchor || nearAnchor(x) {
                clear()
            } else {
                phase = .pinned
                head = index
            }
            return
        }
        fromPinned = phase == .pinned
        phase = .drag
        anchor = index
        head = index
        anchorX = x
    }

    /// A pointer move while held or following.
    public mutating func hover(_ index: Int, x: Double) {
        guard tracking else { return }
        let next = phase == .drag && nearAnchor(x) ? anchor : index
        if next != head { head = next }
    }

    public mutating func release() {
        guard phase == .drag else { return }
        if head != anchor {
            phase = .pinned
        } else if fromPinned {
            // A click without a drag dismisses a pinned range.
            clear()
        } else {
            phase = .follow
        }
    }

    /// Shift+arrow without a range: anchor at `index`.
    public mutating func begin(_ index: Int) {
        phase = .pinned
        anchor = index
        head = index
        anchorX = nil
        fromPinned = false
    }

    /// Shift+arrow: moves the head; the keyboard taking over a click anchor pins it.
    public mutating func move(_ index: Int) {
        guard anchor != nil else { return }
        if phase == .follow { phase = .pinned }
        head = index
    }

    public mutating func clear() {
        let timeline = timeline
        self = ChartScrub()
        self.timeline = timeline
    }

    /// Drops the range when the data moves to another timeline (`length:first:last`), not on a
    /// new array of the same one.
    public mutating func sync(timeline next: String) {
        guard next != timeline else { return }
        clear()
        timeline = next
    }

    /// The timeline key of a series of x values.
    public static func timeline(count: Int, first: Double?, last: Double?) -> String {
        guard let first, let last, count > 0 else { return "empty" }
        return "\(count):\(first):\(last)"
    }

    /// The shared keyboard map (keyboardNav.ts) for a chart with `count` points and highlight
    /// `index`: ←/→ step, Home/End jump, Shift+←/→ extends the range, any plain step ends it.
    /// Returns the next highlighted index, or `nil` for a key it does not handle.
    public mutating func key(_ key: ChartKey, shift: Bool, index: Int?, count: Int) -> Int? {
        guard count > 0 else { return nil }
        let last = count - 1
        let extending = shift && (key == .left || key == .right)
        let from = extending && scrubbing ? head : index
        let next: Int
        switch key {
        case .right: next = from.map { min(last, $0 + 1) } ?? 0
        case .left: next = from.map { max(0, $0 - 1) } ?? last
        case .home: next = 0
        case .end: next = last
        }
        if extending {
            if !scrubbing { begin(index ?? (key == .right ? 0 : last)) }
            move(next)
        } else if scrubbing {
            clear()
        }
        return next
    }

    public enum ChartKey: Equatable, Sendable { case left, right, home, end }
}

/// One series of a range compare (`ScrubSeries`): `value(index)` reads its value at a point.
public struct ChartScrubSeries: Sendable {
    public let key: String
    public let label: String?
    /// The chart's main series: it leads the readout and tints the band.
    public let primary: Bool
    public let value: @Sendable (Int) -> Double?

    public init(key: String, label: String? = nil, primary: Bool = false, value: @escaping @Sendable (Int) -> Double?) {
        self.key = key
        self.label = label
        self.primary = primary
        self.value = value
    }
}

/// `ScrubRow`: the first and last value of a series inside the range.
public struct ChartScrubRow: Equatable, Sendable {
    public let key: String
    public let label: String?
    public let start: Double
    public let end: Double
    /// The points `start` and `end` were read from.
    public let startIndex: Int
    public let endIndex: Int
    /// The series has no value at an end of the range, so its change spans less.
    public let partial: Bool

    public var delta: Double { end - start }
}

/// `ScrubView`: what to draw for the current range compare.
public struct ChartScrubView: Equatable, Sendable {
    public let startIndex: Int
    public let endIndex: Int
    /// Rows in readout order: the primary series first.
    public let rows: [ChartScrubRow]
    /// The row the band is tinted by; `nil` when no series stands for the chart.
    public let lead: ChartScrubRow?
    /// More than one series is plotted, so a row needs its name.
    public let labelled: Bool
    /// False while only a point is anchored.
    public let isRange: Bool

    /// `scrubView`: the range, or just the anchored point; `nil` without either.
    public init?(_ scrub: ChartScrub, count: Int, series: [ChartScrubSeries]) {
        let range = scrub.range
        guard let startIndex = range?.startIndex ?? scrub.anchor, let endIndex = range?.endIndex ?? scrub.anchor,
            startIndex >= 0, endIndex < count
        else { return nil }
        let rows = Self.rows(series, startIndex: startIndex, endIndex: endIndex)
        let lead: ChartScrubRow?
        if let primary = series.first(where: \.primary) {
            lead = rows.first { $0.key == primary.key }
        } else {
            lead = series.count == 1 ? rows.first : nil
        }
        self.startIndex = startIndex
        self.endIndex = endIndex
        self.rows = lead.map { lead in [lead] + rows.filter { $0.key != lead.key } } ?? rows
        self.lead = lead
        labelled = series.count > 1
        isRange = range != nil
    }

    /// `scrubRows`: a series without a value at an end reads its nearest one inside the range
    /// and is marked partial; one value inside a real range has no change to report.
    public static func rows(_ series: [ChartScrubSeries], startIndex: Int, endIndex: Int) -> [ChartScrubRow] {
        series.compactMap { line in
            func read(_ index: Int) -> Double? { line.value(index).flatMap { $0.isFinite ? $0 : nil } }
            guard let first = (startIndex...endIndex).first(where: { read($0) != nil }),
                let last = (startIndex...endIndex).reversed().first(where: { read($0) != nil }),
                let start = read(first), let end = read(last)
            else { return nil }
            if first == last, startIndex != endIndex { return nil }
            return ChartScrubRow(
                key: line.key, label: line.label, start: start, end: end, startIndex: first, endIndex: last,
                partial: first != startIndex || last != endIndex)
        }
    }

    /// The band's tint: gain, loss, or neutral without a lead or change.
    public var trend: Trend {
        guard let lead, lead.end != lead.start else { return .neutral }
        return lead.end > lead.start ? .gain : .loss
    }

    public enum Trend: Equatable, Sendable { case gain, loss, neutral }
}

public enum ChartScrubDelta {
    /// `formatScrubDelta`: the absolute change, plus the percent when `formatPercent` is given
    /// and the start is not 0. A sign the value formatter adds itself is replaced by ours.
    public static func text(
        start: Double, end: Double, formatValue: (Double) -> String, formatPercent: ((Double) -> String)?
    ) -> String {
        let delta = end - start
        let sign = delta > 0 ? "+" : delta < 0 ? "−" : "±"
        var magnitude = formatValue(abs(delta))
        if let first = magnitude.first, "+-−±".contains(first) {
            magnitude.removeFirst()
            if magnitude.first?.isWhitespace == true { magnitude.removeFirst() }
        }
        guard start != 0, let formatPercent else { return "Δ \(sign)\(magnitude)" }
        let percent = delta / abs(start) * 100
        let percentSign = percent > 0 ? "+" : percent < 0 ? "−" : ""
        return "Δ \(sign)\(magnitude) (\(percentSign)\(formatPercent(abs(percent))))"
    }
}
