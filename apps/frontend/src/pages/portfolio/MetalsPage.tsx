import StocksPage from "@/pages/portfolio/StocksPage";

export default function MetalsPage() {
  return (
    <StocksPage
      assetClasses={["metals"]}
      titleKey="metals.title"
      errorTitleKey="metals.pageErrorTitle"
      emptyTitleKey="metals.noMetals"
      emptyDescriptionKey="metals.noMetalsDesc"
      allowedAddAssetClasses={["metals"]}
    />
  );
}
