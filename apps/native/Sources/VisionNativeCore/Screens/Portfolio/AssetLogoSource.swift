import Foundation

/// Where an asset's logo image lives, if anywhere: a company logo for stocks and ETFs, a coin
/// icon for crypto. The asset pages draw it in place of the asset-class glyph and keep the glyph
/// when there is no address, no network, or no image for the symbol.
///
/// Only the ticker leaves the Mac, to the same kind of public market-data host the price
/// providers already query; no amounts, names or account data.
public enum AssetLogoSource {
    /// `cryptocurrency-icons` 0.18.1 (CC0, spothq) on jsDelivr's npm mirror: 128 px colour PNGs
    /// named by lower-case ticker. Pinned so a later release cannot change what is shown.
    static let cryptoBase = "https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/128/color/"
    /// Financial Modeling Prep's public logo images, by upper-case ticker, without an API key.
    static let companyBase = "https://financialmodelingprep.com/image-stock/"

    public static func url(symbol: String?, assetClass: OpenAPI.AssetClass) -> URL? {
        guard let raw = symbol?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        switch assetClass {
        case .crypto:
            let coin = cryptoTicker(raw)
            guard !coin.isEmpty, coin.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
            return URL(string: cryptoBase + coin.lowercased() + ".png")
        case .stock, .etf:
            guard raw.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") })
            else { return nil }
            return URL(string: companyBase + raw.uppercased() + ".png")
        default:
            return nil
        }
    }

    /// The coin in a crypto symbol: `BTC-USD`, `BTC/EUR`, `BTCUSDT` and `btc` are all `BTC`.
    static func cryptoTicker(_ symbol: String) -> String {
        let upper = symbol.uppercased()
        let head = upper.split(whereSeparator: { "-/:".contains($0) }).first.map(String.init) ?? upper
        for quote in ["USDT", "USDC", "EUR", "USD"] where head.count > quote.count && head.hasSuffix(quote) {
            return String(head.dropLast(quote.count))
        }
        return head
    }
}
