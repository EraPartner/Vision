import AppKit
import SwiftUI
import VisionNativeCore

/// The `glass-thin` card surface as Core Animation layers: the surface gradient, the embossed
/// inset edge, the frame and the drop and lift shadows. SwiftUI drew the gradient fill and the
/// gradient edge stroke into CPU bitmaps, re-rendered tile by tile while a tall card (the ledger)
/// scrolled; the render server draws these layers on the GPU, as the browser compositor draws the
/// CSS card. The look is `VisionCardBackground`'s; see there for the web sources.
struct VisionCardLayers: NSViewRepresentable {
    let style: VisionCardLayerStyle

    func makeNSView(context: Context) -> VisionCardLayerView { VisionCardLayerView() }

    func updateNSView(_ view: VisionCardLayerView, context: Context) { view.apply(style) }
}

/// A SwiftUI `.shadow(color:radius:x:y:)` of the card.
struct VisionCardShadow: Equatable {
    let color: CGColor
    let radius: CGFloat
    let x: CGFloat
    let y: CGFloat
}

struct VisionCardLayerStyle: Equatable {
    let cornerRadius: CGFloat
    /// Top and bottom of the surface gradient.
    let fillTop: CGColor
    let fillBottom: CGColor
    /// The inset edge: the top highlight and the bottom hairline.
    let edgeTop: CGColor
    let edgeBottom: CGColor
    let frame: CGColor
    let shadow: VisionCardShadow
    /// The interactive card's hover lift; `nil` on a static card.
    let lift: VisionCardShadow?
    /// The hover transition in seconds, or `nil` to change at once.
    let transitionDuration: Double?
    let transitionCurve: BezierCurve
}

/// Hosts the card layers. The view takes no clicks, so the card's content stays interactive.
@MainActor final class VisionCardLayerView: NSView {
    private let host = CALayer()
    private let shadowLayer = CALayer()
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
        for shadow in [shadowLayer, liftLayer] {
            shadow.shadowOpacity = 1
            host.addSublayer(shadow)
        }
        for gradient in [fillLayer, edgeLayer] {
            gradient.startPoint = CGPoint(x: 0.5, y: 1)
            gradient.endPoint = CGPoint(x: 0.5, y: 0)
        }
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
        for layer in [host, shadowLayer, liftLayer, fillLayer, edgeLayer, edgeMask, frameLayer] {
            layer.contentsScale = scale
        }
    }

    func apply(_ style: VisionCardLayerStyle) {
        guard style != self.style else { return }
        let duration = self.style == nil ? nil : style.transitionDuration
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
        fillLayer.colors = [style.fillTop, style.fillBottom]
        edgeLayer.colors = [style.edgeTop, CGColor.clear, CGColor.clear, style.edgeBottom]
        frameLayer.borderColor = style.frame
        Self.setShadow(shadowLayer, style.shadow)
        if let lift = style.lift {
            Self.setShadow(liftLayer, lift)
        } else {
            liftLayer.shadowColor = nil
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
        for layer in [shadowLayer, liftLayer, fillLayer, edgeLayer, frameLayer] {
            layer.frame = bounds
        }
        shadowLayer.shadowPath = outline
        liftLayer.shadowPath = outline
        fillLayer.cornerRadius = radius
        frameLayer.cornerRadius = radius
        // `shape.inset(by: 1).strokeBorder(…, lineWidth: 1)`: a 1 pt line just inside 1 pt of inset.
        edgeMask.frame = bounds
        edgeMask.path = Self.path(bounds.insetBy(dx: 1.5, dy: 1.5), radius: max(0, radius - 1.5))
        CATransaction.commit()
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
