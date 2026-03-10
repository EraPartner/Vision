import { useCallback, useEffect, useRef, useState } from "react";
import logger from "@/lib/logger";
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
import { apiClient } from "@/lib/api";
import { toast } from "sonner";
import {
  CheckCircle2,
  CloudUpload,
  Download,
  File,
  Loader2,
  Tags,
  Trash2,
  Upload,
  Users,
  XCircle,
} from "lucide-react";

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
          toast.error(
            "Could not load supported parsers from server — you can still use Custom"
          );
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
      toast.error("Please select a CSV file.");
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
      toast.error("Please select a file first.");
      return;
    }

    const bank = resolvedBank();
    if (!bank) {
      toast.error("Please select a bank source.");
      return;
    }

    // If custom bank, validate custom configuration
    if (bankSource === "custom") {
      if (!customConfig.dateColumn || !customConfig.recipientColumn || !customConfig.amountColumn) {
        toast.error("Please fill in all required custom configuration fields.");
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

      toast.success(`Successfully imported ${data.imported} transactions!`, {
        description: `${data.duplicates} duplicates skipped, ${data.total_processed} total processed`,
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
      const message =
        error instanceof Error ? error.message : "Failed to import CSV";
      toast.error(message);
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
      toast.info("Import cancelled.");
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
      toast.error("Please select a CSV file.");
      return;
    }
    setRecipientFile(f);
    setRecipientResult(null);
  }, []);

  const handleRecipientImport = async () => {
    if (!recipientFile) { toast.error("Please select a file first."); return; }
    setRecipientLoading(true);
    setRecipientResult(null);
    try {
      const data = await apiClient.importRecipients(recipientFile, recipientSeparator, recipientEncoding);
      setRecipientResult({ imported: data.imported, skipped: data.skipped, errors: data.errors });
      toast.success(`Imported ${data.imported} recipient(s)`, {
        description: `${data.skipped} already existed, ${data.errors} errors`,
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
      setRecipientFile(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import recipients");
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
      toast.error("Please select a CSV file.");
      return;
    }
    setCategoryFile(f);
    setCategoryResult(null);
  }, []);

  const handleCategoryImport = async () => {
    if (!categoryFile) { toast.error("Please select a file first."); return; }
    setCategoryLoading(true);
    setCategoryResult(null);
    try {
      const data = await apiClient.importCategories(categoryFile, categorySeparator);
      setCategoryResult({ imported: data.imported, skipped: data.skipped, errors: data.errors });
      toast.success(`Imported ${data.imported} categor${data.imported === 1 ? "y" : "ies"}`, {
        description: `${data.skipped} already existed, ${data.errors} errors`,
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
      setCategoryFile(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import categories");
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

      const url = `${import.meta.env.VITE_API_URL || 'http://localhost:3002'}/api/transactions/export/csv?${queryParams.toString()}`;

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

      toast.success('Transactions exported successfully!', {
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to export";
      toast.error(message);
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
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold text-foreground">Import & Export</h2>
        <p className="text-muted-foreground mt-1">
          Import transactions from your bank or export your data as CSV
        </p>
      </div>

      {/* Import Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-primary" />
            CSV Import
          </CardTitle>
          <CardDescription>
            We support most common bank CSV formats. Select your bank for the
            best results.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* Bank selector */}
          <div className="space-y-2">
            <Label htmlFor="bank-select" className="font-semibold">
              Bank Source
            </Label>
            <Select value={bankSource} onValueChange={setBankSource}>
              <SelectTrigger id="bank-select">
                <SelectValue placeholder="Select a bank…" />
              </SelectTrigger>
              <SelectContent>
                {adaptersLoading ? (
                  <SelectItem value="loading" disabled>
                    <Loader2 className="h-4 w-4 mr-2 inline" /> Loading parsers...
                  </SelectItem>
                ) : adapters.length > 0 ? (
                  adapters.map((adapter) => (
                    <SelectItem key={adapter.key} value={adapter.key}>
                      🏦 {adapter.name}
                    </SelectItem>
                  ))
                ) : (
                  <SelectItem value="none" disabled>
                    No parsers available — use Custom
                  </SelectItem>
                )}
                <SelectItem value="custom">✏️ Custom / Andere</SelectItem>
              </SelectContent>
            </Select>

            {bankSource === "custom" && (
              <Input
                placeholder="Enter your bank name…"
                value={customBank}
                onChange={(e) => setCustomBank(e.target.value)}
                className="mt-2"
              />
            )}

            <p className="text-xs text-muted-foreground">
              Selecting your bank helps parse the CSV more accurately.
            </p>
          </div>

          {/* Custom CSV configuration fields */}
          {bankSource === "custom" && (
            <div className="space-y-4 p-4 border rounded-lg bg-muted/30">
              <p className="text-sm font-semibold text-foreground">
                Custom CSV Configuration
              </p>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="date-column">Date Column *</Label>
                  <Input
                    id="date-column"
                    placeholder="e.g., Date, Transaction Date"
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
                  <Label htmlFor="date-format">Date Format *</Label>
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

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="recipient-column">Recipient Column *</Label>
                  <Input
                    id="recipient-column"
                    placeholder="e.g., Description, Payee"
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
                  <Label htmlFor="amount-column">Amount Column *</Label>
                  <Input
                    id="amount-column"
                    placeholder="e.g., Amount, Value"
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

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="memo-column">Memo Column (Optional)</Label>
                  <Input
                    id="memo-column"
                    placeholder="e.g., Notes, Comments"
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
                  <Label htmlFor="separator">Separator</Label>
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

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="encoding">Encoding</Label>
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
                  <Label htmlFor="skip-rows">Skip Rows</Label>
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
                * Required fields. Column names must match exactly as they appear
                in your CSV header row.
              </p>
            </div>
          )}

          {/* Drag-and-drop file picker */}
          <div className="space-y-2">
            <Label className="font-semibold">CSV File</Label>

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
                      {(file.size / 1024).toFixed(1)} KB
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
                    Remove
                  </Button>
                </>
              ) : (
                <>
                  <CloudUpload className="h-10 w-10 text-muted-foreground" />
                  <div className="text-center">
                    <p className="font-medium text-foreground">
                      Drag & drop your CSV here
                    </p>
                    <p className="text-sm text-muted-foreground">
                      or click to browse files
                    </p>
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
                  {progress.phase === 'counting' && 'Analyzing file…'}
                  {progress.phase === 'parsing' && 'Parsing CSV…'}
                  {progress.phase === 'importing' && `Importing transactions…`}
                  {progress.phase === 'connecting' && 'Connecting…'}
                </span>
                <span className="text-foreground font-semibold">{progress.percent}%</span>
              </div>
              <Progress value={progress.percent} className="h-2" />
              {progress.phase === 'importing' && progress.total > 0 && (
                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span>{progress.current} / {progress.total} rows</span>
                  <span className="text-green-600 dark:text-green-400">✓ {progress.imported} imported</span>
                  <span className="text-amber-600 dark:text-amber-400">⊘ {progress.duplicates} duplicates</span>
                  {progress.errors > 0 && (
                    <span className="text-destructive">✗ {progress.errors} errors</span>
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
                <p className="font-medium text-green-800 dark:text-green-300">Import complete</p>
                <p className="text-green-700 dark:text-green-400">
                  {progress.imported} imported, {progress.duplicates} duplicates, {progress.errors} errors
                </p>
              </div>
            </div>
          )}

          {progress && !loading && progress.phase === 'error' && (
            <div className="flex items-center gap-3 p-4 rounded-lg border border-destructive/30 bg-destructive/5">
              <XCircle className="h-5 w-5 text-destructive shrink-0" />
              <p className="text-sm font-medium text-destructive">Import failed. Please try again.</p>
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
                  Importing…
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Import Transactions
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
                Cancel
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
            Recipients Import
          </CardTitle>
          <CardDescription>
            Import recipients from a CSV file. Expected columns:{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">name</code>{" "}
            (required),{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">bank_account</code>{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">address</code>{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">category</code>{" "}
            (optional, format <em>GENERAL:DETAIL</em>).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Options row */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="recipient-separator">Separator</Label>
              <Select value={recipientSeparator} onValueChange={setRecipientSeparator}>
                <SelectTrigger id="recipient-separator">
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
            <div className="space-y-2">
              <Label htmlFor="recipient-encoding">Encoding</Label>
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
                  <p className="text-xs text-muted-foreground">{(recipientFile.size / 1024).toFixed(1)} KB</p>
                </div>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive"
                  onClick={(e) => { e.stopPropagation(); setRecipientFile(null); }}>
                  <Trash2 className="h-4 w-4 mr-1" /> Remove
                </Button>
              </>
            ) : (
              <>
                <CloudUpload className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Drag & drop or click to browse</p>
              </>
            )}
          </div>

          {/* Result summary */}
          {recipientResult && !recipientLoading && (
            <div className="flex items-center gap-3 p-3 rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30">
              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
              <p className="text-sm text-green-800 dark:text-green-300">
                {recipientResult.imported} imported &middot; {recipientResult.skipped} already existed &middot; {recipientResult.errors} errors
              </p>
            </div>
          )}

          <Button onClick={handleRecipientImport} disabled={!recipientFile || recipientLoading} className="w-full h-11" size="lg">
            {recipientLoading ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Importing…</>
            ) : (
              <><Users className="h-4 w-4 mr-2" /> Import Recipients</>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Categories Import Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Tags className="h-5 w-5 text-primary" />
            Categories Import
          </CardTitle>
          <CardDescription>
            Import categories from a CSV file. Each row must have a{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">category</code>{" "}
            column (or the first column is used) in{" "}
            <em>GENERAL:DETAIL</em> format, e.g.{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">FOOD:GROCERIES</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Separator option */}
          <div className="w-1/2 space-y-2">
            <Label htmlFor="category-separator">Separator</Label>
            <Select value={categorySeparator} onValueChange={setCategorySeparator}>
              <SelectTrigger id="category-separator">
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
                  <p className="text-xs text-muted-foreground">{(categoryFile.size / 1024).toFixed(1)} KB</p>
                </div>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive"
                  onClick={(e) => { e.stopPropagation(); setCategoryFile(null); }}>
                  <Trash2 className="h-4 w-4 mr-1" /> Remove
                </Button>
              </>
            ) : (
              <>
                <CloudUpload className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Drag & drop or click to browse</p>
              </>
            )}
          </div>

          {/* Result summary */}
          {categoryResult && !categoryLoading && (
            <div className="flex items-center gap-3 p-3 rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30">
              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
              <p className="text-sm text-green-800 dark:text-green-300">
                {categoryResult.imported} imported &middot; {categoryResult.skipped} already existed &middot; {categoryResult.errors} errors
              </p>
            </div>
          )}

          <Button onClick={handleCategoryImport} disabled={!categoryFile || categoryLoading} className="w-full h-11" size="lg">
            {categoryLoading ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Importing…</>
            ) : (
              <><Tags className="h-4 w-4 mr-2" /> Import Categories</>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Export Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5 text-accent" />
            CSV Export
          </CardTitle>
          <CardDescription>
            Download all your transactions as a CSV file for backups or use in
            spreadsheet software.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Export filters toggle */}
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm font-semibold text-foreground">
              Export Filters
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowExportFilters((prev) => !prev)}
              className="text-foreground"
            >
              {showExportFilters ? "Hide Filters" : "Show Filters"}
            </Button>
          </div>

          {/* Export filters form */}
          {showExportFilters && (
            <div className="space-y-4 mb-4 p-4 border rounded-lg bg-muted/30">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="start-date">Start Date</Label>
                  <Input
                    id="start-date"
                    type="date"
                    placeholder="YYYY-MM-DD"
                    value={exportFilters.startDate}
                    onChange={(e) =>
                      setExportFilters({
                        ...exportFilters,
                        startDate: e.target.value,
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="end-date">End Date</Label>
                  <Input
                    id="end-date"
                    type="date"
                    placeholder="YYYY-MM-DD"
                    value={exportFilters.endDate}
                    onChange={(e) =>
                      setExportFilters({
                        ...exportFilters,
                        endDate: e.target.value,
                      })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="bank-account">Bank Account</Label>
                  <Input
                    id="bank-account"
                    placeholder="e.g., Main Account"
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
                  <Label htmlFor="category-id">Category ID</Label>
                  <Input
                    id="category-id"
                    placeholder="e.g., 123, Expenses"
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
                Leave fields empty to include all records. Date filters are
                inclusive.
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
                Exporting…
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Export All Transactions
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Supported banks info */}
      <Card className="bg-muted/30">
        <CardContent className="pt-6">
          <p className="text-sm font-semibold text-foreground mb-2">
            Supported Banks
          </p>
          <div className="flex flex-wrap gap-2">
            {adaptersLoading ? (
              <span className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
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
              <span className="text-xs text-muted-foreground">
                No supported parsers loaded. Select <strong>Custom</strong> to
                provide a bank name.
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Don't see your bank? Try{" "}
            <strong>Custom</strong>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
