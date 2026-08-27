import StocksPage from "@/pages/portfolio/StocksPage";
import { PAGE_ICONS } from "@/lib/pageIcons";

export default function MetalsPage() {
    return (
        <StocksPage
            assetClasses={["metals"]}
            titleKey="metals.title"
            errorTitleKey="metals.pageErrorTitle"
            emptyTitleKey="metals.noMetals"
            emptyDescriptionKey="metals.noMetalsDesc"
            allowedAddAssetClasses={["metals"]}
            icon={PAGE_ICONS["/portfolio/metals"]}
        />
    );
}
