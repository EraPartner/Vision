// @refresh reset
import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
    Wallet, Upload, Tags, Sparkles, ArrowRight, ArrowLeft,
    CheckCircle2, ClipboardCheck, Loader2, BarChart3, Receipt,
    CalendarClock, TrendingUp, LineChart, X,
    HardDrive, ShieldCheck, FolderOpen, PiggyBank, CreditCard,
    LayoutDashboard,
} from "lucide-react";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { VisionMark } from "@/components/shared/VisionMark";
import { apiClient } from "@/lib/api";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { CsvDropzone } from "@/features/imports/CsvDropzone";
import { isReviewRequired } from "@/lib/api/imports";
import { useAdapters } from "@/features/imports/useAdapters";
import { RestoreFromBackupCard } from "./RestoreFromBackupCard";

/**
 * Heading recipes for the wizard's step titles.
 *
 * The app's display-type rule lives in `index.css` `@layer base`:
 * `h1, h2, h3, .font-display { font-family: var(--font-display) }` — Fraunces.
 * These headings are `h2`s, so they are covered by the element selector, but
 * every other titled surface in the app writes the class out anyway
 * (`DialogTitle`, `CardTitle`, `AlertTitle`, `EmptyState`, the sidebar
 * wordmark). Writing it here puts the wizard back inside that convention and
 * keeps the intent visible at the call site.
 *
 * `STEP_HEADING` is `DialogTitle`'s exact recipe (`ui/dialog.tsx`) — these
 * *are* the dialog's visible titles. `WELCOME_HEADING` is `CardTitle`'s
 * (`ui/card.tsx`), one step up, because the welcome step is the brand moment.
 * The `outline-none` tail is pre-existing and load-bearing: the heading is
 * focused programmatically on every step change (see `headingRef`) and must
 * not draw a focus ring for that.
 */
const HEADING_FOCUS = "outline-none focus:outline-none focus-visible:outline-none";
const STEP_HEADING = `font-display text-xl font-semibold leading-tight tracking-tight text-foreground ${HEADING_FOCUS}`;
const WELCOME_HEADING = `font-display text-2xl font-semibold leading-tight tracking-tight text-foreground ${HEADING_FOCUS}`;

/**
 * Two-letter monogram for a bank tile.
 *
 * Derived from the adapter catalog's own display label — `bankName` in the
 * backend adapter registry (`importPipeline/adapters/index.js`), served as
 * `name` by `/api/info/supported-adapters` — so a newly registered adapter
 * gets its own face automatically, with no second list to keep in sync (the
 * same reason the catalog itself is registry-derived).
 *
 * Case is read from the label rather than forced, because the catalog already
 * distinguishes the two kinds of name: acronyms are spelled in caps and
 * names in title case, so "ING" → "IN" and "Belfius" → "Be" fall straight out
 * of the data and the grid reads as a set of wordmarks rather than a set of
 * badges. A one-letter first word borrows the next word's initial; a label
 * with no letters at all falls back to the adapter key.
 */
function bankMonogram(adapter: { key: string; name: string }): string {
    const words = (adapter.name ?? "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const [first = "", second = ""] = words;
    const fromName = first.length >= 2 ? first.slice(0, 2) : first + second.slice(0, 1);
    const mono = fromName || (adapter.key ?? "").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2);
    return mono ? mono.charAt(0).toUpperCase() + mono.slice(1) : "?";
}

interface OnboardingWizardProps {
    open: boolean;
    onComplete: () => void;
    onOpenSettings?: (tab: string) => void;
}

// `categories` deliberately precedes `bank`/`import`: a first import lands on
// the review page (see `StepNeedsReview`), and the review page is where
// categories get assigned — running the categories step first means the user
// arrives there with real pickers instead of empty ones, and the review
// hand-off no longer skips the one step it needs. Bank and import stay
// adjacent because the import step reads `selectedBank`.
const STEP_KEYS = ["welcome", "overview", "categories", "bank", "import", "tour", "backup"] as const;
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

/**
 * The import step's *other* outcome: the route answered 202, the batch is
 * parked in `awaiting_review`, and nothing was committed. On a first-ever
 * import this is the normal answer, not the exception — `prepareImport`
 * (node-backend services/importPipeline/index.js:78-84) requires review as
 * soon as any row resolved to a NEW recipient, and on an empty database every
 * recipient is new.
 *
 * Deliberately `StepSuccess`'s twin and not a new invention: the same
 * `h-14 w-14` circular plate in the same centered column, so the eye reads
 * "this is the import step's outcome" from the geometry. Only the hue differs
 * — `primary` instead of the `accent` green — because this outcome is not
 * done, it is waiting on the user. Hue carries the meaning; shape carries the
 * category. The CTA is a plain `<Button>` in its default (primary) variant,
 * the same affordance every other terminal action in this wizard uses.
 */
function StepNeedsReview({ title, desc, cta, later, onReview }: {
    title: string;
    desc: string;
    cta: string;
    later: string;
    onReview: () => void;
}) {
    return (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
            <div className="h-14 w-14 rounded-full bg-primary/15 flex items-center justify-center">
                <ClipboardCheck className="h-7 w-7 text-primary" />
            </div>
            <p className="text-lg font-semibold text-foreground">{title}</p>
            <p className="text-sm text-muted-foreground max-w-md">{desc}</p>
            <Button onClick={onReview} className="gap-2 mt-1">
                {cta}
                <ArrowRight className="h-3.5 w-3.5" />
            </Button>
            <p className="text-xs text-muted-foreground">{later}</p>
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
        { key: "categories", label: t('onboarding.step.categories.label'), icon: Tags },
        { key: "bank",       label: t('onboarding.step.bank.label'),       icon: Wallet },
        { key: "import",     label: t('onboarding.step.import.label'),     icon: Upload },
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
    // Set only on the 202 arm: the staged-but-uncommitted batch this run
    // produced. It survives the rest of the wizard so the final step can still
    // hand the user off to it (see the footer's `onboarding.finishImport` CTA).
    const [reviewBatch, setReviewBatch] = useState<{ batchId: number; rows: number } | null>(null);

    const [selectedCategories, setSelectedCategories] = useState<Set<number>>(
        new Set(SUGGESTED_CATEGORIES.map((_, i) => i))
    );
    const [creatingCategories, setCreatingCategories] = useState(false);
    const [categoriesCreated, setCategoriesCreated] = useState(false);

    const goNext = () => { if (stepIdx < STEP_KEYS.length - 1) setStep(STEP_KEYS[stepIdx + 1]); };
    const goBack = () => { if (stepIdx > 0) setStep(STEP_KEYS[stepIdx - 1]); };

    // Move focus to the current step's heading when the step changes so keyboard
    // and screen-reader users land on the new content (the heading is
    // tabIndex={-1} for programmatic focus only). Skip the initial mount so we
    // don't fight the Dialog's own open-focus behaviour.
    const headingRef = useRef<HTMLHeadingElement>(null);
    const didMountRef = useRef(false);
    useEffect(() => {
        if (!didMountRef.current) { didMountRef.current = true; return; }
        headingRef.current?.focus();
    }, [step]);

    const handleImport = async () => {
        if (!file || !selectedBank) return;
        setImporting(true);
        try {
            const result = await apiClient.importCSV(file, selectedBank);
            // The route answers 202 `{ batch_id, requires_review, match_source_counts }`
            // when rows still need review — nothing is committed on that branch, so
            // there are no counts (the same convention importCSVWithProgress uses for
            // its `review_required` event). Reading them unguarded rendered "undefined";
            // reporting them as 0 was honest but still told the user an import had
            // happened. The batch is real and staged — it just needs the review page,
            // so this arm offers that instead of claiming a result.
            if (isReviewRequired(result)) {
                const rows = Object.values(result.match_source_counts ?? {})
                    .reduce((sum, n) => sum + (n ?? 0), 0);
                setReviewBatch({ batchId: result.batch_id, rows });
                toast.info(t('onboarding.toast.reviewRequired', { n: String(rows) }));
                return;
            }
            setImportResult({ imported: result.imported, duplicates: result.duplicates });
            toast.success(t('onboarding.toast.imported', { n: String(result.imported) }));
        } catch (err: unknown) {
            toast.error(t('onboarding.toast.importFailed', { msg: apiErrorToMessage(err, t) }));
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
            const rejected = results.find((result) => result.status === "rejected");
            if (rejected) {
                toast.error(t('onboarding.toast.categoriesFailed', {
                    msg: apiErrorToMessage(rejected.reason, t),
                }));
                return;
            }
            const created = results.length;
            setCategoriesCreated(true);
            toast.success(t('onboarding.toast.categoriesCreated', { n: String(created) }));
        } catch (err: unknown) {
            toast.error(t('onboarding.toast.categoriesFailed', { msg: apiErrorToMessage(err, t) }));
        } finally {
            setCreatingCategories(false);
        }
    };

    const handleNavigate = (path: string) => {
        onComplete();
        navigate(path);
    };

    /**
     * Hand the user off to the review page for the batch this run staged.
     *
     * Onboarding is marked complete *before* navigating, and that is forced,
     * not a preference: `AppLayout` renders this wizard as
     * `open={!onboardingComplete}` (components/layout/AppLayout.tsx:247), so
     * navigating while still incomplete would leave a modal dialog sitting on
     * top of the review page the user was just sent to — strictly worse than
     * the bug being fixed.
     *
     * The cost is real and worth naming: taking this exit from the import step
     * ends onboarding at step 5 of 7, so the tour and backup steps are skipped
     * (the categories step runs before import precisely so this exit doesn't
     * skip it — see `STEP_KEYS`). It is mitigated on three sides rather than hidden — the
     * user is shown the "needs review" state and chooses to leave rather than
     * being teleported; `onboarding.import.review.later` offers finishing
     * setup first, in which case the backup step's footer CTA becomes
     * "Finish your import" and lands them here anyway; and the whole wizard
     * can be replayed from Settings → About ("Restart onboarding",
     * features/settings/sections/AboutSection.tsx:51). Suspending and
     * resuming the wizard around the review page instead would need a
     * persisted in-progress step in `useOnboarding` plus a re-entry trigger on
     * the review page — a step-machine change this fix has no mandate for.
     */
    const goToReview = (batchId: number) => handleNavigate(`/import/${batchId}/review`);

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
                                <VisionMark className="h-4 w-4 text-primary-foreground" />
                            </div>
                            <span className="font-display font-semibold tracking-tight text-foreground">Vision</span>
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
                        <span aria-live="polite" className="text-sm font-medium text-muted-foreground">
                            {t('onboarding.stepOf', { n: String(stepIdx + 1), total: String(STEPS.length), label: STEPS[stepIdx].label })}
                        </span>
                    </div>
                </div>

                {/* Step content */}
                <div className="px-6 py-6 min-h-[340px] flex flex-col">

                    {/* Welcome */}
                    {step === "welcome" && (
                        <div className="flex-1 flex flex-col items-center justify-center text-center gap-4 animate-in">
                            {/* The brand moment. Same aurora-halo + glass-tile treatment
                                `shared/EmptyState.tsx` gives a routine empty list, sized up
                                and carrying the Vision mark instead of a stock icon. The
                                material tiers stack the way the hierarchy in index.css
                                describes them: glass-thick dialog → glass-regular brand tile
                                → glass-thin working surfaces on the later steps. The
                                entrance is `.animate-in`, which index.css already disables
                                under `prefers-reduced-motion`. */}
                            <div className="relative">
                                <div aria-hidden="true" className="absolute -inset-4 rounded-3xl bg-gradient-to-br from-primary/15 to-accent/10 blur-2xl" />
                                <div className="relative h-20 w-20 rounded-2xl glass-regular flex items-center justify-center">
                                    <VisionMark className="h-10 w-10 text-primary" />
                                </div>
                            </div>
                            <h2 ref={headingRef} tabIndex={-1} className={WELCOME_HEADING}>{t('onboarding.welcome.title')}</h2>
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
                                <h2 ref={headingRef} tabIndex={-1} className={STEP_HEADING}>{t('onboarding.overview.title')}</h2>
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
                                <h2 ref={headingRef} tabIndex={-1} className={STEP_HEADING}>{t('onboarding.bank.title')}</h2>
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
                                            aria-pressed={selectedBank === adapter.key}
                                            className={cn(
                                                // Transition list composed via --press-compose (press-feedback
                                                // owns the `transition` shorthand — see index.css).
                                                "press-feedback [--press-compose:color_var(--default-transition-duration)_var(--default-transition-timing-function),background-color_var(--default-transition-duration)_var(--default-transition-timing-function),border-color_var(--default-transition-duration)_var(--default-transition-timing-function),box-shadow_var(--default-transition-duration)_var(--default-transition-timing-function),transform_90ms_ease-out] flex flex-col items-center gap-2 p-4 rounded-xl border-2 hover:shadow-md",
                                                selectedBank === adapter.key
                                                    ? "border-primary bg-primary/5 shadow-sm"
                                                    : "border-border hover:border-primary/40"
                                            )}
                                        >
                                            {/* Monogram, not an icon: six banks rendered as the same
                                                Wallet glyph read as six clones. `aria-hidden` because
                                                the label below already names the tile — the monogram
                                                is a face, not a second name. `Wallet` still means
                                                "bank/account" everywhere else in the app. The plate is
                                                glass-thin, deliberately one tier below the welcome
                                                step's glass-regular brand tile. */}
                                            <span
                                                aria-hidden="true"
                                                className={cn(
                                                    "h-10 w-10 rounded-xl glass-thin flex items-center justify-center font-display text-sm font-semibold tracking-tight transition-colors",
                                                    selectedBank === adapter.key ? "text-primary" : "text-muted-foreground"
                                                )}
                                            >
                                                {bankMonogram(adapter)}
                                            </span>
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
                                <h2 ref={headingRef} tabIndex={-1} className={STEP_HEADING}>{t('onboarding.import.title')}</h2>
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
                            ) : reviewBatch ? (
                                <StepNeedsReview
                                    title={t('onboarding.import.review.title', { n: String(reviewBatch.rows) })}
                                    desc={t('onboarding.import.review.desc')}
                                    cta={t('onboarding.import.review.cta')}
                                    later={t('onboarding.import.review.later')}
                                    onReview={() => goToReview(reviewBatch.batchId)}
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

                            {/* Suppressed on the review arm only: "you can also import
                                later" contradicts a batch that is already staged and
                                waiting, and `onboarding.import.review.later` is the
                                footnote that arm needs instead. */}
                            {!reviewBatch && (
                                <p className="text-xs text-muted-foreground">{t('onboarding.import.skipHint')}</p>
                            )}
                        </div>
                    )}

                    {/* Categories */}
                    {step === "categories" && (
                        <div className="flex-1 flex flex-col gap-4">
                            <div>
                                <h2 ref={headingRef} tabIndex={-1} className={STEP_HEADING}>{t('onboarding.categories.title')}</h2>
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
                                                        "press-feedback [--press-compose:color_var(--default-transition-duration)_var(--default-transition-timing-function),background-color_var(--default-transition-duration)_var(--default-transition-timing-function),border-color_var(--default-transition-duration)_var(--default-transition-timing-function),transform_90ms_ease-out] flex items-center gap-2 p-2.5 rounded-lg border text-left",
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
                                <h2 ref={headingRef} tabIndex={-1} className={STEP_HEADING}>{t('onboarding.tour.title')}</h2>
                                <p className="text-sm text-muted-foreground mt-1">{t('onboarding.tour.desc')}</p>
                            </div>
                            {/* glass-thin instead of a bare border: the working steps join the
                                app's material hierarchy without competing with the welcome step's
                                glass-regular tile. The tile's own hover tint is dropped — a
                                background-color sitting under a glass gradient just muddies it —
                                and replaced with the same border+shadow hover the bank tiles use,
                                so the wizard's two tile grids behave identically. The icon plate
                                keeps its group-hover lift. */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {FEATURES.map((feat) => (
                                    <button
                                        key={feat.path}
                                        onClick={() => handleNavigate(feat.path)}
                                        className="press-feedback [--press-compose:color_var(--default-transition-duration)_var(--default-transition-timing-function),background-color_var(--default-transition-duration)_var(--default-transition-timing-function),border-color_var(--default-transition-duration)_var(--default-transition-timing-function),box-shadow_var(--default-transition-duration)_var(--default-transition-timing-function),transform_90ms_ease-out] glass-thin flex items-start gap-3 p-3 rounded-xl hover:border-primary/40 hover:shadow-md text-left group"
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
                                <h2 ref={headingRef} tabIndex={-1} className={STEP_HEADING}>{t('onboarding.backup.title')}</h2>
                                <p className="text-sm text-muted-foreground mt-1">{t('onboarding.backup.desc')}</p>
                            </div>

                            {/* Why backup matters */}
                            <div className="flex flex-col gap-2.5">
                                {[
                                    { icon: ShieldCheck, labelKey: 'onboarding.backup.reason.safe' },
                                    { icon: HardDrive,   labelKey: 'onboarding.backup.reason.local' },
                                    { icon: FolderOpen,  labelKey: 'onboarding.backup.reason.restore' },
                                ].map(({ icon: Icon, labelKey }) => (
                                    <div key={labelKey} className="flex items-start gap-3 p-3 rounded-lg glass-thin">
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
                            /* The other half of the hand-off. A user who chose
                               "finish setup first" on the import step still has an
                               uncommitted batch; ending the wizard at the dashboard
                               would strand it, so the last CTA points at the batch
                               instead of the dashboard. Same button, same variant,
                               same arrow — only the destination and label change. */
                            <Button
                                onClick={reviewBatch ? () => goToReview(reviewBatch.batchId) : onComplete}
                                className="gap-1.5"
                            >
                                {reviewBatch ? t('onboarding.finishImport') : t('onboarding.goToDashboard')}
                                <ArrowRight className="h-3.5 w-3.5" />
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
