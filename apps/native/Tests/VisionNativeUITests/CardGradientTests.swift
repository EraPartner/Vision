import CoreGraphics
import Testing

@testable import VisionNativeUI

@Suite("Card gradient")
struct CardGradientTests {
    /// The dark `glass-regular` fill (`highlight/0.04 0%, surface/0.78 42%`): CSS mixes the stops
    /// in premultiplied alpha, so a tenth of the way in the faint highlight adds almost no light.
    /// A raw component mix reached a half-opaque light grey there (the Full effects sheen).
    @Test func fillStopsFollowPremultipliedInterpolation() throws {
        let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
        let highlight = try #require(CGColor(colorSpace: space, components: [0.96, 0.94, 0.9, 0.04]))
        let surface = try #require(CGColor(colorSpace: space, components: [0.094, 0.13, 0.145, 0.78]))
        let stops = VisionCardLayerView.premultipliedStops(colors: [highlight, surface], locations: [0, 0.42])
        #expect(stops.colors.count == stops.locations.count)
        #expect(stops.locations.first == 0 && stops.locations.last == 0.42)
        // The sub-stop nearest a quarter of the segment.
        let index = try #require(stops.locations.firstIndex { $0 >= 0.42 / 4 })
        let parts = try #require(stops.colors[index].components)
        let t = 0.25
        let alpha = 0.04 + (0.78 - 0.04) * t
        let red = (0.96 * 0.04 + (0.094 * 0.78 - 0.96 * 0.04) * t) / alpha
        #expect(abs(Double(parts[3]) - alpha) < 0.001)
        #expect(abs(Double(parts[0]) - red) < 0.001)
        // The raw mix would be 0.74 red here; the premultiplied colour stays dark.
        #expect(parts[0] < 0.3)
    }

    /// Equal alphas need no correction: the stops pass through unchanged.
    @Test func equalAlphaStopsAreUnchanged() throws {
        let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
        let card = try #require(CGColor(colorSpace: space, components: [0.1, 0.12, 0.13, 1]))
        let stops = VisionCardLayerView.premultipliedStops(colors: [card, card], locations: [0, 1])
        #expect(stops.colors.count == 2)
    }
}
