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
  File,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";

const PRESET_BANKS = [
  "Chase",
  "Bank of America",
  "Wells Fargo",
  "Capital One",
  "Citi",
  "Discover",
  "American Express",
];

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [bankSource, setBankSource] = useState("auto-detect");
  const [customBank, setCustomBank] = useState("");
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [supportedBanks, setSupportedBanks] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fetchBanks = async () => {
      try {
        const response = await fetch(
          `${import.meta.env.VITE_API_URL || "http://localhost:8000"}/api/supported-banks`
        );
        const data = await response.json();
        if (data.banks?.length) setSupportedBanks(data.banks);
      } catch {
        // fallback to preset list
      }
    };
    fetchBanks();
  }, []);

  const banks = supportedBanks.length > 0 ? supportedBanks : PRESET_BANKS;

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
    if (bankSource === "custom") return customBank || undefined;
    if (bankSource === "auto-detect") return undefined;
    return bankSource;
  };

  const handleImport = async () => {
    if (!file) {
      toast.error("Please select a file first.");
      return;
    }

    setLoading(true);
    try {
      const csvContent = await file.text();
      const bank = resolvedBank();
      const data = await apiClient.importCSV(csvContent, bank);

      toast.success(`Successfully imported ${data.imported} transactions!`, {
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

  return (
    <div className="space-y-8 animate-in max-w-2xl mx-auto">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold text-foreground">Import Transactions</h2>
        <p className="text-muted-foreground mt-1">
          Upload a CSV file from your bank to import transactions
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
                {banks.map((bank) => (
                  <SelectItem key={bank} value={bank}>
                    🏦 {bank}
                  </SelectItem>
                ))}
                <SelectItem value="custom">✏️ Custom / Other</SelectItem>
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

      {/* Supported banks info */}
      <Card className="bg-muted/30">
        <CardContent className="pt-6">
          <p className="text-sm font-semibold text-foreground mb-2">
            Supported Banks
          </p>
          <div className="flex flex-wrap gap-2">
            {banks.map((bank) => (
              <span
                key={bank}
                className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
              >
                {bank}
              </span>
            ))}
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
