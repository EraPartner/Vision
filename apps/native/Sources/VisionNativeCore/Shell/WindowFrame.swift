import CoreGraphics
import Foundation

/// The window frame persisted across launches, in `settings.json` under `windowBounds` like
/// Electron (`readSavedWindowBounds`, `scheduleWindowBoundsSave`, `clampBoundsToWorkArea`).
/// Stored values use Electron's screen coordinates: origin at the top left of the primary
/// display, y growing downwards. AppKit frames have their origin at the bottom left.
public enum WindowFrame {
    public static let settingsKey = "windowBounds"
    public static let minimumSize = CGSize(width: 800, height: 600)
    public static let defaultSize = CGSize(width: 1280, height: 800)
    public static let saveDebounce: Duration = .milliseconds(500)

    /// `x`, `y`, `width` and `height` must all be finite numbers.
    public static func savedBounds(_ settings: [String: JSONValue]) -> CGRect? {
        guard let bounds = settings[settingsKey], bounds.objectValue != nil else { return nil }
        func number(_ key: String) -> Double? {
            switch bounds[key] {
            case .int(let value)?: return Double(value)
            case .double(let value)? where value.isFinite: return value
            default: return nil
            }
        }
        guard let x = number("x"), let y = number("y"), let width = number("width"), let height = number("height")
        else {
            return nil
        }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    public static func json(_ bounds: CGRect) -> JSONValue {
        .object([
            "x": .int(Int(bounds.origin.x.rounded())),
            "y": .int(Int(bounds.origin.y.rounded())),
            "width": .int(Int(bounds.size.width.rounded())),
            "height": .int(Int(bounds.size.height.rounded())),
        ])
    }

    /// Flips between Electron bounds and an AppKit frame; the transform is its own inverse.
    public static func flipped(_ rect: CGRect, primaryScreenHeight: Double) -> CGRect {
        CGRect(
            x: rect.origin.x, y: primaryScreenHeight - rect.origin.y - rect.size.height,
            width: rect.size.width, height: rect.size.height)
    }

    /// `screen.getDisplayMatching`: the work area of the screen that overlaps the frame
    /// most, else the first (main) screen.
    public static func workArea(for frame: CGRect, screens: [(frame: CGRect, visibleFrame: CGRect)]) -> CGRect? {
        var best: (area: Double, visibleFrame: CGRect)?
        for screen in screens {
            let overlap = screen.frame.intersection(frame)
            let area = overlap.isNull ? 0 : Double(overlap.width * overlap.height)
            if area > 0, area > (best?.area ?? 0) { best = (area, screen.visibleFrame) }
        }
        return best?.visibleFrame ?? screens.first?.visibleFrame
    }

    /// `clampBoundsToWorkArea`: at least the minimum size, at most the work area, and moved
    /// inside it, so an unplugged display cannot strand the window off screen. A work area
    /// smaller than the minimum size wins: the window shrinks to it and sits at its origin.
    public static func clamp(_ frame: CGRect, to workArea: CGRect) -> CGRect {
        let width = min(max(minimumSize.width, frame.size.width), workArea.size.width)
        let height = min(max(minimumSize.height, frame.size.height), workArea.size.height)
        func clamp(_ value: CGFloat, _ low: CGFloat, _ high: CGFloat) -> CGFloat { min(max(value, low), high) }
        return CGRect(
            x: clamp(frame.origin.x, workArea.minX, workArea.maxX - width),
            y: clamp(frame.origin.y, workArea.minY, workArea.maxY - height),
            width: width, height: height)
    }

    /// The AppKit frame to open with: the saved bounds clamped to their screen, or `nil` for
    /// the default size centred by AppKit.
    public static func initialFrame(
        settings: [String: JSONValue], primaryScreenHeight: Double, screens: [(frame: CGRect, visibleFrame: CGRect)]
    ) -> CGRect? {
        guard let saved = savedBounds(settings) else { return nil }
        let frame = flipped(saved, primaryScreenHeight: primaryScreenHeight)
        guard let workArea = workArea(for: frame, screens: screens) else { return nil }
        return clamp(frame, to: workArea)
    }
}
