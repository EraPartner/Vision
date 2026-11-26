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
    /// The pre-rendered chrome (`VisionCardChrome`): the outer shadows with the card cut out,
    /// the hover lift, and the inset edge, each one stretchable image shared by every card of
    /// the same style. They replace `shadowHost` (with its cut-out mask) and `edgeLayer` (with
    /// its stroke mask) on any card big enough for the slices: no masked offscreen pass per card
    /// per frame, and two image layers instead of one layer per shadow.
    private let shadowImageLayer = CALayer()
    private let liftImageLayer = CALayer()
    private let edgeImageLayer = CALayer()
    private var usesChrome = false
    /// The images last set on the three chrome layers, so an unchanged style sets nothing.
    private var chromeImages: [CGImage?] = [nil, nil, nil]
    private var style: VisionCardLayerStyle?
    private struct GeometryKey: Equatable {
        let bounds: CGRect
        let radius: CGFloat
        let angle: Double
        let spreads: [CGFloat]
    }
    private var geometryKey: GeometryKey?

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
        // The highlight at 0, clear within a corner radius of each edge (set in `layout`), the
        // hairline at 1.
        edgeLayer.locations = [0, 0.12, 0.88, 1]
        frameLayer.cornerCurve = .continuous
        frameLayer.borderWidth = 1
        for layer in [shadowImageLayer, liftImageLayer, edgeImageLayer] {
            layer.isHidden = true
            layer.contentsGravity = .resize
        }
        host.addSublayer(shadowImageLayer)
        host.addSublayer(liftImageLayer)
        host.addSublayer(fillLayer)
        host.addSublayer(edgeLayer)
        host.addSublayer(edgeImageLayer)
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
        updateChrome()
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
        // An opaque fill (the reduced tier, Reduce Transparency) hides the shadow under the card
        // by itself. The cut-out mask is an offscreen pass the size of the card on every
        // composited frame, so only a translucent card keeps it.
        let cutsOut = style.fillColors.contains { $0.alpha < 1 }
        if cutsOut != (shadowHost.mask != nil) { shadowHost.mask = cutsOut ? shadowMask : nil }
        let fill = Self.premultipliedStops(colors: style.fillColors, locations: style.fillLocations)
        fillLayer.colors = fill.colors
        fillLayer.locations = fill.locations.map { NSNumber(value: $0) }
        // Fade each edge to its own colour at alpha 0, not to `clear` (black): the layer mixes raw
        // components, so a fade to black would darken the rim on its way out.
        edgeLayer.colors = [
            style.edgeTop, style.edgeTop.copy(alpha: 0) ?? CGColor.clear,
            style.edgeBottom.copy(alpha: 0) ?? CGColor.clear, style.edgeBottom,
        ]
        frameLayer.borderColor = style.frame
        if let lift = style.lift {
            Self.setShadow(liftLayer, lift)
            liftLayer.shadowOpacity = 1
        } else {
            liftLayer.shadowOpacity = 0
        }
        updateChrome()
        CATransaction.commit()
        needsLayout = true
    }

    override func layout() {
        super.layout()
        guard let style else { return }
        // Hover changes colours and shadow opacity, not geometry. Keep the explicit paths and
        // gradient coordinates until the size or geometric recipe actually changes.
        let key = GeometryKey(bounds: bounds, radius: style.cornerRadius, angle: style.fillAngle,
                              spreads: style.shadows.map(\.spread))
        guard key != geometryKey else { return }
        geometryKey = key
        let interval = NativePerformance.begin("Cards.geometry")
        defer { NativePerformance.end("Cards.geometry", interval) }
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
        // `0 1px 0 … inset` lights the top edge and the curve of its corners, not the sides: the
        // highlight fades out within one corner radius. A fixed 12 % of the height lit 40 pt of
        // a tall card's sides, which read as a glow around the card.
        let reach = bounds.height > 0 ? min(0.5, Double(radius / bounds.height)) : 0.12
        edgeLayer.locations = [0, NSNumber(value: reach), NSNumber(value: 1 - reach), 1]
        updateChrome()
        CATransaction.commit()
    }

    /// Puts the pre-rendered chrome in place of the masked layers when the card is big enough
    /// for its slices, and back otherwise. Runs inside the caller's transaction, so a hover
    /// change cross-fades the images over the card's transition.
    private func updateChrome() {
        guard let style else { return }
        let scale = window?.backingScaleFactor ?? 2
        let slices = VisionCardChrome.slices(for: style, scale: scale)
        let fits = bounds.width >= slices.minimumSide && bounds.height >= slices.minimumSide
        if fits != usesChrome {
            usesChrome = fits
            let actions = CATransaction.disableActions()
            CATransaction.setDisableActions(true)
            shadowHost.isHidden = fits
            edgeLayer.isHidden = fits
            shadowImageLayer.isHidden = !fits
            liftImageLayer.isHidden = !fits
            edgeImageLayer.isHidden = !fits
            CATransaction.setDisableActions(actions)
        }
        guard fits else { return }
        for (index, (layer, slice)) in [
            (shadowImageLayer, slices.shadows), (liftImageLayer, slices.lift), (edgeImageLayer, slices.edge),
        ].enumerated() {
            let actions = CATransaction.disableActions()
            CATransaction.setDisableActions(true)
            layer.frame = bounds.insetBy(dx: -slice.margin, dy: -slice.margin)
            layer.contentsScale = scale
            layer.contentsCenter = slice.center
            CATransaction.setDisableActions(actions)
            // Contents keep the caller's actions: a hover change cross-fades the images.
            if chromeImages[index] !== slice.image {
                chromeImages[index] = slice.image
                layer.contents = slice.image
            }
        }
    }

    /// Sub-stops per gradient segment for `premultipliedStops`.
    private nonisolated static let premultipliedSteps = 12

    /// CSS interpolates gradient stops in premultiplied alpha; `CAGradientLayer` mixes the raw
    /// components. Between the glass highlight (near white at 0.04) and the surface (dark at
    /// 0.78) the raw mix runs through a bright, half-opaque grey: a diagonal sheen across the
    /// top-left of every Full effects card that the web card does not have. Each segment is
    /// split into sub-stops whose colours are the premultiplied mix, un-premultiplied again, so
    /// the layer's linear steps between them stay within a few levels of the CSS curve.
    nonisolated static func premultipliedStops(colors: [CGColor], locations: [Double]) -> (colors: [CGColor], locations: [Double]) {
        guard colors.count == locations.count, colors.count > 1,
            let space = CGColorSpace(name: CGColorSpace.sRGB)
        else { return (colors, locations) }
        let rgba: [[CGFloat]] = colors.compactMap { color in
            guard let converted = color.converted(to: space, intent: .defaultIntent, options: nil),
                let parts = converted.components, parts.count == 4
            else { return nil }
            return parts
        }
        guard rgba.count == colors.count else { return (colors, locations) }
        // Nothing to correct when every stop has the same alpha.
        guard rgba.contains(where: { abs($0[3] - rgba[0][3]) > 0.001 }) else { return (colors, locations) }
        var outColors: [CGColor] = []
        var outLocations: [Double] = []
        for index in 0..<(rgba.count - 1) {
            let from = rgba[index]
            let to = rgba[index + 1]
            let steps = index == rgba.count - 2 ? premultipliedSteps + 1 : premultipliedSteps
            for step in 0..<steps {
                let t = CGFloat(step) / CGFloat(premultipliedSteps)
                let alpha = from[3] + (to[3] - from[3]) * t
                let channel = { (i: Int) -> CGFloat in
                    let premultiplied = from[i] * from[3] + (to[i] * to[3] - from[i] * from[3]) * t
                    return alpha > 0 ? min(1, max(0, premultiplied / alpha)) : 0
                }
                outColors.append(CGColor(colorSpace: space, components: [channel(0), channel(1), channel(2), alpha]) ?? colors[index])
                outLocations.append(locations[index] + (locations[index + 1] - locations[index]) * Double(t))
            }
        }
        return (outColors, outLocations)
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

/// One stretchable image: a card of side `2 * core + 1` points centred in a square with `margin`
/// points of room on every side. Stretching its centre point to any card at least
/// `2 * core + 1` points wide and tall draws the same pixels Core Animation drew for that card:
/// within `core` of a corner nothing is stretched, and beyond it every row and column is the same.
struct VisionCardChromeSlice {
    let image: CGImage?
    let margin: CGFloat
    let core: CGFloat

    /// The one-point centre, in unit coordinates of the image.
    var center: CGRect {
        let total = 2 * (margin + core) + 1
        return CGRect(x: (margin + core) / total, y: (margin + core) / total, width: 1 / total, height: 1 / total)
    }
}

struct VisionCardChromeSlices {
    let shadows: VisionCardChromeSlice
    let lift: VisionCardChromeSlice
    let edge: VisionCardChromeSlice
    /// The smallest card side the slices fit; smaller cards keep the masked layers.
    let minimumSide: CGFloat
}

/// Renders and caches card chrome slices per style and scale (a handful of styles in the app).
@MainActor enum VisionCardChrome {
    private static var cache: [String: VisionCardChromeSlices] = [:]
    /// More distinct styles than the app has; past it the cache starts over.
    private static let capacity = 64
    /// `VisionCardLayerView.shadowReach`: shadows are not painted further out than this.
    private static let reach: CGFloat = 96

    static func slices(for style: VisionCardLayerStyle, scale: CGFloat) -> VisionCardChromeSlices {
        let key = cacheKey(style, scale: scale)
        if let cached = cache[key] { return cached }
        let radius = style.cornerRadius
        let shadows = slice(shadows: style.shadows, radius: radius, scale: scale)
        let lift = slice(shadows: style.lift.map { [$0] } ?? [], radius: radius, scale: scale)
        let edge = edgeSlice(style, scale: scale)
        let made = VisionCardChromeSlices(
            shadows: shadows, lift: lift, edge: edge,
            minimumSide: 2 * max(shadows.core, lift.core, edge.core) + 1)
        if cache.count >= capacity { cache.removeAll() }
        cache[key] = made
        return made
    }

    /// How far along each edge a continuous corner curves: about 1.53 times its radius, not the
    /// radius itself, so the unstretched caps must cover that much.
    private static func cornerSpan(_ radius: CGFloat) -> CGFloat { (1.6 * radius).rounded(.up) }

    /// How far a shadow reaches past the card: its offset, spread and three blur radii.
    private static func extent(_ shadow: VisionCardShadow) -> CGFloat {
        (abs(shadow.x) + abs(shadow.y) + max(0, shadow.spread) + 3 * shadow.radius).rounded(.up)
    }

    private static func slice(shadows: [VisionCardShadow], radius: CGFloat, scale: CGFloat) -> VisionCardChromeSlice {
        let visible = shadows.filter { $0.color.alpha > 0 }
        let extent = visible.map(extent).max() ?? 0
        let margin = min(reach, extent)
        let core = cornerSpan(radius) + extent
        guard !visible.isEmpty else { return VisionCardChromeSlice(image: nil, margin: margin, core: core) }
        let side = 2 * (margin + core) + 1
        guard let context = bitmap(side: side, scale: scale) else {
            return VisionCardChromeSlice(image: nil, margin: margin, core: core)
        }
        let card = CGRect(x: margin, y: margin, width: 2 * core + 1, height: 2 * core + 1)
        // Each shape is filled far off the image and casts its shadow back onto it, so only the
        // shadow lands (a spread shape would otherwise paint a ring around the card).
        let away = side + 64
        for shadow in visible {
            let shape = card.insetBy(dx: -shadow.spread, dy: -shadow.spread).offsetBy(dx: away, dy: 0)
            context.saveGState()
            // Shadow offset and blur are in device pixels, outside the scale transform. A layer's
            // `shadowRadius` is half the blur Core Graphics takes; y is already upwards here.
            context.setShadow(
                offset: CGSize(width: (shadow.x - away) * scale, height: -shadow.y * scale),
                blur: 2 * shadow.radius * scale, color: shadow.color)
            context.addPath(path(shape, radius: max(0, radius + shadow.spread)))
            context.setFillColor(CGColor(gray: 0, alpha: 1))
            context.fillPath()
            context.restoreGState()
        }
        // A CSS `box-shadow` is not painted under its box.
        context.setBlendMode(.clear)
        context.addPath(path(card, radius: radius))
        context.fillPath()
        return VisionCardChromeSlice(image: context.makeImage(), margin: margin, core: core)
    }

    /// The inset edge: a 1 pt line 1 pt inside the card, the top highlight fading out within one
    /// corner radius of the top and the bottom hairline within one of the bottom.
    private static func edgeSlice(_ style: VisionCardLayerStyle, scale: CGFloat) -> VisionCardChromeSlice {
        let radius = style.cornerRadius
        let core = cornerSpan(radius) + 2
        guard style.edgeTop.alpha > 0 || style.edgeBottom.alpha > 0 else {
            return VisionCardChromeSlice(image: nil, margin: 0, core: core)
        }
        let side = 2 * core + 1
        guard let context = bitmap(side: side, scale: scale), let space = CGColorSpace(name: CGColorSpace.sRGB)
        else { return VisionCardChromeSlice(image: nil, margin: 0, core: core) }
        let card = CGRect(x: 0, y: 0, width: side, height: side)
        let line = path(card.insetBy(dx: 1.5, dy: 1.5), radius: max(0, radius - 1.5))
            .copy(strokingWithWidth: 1, lineCap: .butt, lineJoin: .miter, miterLimit: 10)
        context.addPath(line)
        context.clip()
        let reach = min(0.5, radius / side)
        let colors = [
            style.edgeTop, style.edgeTop.copy(alpha: 0) ?? CGColor.clear,
            style.edgeBottom.copy(alpha: 0) ?? CGColor.clear, style.edgeBottom,
        ]
        guard
            let gradient = CGGradient(
                colorsSpace: space, colors: colors as CFArray, locations: [0, reach, 1 - reach, 1])
        else { return VisionCardChromeSlice(image: nil, margin: 0, core: core) }
        context.drawLinearGradient(
            gradient, start: CGPoint(x: 0, y: side), end: CGPoint(x: 0, y: 0), options: [])
        return VisionCardChromeSlice(image: context.makeImage(), margin: 0, core: core)
    }

    private static func bitmap(side: CGFloat, scale: CGFloat) -> CGContext? {
        let pixels = Int((side * scale).rounded(.up))
        guard pixels > 0, let space = CGColorSpace(name: CGColorSpace.sRGB),
            let context = CGContext(
                data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        context.scaleBy(x: scale, y: scale)
        return context
    }

    private static func path(_ rect: CGRect, radius: CGFloat) -> CGPath {
        RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: rect).cgPath
    }

    private static func cacheKey(_ style: VisionCardLayerStyle, scale: CGFloat) -> String {
        func color(_ color: CGColor) -> String {
            (color.components ?? []).map { String(format: "%.4f", $0) }.joined(separator: ",")
                + "@" + ((color.colorSpace?.name as String?) ?? "")
        }
        func shadow(_ shadow: VisionCardShadow) -> String {
            "\(color(shadow.color))/\(shadow.radius)/\(shadow.x)/\(shadow.y)/\(shadow.spread)"
        }
        return [
            "\(scale)", "\(style.cornerRadius)", style.shadows.map(shadow).joined(separator: ";"),
            style.lift.map(shadow) ?? "-", color(style.edgeTop), color(style.edgeBottom),
        ].joined(separator: "|")
    }
}
