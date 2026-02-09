import {useState} from "react";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@/components/ui/card";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {apiClient} from "@/lib/api";
import {toast} from "sonner";
import {CheckCircle2, Database, Loader2, Upload} from "lucide-react";

interface CSVImportProps {
    onImportComplete: () => void;
}

export function CSVImport({onImportComplete}: CSVImportProps) {
    const [loading, setLoading] = useState(false);
    const [bankSource, setBankSource] = useState("auto-detect");
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

            // Use filename for auto-detect, otherwise use the selected bank
            const bankValue = bankSource === "auto-detect" ? file.name : bankSource;
            const data = await apiClient.importCSV(csvContent, bankValue);

            toast.success(`Successfully imported ${data.imported} transactions!`, {
                icon: <CheckCircle2 className="h-4 w-4"/>,
            });
            onImportComplete();
            setBankSource("auto-detect");
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
        <Card
            className="border-none shadow-xl bg-gradient-to-br from-white to-slate-50 dark:from-slate-900 dark:to-slate-800 hover:shadow-2xl transition-shadow duration-300">
            <CardHeader className="space-y-3">
                <div className="flex items-center gap-3">
                    <div
                        className="h-12 w-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/30">
                        <Upload className="h-6 w-6 text-white"/>
                    </div>
                    <div>
                        <CardTitle className="text-xl">Import Transactions</CardTitle>
                        <CardDescription className="text-base">
                            Upload CSV files from {supportedBanks.length}+ supported banks
                        </CardDescription>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="space-y-5">
                <div className="space-y-3">
                    <Label htmlFor="bank-source" className="text-sm font-semibold">Select Your Bank (Optional)</Label>
                    <Select value={bankSource} onValueChange={setBankSource}>
                        <SelectTrigger id="bank-source"
                                       className="h-11 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                            <SelectValue placeholder="Auto-detect from file"/>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="auto-detect">
                                <div className="flex items-center gap-2">
                                    <Database className="h-4 w-4"/>
                                    Auto-detect
                                </div>
                            </SelectItem>
                            {supportedBanks.map((bank) => (
                                <SelectItem key={bank} value={bank}>
                                    {bank}
                                </SelectItem>
                            ))}
                            <SelectItem value="custom">Andere/Custom</SelectItem>
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                        💡 Selecting your bank helps us parse the CSV more accurately
                    </p>
                </div>

                <div className="space-y-3">
                    <Label htmlFor="csv-file" className="text-sm font-semibold">CSV File</Label>
                    <div className="relative">
                        <Input
                            id="csv-file"
                            type="file"
                            accept=".csv"
                            onChange={handleFileUpload}
                            disabled={loading}
                            className="h-11 cursor-pointer file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 dark:file:bg-blue-900/30 dark:file:text-blue-300 border-slate-200 dark:border-slate-700"
                        />
                        {loading && (
                            <div className="absolute right-3 top-1/2 -translate-y-1/2">
                                <Loader2 className="h-5 w-5 animate-spin text-blue-600"/>
                            </div>
                        )}
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                        📊 Expected format: Date, Description, Amount (columns auto-detected)
                    </p>
                </div>

                <div className="space-y-3 pt-2">
                    <div
                        className="rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 p-4 border border-blue-100 dark:border-blue-900/50">
                        <div className="flex items-start gap-3">
                            <Database className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0"/>
                            <div className="flex-1 space-y-2">
                                <p className="font-semibold text-sm text-blue-900 dark:text-blue-100">Supported
                                    Banks:</p>
                                <p className="text-xs leading-relaxed text-blue-700 dark:text-blue-300">
                                    {supportedBanks.length > 0
                                        ? supportedBanks.slice(0, 6).join(", ") + (supportedBanks.length > 6 ? `, and ${supportedBanks.length - 6} more...` : "")
                                        : "Chase, Bank of America, Wells Fargo, Capital One, Citi, Discover, and more"}
                                </p>
                                <p className="text-xs text-blue-600 dark:text-blue-400 font-medium">
                                    ✨ Don't see your bank? Our smart parser works with most CSV formats!
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}