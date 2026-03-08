import { useCallback, useEffect, useRef, useState } from "react";
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
  Trash2,
  Upload,
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
        console.error("Failed to load supported parsers", err);
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
    try {
      let data;
      
      if (bankSource === "custom") {
        // Call custom import endpoint with configuration
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
      } else {
        // Call standard import endpoint for predefined banks
        data = await apiClient.importCSV(file, bank);
      }

      toast.success(`Successfully imported ${data.imported} transactions!`, {
        description: `${data.duplicates} duplicates skipped, ${data.total_processed} total processed`,
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
      setFile(null);
      setBankSource("");
      setCustomBank("");
      // Reset custom config
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
    } finally {
      setLoading(false);
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
                ${
                  dragOver
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

          {/* Import button */}
          <Button
            onClick={handleImport}
            disabled={!file || loading}
            className="w-full h-11"
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
