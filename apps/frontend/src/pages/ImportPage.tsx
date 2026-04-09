import { useCallback, useEffect, useRef, useState } from "react";
import logger from "@/lib/logger";
import { useLanguage } from "@/contexts/LanguageContext";
import { API_BASE_URL } from "@/lib/api";
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
import { DatePicker } from "@/components/shared/DatePicker";
import { parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";
import { apiClient } from "@/lib/api";
import { toast } from "sonner";
import {
  CheckCircle2,
  CloudUpload,
  Download,
  File,
  Landmark,
  Loader2,
  PencilLine,
  Tags,
  Trash2,
  Upload,
  Users,
  XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";

interface ImportProgress {
  phase: string;
  current: number;
  total: number;
  imported: number;
  duplicates: number;
  errors: number;
  percent: number;
}

export default function ImportPage() {
  const { t } = useLanguage();
  const [file, setFile] = useState<File | null>(null);
  const [bankSource, setBankSource] = useState("");
  const [customBank, setCustomBank] = useState("");
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch supported parsers from backend
  interface BankAdapter {
    key: string;
    name: string;
    adapter_class: string;
  }

  const [adapters, setAdapters] = useState<BankAdapter[]>([]);
  const [adaptersLoading, setAdaptersLoading] = useState(false);
  const [adaptersError, setAdaptersError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const loadAdapters = async () => {
      setAdaptersLoading(true);
      setAdaptersError(null);
      try {
        const res = await apiClient.getSupportedParsers();
        if (mounted && res && Array.isArray(res.adapters)) {
          setAdapters(res.adapters);
        }
      } catch (err) {
        logger.error("Failed to load supported parsers", err);
        if (mounted) {
          setAdaptersError(err instanceof Error ? err.message : String(err));
          setAdapters([]);
          toast.error(t('importPage.toast.parsersError'));
        }
      } finally {
        if (mounted) setAdaptersLoading(false);
      }
    };

    loadAdapters();
    return () => {
      mounted = false;
    };
  }, []);

  const handleFile = useCallback((f: File | null) => {
    if (f && f.type !== "text/csv" && !f.name.endsWith(".csv")) {
      toast.error(t('importPage.toast.noFile'));
      return;
    }
    setFile(f);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const droppedFile = e.dataTransfer.files?.[0];
      handleFile(droppedFile ?? null);
    },
    [handleFile]
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => setDragOver(false), []);

  const resolvedBank = () => {
    if (bankSource === "custom") return customBank || "generic";
    return bankSource;
  };

  const handleImport = async () => {
    if (!file) {
      toast.error(t('importPage.toast.noFileSel'));
      return;
    }

    const bank = resolvedBank();
    if (!bank) {
      toast.error(t('importPage.toast.noBank'));
      return;
    }

    // If custom bank, validate custom configuration
    if (bankSource === "custom") {
        if (!customConfig.dateColumn || !customConfig.recipientColumn || !customConfig.amountColumn) {
          toast.error(t('importPage.toast.noConfig'));
          return;
        }
    }

    setLoading(true);
    setProgress({ phase: 'connecting', current: 0, total: 0, imported: 0, duplicates: 0, errors: 0, percent: 0 });

    try {
      let data;

      if (bankSource === "custom") {
        // Custom config uses the non-streaming endpoint (no raw table)
        data = await apiClient.importCSVCustom(
          file,
          bank,
          customConfig.dateFormat,
          customConfig.dateColumn,
          customConfig.recipientColumn,
          customConfig.amountColumn,
          customConfig.memoColumn || undefined,
          customConfig.separator,
          customConfig.encoding,
          customConfig.skipRows
        );
        setProgress({ phase: 'complete', current: data.total_processed, total: data.total_processed, imported: data.imported, duplicates: data.duplicates, errors: data.errors || 0, percent: 100 });
      } else {
        // Use streaming import with SSE progress
        const { abort, result } = apiClient.importCSVWithProgress(
          file,
          bank,
          (p) => setProgress(p),
        );
        abortRef.current = abort;
        data = await result;
        abortRef.current = null;
      }

      toast.success(t('importPage.toast.importSuccess', { n: data.imported, dups: data.duplicates, total: data.total_processed }), {
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
      setFile(null);
      setBankSource("");
      setCustomBank("");
      setCustomConfig({
        dateColumn: "",
        dateFormat: "%Y-%m-%d",
        recipientColumn: "",
        amountColumn: "",
        memoColumn: "",
        separator: ",",
        encoding: "utf-8",
        skipRows: 0,
      });
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

  // ── Recipients import ────────────────────────────────────────────────────────
  const [recipientFile, setRecipientFile] = useState<File | null>(null);
  const [recipientSeparator, setRecipientSeparator] = useState(",");
  const [recipientEncoding, setRecipientEncoding] = useState("utf-8");
  const [recipientLoading, setRecipientLoading] = useState(false);
  const [recipientResult, setRecipientResult] = useState<{ imported: number; skipped: number; errors: number } | null>(null);
  const recipientFileRef = useRef<HTMLInputElement>(null);

  const handleRecipientFile = useCallback((f: File | null) => {
    if (f && f.type !== "text/csv" && !f.name.endsWith(".csv")) {
      toast.error(t('importPage.toast.noFile'));
      return;
    }
    setRecipientFile(f);
    setRecipientResult(null);
  }, []);

  const handleRecipientImport = async () => {
    if (!recipientFile) { toast.error(t('importPage.toast.noFileSel')); return; }
    setRecipientLoading(true);
    setRecipientResult(null);
    try {
      const data = await apiClient.importRecipients(recipientFile, recipientSeparator, recipientEncoding);
      setRecipientResult({ imported: data.imported, skipped: data.skipped, errors: data.errors });
      toast.success(t('importPage.recipientsResult', { n: data.imported, e: data.skipped, x: data.errors }), {
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
      setRecipientFile(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : undefined;
      toast.error(t('importPage.toast.recipientsImportFailed'), { description: msg });
    } finally {
      setRecipientLoading(false);
    }
  };

  // ── Categories import ────────────────────────────────────────────────────────
  const [categoryFile, setCategoryFile] = useState<File | null>(null);
  const [categorySeparator, setCategorySeparator] = useState(",");
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryResult, setCategoryResult] = useState<{ imported: number; skipped: number; errors: number } | null>(null);
  const categoryFileRef = useRef<HTMLInputElement>(null);

  const handleCategoryFile = useCallback((f: File | null) => {
    if (f && f.type !== "text/csv" && !f.name.endsWith(".csv")) {
      toast.error(t('importPage.toast.noFile'));
      return;
    }
    setCategoryFile(f);
    setCategoryResult(null);
  }, []);

  const handleCategoryImport = async () => {
    if (!categoryFile) { toast.error(t('importPage.toast.noFileSel')); return; }
    setCategoryLoading(true);
    setCategoryResult(null);
    try {
      const data = await apiClient.importCategories(categoryFile, categorySeparator);
      setCategoryResult({ imported: data.imported, skipped: data.skipped, errors: data.errors });
      toast.success(t('importPage.toast.importSuccess', { n: data.imported, dups: data.skipped, total: data.imported }), {
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
      setCategoryFile(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : undefined;
      toast.error(t('importPage.toast.categoriesImportFailed'), { description: msg });
    } finally {
      setCategoryLoading(false);
    }
  };

  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      // Build query parameters for export with filters
      const queryParams = new URLSearchParams();

      if (exportFilters.startDate) {
        queryParams.append('start_date', exportFilters.startDate);
      }
      if (exportFilters.endDate) {
        queryParams.append('end_date', exportFilters.endDate);
      }
      if (exportFilters.bankAccount) {
        queryParams.append('bank_account', exportFilters.bankAccount);
      }
      if (exportFilters.categoryId) {
        queryParams.append('category_id', exportFilters.categoryId);
      }

      const url = `${API_BASE_URL}/api/transactions/export/csv?${queryParams.toString()}`;

      // Call the backend export endpoint
      const response = await fetch(url, {
        method: 'GET',
      });

      if (!response.ok) {
        throw new Error('Failed to export transactions');
      }

      // Get the blob from the response
      const blob = await response.blob();

      // Create download link
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `transactions_${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(downloadUrl);

      toast.success(t('importPage.toast.exportSuccess'), {
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('importPage.toast.exportFailed');
      toast.error(t('importPage.toast.exportFailed'), { description: message });
    } finally {
      setExporting(false);
    }
  };

  // Custom CSV configuration state
  const [customConfig, setCustomConfig] = useState({
    dateColumn: "",
    dateFormat: "%Y-%m-%d",
    recipientColumn: "",
    amountColumn: "",
    memoColumn: "",
    separator: ",",
    encoding: "utf-8",
    skipRows: 0,
  });

  // Export filter state
  const [exportFilters, setExportFilters] = useState({
    startDate: "",
    endDate: "",
    bankAccount: "",
    categoryId: ""
  });
  const [showExportFilters, setShowExportFilters] = useState(false);

  return (
    <div className="space-y-8 animate-in max-w-2xl mx-auto">
      <PageHeader
        title={t('importPage.title')}
        subtitle={t('importPage.subtitle')}
        icon={Upload}
      />

      {/* Import Card */}
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
            <Label htmlFor="bank-select" className="font-semibold">
              {t('importPage.bankSource')}
            </Label>
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

          {/* Custom CSV configuration fields */}
          {bankSource === "custom" && (
            <div className="space-y-4 p-4 border rounded-lg bg-muted/30">
                  <p className="text-sm font-semibold text-foreground"> 
                 {t('importPage.customConfig')}
               </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="date-column">{t('importPage.dateCol')}</Label>
                  <Input
                    id="date-column"
                    placeholder={t('importPage.dateColPlaceholder')}
                    value={customConfig.dateColumn}
                    onChange={(e) =>
                      setCustomConfig({
                        ...customConfig,
                        dateColumn: e.target.value,
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="date-format">{t('importPage.dateFormat')}</Label>
                  <Select
                    value={customConfig.dateFormat}
                    onValueChange={(val) =>
                      setCustomConfig({ ...customConfig, dateFormat: val })
                    }
                  >
                    <SelectTrigger id="date-format">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="%Y-%m-%d">
                        YYYY-MM-DD (2024-12-31)
                      </SelectItem>
                      <SelectItem value="%d/%m/%Y">
                        DD/MM/YYYY (31/12/2024)
                      </SelectItem>
                      <SelectItem value="%m/%d/%Y">
                        MM/DD/YYYY (12/31/2024)
                      </SelectItem>
                      <SelectItem value="%d-%m-%Y">
                        DD-MM-YYYY (31-12-2024)
                      </SelectItem>
                      <SelectItem value="%Y-%m-%d %H:%M:%S">
                        YYYY-MM-DD HH:MM:SS
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="recipient-column">{t('importPage.recipientCol')}</Label>
                  <Input
                    id="recipient-column"
                    placeholder={t('importPage.recipientColPlaceholder')}
                    value={customConfig.recipientColumn}
                    onChange={(e) =>
                      setCustomConfig({
                        ...customConfig,
                        recipientColumn: e.target.value,
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="amount-column">{t('importPage.amountCol')}</Label>
                  <Input
                    id="amount-column"
                    placeholder={t('importPage.amountColPlaceholder')}
                    value={customConfig.amountColumn}
                    onChange={(e) =>
                      setCustomConfig({
                        ...customConfig,
                        amountColumn: e.target.value,
                      })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="memo-column">{t('importPage.memoCol')}</Label>
                  <Input
                    id="memo-column"
                    placeholder={t('importPage.memoColPlaceholder')}
                    value={customConfig.memoColumn}
                    onChange={(e) =>
                      setCustomConfig({
                        ...customConfig,
                        memoColumn: e.target.value,
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="separator">{t('importPage.separator')}</Label>
                  <Select
                    value={customConfig.separator}
                    onValueChange={(val) =>
                      setCustomConfig({ ...customConfig, separator: val })
                    }
                  >
                    <SelectTrigger id="separator">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value=",">, (Comma)</SelectItem>
                      <SelectItem value=";">; (Semicolon)</SelectItem>
                      <SelectItem value="\t">⇥ (Tab)</SelectItem>
                      <SelectItem value="|">| (Pipe)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="encoding">{t('importPage.encoding')}</Label>
                  <Select
                    value={customConfig.encoding}
                    onValueChange={(val) =>
                      setCustomConfig({ ...customConfig, encoding: val })
                    }
                  >
                    <SelectTrigger id="encoding">
                      <SelectValue />
                    </SelectTrigger>
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
                    onChange={(e) =>
                      setCustomConfig({
                        ...customConfig,
                        skipRows: parseInt(e.target.value) || 0,
                      })
                    }
                  />
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                {t('importPage.requiredFieldsNote')}
              </p>
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
              className={`
                relative flex flex-col items-center justify-center gap-3
                rounded-xl border-2 border-dashed p-10 cursor-pointer
                transition-colors duration-200
                ${dragOver
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-muted/50"
                }
              `}
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
                    <p className="text-xs text-muted-foreground">
                      {(file.size / 1024).toFixed(1)} {t('common.kb')}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                    }}
                  >
                   <Trash2 className="h-4 w-4 mr-1" />
                     {t('importPage.remove')}
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
                  {progress.errors > 0 && (
                    <span className="text-destructive">{t('importPage.errors', { n: progress.errors })}</span>
                  )}
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
            <Button
              onClick={handleImport}
              disabled={!file || loading}
              className="flex-1 h-11"
              size="lg"
            >
              {loading ? (
                <>
                   <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                   {t('importPage.importingBtn')}
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  {t('importPage.importBtn')}
                </>
              )}
            </Button>
            {loading && (
              <Button
                variant="outline"
                size="lg"
                className="h-11"
                onClick={handleCancelImport}
              >
                {t('importPage.cancelBtn')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Recipients Import Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            {t('importPage.recipientsImport')}
          </CardTitle>
          <CardDescription>
            {t('importPage.recipientsImportDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Options row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="recipient-separator">{t('importPage.separator')}</Label>
              <Select value={recipientSeparator} onValueChange={setRecipientSeparator}>
                <SelectTrigger id="recipient-separator">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value=",">{t('importPage.sep.comma')}</SelectItem>
                  <SelectItem value=";">{t('importPage.sep.semicolon')}</SelectItem>
                  <SelectItem value="\t">{t('importPage.sep.tab')}</SelectItem>
                  <SelectItem value="|">{t('importPage.sep.pipe')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="recipient-encoding">{t('importPage.encoding')}</Label>
              <Select value={recipientEncoding} onValueChange={setRecipientEncoding}>
                <SelectTrigger id="recipient-encoding">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="utf-8">UTF-8</SelectItem>
                  <SelectItem value="latin-1">Latin-1</SelectItem>
                  <SelectItem value="iso-8859-1">ISO-8859-1</SelectItem>
                  <SelectItem value="windows-1252">Windows-1252</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* File picker */}
          <div
            onClick={() => recipientFileRef.current?.click()}
            onDrop={(e) => { e.preventDefault(); handleRecipientFile(e.dataTransfer.files?.[0] ?? null); }}
            onDragOver={(e) => e.preventDefault()}
            className="relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 cursor-pointer transition-colors duration-200 border-border hover:border-primary/50 hover:bg-muted/50"
          >
            <input
              ref={recipientFileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => handleRecipientFile(e.target.files?.[0] ?? null)}
            />
            {recipientFile ? (
              <>
                <File className="h-8 w-8 text-primary" />
                <div className="text-center">
                  <p className="font-medium text-foreground">{recipientFile.name}</p>
                  <p className="text-xs text-muted-foreground">{(recipientFile.size / 1024).toFixed(1)} {t('common.kb')}</p>
                </div>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive"
                  onClick={(e) => { e.stopPropagation(); setRecipientFile(null); }}>
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

          {/* Result summary */}
          {recipientResult && !recipientLoading && (
            <div className="flex items-center gap-3 p-3 rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30">
              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
              <p className="text-sm text-green-800 dark:text-green-300">
                {t('importPage.resultSummary', { imported: recipientResult.imported, skipped: recipientResult.skipped, errors: recipientResult.errors })}
              </p>
            </div>
          )}

          <Button onClick={handleRecipientImport} disabled={!recipientFile || recipientLoading} className="w-full h-11" size="lg">
            {recipientLoading ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('importPage.importingRecipients')}</>
            ) : (
              <><Users className="h-4 w-4 mr-2" /> {t('importPage.importRecipientsBtn')}</>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Categories Import Card */}
      <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Tags className="h-5 w-5 text-primary" />
              {t('importPage.categoriesImport')}
            </CardTitle>
            <CardDescription>{t('importPage.categoriesImportDesc')}</CardDescription>
          </CardHeader>
        <CardContent className="space-y-5">
          {/* Separator option */}
          <div className="w-full sm:w-1/2 space-y-2">
            <Label htmlFor="category-separator">{t('importPage.separator')}</Label>
            <Select value={categorySeparator} onValueChange={setCategorySeparator}>
              <SelectTrigger id="category-separator">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value=",">{t('importPage.sep.comma')}</SelectItem>
                <SelectItem value=";">{t('importPage.sep.semicolon')}</SelectItem>
                <SelectItem value="\t">{t('importPage.sep.tab')}</SelectItem>
                <SelectItem value="|">{t('importPage.sep.pipe')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* File picker */}
          <div
            onClick={() => categoryFileRef.current?.click()}
            onDrop={(e) => { e.preventDefault(); handleCategoryFile(e.dataTransfer.files?.[0] ?? null); }}
            onDragOver={(e) => e.preventDefault()}
            className="relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 cursor-pointer transition-colors duration-200 border-border hover:border-primary/50 hover:bg-muted/50"
          >
            <input
              ref={categoryFileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => handleCategoryFile(e.target.files?.[0] ?? null)}
            />
            {categoryFile ? (
              <>
                <File className="h-8 w-8 text-primary" />
                <div className="text-center">
                  <p className="font-medium text-foreground">{categoryFile.name}</p>
                  <p className="text-xs text-muted-foreground">{(categoryFile.size / 1024).toFixed(1)} {t('common.kb')}</p>
                </div>
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive"
                  onClick={(e) => { e.stopPropagation(); setCategoryFile(null); }}>
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

          {/* Result summary */}
          {categoryResult && !categoryLoading && (
            <div className="flex items-center gap-3 p-3 rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30">
              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
              <p className="text-sm text-green-800 dark:text-green-300">
                {t('importPage.resultSummary', { imported: categoryResult.imported, skipped: categoryResult.skipped, errors: categoryResult.errors })}
              </p>
            </div>
          )}

                <Button onClick={handleCategoryImport} disabled={!categoryFile || categoryLoading} className="w-full h-11" size="lg">
            {categoryLoading ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('importPage.importingCategories')}</>
            ) : (
              <><Tags className="h-4 w-4 mr-2" /> {t('importPage.importCategoriesBtn')}</>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Export Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5 text-accent" />
            {t('importPage.csvExport')}
          </CardTitle>
          <CardDescription>{t('importPage.csvExportDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Export filters toggle */}
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm font-semibold text-foreground">
              {t('importPage.exportFilters')}
            </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowExportFilters((prev) => !prev)}
                className="text-foreground"
              >
                {showExportFilters ? t('importPage.hideFilters') : t('importPage.showFilters')}
              </Button>
          </div>

          {/* Export filters form */}
          {showExportFilters && (
            <div className="space-y-4 mb-4 p-4 border rounded-lg bg-muted/30">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="start-date">{t('importPage.startDate')}</Label>
                  <DatePicker
                    value={exportFilters.startDate ? parseLocalDateFromYmd(exportFilters.startDate) : undefined}
                    onChange={(date) => setExportFilters({ ...exportFilters, startDate: date ? toYmd(date) : "" })}
                    placeholder={t('plannedPage.link.pickDate')}
                    allowClear
                    clearLabel={t('common.clear')}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="end-date">{t('importPage.endDate')}</Label>
                  <DatePicker
                    value={exportFilters.endDate ? parseLocalDateFromYmd(exportFilters.endDate) : undefined}
                    onChange={(date) => setExportFilters({ ...exportFilters, endDate: date ? toYmd(date) : "" })}
                    placeholder={t('plannedPage.link.pickDate')}
                    allowClear
                    clearLabel={t('common.clear')}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="bank-account">{t('importPage.bankAccount')}</Label>
                   <Input
                     id="bank-account"
                     placeholder={t('importPage.placeholderMainAccount')}
                     value={exportFilters.bankAccount}
                     onChange={(e) =>
                       setExportFilters({
                         ...exportFilters,
                         bankAccount: e.target.value,
                       })
                     }
                   />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="category-id">{t('importPage.categoryId')}</Label>
                   <Input
                     id="category-id"
                     placeholder={t('importPage.placeholderCategoryId')}
                     value={exportFilters.categoryId}
                     onChange={(e) =>
                       setExportFilters({
                         ...exportFilters,
                         categoryId: e.target.value,
                       })
                     }
                   />
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                {t('importPage.exportNote')}
              </p>
            </div>
          )}

          <Button
            onClick={handleExport}
            disabled={exporting}
            variant="outline"
            className="w-full h-11"
            size="lg"
          >
            {exporting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('importPage.exporting')}
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                 {t('importPage.exportBtn')}
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Supported banks info */}
      <Card className="bg-muted/30">
        <CardContent className="pt-6">
          <p className="text-sm font-semibold text-foreground mb-2">
            {t('importPage.supportedBanks')}
          </p>
          <div className="flex flex-wrap gap-2">
            {adaptersLoading ? (
              <span className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('importPage.supportedLoading')}
              </span>
            ) : adapters.length > 0 ? (
              adapters.map((adapter) => (
                <span
                  key={adapter.key}
                  className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
                >
                  {adapter.name}
                </span>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">{t('importPage.noSupportedParsers')}</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-3">{t('importPage.noSupportedBank')}</p>
        </CardContent>
      </Card>
    </div>
  );
}
