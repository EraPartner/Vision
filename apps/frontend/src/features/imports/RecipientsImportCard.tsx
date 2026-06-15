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
import { CheckCircle2, Loader2, Users } from "lucide-react";
import { CsvDropzone } from "@/features/imports/CsvDropzone";
import { SeparatorSelect, EncodingSelect } from "@/features/imports/CsvFormatSelects";

interface RecipientResult {
  imported: number;
  skipped: number;
  errors: number;
}

export function RecipientsImportCard() {
  const { t } = useLanguage();
  const [file, setFile] = useState<File | null>(null);
  const [separator, setSeparator] = useState(",");
  const [encoding, setEncoding] = useState("utf-8");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RecipientResult | null>(null);

  const handleImport = async () => {
    if (!file) { toast.error(t('importPage.toast.noFileSel')); return; }
    setLoading(true);
    setResult(null);
    try {
      const data = await apiClient.importRecipients(file, separator, encoding);
      setResult({ imported: data.imported, skipped: data.skipped, errors: data.errors });
      toast.success(t('importPage.recipientsResult', { n: data.imported, e: data.skipped, x: data.errors }), {
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
      setFile(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : undefined;
      toast.error(t('importPage.toast.recipientsImportFailed'), { description: msg });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          {t('importPage.recipientsImport')}
        </CardTitle>
        <CardDescription>{t('importPage.recipientsImportDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <SeparatorSelect id="recipient-separator" value={separator} onChange={setSeparator} />
          <EncodingSelect id="recipient-encoding" value={encoding} onChange={setEncoding} />
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
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('importPage.importingRecipients')}</>
          ) : (
            <><Users className="h-4 w-4 mr-2" /> {t('importPage.importRecipientsBtn')}</>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
