import AppKit
import MetalKit
import SwiftUI
import VisionNativeCore

private struct VisionCanvasTintKey: EnvironmentKey {
    static let defaultValue = false
}

private struct VisionStaticAtmosphereKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// `data-tint="wealth"` under `/portfolio`: the CSS blobs swap their hues.
    var visionWealthCanvasTint: Bool {
        get { self[VisionCanvasTintKey.self] }
        set { self[VisionCanvasTintKey.self] = newValue }
    }

    /// `fx-static-atmosphere`: a large display holds the atmosphere still.
    var visionStaticAtmosphere: Bool {
        get { self[VisionStaticAtmosphereKey.self] }
        set { self[VisionStaticAtmosphereKey.self] = newValue }
    }
}

/// `.liquid-canvas` (index.css) and `ShaderAurora` (ADR-071, ADR-075): the radial wash, the
/// two drifting colour blobs, the grain and, on the Enhanced tier, the WebGL fbm aurora as a
/// Metal shader. Hidden on Reduced, with Reduce Transparency or Increase Contrast.
struct AuroraCanvas: View {
    @Environment(\.visionTheme) private var theme
    @Environment(\.visionVisualEffects) private var visualEffects
    @Environment(\.visionFullEffects) private var fullEffects
    @Environment(\.visionWealthCanvasTint) private var wealth
    @Environment(\.visionStaticAtmosphere) private var staticAtmosphere
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    /// Key, on screen and the app shown: the aurora pauses on its last frame otherwise, as the
    /// web pauses when `document.hidden || !document.hasFocus()` (`fx-idle-atmosphere`).
    @State private var windowLive = true

    /// tokens.css `--aurora-*-alpha` and `--grain-alpha` (light, dark): `DesignTokens.Atmosphere`.
    private var alphas: (primary: Double, accent: Double, wash: Double, grain: Double) {
        let dark = theme.isDark
        return (
            DesignTokens.Atmosphere.primaryAlpha.value(isDark: dark),
            DesignTokens.Atmosphere.accentAlpha.value(isDark: dark),
            DesignTokens.Atmosphere.washAlpha.value(isDark: dark),
            DesignTokens.Atmosphere.grainAlpha.value(isDark: dark)
        )
    }

    var body: some View {
        if visualEffects == .reduced || reduceTransparency || contrast == .increased {
            EmptyView()
        } else {
            let enhanced = visualEffects == .enhanced
            GeometryReader { proxy in
                ZStack(alignment: .topLeading) {
                    wash(proxy.size)
                    AuroraBlobs(
                        size: proxy.size, first: wealth ? theme.accent : theme.primary,
                        second: wealth ? theme.primary : theme.accent,
                        firstAlpha: alphas.primary, secondAlpha: alphas.accent,
                        // The shader takes over the motion on Enhanced, unless Full effects keep
                        // the blobs drifting under it (index.css "Full effects": "also under the
                        // live WebGL aurora"); static atmosphere and reduced motion hold.
                        animated: (!enhanced || fullEffects) && !staticAtmosphere && !reduceMotion,
                        running: windowLive)
                    if enhanced {
                        AuroraShaderView(
                            primary: theme.palette.primary, accent: theme.palette.accent,
                            animated: !staticAtmosphere && !reduceMotion, live: windowLive
                        )
                        .opacity(theme.isDark ? 0.5 : 0.6)
                    }
                    AuroraGrain().opacity(alphas.grain)
                }
            }
            .background { WindowLivenessProbe { windowLive = $0 } }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    /// `radial-gradient(120rem 60rem at 70% -20%, primary / wash, transparent 60%)`.
    private func wash(_ size: CGSize) -> some View {
        EllipticalGradient(
            colors: [theme.primary.opacity(alphas.wash), .clear], center: .center, startRadiusFraction: 0,
            endRadiusFraction: 0.6
        )
        .frame(width: 1920 * 2, height: 960 * 2)
        .position(x: size.width * 0.7, y: -size.height * 0.2)
    }
}

/// `::before` / `::after`: radial blobs drifting with `aurora-drift-a-smooth` (64 s) and
/// `aurora-drift-b-smooth` (76 s), infinite alternate on `--ease-in-out-quart`: the
/// `:root.fx-full:not(.fx-static-atmosphere) .liquid-canvas` path (index.css "Full effects").
/// The caller turns `animated` off for static atmosphere, Reduce Motion and the Enhanced
/// shader, which are the cases where the web rule does not apply.
private struct AuroraBlobs: View {
    let size: CGSize
    let first: Color
    let second: Color
    let firstAlpha: Double
    let secondAlpha: Double
    let animated: Bool
    /// The window is live; the drift holds its position while it is not.
    let running: Bool
    @State private var clock = AuroraDriftClock()

    var body: some View {
        Group {
            if animated { driftingBlobs } else { blobs(firstProgress: 0, secondProgress: 0) }
        }
        .onAppear { clock.setRunning(running, now: Date.now.timeIntervalSinceReferenceDate) }
        .onChange(of: running) { _, live in
            clock.setRunning(live, now: Date.now.timeIntervalSinceReferenceDate)
        }
    }

    private var driftingBlobs: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !running)) { timeline in
            let now = timeline.date.timeIntervalSinceReferenceDate
            let elapsed = clock.elapsed(at: now)
            blobs(firstProgress: progress(elapsed, 64), secondProgress: progress(elapsed, 76))
        }
    }

    // The blobs drift at 30 fps: the largest moves well under a pixel per frame, so this is the
    // same motion as a display-rate animation for half the per-frame work, and a paused
    // timeline schedules nothing at all.

    private func progress(_ elapsed: Double, _ seconds: Double) -> Double {
        // The smooth path: continuous alternate drift on `--ease-in-out-quart`. Native drawing is
        // GPU-composited, so this is the Full-effects drift whether or not the switch is on; the
        // web's 100 ms stepped default (index.css `aurora-drift-a`) is not modelled.
        AuroraDriftClock.progress(elapsed: elapsed, duration: seconds, curve: DesignTokens.Ease.inOutQuart)
    }

    private func blobs(firstProgress: Double, secondProgress: Double) -> some View {
        let a = max(size.width * 0.55, 544)
        let b = max(size.width * 0.48, 480)
        return ZStack(alignment: .topLeading) {
            blob(first, alpha: firstAlpha, diameter: a)
                .scaleEffect(1 + 0.18 * firstProgress)
                .offset(x: size.width * 0.14 * firstProgress, y: size.height * 0.09 * firstProgress)
                .position(x: -size.width * 0.12 + a / 2, y: -size.height * 0.18 + a / 2)
            blob(second, alpha: secondAlpha, diameter: b)
                .scaleEffect(1.12 - 0.16 * secondProgress)
                .offset(x: -size.width * 0.11 * secondProgress, y: -size.height * 0.07 * secondProgress)
                .position(x: size.width * 1.1 - b / 2, y: size.height * 1.22 - b / 2)
        }
    }

    /// `radial-gradient(closest-side, colour / alpha, transparent 72%)`.
    private func blob(_ color: Color, alpha: Double, diameter: CGFloat) -> some View {
        Circle()
            .fill(
                RadialGradient(
                    colors: [color.opacity(alpha), .clear], center: .center, startRadius: 0,
                    endRadius: diameter / 2 * 0.72)
            )
            .frame(width: diameter, height: diameter)
    }
}

/// `.liquid-canvas-grain`: a tiled 160×160 fractal-noise texture.
private struct AuroraGrain: View {
    private static let tile: Image? = {
        let side = 160
        var state: UInt64 = 0x9E37_79B9_7F4A_7C15
        func next() -> Double {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Double(state >> 33) / Double(UInt64(1) << 31)
        }
        var lattices: [[Double]] = []
        for octave in 0..<3 {
            let cells = 8 << octave
            lattices.append((0..<(cells * cells)).map { _ in next() })
        }
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        for y in 0..<side {
            for x in 0..<side {
                var value = 0.0
                var amplitude = 0.5
                for (octave, lattice) in lattices.enumerated() {
                    let cells = 8 << octave
                    let fx = Double(x) / Double(side) * Double(cells)
                    let fy = Double(y) / Double(side) * Double(cells)
                    let x0 = Int(fx) % cells
                    let y0 = Int(fy) % cells
                    let x1 = (x0 + 1) % cells
                    let y1 = (y0 + 1) % cells
                    let tx = fx - floor(fx)
                    let ty = fy - floor(fy)
                    let top = lattice[y0 * cells + x0] * (1 - tx) + lattice[y0 * cells + x1] * tx
                    let bottom = lattice[y1 * cells + x0] * (1 - tx) + lattice[y1 * cells + x1] * tx
                    value += amplitude * (top * (1 - ty) + bottom * ty)
                    amplitude *= 0.5
                }
                let level = UInt8(max(0, min(255, value / 0.875 * 255)))
                let index = (y * side + x) * 4
                pixels[index] = level
                pixels[index + 1] = level
                pixels[index + 2] = level
                pixels[index + 3] = 255
            }
        }
        guard let provider = CGDataProvider(data: Data(pixels) as CFData),
            let image = CGImage(
                width: side, height: side, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: side * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
        else { return nil }
        return Image(decorative: image, scale: 1)
    }()

    var body: some View {
        if let tile = Self.tile {
            Rectangle().fill(ImagePaint(image: tile, scale: 1))
        }
    }
}

/// ShaderAurora: the same fbm fragment shader as the WebGL layer, compiled at runtime,
/// drawn at a quarter resolution (at most 640 px wide) and about 30 fps; held on its
/// first frame for reduced motion or a large display, and paused while the window is
/// not key, occluded, minimised or its app hidden (`document.hidden || !hasFocus`).
struct AuroraShaderView: NSViewRepresentable {
    let primary: HSLColor
    let accent: HSLColor
    let animated: Bool
    /// The window is key, on screen and its app shown; the loop pauses on the last frame otherwise.
    let live: Bool

    func makeCoordinator() -> AuroraRenderer { AuroraRenderer() }

    func makeNSView(context: Context) -> NSView {
        guard let device = MTLCreateSystemDefaultDevice() else { return NSView() }
        let view = AuroraMTKView(frame: .zero, device: device)
        view.delegate = context.coordinator
        view.colorPixelFormat = .bgra8Unorm
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        view.layer?.isOpaque = false
        view.autoResizeDrawable = false
        view.preferredFramesPerSecond = 30
        context.coordinator.attach(view)
        update(context.coordinator, view: view)
        // The runtime shader compile is not on the first frame's path (ADR-247): the CSS
        // atmosphere shows at once and the shader joins it once compiled.
        let renderer = context.coordinator
        Task { @MainActor in
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(400))
            if renderer.prepare(device: device) { renderer.refreshPlayback() } else { view.isHidden = true }
        }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        guard let view = view as? AuroraMTKView else { return }
        update(context.coordinator, view: view)
    }

    static func dismantleNSView(_ view: NSView, coordinator: AuroraRenderer) {
        guard let view = view as? AuroraMTKView else { return }
        view.isPaused = true
        view.delegate = nil
    }

    private func update(_ renderer: AuroraRenderer, view: AuroraMTKView) {
        renderer.colors = (Self.rgb(primary), Self.rgb(accent))
        renderer.animated = animated
        renderer.live = live
        renderer.refreshPlayback()
    }

    private static func rgb(_ color: HSLColor) -> SIMD4<Float> {
        let rgb = color.rgb
        return SIMD4(Float(rgb.red), Float(rgb.green), Float(rgb.blue), 1)
    }
}

final class AuroraMTKView: MTKView {
    override func layout() {
        super.layout()
        // RESOLUTION_SCALE 0.25, capped at MAX_CANVAS_WIDTH 640; the layer upscales it.
        let width = max(1, bounds.width)
        let scale = min(0.25, 640 / width)
        let size = CGSize(width: max(1, (width * scale).rounded()), height: max(1, (bounds.height * scale).rounded()))
        // Layout also runs when nothing moved; a new drawable size reallocates the drawables.
        guard size != drawableSize else { return }
        drawableSize = size
        if isPaused { needsDisplay = true }
    }
}

@MainActor final class AuroraRenderer: NSObject, MTKViewDelegate {
    private struct Uniforms {
        var resolution: SIMD2<Float>
        var time: Float
        var padding: Float = 0
        var first: SIMD4<Float>
        var second: SIMD4<Float>
    }

    var colors: (SIMD4<Float>, SIMD4<Float>) = (SIMD4(0.18, 0.65, 0.45, 1), SIMD4(0.85, 0.7, 0.4, 1))
    var animated = true
    var live = true
    private var hasDrawn = false
    private var queue: MTLCommandQueue?
    private var pipeline: MTLRenderPipelineState?
    private weak var view: AuroraMTKView?
    private let start = CACurrentMediaTime()

    func prepare(device: MTLDevice) -> Bool {
        do {
            let library = try device.makeLibrary(source: Self.source, options: nil)
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: "auroraVertex")
            descriptor.fragmentFunction = library.makeFunction(name: "auroraFragment")
            descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
            queue = device.makeCommandQueue()
            return pipeline != nil && queue != nil
        } catch {
            // As a lost WebGL context: no shader, the CSS atmosphere remains.
            return false
        }
    }

    func attach(_ view: AuroraMTKView) {
        self.view = view
    }

    /// `shaderAuroraMode`: loop, a held static frame, or paused on the last frame. The window
    /// state comes from the canvas (`WindowLivenessProbe`), so one observer serves every layer.
    func refreshPlayback() {
        guard let view else { return }
        let mode = AuroraPlayback.resolve(motionAllowed: animated, windowIsLive: live)
        let loop = mode == .loop
        view.enableSetNeedsDisplay = !loop
        view.isPaused = !loop
        // A held frame is drawn once; a paused loop keeps its last frame (or draws its first).
        if mode == .held || (mode == .paused && !hasDrawn) { view.needsDisplay = true }
    }

    nonisolated func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    nonisolated func draw(in view: MTKView) {
        MainActor.assumeIsolated { render(view) }
    }

    private func render(_ view: MTKView) {
        guard let pipeline, let queue, let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
            let buffer = queue.makeCommandBuffer(), let encoder = buffer.makeRenderCommandEncoder(descriptor: pass)
        else { return }
        let size = view.drawableSize
        var uniforms = Uniforms(
            resolution: SIMD2(Float(size.width), Float(size.height)),
            time: animated ? Float(CACurrentMediaTime() - start) : 0, first: colors.0, second: colors.1)
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
        hasDrawn = true
        buffer.present(drawable)
        buffer.commit()
    }

    /// ShaderAurora.tsx's vertex and fragment shaders, translated from GLSL.
    static let source = """
        #include <metal_stdlib>
        using namespace metal;

        struct AuroraUniforms {
            float2 res;
            float time;
            float padding;
            float4 c1;
            float4 c2;
        };

        vertex float4 auroraVertex(uint vid [[vertex_id]]) {
            const float2 positions[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
            return float4(positions[vid], 0.0, 1.0);
        }

        static float hash(float2 p) { return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453123); }

        static float noise(float2 p) {
            float2 i = floor(p);
            float2 f = fract(p);
            float2 u = f * f * (3.0 - 2.0 * f);
            return mix(
                mix(hash(i), hash(i + float2(1.0, 0.0)), u.x),
                mix(hash(i + float2(0.0, 1.0)), hash(i + float2(1.0, 1.0)), u.x),
                u.y);
        }

        static float fbm(float2 p) {
            float v = 0.0;
            float a = 0.5;
            for (int i = 0; i < 4; i++) {
                v += a * noise(p);
                p *= 2.0;
                a *= 0.5;
            }
            return v;
        }

        fragment float4 auroraFragment(float4 position [[position]], constant AuroraUniforms &u [[buffer(0)]]) {
            // gl_FragCoord has a bottom-left origin.
            float2 coord = float2(position.x, u.res.y - position.y);
            float2 uv = coord / u.res;
            float2 p = uv * float2(u.res.x / u.res.y, 1.0);
            float t = u.time * 0.045;
            float n1 = fbm(p * 1.3 + float2(t, -t * 0.6));
            float n2 = fbm(p * 1.7 - float2(t * 0.7, t * 0.4) + 3.7);
            float m1 = smoothstep(0.34, 0.68, n1);
            float m2 = smoothstep(0.38, 0.72, n2);
            float3 col = u.c1.rgb * m1 + u.c2.rgb * m2;
            float a = clamp(max(m1, m2), 0.0, 1.0) * 0.65;
            return float4(col * a, a);
        }
        """
}
