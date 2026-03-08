import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
    Wallet, Upload, Tags, Sparkles, ArrowRight, ArrowLeft,
    CheckCircle2, CloudUpload, Loader2, BarChart3, Receipt,
    CalendarClock, TrendingUp, LineChart, File, X,
} from "lucide-react";
import { apiClient } from "@/lib/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const ONBOARDING_KEY = "onboarding_complete";

export function useOnboarding() {
    const [isComplete, setIsComplete] = useState(true); // Default true to avoid flash
    const [isLoading, setIsLoading] = useState(true);

    // Load from database on mount
    useEffect(() => {
        let cancelled = false;
        apiClient.getSetting(ONBOARDING_KEY)
            .then((result) => {
                if (!cancelled) setIsComplete(result?.value === true);
            })
            .catch(() => {
                // Setting not found = first run = not complete
                if (!cancelled) setIsComplete(false);
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => { cancelled = true; };
    }, []);

    const complete = useCallback(() => {
        setIsComplete(true);
        apiClient.saveSetting(ONBOARDING_KEY, true).catch(() => {});
    }, []);

    const reset = useCallback(() => {
        setIsComplete(false);
        apiClient.saveSetting(ONBOARDING_KEY, false).catch(() => {});
    }, []);

    return { isComplete, isLoading, complete, reset };
}

interface OnboardingWizardProps {
    open: boolean;
    onComplete: () => void;
}

const STEPS = [
    { key: "welcome", label: "Welcome", icon: Sparkles },
    { key: "bank", label: "Bank Setup", icon: Wallet },
    { key: "import", label: "Import Data", icon: Upload },
    { key: "categories", label: "Categories", icon: Tags },
    { key: "tour", label: "Feature Tour", icon: BarChart3 },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

interface BankAdapter {
    key: string;
    name: string;
}

const SUGGESTED_CATEGORIES = [
    { general: "FOOD", detail: "Groceries", emoji: "🛒" },
    { general: "FOOD", detail: "Restaurants", emoji: "🍽️" },
    { general: "HOUSING", detail: "Rent", emoji: "🏠" },
    { general: "HOUSING", detail: "Utilities", emoji: "💡" },
    { general: "TRANSPORT", detail: "Fuel", emoji: "⛽" },
    { general: "TRANSPORT", detail: "Public Transport", emoji: "🚌" },
    { general: "ENTERTAINMENT", detail: "Subscriptions", emoji: "📺" },
    { general: "ENTERTAINMENT", detail: "Hobbies", emoji: "🎮" },
    { general: "HEALTH", detail: "Insurance", emoji: "🏥" },
    { general: "HEALTH", detail: "Pharmacy", emoji: "💊" },
    { general: "INCOME", detail: "Salary", emoji: "💰" },
    { general: "INCOME", detail: "Freelance", emoji: "💻" },
    { general: "SAVINGS", detail: "Investments", emoji: "📈" },
    { general: "PERSONAL", detail: "Clothing", emoji: "👕" },
    { general: "PERSONAL", detail: "Gifts", emoji: "🎁" },
];

const FEATURES = [
    {
        icon: Receipt,
        title: "Transactions",
        desc: "View, filter, and manage all your transactions in one place",
        path: "/transactions",
    },
    {
        icon: Tags,
        title: "Categories",
        desc: "Organize spending with hierarchical categories",
        path: "/categories",
    },
    {
        icon: CalendarClock,
        title: "Planned Payments",
        desc: "Track recurring bills and upcoming payments with auto-detection",
        path: "/planned",
    },
    {
        icon: BarChart3,
        title: "Statistics",
        desc: "Deep analytics with pivot tables, trends, and breakdowns",
        path: "/statistics",
    },
    {
        icon: TrendingUp,
        title: "Portfolio",
        desc: "Track investments, stocks, crypto, and real estate",
        path: "/portfolio",
    },
    {
        icon: LineChart,
        title: "Market Lookup",
        desc: "Search any ticker for real-time quotes and charts",
        path: "/portfolio/market",
    },
];

export function OnboardingWizard({ open, onComplete }: OnboardingWizardProps) {
    const navigate = useNavigate();
    const [step, setStep] = useState<StepKey>("welcome");
    const stepIdx = STEPS.findIndex((s) => s.key === step);

    // Bank setup state
    const [adapters, setAdapters] = useState<BankAdapter[]>([]);
    const [selectedBank, setSelectedBank] = useState("");
    const [adaptersLoading, setAdaptersLoading] = useState(false);

    // Import state
    const [file, setFile] = useState<File | null>(null);
    const [importing, setImporting] = useState(false);
    const [importResult, setImportResult] = useState<{ imported: number; duplicates: number } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Category state
    const [selectedCategories, setSelectedCategories] = useState<Set<number>>(
        new Set(SUGGESTED_CATEGORIES.map((_, i) => i))
    );
    const [creatingCategories, setCreatingCategories] = useState(false);
    const [categoriesCreated, setCategoriesCreated] = useState(false);

    // Load adapters
    useEffect(() => {
        if (!open) return;
        let mounted = true;
        setAdaptersLoading(true);
        apiClient.getSupportedParsers()
            .then((res) => {
                if (mounted) setAdapters(res.adapters || []);
            })
            .catch(() => {})
            .finally(() => { if (mounted) setAdaptersLoading(false); });
        return () => { mounted = false; };
    }, [open]);

    const goNext = () => {
        if (stepIdx < STEPS.length - 1) setStep(STEPS[stepIdx + 1].key);
    };
    const goBack = () => {
        if (stepIdx > 0) setStep(STEPS[stepIdx - 1].key);
    };

    const handleImport = async () => {
        if (!file || !selectedBank) return;
        setImporting(true);
        try {
            const result = await apiClient.importCSV(file, selectedBank);
            setImportResult({ imported: result.imported, duplicates: result.duplicates });
            toast.success(`Imported ${result.imported} transactions!`);
        } catch (err: any) {
            toast.error(`Import failed: ${err.message}`);
        } finally {
            setImporting(false);
        }
    };

    const handleCreateCategories = async () => {
        setCreatingCategories(true);
        let created = 0;
        try {
            for (const idx of selectedCategories) {
                const cat = SUGGESTED_CATEGORIES[idx];
                try {
                    await apiClient.createCategory({
                        general: cat.general,
                        detail: cat.detail,
                    });
                    created++;
                } catch {
                    // May already exist, skip
                }
            }
            setCategoriesCreated(true);
            toast.success(`Created ${created} categories!`);
        } catch (err: any) {
            toast.error(`Failed: ${err.message}`);
        } finally {
            setCreatingCategories(false);
        }
    };

    const handleFinish = () => {
        onComplete();
    };

    const handleNavigate = (path: string) => {
        onComplete();
        navigate(path);
    };

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o) onComplete(); }}>
            <DialogContent className="sm:max-w-2xl p-0 overflow-hidden gap-0 [&>button]:hidden">
                {/* Progress header */}
                <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent px-6 pt-6 pb-4">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
                                <Wallet className="h-4 w-4 text-primary-foreground" />
                            </div>
                            <span className="font-bold text-foreground">Vault Voyager</span>
                        </div>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onComplete}>
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                    {/* Step indicators */}
                    <div className="flex gap-1.5">
                        {STEPS.map((s, i) => (
                            <div
                                key={s.key}
                                className={cn(
                                    "h-1.5 flex-1 rounded-full transition-colors",
                                    i <= stepIdx ? "bg-primary" : "bg-muted"
                                )}
                            />
                        ))}
                    </div>
                    <div className="flex items-center gap-2 mt-3">
                        {(() => { const StepIcon = STEPS[stepIdx].icon; return <StepIcon className="h-4 w-4 text-primary" />; })()}
                        <span className="text-sm font-medium text-muted-foreground">
                            Step {stepIdx + 1} of {STEPS.length} · {STEPS[stepIdx].label}
                        </span>
                    </div>
                </div>

                {/* Step content */}
                <div className="px-6 py-6 min-h-[340px] flex flex-col">
                    {/* Welcome */}
                    {step === "welcome" && (
                        <div className="flex-1 flex flex-col items-center justify-center text-center gap-4">
                            <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-lg">
                                <Sparkles className="h-8 w-8 text-primary-foreground" />
                            </div>
                            <h2 className="text-2xl font-bold text-foreground">
                                Welcome to Vault Voyager!
                            </h2>
                            <p className="text-muted-foreground max-w-md">
                                Let's get you set up in just a few steps. We'll help you connect your bank, 
                                import your first transactions, and organize your spending categories.
                            </p>
                            <div className="flex gap-2 mt-2">
                                <Badge variant="secondary" className="gap-1">
                                    <Upload className="h-3 w-3" /> Import CSV
                                </Badge>
                                <Badge variant="secondary" className="gap-1">
                                    <Tags className="h-3 w-3" /> Categories
                                </Badge>
                                <Badge variant="secondary" className="gap-1">
                                    <BarChart3 className="h-3 w-3" /> Analytics
                                </Badge>
                            </div>
                        </div>
                    )}

                    {/* Bank Setup */}
                    {step === "bank" && (
                        <div className="flex-1 flex flex-col gap-4">
                            <div>
                                <h2 className="text-xl font-bold text-foreground">Select your bank</h2>
                                <p className="text-sm text-muted-foreground mt-1">
                                    Choose your bank so we can parse your CSV exports correctly.
                                </p>
                            </div>
                            {adaptersLoading ? (
                                <div className="flex-1 flex items-center justify-center">
                                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                    {adapters.map((adapter) => (
                                        <button
                                            key={adapter.key}
                                            onClick={() => setSelectedBank(adapter.key)}
                                            className={cn(
                                                "flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all hover:shadow-md",
                                                selectedBank === adapter.key
                                                    ? "border-primary bg-primary/5 shadow-sm"
                                                    : "border-border hover:border-primary/40"
                                            )}
                                        >
                                            <Wallet className={cn(
                                                "h-6 w-6",
                                                selectedBank === adapter.key ? "text-primary" : "text-muted-foreground"
                                            )} />
                                            <span className={cn(
                                                "text-sm font-medium",
                                                selectedBank === adapter.key ? "text-foreground" : "text-muted-foreground"
                                            )}>
                                                {adapter.name}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            )}
                            <p className="text-xs text-muted-foreground mt-auto">
                                Don't see your bank? You can still use the custom CSV importer later.
                            </p>
                        </div>
                    )}

                    {/* Import */}
                    {step === "import" && (
                        <div className="flex-1 flex flex-col gap-4">
                            <div>
                                <h2 className="text-xl font-bold text-foreground">Import your transactions</h2>
                                <p className="text-sm text-muted-foreground mt-1">
                                    Upload a CSV export from {selectedBank ? adapters.find(a => a.key === selectedBank)?.name || "your bank" : "your bank"}.
                                    You can always import more later.
                                </p>
                            </div>

                            {importResult ? (
                                <div className="flex-1 flex flex-col items-center justify-center gap-3">
                                    <div className="h-14 w-14 rounded-full bg-accent/20 flex items-center justify-center">
                                        <CheckCircle2 className="h-7 w-7 text-accent" />
                                    </div>
                                    <p className="text-lg font-semibold text-foreground">
                                        {importResult.imported} transactions imported!
                                    </p>
                                    {importResult.duplicates > 0 && (
                                        <p className="text-sm text-muted-foreground">
                                            {importResult.duplicates} duplicates skipped
                                        </p>
                                    )}
                                </div>
                            ) : (
                                <>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".csv,.CSV"
                                        className="hidden"
                                        onChange={(e) => setFile(e.target.files?.[0] || null)}
                                    />
                                    <button
                                        onClick={() => fileInputRef.current?.click()}
                                        className={cn(
                                            "flex-1 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed transition-colors cursor-pointer min-h-[160px]",
                                            file ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
                                        )}
                                    >
                                        {file ? (
                                            <>
                                                <File className="h-8 w-8 text-primary" />
                                                <span className="text-sm font-medium text-foreground">{file.name}</span>
                                                <span className="text-xs text-muted-foreground">
                                                    {(file.size / 1024).toFixed(1)} KB
                                                </span>
                                            </>
                                        ) : (
                                            <>
                                                <CloudUpload className="h-8 w-8 text-muted-foreground" />
                                                <span className="text-sm text-muted-foreground">
                                                    Click to select or drop your CSV file
                                                </span>
                                            </>
                                        )}
                                    </button>

                                    {file && (
                                        <Button
                                            onClick={handleImport}
                                            disabled={importing || !selectedBank}
                                            className="gap-2"
                                        >
                                            {importing ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : (
                                                <Upload className="h-4 w-4" />
                                            )}
                                            {importing ? "Importing..." : "Import Transactions"}
                                        </Button>
                                    )}
                                </>
                            )}

                            <p className="text-xs text-muted-foreground">
                                You can skip this step and import later from the Import page.
                            </p>
                        </div>
                    )}

                    {/* Categories */}
                    {step === "categories" && (
                        <div className="flex-1 flex flex-col gap-4">
                            <div>
                                <h2 className="text-xl font-bold text-foreground">Set up categories</h2>
                                <p className="text-sm text-muted-foreground mt-1">
                                    Select the spending categories you'd like to use. You can always add more later.
                                </p>
                            </div>

                            {categoriesCreated ? (
                                <div className="flex-1 flex flex-col items-center justify-center gap-3">
                                    <div className="h-14 w-14 rounded-full bg-accent/20 flex items-center justify-center">
                                        <CheckCircle2 className="h-7 w-7 text-accent" />
                                    </div>
                                    <p className="text-lg font-semibold text-foreground">
                                        Categories created!
                                    </p>
                                    <p className="text-sm text-muted-foreground">
                                        You can manage them anytime from the Categories page.
                                    </p>
                                </div>
                            ) : (
                                <>
                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[240px] overflow-y-auto pr-1">
                                        {SUGGESTED_CATEGORIES.map((cat, idx) => {
                                            const selected = selectedCategories.has(idx);
                                            return (
                                                <button
                                                    key={idx}
                                                    onClick={() => {
                                                        const next = new Set(selectedCategories);
                                                        if (selected) next.delete(idx);
                                                        else next.add(idx);
                                                        setSelectedCategories(next);
                                                    }}
                                                    className={cn(
                                                        "flex items-center gap-2 p-2.5 rounded-lg border transition-all text-left",
                                                        selected
                                                            ? "border-primary bg-primary/5"
                                                            : "border-border hover:border-primary/40"
                                                    )}
                                                >
                                                    <span className="text-base">{cat.emoji}</span>
                                                    <div className="min-w-0">
                                                        <p className={cn(
                                                            "text-xs font-medium truncate",
                                                            selected ? "text-foreground" : "text-muted-foreground"
                                                        )}>
                                                            {cat.detail}
                                                        </p>
                                                        <p className="text-xs text-muted-foreground/60 truncate">
                                                            {cat.general}
                                                        </p>
                                                    </div>
                                                    {selected && (
                                                        <CheckCircle2 className="h-3.5 w-3.5 text-primary ml-auto shrink-0" />
                                                    )}
                                                </button>
                                            );
                                        })}
                                    </div>

                                    <div className="flex items-center gap-2">
                                        <Button
                                            onClick={handleCreateCategories}
                                            disabled={creatingCategories || selectedCategories.size === 0}
                                            className="gap-2"
                                        >
                                            {creatingCategories ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : (
                                                <Tags className="h-4 w-4" />
                                            )}
                                            Create {selectedCategories.size} Categories
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => {
                                                if (selectedCategories.size === SUGGESTED_CATEGORIES.length) {
                                                    setSelectedCategories(new Set());
                                                } else {
                                                    setSelectedCategories(new Set(SUGGESTED_CATEGORIES.map((_, i) => i)));
                                                }
                                            }}
                                        >
                                            {selectedCategories.size === SUGGESTED_CATEGORIES.length ? "Deselect All" : "Select All"}
                                        </Button>
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    {/* Feature Tour */}
                    {step === "tour" && (
                        <div className="flex-1 flex flex-col gap-4">
                            <div>
                                <h2 className="text-xl font-bold text-foreground">You're all set! 🎉</h2>
                                <p className="text-sm text-muted-foreground mt-1">
                                    Here's a quick look at what you can do with Vault Voyager.
                                </p>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {FEATURES.map((feat) => (
                                    <button
                                        key={feat.path}
                                        onClick={() => handleNavigate(feat.path)}
                                        className="flex items-start gap-3 p-3 rounded-xl border border-border hover:border-primary/40 hover:bg-primary/5 transition-all text-left group"
                                    >
                                        <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
                                            <feat.icon className="h-4 w-4 text-primary" />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-sm font-semibold text-foreground">{feat.title}</p>
                                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{feat.desc}</p>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer navigation */}
                <div className="border-t px-6 py-4 flex items-center justify-between bg-muted/30">
                    <div>
                        {stepIdx > 0 ? (
                            <Button variant="ghost" size="sm" onClick={goBack} className="gap-1.5">
                                <ArrowLeft className="h-3.5 w-3.5" />
                                Back
                            </Button>
                        ) : (
                            <Button variant="ghost" size="sm" onClick={onComplete}>
                                Skip setup
                            </Button>
                        )}
                    </div>
                    <div>
                        {step === "tour" ? (
                            <Button onClick={handleFinish} className="gap-1.5">
                                Go to Dashboard
                                <ArrowRight className="h-3.5 w-3.5" />
                            </Button>
                        ) : (
                            <Button onClick={goNext} className="gap-1.5">
                                {step === "welcome" ? "Get Started" : "Next"}
                                <ArrowRight className="h-3.5 w-3.5" />
                            </Button>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
