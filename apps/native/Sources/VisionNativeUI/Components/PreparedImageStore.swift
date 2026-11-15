import AppKit
import ImageIO
import SwiftUI

/// Disposable, decoded thumbnails (list item 2.5): ImageIO decodes at display size off the main
/// actor, and an 8 MB LRU keeps the results. Source bytes stay owned by their data model; callers
/// key an entry by what identifies the bytes (a URL, an attachment id), so no hashing is needed.
@MainActor
final class PreparedImageStore {
    static let shared = PreparedImageStore()
    private struct Entry {
        let image: NSImage
        let cost: Int
        var use: Int
    }
    /// `CGImage` crosses from the decoding task to the main actor once and is never mutated.
    // lint:allow unchecked-sendable an immutable CGImage handed over once, never mutated
    private struct Decoded: @unchecked Sendable {
        let image: CGImage
    }
    private var entries: [String: Entry] = [:]
    private var pending: [String: Task<Decoded?, Never>] = [:]
    private var clock = 0
    private var cost = 0
    private let budget = 8 * 1024 * 1024

    /// A decoded thumbnail already in the cache.
    func cached(key: String, pixels: Int) -> NSImage? {
        let key = Self.entryKey(key, pixels)
        guard var entry = entries[key] else { return nil }
        clock += 1
        entry.use = clock
        entries[key] = entry
        return entry.image
    }

    /// Decodes `data` to at most `pixels` on its longer side off the main actor.
    func image(key: String, data: Data, pixels: Int = 128) async -> NSImage? {
        let pixels = Self.clamp(pixels)
        if let image = cached(key: key, pixels: pixels) { return image }
        let entryKey = Self.entryKey(key, pixels)
        let task =
            pending[entryKey]
            ?? Task.detached(priority: .utility) { Self.decode(data, pixels: pixels).map(Decoded.init) }
        pending[entryKey] = task
        let decoded = await task.value
        pending[entryKey] = nil
        if let image = cached(key: key, pixels: pixels) { return image }
        guard let decoded else { return nil }
        return store(decoded.image, key: entryKey)
    }

    /// Fetches a remote image (as `AsyncImage` does, through the shared session) and decodes it.
    func image(url: URL, pixels: Int) async throws -> NSImage {
        let key = url.absoluteString
        if let image = cached(key: key, pixels: Self.clamp(pixels)) { return image }
        let (data, _) = try await URLSession.shared.data(from: url)
        try Task.checkCancellation()
        guard let image = await image(key: key, data: data, pixels: pixels) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return image
    }

    private func store(_ thumbnail: CGImage, key: String) -> NSImage {
        let image = NSImage(cgImage: thumbnail, size: NSSize(width: thumbnail.width, height: thumbnail.height))
        let imageCost = thumbnail.bytesPerRow * thumbnail.height
        while cost + imageCost > budget, let oldest = entries.min(by: { $0.value.use < $1.value.use }) {
            cost -= oldest.value.cost
            entries[oldest.key] = nil
        }
        if imageCost <= budget {
            clock += 1
            entries[key] = Entry(image: image, cost: imageCost, use: clock)
            cost += imageCost
        }
        return image
    }

    private static func clamp(_ pixels: Int) -> Int { max(1, min(pixels, 1024)) }
    private static func entryKey(_ key: String, _ pixels: Int) -> String { "\(pixels):\(key)" }

    private nonisolated static func decode(_ data: Data, pixels: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(
            source, 0,
            [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: pixels,
                kCGImageSourceShouldCacheImmediately: true,
            ] as CFDictionary)
    }
}

/// `AsyncImage` with the same phases, decoded to display size through `PreparedImageStore`
/// instead of at the source size.
struct PreparedAsyncImage<Content: View>: View {
    let url: URL
    /// The longer side in pixels to decode to.
    let pixels: Int
    @ViewBuilder let content: (AsyncImagePhase) -> Content
    @State private var phase: AsyncImagePhase = .empty
    @State private var loadedURL: URL?

    init(url: URL, pixels: Int, @ViewBuilder content: @escaping (AsyncImagePhase) -> Content) {
        self.url = url
        self.pixels = pixels
        self.content = content
        if let image = PreparedImageStore.shared.cached(key: url.absoluteString, pixels: pixels) {
            _phase = State(initialValue: .success(Image(nsImage: image)))
            _loadedURL = State(initialValue: url)
        }
    }

    var body: some View {
        // The loader sits in a zero-size view: an empty phase may render nothing, and a task on
        // nothing never starts.
        ZStack {
            Color.clear.frame(width: 0, height: 0).task(id: url) { await load() }
            content(phase)
        }
    }

    private func load() async {
        do {
            guard loadedURL != url else { return }
            phase = .empty
            let image = try await PreparedImageStore.shared.image(url: url, pixels: pixels)
            phase = .success(Image(nsImage: image))
            loadedURL = url
        } catch is CancellationError {
            return
        } catch {
            if Task.isCancelled { return }
            phase = .failure(error)
            loadedURL = url
        }
    }
}

/// An attachment thumbnail decoded off the main actor; the placeholder shows until it is ready.
struct PreparedDataImage<Content: View, Placeholder: View>: View {
    let key: String
    let data: Data
    let pixels: Int
    @ViewBuilder let content: (Image) -> Content
    @ViewBuilder let placeholder: () -> Placeholder
    @State private var image: NSImage?

    var body: some View {
        ZStack {
            if let image = image ?? PreparedImageStore.shared.cached(key: key, pixels: pixels) {
                content(Image(nsImage: image))
            } else {
                placeholder()
            }
        }
        .task(id: key) { image = await PreparedImageStore.shared.image(key: key, data: data, pixels: pixels) }
    }
}
