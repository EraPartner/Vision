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
        let layout = StatisticsFlowLayout(flow: flow)
        GeometryReader { geometry in
            let size = geometry.size
            Canvas { context, size in
                for link in layout.links {
                    guard let from = layout.nodes.first(where: { $0.id == link.source }),
                        let to = layout.nodes.first(where: { $0.id == link.target })
                    else { continue }
                    let active =
                        hoveredNode == nil && hoveredLink == nil || hoveredNode == link.source
                        || hoveredNode == link.target || hoveredLink == link.id
                    context.fill(
                        band(link: link, from: from, to: to, links: layout.links, size: size),
                        with: .color(color(from.node).opacity(active ? 0.36 : 0.08)))
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
                            let bounds = rect(node, size: size)
                            let label = CGRect(
                                x: node.column == layout.columnCount - 1 ? bounds.minX - 130 : bounds.maxX,
                                y: bounds.midY - 20, width: 130, height: 40)
                            return bounds.union(label).contains(location)
                        }?.id
                    hoveredLink =
                        hoveredNode == nil
                        ? layout.links.first { link in
                            guard let from = layout.nodes.first(where: { $0.id == link.source }),
                                let to = layout.nodes.first(where: { $0.id == link.target })
                            else { return false }
                            return band(link: link, from: from, to: to, links: layout.links, size: size).contains(
                                location)
                        }?.id : nil
                }
            }
            ForEach(layout.nodes) { node in
                let bounds = rect(node, size: size)
                RoundedRectangle(cornerRadius: 4).fill(color(node.node))
                    .frame(width: bounds.width, height: bounds.height)
                    .position(x: bounds.midX, y: bounds.midY)
                    .overlay(alignment: node.column == layout.columnCount - 1 ? .trailing : .leading) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(label(node.node)).font(.caption.weight(.medium)).lineLimit(2)
                            if hoveredNode == node.id {
                                MoneyText(
                                    amount: node.node.value, currency: currency, settings: settings, signed: false,
                                    colored: false
                                ).font(.caption2)
                            }
                        }.frame(width: 125, alignment: .leading)
                            .position(
                                x: node.column == layout.columnCount - 1 ? bounds.minX - 65 : bounds.maxX + 70,
                                y: bounds.midY)
                    }
                    .accessibilityLabel(label(node.node))
                    .accessibilityValue(
                        MoneyText.text(node.node.value, currency: currency, settings: settings, signed: false)
                    )
                    .allowsHitTesting(false)
            }
        }.frame(minHeight: 380)
            .onChange(of: hoveredNode) { _, _ in onHoverChange(hoveredNode, hoveredLink) }
            .onChange(of: hoveredLink) { _, _ in onHoverChange(hoveredNode, hoveredLink) }
    }
    private func rect(_ node: StatisticsFlowNodeLayout, size: CGSize) -> CGRect {
        let pad: CGFloat = 145
        let width: CGFloat = 16
        let plot = max(20, size.width - 2 * pad - width)
        return CGRect(
            x: pad + CGFloat(node.x) * plot, y: CGFloat(node.y) * (size.height - 24) + 12,
            width: width, height: CGFloat(node.height) * (size.height - 24))
    }
    private func band(
        link: StatisticsFlow.Link, from: StatisticsFlowNodeLayout, to: StatisticsFlowNodeLayout,
        links: [StatisticsFlow.Link], size: CGSize
    ) -> Path {
        let left = rect(from, size: size)
        let right = rect(to, size: size)
        let sourceTotal = max(from.node.value, links.filter { $0.source == link.source }.reduce(0) { $0 + $1.value })
        let targetTotal = max(to.node.value, links.filter { $0.target == link.target }.reduce(0) { $0 + $1.value })
        let preceding = links.prefix { $0.id != link.id }
        let sourceBefore = preceding.filter { $0.source == link.source }.reduce(0) { $0 + $1.value }
        let targetBefore = preceding.filter { $0.target == link.target }.reduce(0) { $0 + $1.value }
        let coordinate: (Decimal, Decimal, CGRect) -> CGFloat = { value, total, bounds in
            let ratio = total > 0 ? min(1, max(0, value / total)) : 0
            return bounds.minY + bounds.height * CGFloat(NSDecimalNumber(decimal: ratio).doubleValue)
        }
        let sourceTop = coordinate(sourceBefore, sourceTotal, left)
        let sourceBottom = coordinate(sourceBefore + link.value, sourceTotal, left)
        let targetTop = coordinate(targetBefore, targetTotal, right)
        let targetBottom = coordinate(targetBefore + link.value, targetTotal, right)
        var path = Path()
        path.move(to: CGPoint(x: left.maxX, y: sourceTop))
        let midpoint = (left.maxX + right.minX) / 2
        path.addCurve(
            to: CGPoint(x: right.minX, y: targetTop), control1: CGPoint(x: midpoint, y: sourceTop),
            control2: CGPoint(x: midpoint, y: targetTop))
        path.addLine(to: CGPoint(x: right.minX, y: targetBottom))
        path.addCurve(
            to: CGPoint(x: left.maxX, y: sourceBottom), control1: CGPoint(x: midpoint, y: targetBottom),
            control2: CGPoint(x: midpoint, y: sourceBottom))
        path.closeSubpath()
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
