import SwiftUI

/// An SF Symbol by name, or one of Vision's own glyphs where SF Symbols has none. Views that take
/// a symbol name (page headers, empty states, asset tiles) draw it through this, so a custom name
/// works wherever an SF Symbol name does.
struct VisionSymbol: View {
    let name: String
    var size: CGFloat
    var weight: Font.Weight = .regular

    init(_ name: String, size: CGFloat, weight: Font.Weight = .regular) {
        self.name = name
        self.size = size
        self.weight = weight
    }

    /// A gold bar (ingot), for precious metals. SF Symbols has no ingot, and the web's lucide
    /// `Gem` read as a jewel rather than bullion.
    static let goldBar = "vision.goldbar"

    var body: some View {
        if name == Self.goldBar {
            GoldBarShape()
                .stroke(style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                // The ingot is wider than tall, like `rectangle`-family symbols at the same size.
                .frame(width: size * 1.3, height: size * 1.05)
        } else {
            Image(systemName: name).font(.system(size: size, weight: weight))
        }
    }

    /// Close to the stroke of an SF Symbol at the same point size and weight.
    private var lineWidth: CGFloat {
        let scale: CGFloat
        switch weight {
        case .ultraLight, .thin, .light: scale = 0.065
        case .medium: scale = 0.09
        case .semibold, .bold, .heavy, .black: scale = 0.105
        default: scale = 0.08
        }
        return max(1, size * scale)
    }
}

/// A trapezoidal bar seen from the front and a little above: the sloped front face, the top face
/// and the right end.
struct GoldBarShape: Shape {
    func path(in rect: CGRect) -> Path {
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * rect.width, y: rect.minY + y * rect.height)
        }
        var path = Path()
        // Outline: front bottom edge, right end, back top edge, front top-left corner.
        path.move(to: point(0.04, 0.86))
        path.addLine(to: point(0.78, 0.86))
        path.addLine(to: point(0.96, 0.68))
        path.addLine(to: point(0.84, 0.22))
        path.addLine(to: point(0.34, 0.22))
        path.addLine(to: point(0.18, 0.40))
        path.closeSubpath()
        // The front face's top edge and its right edge, which separate the three faces.
        path.move(to: point(0.18, 0.40))
        path.addLine(to: point(0.66, 0.40))
        path.addLine(to: point(0.84, 0.22))
        path.move(to: point(0.66, 0.40))
        path.addLine(to: point(0.78, 0.86))
        return path
    }
}
