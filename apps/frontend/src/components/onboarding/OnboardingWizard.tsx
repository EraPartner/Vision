// @refresh reset
import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
    Wallet, Upload, Tags, Sparkles, ArrowRight, ArrowLeft,
    CheckCircle2, Loader2, BarChart3, Receipt,
    CalendarClock, TrendingUp, LineChart, X,
    HardDrive, ShieldCheck, FolderOpen, PiggyBank, CreditCard,
    LayoutDashboard,
} from "lucide-react";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { apiClient } from "@/lib/api";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import logger from "@/lib/logger";
import { CsvDropzone } from "@/features/imports/CsvDropzone";
import { useAdapters } from "@/features/imports/useAdapters";
import { RestoreFromBackupCard } from "./RestoreFromBackupCard";

const ONBOARDING_KEY = "onboarding_complete";

// eslint-disable-next-line react-refresh/only-export-components
export function useOnboarding() {
    const { t } = useLanguage();
    const [isComplete, setIsComplete] = useState(true);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        apiClient.getSetting(ONBOARDING_KEY)
            .then((result) => {
                if (!cancelled) setIsComplete(result?.value === true);
            })
            .catch(() => {
                if (!cancelled) setIsComplete(false);
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => { cancelled = true; };
    }, []);

    const complete = useCallback(() => {
        setIsComplete(true);
        apiClient.saveSetting(ONBOARDING_KEY, true).catch((err) => {
            logger.error('Failed to persist onboarding completion', err);
            toast.error(t('onboarding.persist.failed'));
        });
    }, [t]);

    const reset = useCallback(() => {
        setIsComplete(false);
        apiClient.saveSetting(ONBOARDING_KEY, false).catch((err) => {
            logger.error('Failed to persist onboarding reset', err);
            toast.error(t('onboarding.persist.failed'));
        });
    }, [t]);

    return { isComplete, isLoading, complete, reset };
}

interface OnboardingWizardProps {
    open: boolean;
    onComplete: () => void;
    onOpenSettings?: (tab: string) => void;
}

const STEP_KEYS = ["welcome", "overview", "bank", "import", "categories", "tour", "backup"] as const;
type StepKey = (typeof STEP_KEYS)[number];

const SUGGESTED_CATEGORIES = [
    { general: "FOOD",          detail: "Groceries",        detailKey: "onboarding.cat.groceries",      emoji: "🛒" },
    { general: "FOOD",          detail: "Restaurants",      detailKey: "onboarding.cat.restaurants",    emoji: "🍽️" },
    { general: "HOUSING",       detail: "Rent",             detailKey: "onboarding.cat.rent",           emoji: "🏠" },
    { general: "HOUSING",       detail: "Utilities",        detailKey: "onboarding.cat.utilities",      emoji: "💡" },
    { general: "TRANSPORT",     detail: "Fuel",             detailKey: "onboarding.cat.fuel",           emoji: "⛽" },
    { general: "TRANSPORT",     detail: "Public Transport", detailKey: "onboarding.cat.publicTransport",emoji: "🚌" },
    { general: "ENTERTAINMENT", detail: "Subscriptions",    detailKey: "onboarding.cat.subscriptions",  emoji: "📺" },
    { general: "ENTERTAINMENT", detail: "Hobbies",          detailKey: "onboarding.cat.hobbies",        emoji: "🎮" },
    { general: "HEALTH",        detail: "Insurance",        detailKey: "onboarding.cat.insurance",      emoji: "🏥" },
    { general: "HEALTH",        detail: "Pharmacy",         detailKey: "onboarding.cat.pharmacy",       emoji: "💊" },
    { general: "INCOME",        detail: "Salary",           detailKey: "onboarding.cat.salary",         emoji: "💰" },
    { general: "INCOME",        detail: "Freelance",        detailKey: "onboarding.cat.freelance",      emoji: "💻" },
    { general: "SAVINGS",       detail: "Investments",      detailKey: "onboarding.cat.investments",    emoji: "📈" },
    { general: "PERSONAL",      detail: "Clothing",         detailKey: "onboarding.cat.clothing",       emoji: "👕" },
    { general: "PERSONAL",      detail: "Gifts",            detailKey: "onboarding.cat.gifts",          emoji: "🎁" },
] as const;

// The green check-circle "step done" block, shared by the import and
// categories steps (they differed only in copy).
function StepSuccess({ title, subtitle }: { title: string; subtitle?: string }) {
    return (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <div className="h-14 w-14 rounded-full bg-accent/20 flex items-center justify-center">
                <CheckCircle2 className="h-7 w-7 text-accent" />
            </div>
            <p className="text-lg font-semibold text-foreground">{title}</p>
            {subtitle && (
                <p className="text-sm text-muted-foreground">{subtitle}</p>
            )}
        </div>
    );
}

export function OnboardingWizard({ open, onComplete, onOpenSettings }: OnboardingWizardProps) {
    const { t } = useLanguage();
    const navigate = useNavigate();
    const [step, setStep] = useState<StepKey>("welcome");
    const stepIdx = STEP_KEYS.indexOf(step);

    const STEPS = [
        { key: "welcome",    label: t('onboarding.step.welcome.label'),    icon: Sparkles },
        { key: "overview",   label: t('onboarding.step.overview.label'),   icon: LayoutDashboard },
        { key: "bank",       label: t('onboarding.step.bank.label'),       icon: Wallet },
        { key: "import",     label: t('onboarding.step.import.label'),     icon: Upload },
        { key: "categories", label: t('onboarding.step.categories.label'), icon: Tags },
        { key: "tour",       label: t('onboarding.step.tour.label'),       icon: BarChart3 },
        { key: "backup",     label: t('onboarding.step.backup.label'),     icon: HardDrive },
    ];

    const FEATURES = [
        { icon: Receipt,      title: t('onboarding.feature.transactions.title'), desc: t('onboarding.feature.transactions.desc'), path: "/transactions" },
        { icon: Tags,         title: t('onboarding.feature.categories.title'),   desc: t('onboarding.feature.categories.desc'),   path: "/categories" },
        { icon: CalendarClock,title: t('onboarding.feature.planned.title'),      desc: t('onboarding.feature.planned.desc'),      path: "/planned" },
        { icon: BarChart3,    title: t('onboarding.feature.statistics.title'),   desc: t('onboarding.feature.statistics.desc'),   path: "/statistics" },
        { icon: TrendingUp,   title: t('onboarding.feature.portfolio.title'),    desc: t('onboarding.feature.portfolio.desc'),    path: "/portfolio" },
        { icon: LineChart,    title: t('onboarding.feature.market.title'),       desc: t('onboarding.feature.market.desc'),       path: "/research/market" },
    ];

    const OVERVIEW_SECTIONS = [
        {
            label: t('onboarding.overview.budgeting.label'),
            color: "from-chart-3/20 to-chart-3/5 border-chart-3/20",
            iconColor: "text-chart-3",
            items: [
                { icon: CreditCard,     title: t('onboarding.feature.transactions.title'), desc: t('onboarding.feature.transactions.desc') },
                { icon: Tags,           title: t('onboarding.feature.categories.title'),   desc: t('onboarding.feature.categories.desc') },
                { icon: CalendarClock,  title: t('onboarding.feature.planned.title'),      desc: t('onboarding.feature.planned.desc') },
                { icon: PiggyBank,      title: t('onboarding.feature.statistics.title'),   desc: t('onboarding.feature.statistics.desc') },
            ],
        },
        {
            label: t('onboarding.overview.portfolio.label'),
            color: "from-primary/20 to-primary/5 border-primary/20",
            iconColor: "text-primary",
            items: [
                { icon: TrendingUp, title: t('onboarding.feature.portfolio.title'), desc: t('onboarding.feature.portfolio.desc') },
                { icon: LineChart,  title: t('onboarding.feature.market.title'),    desc: t('onboarding.feature.market.desc') },
            ],
        },
    ];

    const { adapters, loading: adaptersLoading } = useAdapters(open);
    const [selectedBank, setSelectedBank] = useState("");

    const [file, setFile] = useState<File | null>(null);
    const [importing, setImporting] = useState(false);
    const [importResult, setImportResult] = useState<{ imported: number; duplicates: number } | null>(null);

    const [selectedCategories, setSelectedCategories] = useState<Set<number>>(
        new Set(SUGGESTED_CATEGORIES.map((_, i) => i))
    );
    const [creatingCategories, setCreatingCategories] = useState(false);
    const [categoriesCreated, setCategoriesCreated] = useState(false);

    const goNext = () => { if (stepIdx < STEP_KEYS.length - 1) setStep(STEP_KEYS[stepIdx + 1]); };
    const goBack = () => { if (stepIdx > 0) setStep(STEP_KEYS[stepIdx - 1]); };

    const handleImport = async () => {
        if (!file || !selectedBank) return;
        setImporting(true);
        try {
            const result = await apiClient.importCSV(file, selectedBank);
            setImportResult({ imported: result.imported, duplicates: result.duplicates });
            toast.success(t('onboarding.toast.imported', { n: String(result.imported) }));
        } catch (err: unknown) {
            toast.error(t('onboarding.toast.importFailed', { msg: (err as Error).message }));
        } finally {
            setImporting(false);
        }
    };

    const handleCreateCategories = async () => {
        setCreatingCategories(true);
        try {
            const results = await Promise.allSettled(
                Array.from(selectedCategories).map((idx) => {
                    const cat = SUGGESTED_CATEGORIES[idx];
                    return apiClient.createCategory({ general: cat.general, detail: cat.detail });
                })
            );
            const created = results.filter((r) => r.status === "fulfilled").length;
            setCategoriesCreated(true);
            toast.success(t('onboarding.toast.categoriesCreated', { n: String(created) }));
        } catch (err: unknown) {
            toast.error(t('onboarding.toast.categoriesFailed', { msg: (err as Error).message }));
        } finally {
            setCreatingCategories(false);
        }
    };

    const handleNavigate = (path: string) => {
        onComplete();
        navigate(path);
    };

    return (
        <>
        <Dialog open={open} onOpenChange={(o) => { if (!o) onComplete(); }}>
            <DialogContent className="sm:max-w-2xl p-0 overflow-hidden gap-0 [&>button]:hidden">
                <VisuallyHidden><DialogTitle>{t('onboarding.wizard.title')}</DialogTitle></VisuallyHidden>
                {/* Progress header */}
                <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent px-6 pt-6 pb-4">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
                                <Wallet className="h-4 w-4 text-primary-foreground" />
                            </div>
                            <span className="font-bold text-foreground">Vision</span>
                        </div>
                        <Button variant="ghost" size="icon" className="icon-touch-target" aria-label={t('aria.close')} onClick={onComplete}>
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                    <div className="flex gap-1.5">
                        {STEPS.map((s, i) => (
                            <div
                                key={s.key}
                                className={cn("h-1.5 flex-1 rounded-full transition-colors", i <= stepIdx ? "bg-primary" : "bg-muted")}
                            />
                        ))}
                    </div>
                    <div className="flex items-center gap-2 mt-3">
                        {(() => { const StepIcon = STEPS[stepIdx].icon; return <StepIcon className="h-4 w-4 text-primary" />; })()}
                        <span className="text-sm font-medium text-muted-foreground">
                            {t('onboarding.stepOf', { n: String(stepIdx + 1), total: String(STEPS.length), label: STEPS[stepIdx].label })}
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
                            <h2 className="text-2xl font-bold text-foreground">{t('onboarding.welcome.title')}</h2>
                            <p className="text-muted-foreground max-w-md">{t('onboarding.welcome.desc')}</p>
                            <div className="flex gap-2 mt-2">
                                <Badge variant="secondary" className="gap-1">
                                    <Upload className="h-3 w-3" /> {t('onboarding.importCSV')}
                                </Badge>
                                <Badge variant="secondary" className="gap-1">
                                    <Tags className="h-3 w-3" /> {t('onboarding.step.categories.label')}
                                </Badge>
                                <Badge variant="secondary" className="gap-1">
                                    <BarChart3 className="h-3 w-3" /> {t('onboarding.analytics')}
                                </Badge>
                            </div>
                            {/* Offer restore early so migrating users don't need to reach the backup step */}
                            <div className="w-full max-w-md mt-1">
                                <RestoreFromBackupCard compact onDismiss={onComplete} />
                            </div>
                        </div>
                    )}

                    {/* Overview */}
                    {step === "overview" && (
                        <div className="flex-1 flex flex-col gap-4">
                            <div>
                                <h2 className="text-xl font-bold text-foreground">{t('onboarding.overview.title')}</h2>
                                <p className="text-sm text-muted-foreground mt-1">{t('onboarding.overview.desc')}</p>
                            </div>
                            <div className="flex flex-col gap-3 overflow-y-auto">
                                {OVERVIEW_SECTIONS.map((section) => (
                                    <div key={section.label} className={cn("rounded-xl border bg-gradient-to-br p-4", section.color)}>
                                        <p className={cn("text-xs font-semibold uppercase tracking-wide mb-3", section.iconColor)}>
                                            {section.label}
                                        </p>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                            {section.items.map((item) => (
                                                <div key={item.title} className="flex items-start gap-2.5">
                                                    <div className={cn("h-7 w-7 rounded-md bg-background/60 flex items-center justify-center shrink-0 mt-0.5")}>
                                                        <item.icon className={cn("h-3.5 w-3.5", section.iconColor)} />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-xs font-semibold text-foreground">{item.title}</p>
                                                        <p className="text-xs text-muted-foreground line-clamp-2">{item.desc}</p>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Bank Setup */}
                    {step === "bank" && (
                        <div className="flex-1 flex flex-col gap-4">
                            <div>
                                <h2 className="text-xl font-bold text-foreground">{t('onboarding.bank.title')}</h2>
                                <p className="text-sm text-muted-foreground mt-1">{t('onboarding.bank.desc')}</p>
                            </div>
                            {adaptersLoading ? (
                                <SectionLoader className="flex-1" />
                            ) : (
                                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                    {adapters.map((adapter) => (
                                        <button
                                            key={adapter.key}
                                            onClick={() => setSelectedBank(adapter.key)}
                                            className={cn(
                                                "flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-[color,background-color,border-color,box-shadow] hover:shadow-md",
                                                selectedBank === adapter.key
                                                    ? "border-primary bg-primary/5 shadow-sm"
                                                    : "border-border hover:border-primary/40"
                                            )}
                                        >
                                            <Wallet className={cn("h-6 w-6", selectedBank === adapter.key ? "text-primary" : "text-muted-foreground")} />
                                            <span className={cn("text-sm font-medium", selectedBank === adapter.key ? "text-foreground" : "text-muted-foreground")}>
                                                {adapter.name}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            )}
                            <p className="text-xs text-muted-foreground mt-auto">{t('onboarding.bank.notListed')}</p>
                        </div>
                    )}

                    {/* Import */}
                    {step === "import" && (
                        <div className="flex-1 flex flex-col gap-4">
                            <div>
                                <h2 className="text-xl font-bold text-foreground">{t('onboarding.import.title')}</h2>
                                <p className="text-sm text-muted-foreground mt-1">
                                    {t('onboarding.import.desc', { bank: selectedBank ? adapters.find(a => a.key === selectedBank)?.name || t('onboarding.import.yourBank') : t('onboarding.import.yourBank') })}
                                </p>
                            </div>

                            {importResult ? (
                                <StepSuccess
                                    title={t('onboarding.import.success', { n: String(importResult.imported) })}
                                    subtitle={importResult.duplicates > 0
                                        ? t('onboarding.import.duplicates', { n: String(importResult.duplicates) })
                                        : undefined}
                                />
                            ) : (
                                <>
                                    <CsvDropzone file={file} onFileSelect={setFile} compact />

                                    {file && (
                                        <Button onClick={handleImport} disabled={importing || !selectedBank} className="gap-2">
                                            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                                            {importing ? t('onboarding.import.importing') : t('onboarding.import.button')}
                                        </Button>
                                    )}
                                </>
                            )}

                            <p className="text-xs text-muted-foreground">{t('onboarding.import.skipHint')}</p>
                        </div>
                    )}

                    {/* Categories */}
                    {step === "categories" && (
                        <div className="flex-1 flex flex-col gap-4">
                            <div>
                                <h2 className="text-xl font-bold text-foreground">{t('onboarding.categories.title')}</h2>
                                <p className="text-sm text-muted-foreground mt-1">{t('onboarding.categories.desc')}</p>
                            </div>

                            {categoriesCreated ? (
                                <StepSuccess
                                    title={t('onboarding.categories.created')}
                                    subtitle={t('onboarding.categories.manage')}
                                />
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
                                                        if (selected) next.delete(idx); else next.add(idx);
                                                        setSelectedCategories(next);
                                                    }}
                                                    className={cn(
                                                        "flex items-center gap-2 p-2.5 rounded-lg border transition-[color,background-color,border-color] text-left",
                                                        selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
                                                    )}
                                                >
                                                    <span className="text-base">{cat.emoji}</span>
                                                    <div className="min-w-0">
                                                        <p className={cn("text-xs font-medium truncate", selected ? "text-foreground" : "text-muted-foreground")}>
                                                            {t(cat.detailKey)}
                                                        </p>
                                                        <p className="text-xs text-muted-foreground/60 truncate">{cat.general}</p>
                                                    </div>
                                                    {selected && <CheckCircle2 className="h-3.5 w-3.5 text-primary ml-auto shrink-0" />}
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
                                            {creatingCategories ? <Loader2 className="h-4 w-4 animate-spin" /> : <Tags className="h-4 w-4" />}
                                            {t('onboarding.categories.create', { n: String(selectedCategories.size) })}
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
                                            {selectedCategories.size === SUGGESTED_CATEGORIES.length ? t('onboarding.categories.deselectAll') : t('onboarding.categories.selectAll')}
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
                                <h2 className="text-xl font-bold text-foreground">{t('onboarding.tour.title')}</h2>
                                <p className="text-sm text-muted-foreground mt-1">{t('onboarding.tour.desc')}</p>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {FEATURES.map((feat) => (
                                    <button
                                        key={feat.path}
                                        onClick={() => handleNavigate(feat.path)}
                                        className="flex items-start gap-3 p-3 rounded-xl border border-border hover:border-primary/40 hover:bg-primary/5 transition-[color,background-color,border-color] text-left group"
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

                    {/* Backup */}
                    {step === "backup" && (
                        <div className="flex-1 flex flex-col gap-5">
                            <div>
                                <h2 className="text-xl font-bold text-foreground">{t('onboarding.backup.title')}</h2>
                                <p className="text-sm text-muted-foreground mt-1">{t('onboarding.backup.desc')}</p>
                            </div>

                            {/* Why backup matters */}
                            <div className="flex flex-col gap-2.5">
                                {[
                                    { icon: ShieldCheck, labelKey: 'onboarding.backup.reason.safe' },
                                    { icon: HardDrive,   labelKey: 'onboarding.backup.reason.local' },
                                    { icon: FolderOpen,  labelKey: 'onboarding.backup.reason.restore' },
                                ].map(({ icon: Icon, labelKey }) => (
                                    <div key={labelKey} className="flex items-start gap-3 p-3 rounded-lg border border-border bg-muted/30">
                                        <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                                            <Icon className="h-4 w-4 text-primary" />
                                        </div>
                                        <p className="text-sm text-foreground leading-relaxed">{t(labelKey)}</p>
                                    </div>
                                ))}
                            </div>

                            {/* CTA */}
                            <div className="mt-auto pt-2 flex flex-col gap-2">
                                <p className="text-xs text-muted-foreground">{t('onboarding.backup.hint')}</p>
                                <Button
                                    className="gap-2 w-full sm:w-auto"
                                    onClick={() => {
                                        onComplete();
                                        onOpenSettings?.('backup');
                                    }}
                                >
                                    <FolderOpen className="h-4 w-4" />
                                    {t('onboarding.backup.openSettings')}
                                </Button>
                            </div>

                            {/* Restore — delegates to RestoreFromBackupCard (handles frontendState + schema errors) */}
                            <div className="flex items-center gap-3 my-1">
                                <div className="h-px flex-1 bg-border" />
                                <span className="text-xs text-muted-foreground">{t('onboarding.restore.orTitle')}</span>
                                <div className="h-px flex-1 bg-border" />
                            </div>
                            <RestoreFromBackupCard compact onDismiss={onComplete} />
                        </div>
                    )}
                </div>

                {/* Footer navigation */}
                <div className="border-t px-6 py-4 flex items-center justify-between bg-muted/30">
                    <div>
                        {stepIdx > 0 ? (
                            <Button variant="ghost" size="sm" onClick={goBack} className="gap-1.5">
                                <ArrowLeft className="h-3.5 w-3.5" /> {t('onboarding.back')}
                            </Button>
                        ) : (
                            <Button variant="ghost" size="sm" onClick={onComplete}>{t('onboarding.skipSetup')}</Button>
                        )}
                    </div>
                    <div>
                        {step === "backup" ? (
                            <Button onClick={onComplete} className="gap-1.5">
                                {t('onboarding.goToDashboard')} <ArrowRight className="h-3.5 w-3.5" />
                            </Button>
                        ) : step === "tour" ? (
                            <Button onClick={goNext} className="gap-1.5">
                                {t('onboarding.nextStep')} <ArrowRight className="h-3.5 w-3.5" />
                            </Button>
                        ) : (
                            <Button onClick={goNext} className="gap-1.5">
                                {step === "welcome" ? t('onboarding.getStarted') : t('onboarding.nextStep')}
                                <ArrowRight className="h-3.5 w-3.5" />
                            </Button>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
        </>
    );
}
