import SwiftUI
import VisionNativeCore

struct StatisticsFlowView: View {
    let flow: StatisticsFlow
    let settings: NativeAppSettings
    let currency: CurrencyCode
    let strings: any Localizing
    @State private var hoveredNode: String?
    private let onHoverChange: (String?, String?) -> Void
    @State private var hoveredLink: String?
    @Environment(\.visionTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        flow: StatisticsFlow, settings: NativeAppSettings, currency: CurrencyCode, strings: any Localizing,
        initialNode: String? = nil, initialLink: String? = nil,
        onHoverChange: @escaping (String?, String?) -> Void = { _, _ in }
    ) {
        self.flow = flow
        self.settings = settings
        self.currency = currency
        self.strings = strings
        _hoveredNode = State(initialValue: initialNode)
        _hoveredLink = State(initialValue: initialLink)
        self.onHoverChange = onHoverChange
    }
    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            // Same layout as the web chart (ADR-245): d3-sankey positions inside 16 pt margins.
            let layout = StatisticsFlowLayout(flow: flow, width: size.width, height: size.height)
            let margin = CGFloat(StatisticsFlowLayout.margin)
            let fade: Animation? =
                reduceMotion ? nil : .visionCurve(DesignTokens.Ease.glide, duration: DesignTokens.Duration.fast)
            ZStack(alignment: .topLeading) {
                // Links as shapes, not a canvas, so the highlight fades (`transition: stroke-opacity`).
                ForEach(layout.links) { link in
                    let isHovered =
                        hoveredLink == link.id || hoveredNode == link.link.source || hoveredNode == link.link.target
                    // Stroked with the target node's colour, 25% opaque, 60% when highlighted.
                    let target = layout.nodes.first { $0.id == link.link.target }
                    // The band as its stroked outline, so the view's own shape is the hit area: the
                    // pointer is on a link only over its band, as an SVG `<path>` stroke is.
                    curve(link, margin: margin)
                        .strokedPath(StrokeStyle(lineWidth: max(1, CGFloat(link.width))))
                        .fill(target.map { color($0.node) } ?? theme.mutedForeground)
                        .opacity(isHovered ? 0.6 : 0.25)
                        .animation(fade, value: isHovered)
                        .onHover { inside in
                            // `onMouseEnter` / `onMouseLeave`; a late leave never clears a newer link.
                            if inside {
                                if hoveredLink != link.id { hoveredLink = link.id }
                            } else if hoveredLink == link.id {
                                hoveredLink = nil
                            }
                        }
                }
                .accessibilityHidden(true)
                ForEach(layout.nodes) { node in
                    let bounds = rect(node, margin: margin)
                    let isHovered = hoveredNode == node.id
                    // Labels 6 pt off the node edge at its vertical middle, like the web chart: nodes in
                    // the right half carry theirs on the left (end-anchored), all others on the right.
                    let leading = node.labelsLeading
                    let anchorX = leading ? bounds.minX - 6 : bounds.maxX + 6
                    RoundedRectangle(cornerRadius: 3).fill(color(node.node))
                        .opacity(isHovered ? 1 : 0.85)
                        .animation(fade, value: isHovered)
                        .frame(width: bounds.width, height: bounds.height)
                        .contentShape(Rectangle())
                        .onHover { inside in
                            if inside {
                                if hoveredNode != node.id { hoveredNode = node.id }
                            } else if hoveredNode == node.id {
                                hoveredNode = nil
                            }
                        }
                        .position(x: bounds.midX, y: bounds.midY)
                        .accessibilityLabel(label(node.node))
                        .accessibilityValue(
                            MoneyText.text(node.value, currency: currency, settings: settings, signed: false)
                        )
                    // A zero-width frame anchors the text at the node's edge whatever its length;
                    // the web label is never truncated.
                    Text(label(node.node)).font(.system(size: 11))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1).fixedSize()
                        .frame(width: 0, height: 0, alignment: leading ? .trailing : .leading)
                        .position(x: anchorX, y: bounds.midY)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    // The value, 14 pt under the label, while the node is hovered.
                    if isHovered {
                        MoneyText(
                            amount: node.value, currency: currency, settings: settings, signed: false, colored: false
                        )
                        .font(.system(size: 10)).foregroundStyle(theme.mutedForeground)
                        .lineLimit(1).fixedSize()
                        .frame(width: 0, height: 0, alignment: leading ? .trailing : .leading)
                        .position(x: anchorX, y: bounds.midY + 14)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    }
                }
            }
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            // Each node bar and link band tracks its own hover (SVG `onMouseEnter`/`onMouseLeave`),
            // nodes drawn over links. One tracker for the whole chart, testing nodes first by their
            // rectangles, lit a node's whole section over the band beside it.
        }.frame(minHeight: 380)
            .onChange(of: hoveredNode) { _, _ in onHoverChange(hoveredNode, hoveredLink) }
            .onChange(of: hoveredLink) { _, _ in onHoverChange(hoveredNode, hoveredLink) }
    }


    /// The node's rectangle in view coordinates; at least 1 pt tall, as on the web.
    private func rect(_ node: StatisticsFlowNodeLayout, margin: CGFloat) -> CGRect {
        CGRect(
            x: margin + CGFloat(node.x0), y: margin + CGFloat(node.y0),
            width: CGFloat(node.x1 - node.x0), height: max(1, CGFloat(node.y1 - node.y0)))
    }
    /// The link's centre line: the web `sankeyLinkPath` curve, M sx,y0 C mx,y0 mx,y1 tx,y1.
    private func curve(_ link: StatisticsFlowLinkLayout, margin: CGFloat) -> Path {
        let sx = margin + CGFloat(link.sourceX)
        let tx = margin + CGFloat(link.targetX)
        let mx = (sx + tx) / 2
        let sy = margin + CGFloat(link.sourceY)
        let ty = margin + CGFloat(link.targetY)
        var path = Path()
        path.move(to: CGPoint(x: sx, y: sy))
        path.addCurve(to: CGPoint(x: tx, y: ty), control1: CGPoint(x: mx, y: sy), control2: CGPoint(x: mx, y: ty))
        return path
    }
    private func label(_ node: StatisticsFlow.Node) -> String {
        let keys = [
            "__income__": "income", "__spending__": "spending", "__funding_gap__": "fundingGap",
            "__uncategorised__": "uncategorised", "__other__": "other", "__savings__": "savings",
        ]
        return keys[node.id].map { strings.t("statsPage.sankey.\($0)") } ?? node.label
    }
    private func color(_ node: StatisticsFlow.Node) -> Color {
        let key = node.id.hasPrefix("cat:") ? node.label : node.id
        let root =
            key.split(separator: ":", maxSplits: 1).first.map(String.init)?.trimmingCharacters(in: .whitespaces)
            .uppercased() ?? ""
        var hash: Int32 = 0
        for character in root.utf16 { hash = hash &* 31 &+ Int32(character) }
        let p = theme.palette
        return Color(
            token: [p.chart1, p.chart2, p.chart3, p.chart4, p.chart5, p.chart6, p.chart7, p.chart8][
                Int(abs(Int64(hash)) % 8)])
    }
}
