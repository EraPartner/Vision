import StocksPage from "@/pages/portfolio/StocksPage";

export default function MetalsPage() {
  return (
    <StocksPage
      assetClasses={["metals"]}
      titleKey="metals.title"
      emptyTitleKey="metals.noMetals"
      emptyDescriptionKey="metals.noMetalsDesc"
      allowedAddAssetClasses={["metals"]}
      enableFxAwarePnl={false}
    />
  );
}
