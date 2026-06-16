import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api";
import { Tags } from "lucide-react";
import { SimpleImportCard } from "@/features/imports/SimpleImportCard";

export function CategoriesImportCard() {
  const { t } = useLanguage();
  return (
    <SimpleImportCard
      icon={Tags}
      idPrefix="category"
      titleKey="importPage.categoriesImport"
      descKey="importPage.categoriesImportDesc"
      importingLabelKey="importPage.importingCategories"
      importLabelKey="importPage.importCategoriesBtn"
      importFailedKey="importPage.toast.categoriesImportFailed"
      onImport={(file, separator) => apiClient.importCategories(file, separator)}
      successToast={(data) =>
        t('importPage.toast.importSuccess', { n: data.imported, dups: data.skipped, total: data.total_processed })
      }
    />
  );
}
