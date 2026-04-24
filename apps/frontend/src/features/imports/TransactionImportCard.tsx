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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { CsvColumnMapper } from "@/components/import/CsvColumnMapper";
import { apiClient } from "@/lib/api";
import { toast } from "sonner";
import {
  CheckCircle2,
  CloudUpload,
  File,
  Landmark,
  Loader2,
  PencilLine,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { useAdapters } from "./useAdapters";
import type { ImportProgress } from "@/lib/api/types";

interface CustomConfig {
  dateColumn: string;
  dateFormat: string;
  recipientColumn: string;
  amountColumn: string;
  memoColumn: string;
  separator: string;
  encoding: string;
  skipRows: number;
}

const DEFAULT_CUSTOM_CONFIG: CustomConfig = {
  dateColumn: "",
  dateFormat: "%Y-%m-%d",
  recipientColumn: "",
  amountColumn: "",
  memoColumn: "",
  separator: ",",
  encoding: "utf-8",
  skipRows: 0,
};

interface TransactionImportCardProps {
  onImportSuccess: () => void;
}

export function TransactionImportCard({ onImportSuccess }: TransactionImportCardProps) {
  const { t } = useLanguage();
  const { adapters, loading: adaptersLoading } = useAdapters();
  const [file, setFile] = useState<File | null>(null);
  const [bankSource, setBankSource] = useState("");
  const [customBank, setCustomBank] = useState("");
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [customConfig, setCustomConfig] = useState<CustomConfig>(DEFAULT_CUSTOM_CONFIG);
  const abortRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((f: File | null) => {
    if (f && f.type !== "text/csv" && !f.name.endsWith(".csv")) {
      toast.error(t('importPage.toast.noFile'));
      return;
    }
    setFile(f);
  }, [t]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0] ?? null);
  }, [handleFile]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => setDragOver(false), []);

  const resolvedBank = () => bankSource === "custom" ? (customBank || "generic") : bankSource;

  const handleImport = async () => {
    if (!file) { toast.error(t('importPage.toast.noFileSel')); return; }
    const bank = resolvedBank();
    if (!bank) { toast.error(t('importPage.toast.noBank')); return; }
    if (bankSource === "custom" && (!customConfig.dateColumn || !customConfig.recipientColumn || !customConfig.amountColumn)) {
      toast.error(t('importPage.toast.noConfig'));
      return;
    }

    setLoading(true);
    setProgress({ phase: 'connecting', current: 0, total: 0, imported: 0, duplicates: 0, errors: 0, percent: 0 });

    try {
      let data;
      if (bankSource === "custom") {
        data = await apiClient.importCSVCustom(
          file, bank,
          customConfig.dateFormat, customConfig.dateColumn,
          customConfig.recipientColumn, customConfig.amountColumn,
          customConfig.memoColumn || undefined,
          customConfig.separator, customConfig.encoding, customConfig.skipRows,
        );
        setProgress({ phase: 'complete', current: data.total_processed, total: data.total_processed, imported: data.imported, duplicates: data.duplicates, errors: data.errors || 0, percent: 100 });
      } else {
        const { abort, result } = apiClient.importCSVWithProgress(file, bank, (p) => setProgress(p));
        abortRef.current = abort;
        data = await result;
        abortRef.current = null;
      }

      toast.success(t('importPage.toast.importSuccess', { n: data.imported, dups: data.duplicates, total: data.total_processed }), {
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
      onImportSuccess();
      setFile(null);
      setBankSource("");
      setCustomBank("");
      setCustomConfig(DEFAULT_CUSTOM_CONFIG);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('importPage.failed');
      toast.error(t('importPage.toast.serverError'), { description: message });
      setProgress((p) => p ? { ...p, phase: 'error' } : null);
    } finally {
      setLoading(false);
    }
  };

  const handleCancelImport = () => {
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
      setLoading(false);
      setProgress(null);
      toast.info(t('importPage.toast.importCancelled'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5 text-primary" />
          {t('importPage.csvImport')}
        </CardTitle>
        <CardDescription>{t('importPage.csvImportDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Bank selector */}
        <div className="space-y-2">
          <Label htmlFor="bank-select" className="font-semibold">{t('importPage.bankSource')}</Label>
          <Select value={bankSource} onValueChange={setBankSource}>
            <SelectTrigger id="bank-select">
              <SelectValue placeholder={t('importPage.bankSourcePlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {adaptersLoading ? (
                <SelectItem value="loading" disabled>
                  <Loader2 className="h-4 w-4 mr-2 inline" /> {t('importPage.loading')}
                </SelectItem>
              ) : adapters.length > 0 ? (
                adapters.map((adapter) => (
                  <SelectItem key={adapter.key} value={adapter.key}>
                    <span className="inline-flex items-center gap-2">
                      <Landmark className="h-3.5 w-3.5 text-muted-foreground" />
                      {adapter.name}
                    </span>
                  </SelectItem>
                ))
              ) : (
                <SelectItem value="none" disabled>{t('importPage.noParsers')}</SelectItem>
              )}
              <SelectItem value="custom">
                <span className="inline-flex items-center gap-2">
                  <PencilLine className="h-3.5 w-3.5 text-muted-foreground" />
                  {t('importPage.customOther')}
                </span>
              </SelectItem>
            </SelectContent>
          </Select>

          {bankSource === "custom" && (
            <Input
              placeholder={t('importPage.customBankName')}
              value={customBank}
              onChange={(e) => setCustomBank(e.target.value)}
              className="mt-2"
            />
          )}
          <p className="text-xs text-muted-foreground">{t('importPage.bankHint')}</p>
        </div>

        {/* Custom CSV configuration */}
        {bankSource === "custom" && (
          <div className="space-y-4 p-4 border rounded-lg bg-muted/30">
            <p className="text-sm font-semibold text-foreground">{t('importPage.customConfig')}</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="separator">{t('importPage.separator')}</Label>
                <Select value={customConfig.separator} onValueChange={(val) => setCustomConfig({ ...customConfig, separator: val })}>
                  <SelectTrigger id="separator"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value=",">, (Comma)</SelectItem>
                    <SelectItem value=";">; (Semicolon)</SelectItem>
                    <SelectItem value="\t">⇥ (Tab)</SelectItem>
                    <SelectItem value="|">| (Pipe)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="date-format">{t('importPage.dateFormat')}</Label>
                <Select value={customConfig.dateFormat} onValueChange={(val) => setCustomConfig({ ...customConfig, dateFormat: val })}>
                  <SelectTrigger id="date-format"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="%Y-%m-%d">YYYY-MM-DD (2024-12-31)</SelectItem>
                    <SelectItem value="%d/%m/%Y">DD/MM/YYYY (31/12/2024)</SelectItem>
                    <SelectItem value="%m/%d/%Y">MM/DD/YYYY (12/31/2024)</SelectItem>
                    <SelectItem value="%d-%m-%Y">DD-MM-YYYY (31-12-2024)</SelectItem>
                    <SelectItem value="%Y-%m-%d %H:%M:%S">YYYY-MM-DD HH:MM:SS</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="encoding">{t('importPage.encoding')}</Label>
                <Select value={customConfig.encoding} onValueChange={(val) => setCustomConfig({ ...customConfig, encoding: val })}>
                  <SelectTrigger id="encoding"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="utf-8">UTF-8</SelectItem>
                    <SelectItem value="latin-1">Latin-1</SelectItem>
                    <SelectItem value="iso-8859-1">ISO-8859-1</SelectItem>
                    <SelectItem value="windows-1252">Windows-1252</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="skip-rows">{t('importPage.skipRows')}</Label>
                <Input
                  id="skip-rows"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={customConfig.skipRows}
                  onChange={(e) => setCustomConfig({ ...customConfig, skipRows: parseInt(e.target.value) || 0 })}
                />
              </div>
            </div>

            <CsvColumnMapper
              file={file}
              separator={customConfig.separator}
              config={{
                dateColumn: customConfig.dateColumn,
                recipientColumn: customConfig.recipientColumn,
                amountColumn: customConfig.amountColumn,
                memoColumn: customConfig.memoColumn,
              }}
              onChange={(cols) => setCustomConfig({ ...customConfig, ...cols })}
            />
            <p className="text-xs text-muted-foreground">{t('importPage.requiredNote')}</p>
          </div>
        )}

        {/* Drag-and-drop file picker */}
        <div className="space-y-2">
          <Label className="font-semibold">{t('importPage.csvFile')}</Label>
          <div
            onClick={() => fileInputRef.current?.click()}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            className={`relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 cursor-pointer transition-colors duration-200 ${
              dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/50"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <>
                <File className="h-10 w-10 text-primary" />
                <div className="text-center">
                  <p className="font-medium text-foreground">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} {t('common.kb')}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={(e) => { e.stopPropagation(); setFile(null); }}
                >
                  <Trash2 className="h-4 w-4 mr-1" /> {t('importPage.remove')}
                </Button>
              </>
            ) : (
              <>
                <CloudUpload className="h-10 w-10 text-muted-foreground" />
                <div className="text-center">
                  <p className="font-medium text-foreground">{t('importPage.dropzone')}</p>
                  <p className="text-sm text-muted-foreground">{t('importPage.dropzoneOr')}</p>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Progress indicator */}
        {progress && loading && (
          <div className="space-y-3 p-4 rounded-lg border bg-muted/30">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground font-medium capitalize">
                {progress.phase === 'counting' && t('importPage.analyzing')}
                {progress.phase === 'parsing' && t('importPage.parsingCSV')}
                {progress.phase === 'importing' && t('importPage.importingTxns')}
                {progress.phase === 'connecting' && t('importPage.connecting')}
              </span>
              <span className="text-foreground font-semibold">{progress.percent}%</span>
            </div>
            <Progress value={progress.percent} className="h-2" />
            {progress.phase === 'importing' && progress.total > 0 && (
              <div className="flex gap-4 text-xs text-muted-foreground">
                <span>{t('importPage.rows', { current: progress.current, total: progress.total })}</span>
                <span className="text-green-600 dark:text-green-400">{t('importPage.imported', { n: progress.imported })}</span>
                <span className="text-amber-600 dark:text-amber-400">{t('importPage.duplicates', { n: progress.duplicates })}</span>
                {progress.errors > 0 && <span className="text-destructive">{t('importPage.errors', { n: progress.errors })}</span>}
              </div>
            )}
          </div>
        )}

        {/* Import complete summary */}
        {progress && !loading && progress.phase === 'complete' && (
          <div className="flex items-center gap-3 p-4 rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30">
            <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-green-800 dark:text-green-300">{t('importPage.complete')}</p>
              <p className="text-green-700 dark:text-green-400">
                {t('importPage.progressSummary', { imported: progress.imported, duplicates: progress.duplicates, errors: progress.errors })}
              </p>
            </div>
          </div>
        )}

        {progress && !loading && progress.phase === 'error' && (
          <div className="flex items-center gap-3 p-4 rounded-lg border border-destructive/30 bg-destructive/5">
            <XCircle className="h-5 w-5 text-destructive shrink-0" />
            <p className="text-sm font-medium text-destructive">{t('importPage.failed')}</p>
          </div>
        )}

        {/* Import / Cancel button */}
        <div className="flex gap-2">
          <Button onClick={handleImport} disabled={!file || loading} className="flex-1 h-11" size="lg">
            {loading ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('importPage.importingBtn')}</>
            ) : (
              <><Upload className="h-4 w-4 mr-2" /> {t('importPage.importBtn')}</>
            )}
          </Button>
          {loading && (
            <Button variant="outline" size="lg" className="h-11" onClick={handleCancelImport}>
              {t('importPage.cancelBtn')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
