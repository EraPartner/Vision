import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Tags } from "lucide-react";
import { CsvDropzone } from "@/features/imports/CsvDropzone";
import { SeparatorSelect } from "@/features/imports/CsvFormatSelects";

interface CategoryResult {
  imported: number;
  skipped: number;
  errors: number;
  total_processed: number;
}

export function CategoriesImportCard() {
  const { t } = useLanguage();
  const [file, setFile] = useState<File | null>(null);
  const [separator, setSeparator] = useState(",");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CategoryResult | null>(null);

  const handleImport = async () => {
    if (!file) { toast.error(t('importPage.toast.noFileSel')); return; }
    setLoading(true);
    setResult(null);
    try {
      const data = await apiClient.importCategories(file, separator);
      setResult({ imported: data.imported, skipped: data.skipped, errors: data.errors, total_processed: data.total_processed });
      toast.success(t('importPage.toast.importSuccess', { n: data.imported, dups: data.skipped, total: data.total_processed }), {
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
      setFile(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : undefined;
      toast.error(t('importPage.toast.categoriesImportFailed'), { description: msg });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Tags className="h-5 w-5 text-primary" />
          {t('importPage.categoriesImport')}
        </CardTitle>
        <CardDescription>{t('importPage.categoriesImportDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="w-full sm:w-1/2">
          <SeparatorSelect id="category-separator" value={separator} onChange={setSeparator} />
        </div>

        <CsvDropzone file={file} onFileSelect={(f) => { setFile(f); setResult(null); }} compact />

        {result && !loading && (
          <div className="flex items-center gap-3 p-3 rounded-lg border border-success/30 bg-success/10">
            <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
            <p className="text-sm text-success">
              {t('importPage.resultSummary', { imported: result.imported, skipped: result.skipped, errors: result.errors })}
            </p>
          </div>
        )}

        <Button onClick={handleImport} disabled={!file || loading} className="w-full h-11" size="lg">
          {loading ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('importPage.importingCategories')}</>
          ) : (
            <><Tags className="h-4 w-4 mr-2" /> {t('importPage.importCategoriesBtn')}</>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
