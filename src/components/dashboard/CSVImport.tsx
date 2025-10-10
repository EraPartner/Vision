import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Upload, Loader2 } from "lucide-react";

interface CSVImportProps {
  onImportComplete: () => void;
}

export function CSVImport({ onImportComplete }: CSVImportProps) {
  const [loading, setLoading] = useState(false);
  const [bankSource, setBankSource] = useState("");

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    try {
      const csvContent = await file.text();
      
      const { data, error } = await supabase.functions.invoke("import-csv", {
        body: { csvContent, bankSource: bankSource || file.name },
      });

      if (error) throw error;

      toast.success(`Successfully imported ${data.imported} transactions!`);
      onImportComplete();
      setBankSource("");
    } catch (error: any) {
      toast.error(error.message || "Failed to import CSV");
    } finally {
      setLoading(false);
      e.target.value = "";
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import Transactions</CardTitle>
        <CardDescription>
          Upload a CSV file from your bank to import transactions
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="bank-source">Bank Name (Optional)</Label>
          <Input
            id="bank-source"
            placeholder="e.g., Chase, Bank of America"
            value={bankSource}
            onChange={(e) => setBankSource(e.target.value)}
          />
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
            Expected format: Date, Description, Amount (or similar)
          </p>
        </div>
        <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
          <Upload className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            The CSV parser will automatically detect your bank's format
          </p>
        </div>
      </CardContent>
    </Card>
  );
}