import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
} from "lucide-react";

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [bankSource, setBankSource] = useState("auto-detect");
  const [customBank, setCustomBank] = useState("");
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch supported banks from backend instead of hardcoding
  const [banks, setBanks] = useState<string[]>([]);
  const [banksLoading, setBanksLoading] = useState(false);
  const [banksError, setBanksError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const loadBanks = async () => {
      setBanksLoading(true);
      setBanksError(null);
      try {
        const res = await apiClient.getBanks();
        if (mounted && res && Array.isArray(res.banks)) {
          setBanks(res.banks);
        }
      } catch (err) {
        console.error('Failed to load banks', err);
        if (mounted) {
          setBanksError(err instanceof Error ? err.message : String(err));
          // Leave banks empty - we intentionally avoid hardcoding fallback values
          setBanks([]);
          toast.error('Could not load supported banks from server — you can still use Auto-detect or Custom');
        }
      } finally {
        if (mounted) setBanksLoading(false);
      }
    };

    loadBanks();
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
    if (bankSource === "auto-detect") return "generic";
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

    setLoading(true);
    try {
      const data = await apiClient.importCSV(file, bank);

      toast.success(`Successfully imported ${data.imported} transactions!`, {
        description: `${data.duplicates} duplicates skipped, ${data.total_processed} total processed`,
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
      setFile(null);
      setBankSource("auto-detect");
      setCustomBank("");
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
      const data = await apiClient.getTransactions({ limit: 10000 });
      const transactions = data.items || [];

      if (transactions.length === 0) {
        toast.error("No transactions to export.");
        return;
      }

      const headers = ["Date", "Description", "Amount", "Currency", "Category", "Recipient", "Bank"];
      const rows = transactions.map((t) => [
        t.transaction_date,
        `"${(t.memo || "").replace(/"/g, '""')}"`,
        t.amount,
        t.currency || "EUR",
        t.category_name || "",
        `"${(t.recipient_name || "").replace(/"/g, '""')}"`,
        t.bank_account || "",
      ]);

      const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `transactions_${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);

      toast.success(`Exported ${transactions.length} transactions!`, {
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to export";
      toast.error(message);
    } finally {
      setExporting(false);
    }
  };

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
            best results, or let us auto-detect.
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
                <SelectItem value="auto-detect">🔍 Auto-detect</SelectItem>
                {banksLoading ? (
                  <SelectItem value="loading" disabled>
                    <Loader2 className="h-4 w-4 mr-2 inline" /> Loading banks...
                  </SelectItem>
                ) : banks.length > 0 ? (
                  banks.map((bank) => (
                    <SelectItem key={bank} value={bank}>
                      🏦 {bank}
                    </SelectItem>
                  ))
                ) : (
                  <SelectItem value="none" disabled>
                    No banks available — use Auto-detect or Custom
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
            {banksLoading ? (
              <span className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
              </span>
            ) : banks.length > 0 ? (
              banks.map((bank) => (
                <span
                  key={bank}
                  className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
                >
                  {bank}
                </span>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">
                No supported banks loaded. Use <strong>Auto-detect</strong> or select <strong>Custom</strong> to provide a bank name.
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Don't see your bank? Try <strong>Auto-detect</strong> or select{" "}
            <strong>Custom</strong> — our smart parser works with most CSV
            formats.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}