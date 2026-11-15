import AppKit
import SwiftUI
import VisionNativeCore

/// An asset's logo (`AssetLogoSource`), or `fallback` (the asset-class glyph) until it has
/// loaded and whenever it cannot: no address, offline, an error, or no image for the ticker.
struct AssetLogo<Fallback: View>: View {
    let url: URL?
    var size: CGFloat = 32
    /// Company logos are drawn on a light disc, since many are dark marks on transparency;
    /// coin icons are already discs.
    var plate = true
    @ViewBuilder let fallback: () -> Fallback
    @State private var loaded: NSImage?

    var body: some View {
        // The store's copy first, so a table row scrolled back into view shows the logo at once.
        let image = loaded ?? url.flatMap { AssetLogoStore.shared.cached($0) }
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .padding(plate ? size * 0.14 : 0)
                    .frame(width: size, height: size)
                    .background { if plate { Circle().fill(Color.white) } }
                    .clipShape(Circle())
            } else {
                fallback()
            }
        }
        .task(id: url) {
            guard let url else {
                loaded = nil
                return
            }
            loaded = await AssetLogoStore.shared.image(for: url)
        }
    }
}

/// Logos fetched this session, by address. A failed address is not asked again until relaunch,
/// so an unknown ticker or an offline Mac costs one request per symbol, not one per redraw.
@MainActor
final class AssetLogoStore {
    static let shared = AssetLogoStore()

    private let images = NSCache<NSURL, NSImage>()
    private var failed: Set<URL> = []
    private var pending: [URL: Task<Data?, Never>] = [:]

    private init() {
        images.totalCostLimit = 8 * 1024 * 1024
        images.countLimit = 256
    }

    func cached(_ url: URL) -> NSImage? { images.object(forKey: url as NSURL) }

    func image(for url: URL) async -> NSImage? {
        if let image = cached(url) { return image }
        if failed.contains(url) { return nil }
        let task =
            pending[url]
            ?? Task<Data?, Never> {
                let request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 10)
                guard let result = try? await URLSession.shared.data(for: request) else { return nil }
                let (data, response) = result
                guard (response as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty else { return nil }
                return data
            }
        pending[url] = task
        let data = await task.value
        pending[url] = nil
        if let image = cached(url) { return image }
        if let data, let image = PreparedImageStore.shared.image(data: data) {
            images.setObject(image, forKey: url as NSURL, cost: 128 * 128 * 4)
            return image
        }
        if failed.count >= 256 { failed.removeAll(keepingCapacity: true) }
        failed.insert(url)
        return nil
    }
}
