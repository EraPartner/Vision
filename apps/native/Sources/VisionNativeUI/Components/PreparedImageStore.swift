import AppKit
import CryptoKit
import ImageIO

/// Disposable, decoded thumbnails. Source attachment bytes stay owned by their data model.
@MainActor
final class PreparedImageStore {
    static let shared = PreparedImageStore()
    private struct Entry {
        let image: NSImage
        let cost: Int
        var use: Int
    }
    private var entries: [String: Entry] = [:]
    private var clock = 0
    private var cost = 0
    private let budget = 8 * 1024 * 1024

    func image(data: Data, pixels: Int = 128) -> NSImage? {
        let pixels = max(1, min(pixels, 1024))
        let key = SHA256.hash(data: data).description + ":\(pixels)"
        clock += 1
        if var entry = entries[key] {
            entry.use = clock
            entries[key] = entry
            return entry.image
        }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
            let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: pixels,
                kCGImageSourceShouldCacheImmediately: true,
            ] as CFDictionary)
        else { return nil }
        let image = NSImage(cgImage: thumbnail, size: NSSize(width: thumbnail.width, height: thumbnail.height))
        let imageCost = thumbnail.bytesPerRow * thumbnail.height
        while cost + imageCost > budget, let oldest = entries.min(by: { $0.value.use < $1.value.use }) {
            cost -= oldest.value.cost
            entries[oldest.key] = nil
        }
        if imageCost <= budget {
            entries[key] = Entry(image: image, cost: imageCost, use: clock)
            cost += imageCost
        }
        return image
    }
}
