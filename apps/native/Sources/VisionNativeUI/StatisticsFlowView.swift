import SwiftUI
import VisionNativeCore

struct StatisticsFlowView: View {
    let flow: StatisticsFlow
    let settings: NativeAppSettings
    let currency: String
    let strings: any Localizing
    @State private var hoveredNode: String?
    private let onHoverChange: (String?, String?) -> Void
    @State private var hoveredLink: String?
    @Environment(\.visionTheme) private var theme

    init(
        flow: StatisticsFlow, settings: NativeAppSettings, currency: String, strings: any Localizing,
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
            Canvas { context, _ in
                for link in layout.links {
                    let isHovered =
                        hoveredLink == link.id || hoveredNode == link.link.source || hoveredNode == link.link.target
                    // Stroked with the target node's colour, 25% opaque, 60% when highlighted.
                    let target = layout.nodes.first { $0.id == link.link.target }
                    context.stroke(
                        curve(link, margin: margin),
                        with: .color(target.map { color($0.node) }?.opacity(isHovered ? 0.6 : 0.25) ?? theme.mutedForeground),
                        style: StrokeStyle(lineWidth: max(1, CGFloat(link.width))))
                }
            }
            .onContinuousHover { phase in
                switch phase {
                case .ended:
                    hoveredNode = nil
                    hoveredLink = nil
                case .active(let location):
                    hoveredNode =
                        layout.nodes.first { node in
                            let bounds = rect(node, margin: margin)
                            let label = CGRect(
                                x: node.labelsLeading ? bounds.minX - 6 - Self.labelWidth : bounds.maxX,
                                y: bounds.midY - 8, width: Self.labelWidth + 6, height: 16)
                            return bounds.union(label).contains(location)
                        }?.id
                    hoveredLink =
                        hoveredNode == nil
                        ? layout.links.first { link in
                            curve(link, margin: margin)
                                .strokedPath(StrokeStyle(lineWidth: max(1, CGFloat(link.width))))
                                .contains(location)
                        }?.id : nil
                }
            }
            ForEach(layout.nodes) { node in
                let bounds = rect(node, margin: margin)
                // Labels 6 pt off the node edge at its vertical middle, like the web chart: nodes in
                // the right half carry theirs on the left (end-anchored), all others on the right.
                let leading = node.labelsLeading
                RoundedRectangle(cornerRadius: 3).fill(color(node.node).opacity(hoveredNode == node.id ? 1 : 0.85))
                    .frame(width: bounds.width, height: bounds.height)
                    .position(x: bounds.midX, y: bounds.midY)
                    .overlay {
                        VStack(alignment: leading ? .trailing : .leading, spacing: 2) {
                            Text(label(node.node)).font(.system(size: 11))
                                .foregroundStyle(theme.foreground)
                                .lineLimit(1).truncationMode(.tail)
                            if hoveredNode == node.id {
                                MoneyText(
                                    amount: node.value, currency: currency, settings: settings, signed: false,
                                    colored: false
                                ).font(.system(size: 10)).foregroundStyle(theme.mutedForeground)
                            }
                        }
                        .frame(width: Self.labelWidth, alignment: leading ? .trailing : .leading)
                        .position(
                            x: leading
                                ? bounds.minX - 6 - Self.labelWidth / 2 : bounds.maxX + 6 + Self.labelWidth / 2,
                            y: bounds.midY + (hoveredNode == node.id ? 7 : 0))
                    }
                    .accessibilityLabel(label(node.node))
                    .accessibilityValue(
                        MoneyText.text(node.value, currency: currency, settings: settings, signed: false)
                    )
                    .allowsHitTesting(false)
            }
        }.frame(minHeight: 380)
            .onChange(of: hoveredNode) { _, _ in onHoverChange(hoveredNode, hoveredLink) }
            .onChange(of: hoveredLink) { _, _ in onHoverChange(hoveredNode, hoveredLink) }
    }
    private static let labelWidth: CGFloat = 132

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
