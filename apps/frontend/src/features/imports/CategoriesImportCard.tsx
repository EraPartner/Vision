import { useCallback, useRef, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api";
import { toast } from "sonner";
import { CheckCircle2, CloudUpload, File, Loader2, Tags, Trash2 } from "lucide-react";

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
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((f: File | null) => {
    if (f && f.type !== "text/csv" && !f.name.endsWith(".csv")) {
      toast.error(t('importPage.toast.noFile'));
      return;
    }
    setFile(f);
    setResult(null);
  }, [t]);

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
        <div className="w-full sm:w-1/2 space-y-2">
          <Label htmlFor="category-separator">{t('importPage.separator')}</Label>
          <Select value={separator} onValueChange={setSeparator}>
            <SelectTrigger id="category-separator"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value=",">{t('importPage.sep.comma')}</SelectItem>
              <SelectItem value=";">{t('importPage.sep.semicolon')}</SelectItem>
              <SelectItem value="\t">{t('importPage.sep.tab')}</SelectItem>
              <SelectItem value="|">{t('importPage.sep.pipe')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div
          onClick={() => fileRef.current?.click()}
          onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0] ?? null); }}
          onDragOver={(e) => e.preventDefault()}
          className="relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 cursor-pointer transition-colors duration-200 border-border hover:border-primary/50 hover:bg-muted/50"
        >
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <>
              <File className="h-8 w-8 text-primary" />
              <div className="text-center">
                <p className="font-medium text-foreground">{file.name}</p>
                <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} {t('common.kb')}</p>
              </div>
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive"
                onClick={(e) => { e.stopPropagation(); setFile(null); }}>
                <Trash2 className="h-4 w-4 mr-1" /> {t('importPage.remove')}
              </Button>
            </>
          ) : (
            <>
              <CloudUpload className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t('importPage.dropzoneSmall')}</p>
            </>
          )}
        </div>

        {result && !loading && (
          <div className="flex items-center gap-3 p-3 rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30">
            <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
            <p className="text-sm text-green-800 dark:text-green-300">
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
