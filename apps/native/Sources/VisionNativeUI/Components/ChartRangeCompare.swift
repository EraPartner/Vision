import AppKit
import SwiftUI
import VisionNativeCore

/// The range-compare layer of a chart (`ScrubBand`, `ScrubReadout` and `useChartPointer`,
/// components/charts): it sits in the chart's `chartOverlay`, hit-tests the pointer, drives
/// `ChartScrub`, and draws the tinted band with edge hairlines and value dots inside the plot
/// and the Δ readout over it. The chart supplies plot coordinates, so any x scale works.
///
/// The web's pointer-cancel paths (a touch the browser takes for a scroll, a second finger,
/// lost pointer capture) have no macOS counterpart: a mouse or trackpad press always ends with
/// a release.
struct ChartRangeCompareLayer: View {
    @Binding var scrub: ChartScrub
    /// The plot rect inside the overlay's geometry.
    let plot: CGRect
    /// What to draw; `nil` while nothing is anchored.
    let view: ChartScrubView?
    /// The nearest point to a plot x.
    let indexAt: (CGFloat) -> Int?
    /// The plot x of a point.
    let xOf: (Int) -> CGFloat?
    /// The plot y of a row's value; `nil` hides that dot.
    let yOf: (ChartScrubRow, Double) -> CGFloat?
    let colorOf: (String) -> Color
    /// The tooltip title of a point: the period, and the span of a partial row.
    let titleOf: (Int) -> String
    let deltaOf: (ChartScrubRow) -> String
    /// The highlighted point; `nil` when the pointer leaves.
    let onHover: (Int?) -> Void
    /// A press focuses the chart, so Escape and the arrows reach it.
    var onPress: () -> Void = {}
    /// Rows beyond this are summarized as "+N".
    var maxRows = 4
    /// `scrubbable`: off, a press only highlights and focuses.
    var scrubbable = true

    @State private var pressing = false
    @State private var ignoringPress = false
    @Environment(\.visionTheme) private var theme
    @Environment(\.visionFullEffects) private var fullEffects

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let view { band(view).offset(x: plot.minX, y: plot.minY).allowsHitTesting(false) }
            Rectangle().fill(.clear).contentShape(Rectangle())
                .frame(width: max(plot.width, 0), height: max(plot.height, 0))
                .offset(x: plot.minX, y: plot.minY)
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let location):
                        // Scrolling re-reports a parked pointer every frame: write on change only.
                        guard let index = indexAt(location.x) else { return }
                        onHover(index)
                        if scrub.tracking { scrub.hover(index, x: location.x) }
                    case .ended:
                        // Leaving keeps a range or anchor: a drag may end outside the plot.
                        onHover(nil)
                    }
                }
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            let x = value.location.x
                            if !pressing {
                                pressing = true
                                // Control-click opens the context menu on macOS.
                                ignoringPress = !scrubbable || NSEvent.modifierFlags.contains(.control)
                                if !scrubbable { onPress() }
                                guard !ignoringPress, let index = indexAt(value.startLocation.x) else { return }
                                onPress()
                                scrub.press(index, x: value.startLocation.x)
                            }
                            guard let index = indexAt(x) else { return }
                            onHover(index)
                            if !ignoringPress, scrub.tracking { scrub.hover(index, x: x) }
                        }
                        .onEnded { _ in
                            pressing = false
                            if !ignoringPress { scrub.release() }
                            ignoringPress = false
                        })
            if let view, view.isRange { readout(view) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func trendColor(_ view: ChartScrubView) -> Color {
        switch view.trend {
        case .gain: return theme.gain
        case .loss: return theme.loss
        case .neutral: return theme.secondaryLabel
        }
    }

    @ViewBuilder
    private func band(_ view: ChartScrubView) -> some View {
        if let start = xOf(view.startIndex), let end = xOf(view.endIndex) {
            let color = trendColor(view)
            let width = abs(end - start)
            let height = plot.height
            Canvas { context, _ in
                if width > 0 {
                    context.fill(
                        Path(CGRect(x: min(start, end), y: 0, width: width, height: height)),
                        with: .color(color.opacity(0.1)))
                }
                for x in width > 0 ? [start, end] : [start] {
                    var line = Path()
                    line.move(to: CGPoint(x: x, y: 0))
                    line.addLine(to: CGPoint(x: x, y: height))
                    context.stroke(line, with: .color(color.opacity(0.7)), lineWidth: 1)
                }
                let ends: [Bool] = width > 0 ? [true, false] : [true]
                for isStart in ends {
                    for row in view.rows {
                        let index = isStart ? row.startIndex : row.endIndex
                        guard let x = xOf(index), let y = yOf(row, isStart ? row.start : row.end) else { continue }
                        let dot = Path(ellipseIn: CGRect(x: x - 3.5, y: y - 3.5, width: 7, height: 7))
                        context.fill(dot, with: .color(theme.background))
                        context.stroke(dot, with: .color(colorOf(row.key)), lineWidth: 2)
                    }
                }
            }
            .frame(width: max(plot.width, 0), height: max(height, 0))
            .accessibilityHidden(true)
        }
    }

    /// The Δ readout over the range: the period, then the change per series. It tracks the
    /// range's middle and shifts by the same share of its own width as the middle is of the
    /// chart's, so it never leaves the chart box.
    @ViewBuilder
    private func readout(_ view: ChartScrubView) -> some View {
        if !view.rows.isEmpty, let start = xOf(view.startIndex), let end = xOf(view.endIndex) {
            GeometryReader { geometry in
                let width = geometry.size.width
                let mid = plot.minX + (start + end) / 2
                let share = width > 0 ? min(1, max(0, mid / width)) : 0.5
                let shown = Array(view.rows.prefix(maxRows))
                // The zero-height spacer spans the chart box; the readout's leading guide puts it
                // at `mid - share * its width` within it.
                ZStack(alignment: .topLeading) {
                Color.clear.frame(width: max(width, 0), height: 0)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: "\(titleOf(view.startIndex)) – \(titleOf(view.endIndex))")
                        .foregroundStyle(theme.secondaryLabel)
                    ForEach(shown, id: \.key) { row in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            if view.labelled {
                                Circle().fill(colorOf(row.key)).frame(width: 8, height: 8).accessibilityHidden(true)
                                Text(verbatim: row.label ?? row.key).foregroundStyle(theme.secondaryLabel)
                            }
                            Text(verbatim: deltaOf(row)).lineLimit(1).fixedSize()
                                .foregroundStyle(row.delta > 0 ? theme.gain : row.delta < 0 ? theme.loss : theme.foreground)
                            if row.partial {
                                Text(verbatim: "\(titleOf(row.startIndex)) – \(titleOf(row.endIndex))")
                                    .foregroundStyle(theme.tertiaryLabel)
                            }
                        }
                        .font(.footnote.weight(.medium))
                    }
                    if view.rows.count > shown.count {
                        Text(verbatim: "+\(view.rows.count - shown.count)").foregroundStyle(theme.secondaryLabel)
                    }
                }
                .font(.footnote)
                .monospacedDigit()
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(readoutBackground)
                .frame(maxWidth: width > 0 ? width : nil, alignment: .leading)
                .fixedSize(horizontal: width <= 0, vertical: true)
                .alignmentGuide(.leading) { dimensions in dimensions.width * share - mid }
                }
                .padding(.top, 2)
                .allowsHitTesting(false)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
            }
        }
    }

    @ViewBuilder
    private var readoutBackground: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        if fullEffects {
            VisionGlassSurface(material: .thick, cornerRadius: 12)
        } else {
            shape.fill(theme.card)
                .overlay(shape.strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
                .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
        }
    }
}

extension KeyPress {
    /// The chart key map's keys (keyboardNav.ts): ←/→, Home and End.
    var chartKey: ChartScrub.ChartKey? {
        if key == .leftArrow { return .left }
        if key == .rightArrow { return .right }
        if key == .home || characters == "\u{F729}" { return .home }
        if key == .end || characters == "\u{F72B}" { return .end }
        return nil
    }
}

/// `useChartKeyboardNav` for a chart that highlights points by index.
enum ChartKeyboard {
    /// ←/→ step, Home/End jump, Shift+←/→ extends the range compare, Escape clears the highlight
    /// and range (and is left to an enclosing dialog when there is neither).
    static func handle(_ press: KeyPress, scrub: inout ChartScrub, selected: inout Int?, count: Int)
        -> KeyPress.Result
    {
        if press.key == .escape {
            guard selected != nil || scrub.scrubbing else { return .ignored }
            selected = nil
            scrub.clear()
            return .handled
        }
        guard let key = press.chartKey,
            let next = scrub.key(key, shift: press.modifiers.contains(.shift), index: selected, count: count)
        else { return .ignored }
        selected = next
        return .handled
    }
}
