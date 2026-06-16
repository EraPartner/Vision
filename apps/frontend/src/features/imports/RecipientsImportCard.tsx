import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api";
import { Users } from "lucide-react";
import { SimpleImportCard } from "@/features/imports/SimpleImportCard";

export function RecipientsImportCard() {
  const { t } = useLanguage();
  return (
    <SimpleImportCard
      icon={Users}
      idPrefix="recipient"
      titleKey="importPage.recipientsImport"
      descKey="importPage.recipientsImportDesc"
      importingLabelKey="importPage.importingRecipients"
      importLabelKey="importPage.importRecipientsBtn"
      importFailedKey="importPage.toast.recipientsImportFailed"
      showEncoding
      onImport={(file, separator, encoding) => apiClient.importRecipients(file, separator, encoding)}
      successToast={(data) =>
        t('importPage.recipientsResult', { n: data.imported, e: data.skipped, x: data.errors })
      }
    />
  );
}
