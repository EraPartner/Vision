import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
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
import { CsvColumnMapper } from "@/features/imports/CsvColumnMapper";
import { CsvDropzone } from "@/features/imports/CsvDropzone";
import { FileHeadersPanel } from "@/features/imports/FileHeadersPanel";
import { SeparatorSelect, EncodingSelect, DateFormatSelect } from "@/features/imports/CsvFormatSelects";
import { isCsvFile } from "@/features/imports/csvFile";
import { apiClient } from "@/lib/api";
import { toast } from "sonner";
import {
  Bookmark,
  CheckCircle2,
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
import { consumePendingImportFile } from "@/lib/importHandoff";
import type { ImportProgress, ImportResult } from "@/lib/api/types";
import type { ImportCsvResult } from "@/lib/api/imports";

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
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [customConfig, setCustomConfig] = useState<CustomConfig>(DEFAULT_CUSTOM_CONFIG);
  const [editingSaved, setEditingSaved] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);

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

  // CSV dropped on the window / opened via Finder before this card mounted
  // (see lib/importHandoff.ts + ElectronBridge).
  useEffect(() => {
    const pending = consumePendingImportFile();
    if (pending && isCsvFile(pending)) setFile(pending);
  }, []);

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
      let data: ImportCsvResult | ImportResult;
      if (isCustomLike) {
        const custom = await apiClient.importCSVCustom(
          file, bank,
          customConfig.dateFormat, customConfig.dateColumn,
          customConfig.recipientColumn, customConfig.amountColumn,
          customConfig.memoColumn || undefined,
          customConfig.separator, customConfig.encoding, customConfig.skipRows,
        );
        if ('requires_review' in custom) {
          // 202: the batch is parked in awaiting_review, nothing was committed
          // and this branch carries no counts at all (`respondReviewRequired`
          // sends only batch_id / requires_review / match_source_counts). So
          // there is no completed-progress panel and no "imported N" toast to
          // show — the review page is the entire outcome.
          navigate(`/import/${custom.batch_id}/review`);
          return;
        }
        // 201: the row count on this route is `total`. It was read as
        // `total_processed` — a field this route has never put on the wire —
        // which is what rendered "undefined total processed" in the toast.
        data = custom;
        setProgress({ phase: 'complete', current: custom.total, total: custom.total, imported: custom.imported, duplicates: custom.duplicates, errors: custom.errors, percent: 100 });
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

      // Both shapes that reach here are committed imports; the SSE result names
      // the row count `total_processed` (importRoutes.js:362) and the
      // non-streaming route names it `total` (buildPipelineResult).
      // (`?? 0` is a type bridge only: every committed SSE result carries
      // total_processed — importResultSchema requires it — the field is just
      // optional on ImportResult for the review-required variant, which
      // returned above.)
      const totalProcessed = 'total' in data ? data.total : data.total_processed ?? 0;
      toast.success(t('importPage.toast.importSuccess', { n: data.imported, dups: data.duplicates, total: totalProcessed }), {
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
      onImportSuccess();
      setFile(null);
      setBankSource("");
      setCustomBank("");
      setCustomConfig(DEFAULT_CUSTOM_CONFIG);
    } catch (error) {
      toast.error(t('importPage.toast.serverError'), { description: apiErrorToMessage(error, t) });
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
              <SeparatorSelect id="separator" value={customConfig.separator} onChange={(val) => setCustomConfig({ ...customConfig, separator: val })} />
              <DateFormatSelect id="date-format" value={customConfig.dateFormat} onChange={(val) => setCustomConfig({ ...customConfig, dateFormat: val })} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <EncodingSelect id="encoding" value={customConfig.encoding} onChange={(val) => setCustomConfig({ ...customConfig, encoding: val })} />
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
        <CsvDropzone file={file} onFileSelect={setFile} label={t('importPage.csvFile')} />

        {/* Detected columns of the selected file (always shown once a file is chosen) */}
        <FileHeadersPanel
          file={file}
          separator={isCustomLike ? customConfig.separator : undefined}
          highlightedHeaders={
            isCustomLike
              ? [
                  customConfig.dateColumn,
                  customConfig.recipientColumn,
                  customConfig.amountColumn,
                  customConfig.memoColumn,
                ]
              : []
          }
          defaultCollapsed={isCustomLike}
        />

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
                <span className="text-success">{t('importPage.imported', { n: progress.imported })}</span>
                <span className="text-warning">{t('importPage.duplicates', { n: progress.duplicates })}</span>
                {progress.errors > 0 && <span className="text-destructive">{t('importPage.errors', { n: progress.errors })}</span>}
              </div>
            )}
          </div>
        )}

        {/* Import complete summary */}
        {progress && !loading && progress.phase === 'complete' && (
          <div className="flex items-center gap-3 p-4 rounded-lg border border-success/30 bg-success/10">
            <CheckCircle2 className="icon-success-bounce h-5 w-5 text-success shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-success">{t('importPage.complete')}</p>
              <p className="text-success">
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
