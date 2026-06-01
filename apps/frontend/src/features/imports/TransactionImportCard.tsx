import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  Bookmark,
  CheckCircle2,
  CloudUpload,
  File,
  Landmark,
  Loader2,
  Pencil,
  PencilLine,
  Save,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { useAdapters } from "./useAdapters";
import {
  useCustomParserConfigs,
  useCreateCustomParserConfig,
  useUpdateCustomParserConfig,
  useDeleteCustomParserConfig,
} from "@/hooks/useCustomParserConfigs";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
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
  const navigate = useNavigate();
  const { adapters, loading: adaptersLoading } = useAdapters();
  const [file, setFile] = useState<File | null>(null);
  const [bankSource, setBankSource] = useState("");
  const [customBank, setCustomBank] = useState("");
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [customConfig, setCustomConfig] = useState<CustomConfig>(DEFAULT_CUSTOM_CONFIG);
  const [editingSaved, setEditingSaved] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: savedParsers } = useCustomParserConfigs();
  const createParser = useCreateCustomParserConfig();
  const updateParser = useUpdateCustomParserConfig();
  const deleteParser = useDeleteCustomParserConfig();
  const { confirm, ConfirmDialog } = useConfirmDialog();

  const isSaved = bankSource.startsWith("saved:");
  const selectedParser = isSaved
    ? savedParsers?.find((p) => p.id === Number(bankSource.slice(6)))
    : undefined;
  const isCustomLike = isSaved || bankSource === "custom";
  // Editable config form shows for new custom imports, or when editing a saved parser.
  const showConfigEditor = bankSource === "custom" || (isSaved && editingSaved);

  const handleBankChange = (val: string) => {
    setBankSource(val);
    setProgress(null);
    setEditingSaved(false);
    if (val.startsWith("saved:")) {
      const parser = savedParsers?.find((p) => p.id === Number(val.slice(6)));
      if (parser) {
        setCustomConfig({ ...DEFAULT_CUSTOM_CONFIG, ...parser.config });
        setCustomBank(parser.name);
      }
    } else if (val === "custom") {
      setCustomConfig(DEFAULT_CUSTOM_CONFIG);
      setCustomBank("");
    }
  };

  const hasRequiredMapping = Boolean(
    customConfig.dateColumn && customConfig.recipientColumn && customConfig.amountColumn,
  );

  const handleSaveParser = async () => {
    const name = customBank.trim();
    if (!name) { toast.error(t('importPage.customParser.nameRequired')); return; }
    if (!hasRequiredMapping) { toast.error(t('importPage.toast.noConfig')); return; }
    const config = { ...customConfig };
    if (isSaved && selectedParser) {
      await updateParser.mutateAsync({ id: selectedParser.id, name, config });
      setEditingSaved(false);
    } else {
      const created = await createParser.mutateAsync({ name, config });
      setBankSource(`saved:${created.id}`);
    }
  };

  const handleDeleteParser = async () => {
    if (!selectedParser) return;
    const ok = await confirm({
      title: t('importPage.customParser.deleteTitle'),
      description: t('importPage.customParser.deleteConfirm', { name: selectedParser.name }),
      variant: "destructive",
    });
    if (!ok) return;
    await deleteParser.mutateAsync(selectedParser.id);
    setBankSource("");
    setCustomBank("");
    setCustomConfig(DEFAULT_CUSTOM_CONFIG);
  };

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

  const resolvedBank = () => {
    if (isSaved) return selectedParser?.name || "generic";
    if (bankSource === "custom") return customBank || "generic";
    return bankSource;
  };

  const handleImport = async () => {
    if (!file) { toast.error(t('importPage.toast.noFileSel')); return; }
    const bank = resolvedBank();
    if (!bank) { toast.error(t('importPage.toast.noBank')); return; }
    if (isCustomLike && !hasRequiredMapping) {
      toast.error(t('importPage.toast.noConfig'));
      return;
    }

    setLoading(true);
    setProgress({ phase: 'connecting', current: 0, total: 0, imported: 0, duplicates: 0, errors: 0, percent: 0 });

    try {
      let data;
      if (isCustomLike) {
        data = await apiClient.importCSVCustom(
          file, bank,
          customConfig.dateFormat, customConfig.dateColumn,
          customConfig.recipientColumn, customConfig.amountColumn,
          customConfig.memoColumn || undefined,
          customConfig.separator, customConfig.encoding, customConfig.skipRows,
        );
        setProgress({ phase: 'complete', current: data.total_processed, total: data.total_processed, imported: data.imported, duplicates: data.duplicates, errors: (data as { errors?: number }).errors || 0, percent: 100 });
      } else {
        const { abort, result } = apiClient.importCSVWithProgress(file, bank, (p) => setProgress(p));
        abortRef.current = abort;
        data = await result;
        abortRef.current = null;
      }

      if ('requires_review' in data && data.requires_review && data.batch_id != null) {
        navigate(`/import/${data.batch_id}/review`);
        return;
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
          <Select value={bankSource} onValueChange={handleBankChange}>
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
              {savedParsers && savedParsers.length > 0 && savedParsers.map((parser) => (
                <SelectItem key={parser.id} value={`saved:${parser.id}`}>
                  <span className="inline-flex items-center gap-2">
                    <Bookmark className="h-3.5 w-3.5 text-primary" />
                    {parser.name}
                  </span>
                </SelectItem>
              ))}
              <SelectItem value="custom">
                <span className="inline-flex items-center gap-2">
                  <PencilLine className="h-3.5 w-3.5 text-muted-foreground" />
                  {t('importPage.customOther')}
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('importPage.bankHint')}</p>
        </div>

        {/* Custom CSV configuration */}
        {isCustomLike && (
          <div className="space-y-4 p-4 border rounded-lg bg-muted/30">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">{t('importPage.customConfig')}</p>
              {isSaved && !editingSaved && (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditingSaved(true)}>
                    <Pencil className="h-4 w-4 mr-1" /> {t('importPage.customParser.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={handleDeleteParser}
                    disabled={deleteParser.isPending}
                  >
                    <Trash2 className="h-4 w-4 mr-1" /> {t('importPage.customParser.delete')}
                  </Button>
                </div>
              )}
            </div>

            {/* Read-only summary for a selected saved parser */}
            {isSaved && !editingSaved && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <div><span className="font-medium text-foreground">{t('importPage.dateCol')}:</span> {customConfig.dateColumn}</div>
                <div><span className="font-medium text-foreground">{t('importPage.recipientCol')}:</span> {customConfig.recipientColumn}</div>
                <div><span className="font-medium text-foreground">{t('importPage.amountCol')}:</span> {customConfig.amountColumn}</div>
                <div><span className="font-medium text-foreground">{t('importPage.memoCol')}:</span> {customConfig.memoColumn || "—"}</div>
                <div><span className="font-medium text-foreground">{t('importPage.separator')}:</span> {customConfig.separator}</div>
                <div><span className="font-medium text-foreground">{t('importPage.dateFormat')}:</span> {customConfig.dateFormat}</div>
              </div>
            )}

            {showConfigEditor && (
            <>
            <div className="space-y-2">
              <Label htmlFor="parser-name">{t('importPage.customParser.name')}</Label>
              <Input
                id="parser-name"
                placeholder={t('importPage.customBankName')}
                value={customBank}
                onChange={(e) => setCustomBank(e.target.value)}
              />
            </div>

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
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleSaveParser}
                disabled={createParser.isPending || updateParser.isPending || !hasRequiredMapping || !customBank.trim()}
              >
                <Save className="h-4 w-4 mr-1" />
                {isSaved ? t('importPage.customParser.saveChanges') : t('importPage.customParser.save')}
              </Button>
              {isSaved && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingSaved(false);
                    if (selectedParser) {
                      setCustomConfig({ ...DEFAULT_CUSTOM_CONFIG, ...selectedParser.config });
                      setCustomBank(selectedParser.name);
                    }
                  }}
                >
                  {t('common.cancel')}
                </Button>
              )}
            </div>
            </>
            )}
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
        <ConfirmDialog />
      </CardContent>
    </Card>
  );
}
