import Foundation

/// The five asset pages under `/portfolio/:segment` (StocksPage, CryptoPage, MetalsPage,
/// RealEstatePage, SavingsPage). The raw value is the route segment.
public enum PortfolioHoldingsPage: String, CaseIterable, Hashable, Sendable {
    case stocks
    case crypto
    case metals
    case realEstate = "real-estate"
    case savings

    public var path: String { "/portfolio/" + rawValue }

    /// The asset class the page adds and is named after.
    public var assetClass: OpenAPI.AssetClass {
        switch self {
        case .stocks: .stock
        case .crypto: .crypto
        case .metals: .metals
        case .realEstate: .realEstate
        case .savings: .savings
        }
    }

    /// The classes the page lists: stocks include ETFs, savings include bonds.
    public var assetClasses: [OpenAPI.AssetClass] {
        switch self {
        case .stocks: [.stock, .etf]
        case .savings: [.savings, .bond]
        case .crypto, .metals, .realEstate: [assetClass]
        }
    }

    /// The page's localisation namespace.
    public var stringsPrefix: String {
        switch self {
        case .stocks: "stocks"
        case .crypto: "crypto"
        case .metals: "metals"
        case .realEstate: "realestate"
        case .savings: "savings"
        }
    }

    /// The empty state title key; its description adds `Desc`.
    public var emptyKey: String {
        switch self {
        case .stocks: "stocks.noStocks"
        case .crypto: "crypto.noCrypto"
        case .metals: "metals.noMetals"
        case .realEstate: "realestate.noProperties"
        case .savings: "savings.noAccounts"
        }
    }

    /// Metals reuse the stocks explanation.
    public var howItWorksKey: String { (self == .metals ? "stocks" : stringsPrefix) + ".howItWorks" }

    /// The row menu's delete label.
    public var deleteKey: String {
        switch self {
        case .crypto: "crypto.deleteAsset"
        case .realEstate: "realestate.deleteProperty"
        case .savings: "savings.deleteAccount"
        case .stocks, .metals: "portfolio.deleteInvestment"
        }
    }
}
