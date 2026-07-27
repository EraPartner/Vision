/**
 * SimpleImportCard — the shared shell for the lightweight CSV import surfaces
 * (recipients, categories) that share one shape: separator (+ optional encoding)
 * selects, a compact CsvDropzone, an imported/skipped/errors result panel, and a
 * single submit button. The richer transaction/portfolio imports (column mapping,
 * previews) intentionally do NOT use this — they have their own flow.
 */

import { useState, type ComponentType } from "react";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { CheckCircle2, Loader2 } from "lucide-react";
import { CsvDropzone } from "@/features/imports/CsvDropzone";
import { SeparatorSelect, EncodingSelect } from "@/features/imports/CsvFormatSelects";

export interface SimpleImportResult {
  imported: number;
  skipped: number;
  errors: number;
}

interface SimpleImportCardProps<R extends SimpleImportResult> {
  icon: ComponentType<{ className?: string }>;
  /** Prefix for the select element ids (e.g. "recipient" -> "recipient-separator"). */
  idPrefix: string;
  titleKey: string;
  descKey: string;
  importingLabelKey: string;
  importLabelKey: string;
  importFailedKey: string;
  /** Show the encoding select alongside the separator (recipients need it). */
  showEncoding?: boolean;
  onImport: (file: File, separator: string, encoding: string) => Promise<R>;
  /** Build the success-toast message from the import result. */
  successToast: (result: R) => string;
}

export function SimpleImportCard<R extends SimpleImportResult>({
  icon: Icon,
  idPrefix,
  titleKey,
  descKey,
  importingLabelKey,
  importLabelKey,
  importFailedKey,
  showEncoding = false,
  onImport,
  successToast,
}: SimpleImportCardProps<R>) {
  const { t } = useLanguage();
  const [file, setFile] = useState<File | null>(null);
  const [separator, setSeparator] = useState(",");
  const [encoding, setEncoding] = useState("utf-8");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SimpleImportResult | null>(null);

  const handleImport = async () => {
    if (!file) { toast.error(t('importPage.toast.noFileSel')); return; }
    setLoading(true);
    setResult(null);
    try {
      const data = await onImport(file, separator, encoding);
      setResult({ imported: data.imported, skipped: data.skipped, errors: data.errors });
      toast.success(successToast(data), { icon: <CheckCircle2 className="h-4 w-4" /> });
      setFile(null);
    } catch (err) {
      toast.error(t(importFailedKey), { description: apiErrorToMessage(err, t) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-primary" />
          {t(titleKey)}
        </CardTitle>
        <CardDescription>{t(descKey)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className={showEncoding ? "grid grid-cols-1 sm:grid-cols-2 gap-4" : "w-full sm:w-1/2"}>
          <SeparatorSelect id={`${idPrefix}-separator`} value={separator} onChange={setSeparator} />
          {showEncoding && <EncodingSelect id={`${idPrefix}-encoding`} value={encoding} onChange={setEncoding} />}
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
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t(importingLabelKey)}</>
          ) : (
            <><Icon className="h-4 w-4 mr-2" /> {t(importLabelKey)}</>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
