import AppKit
import SwiftUI
import VisionNativeCore

/// A glass card surface as Core Animation layers: the material gradient, the embossed inset
/// edge, the frame and the outer and lift shadows. SwiftUI drew the gradient fill and the
/// gradient edge stroke into CPU bitmaps, re-rendered tile by tile while a tall card (the ledger)
/// scrolled; the render server draws these layers on the GPU, as the browser compositor draws the
/// CSS card. The look is `VisionCardBackground`'s; see there for the web sources.
struct VisionCardLayers: NSViewRepresentable {
    let style: VisionCardLayerStyle

    func makeNSView(context: Context) -> VisionCardLayerView { VisionCardLayerView() }

    func updateNSView(_ view: VisionCardLayerView, context: Context) { view.apply(style) }
}

/// One outer `box-shadow` layer: SwiftUI-style radius (half the CSS blur), offset and spread.
struct VisionCardShadow: Equatable {
    let color: CGColor
    let radius: CGFloat
    let x: CGFloat
    let y: CGFloat
    var spread: CGFloat = 0
}

struct VisionCardLayerStyle: Equatable {
    let cornerRadius: CGFloat
    /// The material's `linear-gradient(angle, stops…)`.
    let fillColors: [CGColor]
    let fillLocations: [Double]
    /// CSS degrees: 180 runs top to bottom, 135 from the top-left to the bottom-right corner.
    let fillAngle: Double
    /// The inset edge: the top highlight and the bottom hairline.
    let edgeTop: CGColor
    let edgeBottom: CGColor
    let frame: CGColor
    /// The outer shadows, painted only outside the card.
    let shadows: [VisionCardShadow]
    /// The interactive card's hover lift; `nil` on a static card.
    let lift: VisionCardShadow?
    /// The hover transition in seconds, or `nil` to change at once.
    let transitionDuration: Double?
    let transitionCurve: BezierCurve
}

/// Hosts the card layers. The view takes no clicks, so the card's content stays interactive.
@MainActor final class VisionCardLayerView: NSView {
    private let host = CALayer()
    /// Holds the shadows and cuts the card's own shape out of them: a CSS `box-shadow` is not
    /// painted under its box, so the translucent surface stays as clear as the web card's
    /// instead of darkening over its own shadow.
    private let shadowHost = CALayer()
    private let shadowMask = CAShapeLayer()
    private var shadowLayers: [CALayer] = []
    private let liftLayer = CALayer()
    private let fillLayer = CAGradientLayer()
    private let edgeLayer = CAGradientLayer()
    private let edgeMask = CAShapeLayer()
    private let frameLayer = CALayer()
    private var style: VisionCardLayerStyle?

    init() {
        super.init(frame: .zero)
        // Layer-hosting: the origin is bottom-left, so "top" is y = 1 in unit coordinates.
        layer = host
        wantsLayer = true
        host.masksToBounds = false
        shadowMask.fillRule = .evenOdd
        shadowMask.fillColor = CGColor(gray: 0, alpha: 1)
        shadowHost.mask = shadowMask
        host.addSublayer(shadowHost)
        // A layer without a colour still casts Core Animation's default opaque black shadow, so
        // the lift is switched off by its opacity until a card has one.
        liftLayer.shadowOpacity = 0
        shadowHost.addSublayer(liftLayer)
        edgeLayer.startPoint = CGPoint(x: 0.5, y: 1)
        edgeLayer.endPoint = CGPoint(x: 0.5, y: 0)
        fillLayer.cornerCurve = .continuous
        fillLayer.masksToBounds = true
        edgeMask.fillColor = nil
        edgeMask.strokeColor = CGColor(gray: 0, alpha: 1)
        edgeMask.lineWidth = 1
        edgeLayer.mask = edgeMask
        // `.init(color: highlight, location: 0)`, clear at 0.12 and 0.88, the hairline at 1.
        edgeLayer.locations = [0, 0.12, 0.88, 1]
        frameLayer.cornerCurve = .continuous
        frameLayer.borderWidth = 1
        host.addSublayer(fillLayer)
        host.addSublayer(edgeLayer)
        host.addSublayer(frameLayer)
    }

    @available(*, unavailable)
    // lint:allow fatal-error required init(coder:) is never used, no storyboard decoding
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        let scale = window?.backingScaleFactor ?? 2
        for layer in [host, shadowHost, shadowMask, liftLayer, fillLayer, edgeLayer, edgeMask, frameLayer]
            + shadowLayers
        {
            layer.contentsScale = scale
        }
    }

    func apply(_ style: VisionCardLayerStyle) {
        guard style != self.style else { return }
        let previous = self.style
        let duration = previous == nil ? nil : style.transitionDuration
        self.style = style
        CATransaction.begin()
        if let duration {
            CATransaction.setAnimationDuration(duration)
            let curve = style.transitionCurve
            CATransaction.setAnimationTimingFunction(
                CAMediaTimingFunction(
                    controlPoints: Float(curve.x1), Float(curve.y1), Float(curve.x2), Float(curve.y2)))
        } else {
            CATransaction.setDisableActions(true)
        }
        if shadowLayers.count != style.shadows.count {
            for layer in shadowLayers { layer.removeFromSuperlayer() }
            shadowLayers = style.shadows.map { _ in
                let layer = CALayer()
                layer.shadowOpacity = 1
                layer.contentsScale = window?.backingScaleFactor ?? 2
                return layer
            }
            for layer in shadowLayers { shadowHost.insertSublayer(layer, below: liftLayer) }
        }
        for (layer, shadow) in zip(shadowLayers, style.shadows) { Self.setShadow(layer, shadow) }
        fillLayer.colors = style.fillColors
        fillLayer.locations = style.fillLocations.map { NSNumber(value: $0) }
        edgeLayer.colors = [style.edgeTop, CGColor.clear, CGColor.clear, style.edgeBottom]
        frameLayer.borderColor = style.frame
        if let lift = style.lift {
            Self.setShadow(liftLayer, lift)
            liftLayer.shadowOpacity = 1
        } else {
            liftLayer.shadowOpacity = 0
        }
        CATransaction.commit()
        needsLayout = true
    }

    override func layout() {
        super.layout()
        guard let style else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let bounds = self.bounds
        let radius = style.cornerRadius
        let outline = Self.path(bounds, radius: radius)
        for layer in [shadowHost, shadowMask, liftLayer, fillLayer, edgeLayer, frameLayer] + shadowLayers {
            layer.frame = bounds
        }
        for (layer, shadow) in zip(shadowLayers, style.shadows) {
            layer.shadowPath = Self.path(
                bounds.insetBy(dx: -shadow.spread, dy: -shadow.spread), radius: max(0, radius + shadow.spread))
        }
        liftLayer.shadowPath = outline
        // Everything around the card, far enough out for the widest shadow, minus the card.
        let around = CGMutablePath()
        around.addRect(bounds.insetBy(dx: -Self.shadowReach, dy: -Self.shadowReach))
        around.addPath(outline)
        shadowMask.path = around
        let (start, end) = Self.gradientPoints(angle: style.fillAngle, size: bounds.size)
        fillLayer.startPoint = start
        fillLayer.endPoint = end
        fillLayer.cornerRadius = radius
        frameLayer.cornerRadius = radius
        // `shape.inset(by: 1).strokeBorder(…, lineWidth: 1)`: a 1 pt line just inside 1 pt of inset.
        edgeMask.frame = bounds
        edgeMask.path = Self.path(bounds.insetBy(dx: 1.5, dy: 1.5), radius: max(0, radius - 1.5))
        CATransaction.commit()
    }

    /// How far outside the card a shadow may paint (offset plus blur of the largest lift).
    private static let shadowReach: CGFloat = 96

    /// The CSS gradient line of `angle` for a box of `size`, as unit points of a bottom-up layer:
    /// through the centre, long enough that the perpendiculars through the corners mark 0 % and
    /// 100 % (`|w sin a| + |h cos a|`). A unit-square diagonal would tilt the stripes on a wide card.
    static func gradientPoints(angle: Double, size: CGSize) -> (CGPoint, CGPoint) {
        let radians = angle * Double.pi / 180
        let dx = sin(radians)
        let dy = cos(radians)
        let width = max(1, Double(size.width))
        let height = max(1, Double(size.height))
        let half = (abs(width * dx) + abs(height * dy)) / 2
        // Offsets from the centre in points, y upwards (CSS 0 degrees points up).
        let ox = dx * half / width
        let oy = dy * half / height
        return (CGPoint(x: 0.5 - ox, y: 0.5 - oy), CGPoint(x: 0.5 + ox, y: 0.5 + oy))
    }

    /// SwiftUI's `.shadow(color:radius:x:y:)`: y grows downward there and upward here.
    private static func setShadow(_ layer: CALayer, _ shadow: VisionCardShadow) {
        layer.shadowColor = shadow.color
        layer.shadowRadius = shadow.radius
        layer.shadowOffset = CGSize(width: shadow.x, height: -shadow.y)
    }

    /// The continuous rounded rectangle SwiftUI's `RoundedRectangle(style: .continuous)` draws.
    private static func path(_ rect: CGRect, radius: CGFloat) -> CGPath {
        RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: rect).cgPath
    }
}
