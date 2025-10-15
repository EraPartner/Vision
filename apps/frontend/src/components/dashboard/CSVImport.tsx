import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiClient } from "@/lib/api";
import { toast } from "sonner";
import { Upload, Loader2, CheckCircle2 } from "lucide-react";

interface CSVImportProps {
  onImportComplete: () => void;
}

export function CSVImport({ onImportComplete }: CSVImportProps) {
  const [loading, setLoading] = useState(false);
  const [bankSource, setBankSource] = useState("");
  const [supportedBanks, setSupportedBanks] = useState<string[]>([]);

  useEffect(() => {
    // Fetch supported banks
    const fetchBanks = async () => {
      try {
        const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:8000'}/api/supported-banks`);
        const data = await response.json();
        setSupportedBanks(data.banks || []);
      } catch (error) {
        console.error("Failed to fetch supported banks:", error);
      }
    };
    fetchBanks();
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    try {
      const csvContent = await file.text();
      
      const data = await apiClient.importCSV(csvContent, bankSource || file.name);

      toast.success(`Successfully imported ${data.imported} transactions!`, {
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
      onImportComplete();
      setBankSource("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to import CSV";
      toast.error(message);
    } finally {
      setLoading(false);
      if (e.target) {
        e.target.value = "";
      }
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import Transactions</CardTitle>
        <CardDescription>
          Upload a CSV file from your bank. We support {supportedBanks.length}+ banks and automatically detect the format.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="bank-source">Select Your Bank (Optional)</Label>
          <Select value={bankSource} onValueChange={setBankSource}>
            <SelectTrigger id="bank-source">
              <SelectValue placeholder="Auto-detect from file" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Auto-detect</SelectItem>
              {supportedBanks.map((bank) => (
                <SelectItem key={bank} value={bank}>
                  {bank}
                </SelectItem>
              ))}
              <SelectItem value="custom">Other/Custom</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Selecting your bank helps us parse the CSV more accurately
          </p>
        </div>
        
        <div className="space-y-2">
          <Label htmlFor="csv-file">CSV File</Label>
          <div className="flex gap-2">
            <Input
              id="csv-file"
              type="file"
              accept=".csv"
              onChange={handleFileUpload}
              disabled={loading}
              className="cursor-pointer"
            />
            {loading && <Loader2 className="h-4 w-4 animate-spin self-center" />}
          </div>
          <p className="text-xs text-muted-foreground">
            Expected format: Date, Description, Amount (columns auto-detected)
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-start gap-2 p-3 bg-muted rounded-lg">
            <Upload className="h-4 w-4 text-muted-foreground mt-0.5" />
            <div className="flex-1 text-sm text-muted-foreground">
              <p className="font-medium mb-1">Supported Banks:</p>
              <p className="text-xs leading-relaxed">
                {supportedBanks.length > 0 
                  ? supportedBanks.join(", ")
                  : "Chase, Bank of America, Wells Fargo, Capital One, Citi, Discover, Amex, and more"}
              </p>
              <p className="text-xs mt-2">
                Don't see your bank? No problem! Our generic parser works with most CSV formats.
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}