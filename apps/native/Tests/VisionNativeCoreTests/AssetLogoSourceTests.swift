import Foundation
import Testing

@testable import VisionNativeCore

struct AssetLogoSourceTests {
    @Test func stocksAndETFsUseTheCompanyLogoByTicker() {
        #expect(
            AssetLogoSource.url(symbol: " aapl ", assetClass: .stock)?.absoluteString
                == "https://financialmodelingprep.com/image-stock/AAPL.png")
        #expect(
            AssetLogoSource.url(symbol: "VWCE.DE", assetClass: .etf)?.absoluteString
                == "https://financialmodelingprep.com/image-stock/VWCE.DE.png")
    }

    @Test func cryptoUsesTheCoinIconWhateverTheQuote() {
        for symbol in ["BTC", "btc", "BTC-USD", "BTC/EUR", "BTCUSDT"] {
            #expect(
                AssetLogoSource.url(symbol: symbol, assetClass: .crypto)?.absoluteString
                    == "https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/128/color/btc.png")
        }
        // A stablecoin on its own is the coin, not an empty ticker.
        #expect(AssetLogoSource.url(symbol: "USDT", assetClass: .crypto)?.lastPathComponent == "usdt.png")
    }

    @Test func noLogoWithoutAUsableTickerOrForOtherClasses() {
        #expect(AssetLogoSource.url(symbol: nil, assetClass: .stock) == nil)
        #expect(AssetLogoSource.url(symbol: "  ", assetClass: .stock) == nil)
        #expect(AssetLogoSource.url(symbol: "A/B?x", assetClass: .stock) == nil)
        #expect(AssetLogoSource.url(symbol: "XAU", assetClass: .metals) == nil)
        #expect(AssetLogoSource.url(symbol: "KBC", assetClass: .savings) == nil)
    }
}
