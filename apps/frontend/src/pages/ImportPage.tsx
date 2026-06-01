import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Upload } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { ImportHistoryCard } from "@/features/imports/ImportHistoryCard";
import { TransactionImportCard } from "@/features/imports/TransactionImportCard";
import { RecipientsImportCard } from "@/features/imports/RecipientsImportCard";
import { CategoriesImportCard } from "@/features/imports/CategoriesImportCard";
import { ExportCard } from "@/features/imports/ExportCard";
import { SupportedBanksCard } from "@/features/imports/SupportedBanksCard";

export default function ImportPage() {
  const { t } = useLanguage();
  const [historyKey, setHistoryKey] = useState(0);

  return (
    <div className="space-y-8 animate-in max-w-2xl mx-auto">
      <PageHeader
        title={t('importPage.title')}
        subtitle={t('importPage.subtitle')}
        icon={Upload}
      />
      <TransactionImportCard onImportSuccess={() => setHistoryKey((k) => k + 1)} />
      <RecipientsImportCard />
      <CategoriesImportCard />
      <ExportCard />
      <ImportHistoryCard refreshKey={historyKey} />
      <SupportedBanksCard />
    </div>
  );
}
