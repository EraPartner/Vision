import StocksPage from "@/pages/portfolio/StocksPage";
import { PAGE_ICONS } from "@/lib/pageIcons";

export default function CryptoPage() {
    return (
        <StocksPage
            assetClasses={["crypto"]}
            titleKey="crypto.title"
            errorTitleKey="crypto.pageErrorTitle"
            emptyTitleKey="crypto.noCrypto"
            emptyDescriptionKey="crypto.noCryptoDesc"
            allowedAddAssetClasses={["crypto"]}
            icon={PAGE_ICONS["/portfolio/crypto"]}
            howItWorksKey="crypto.howItWorks"
            deleteTitleKey="crypto.deleteAsset"
            deleteDescriptionKey="crypto.deleteAssetDesc"
            showEmptyStateExport={false}
            showDividends={false}
            dynamicUnrealizedIcon
            assetCellVariant="combined"
            unitsDecimals={6}
            unitsMonospace
            priceColumnsInTargetCurrency
            // Crypto has always shown spot-converted P&L and the legacy total-return
            // percentage in the unrealized pill — keep both verbatim.
            enableFxAwarePnl={false}
            simplePnlPercentSource="totalReturn"
        />
    );
}
