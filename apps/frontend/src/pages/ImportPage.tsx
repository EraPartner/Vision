import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { ArrowRight, CheckCircle2, ChevronDown, X } from "lucide-react";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { PageHeader } from "@/components/shared/PageHeader";
import { ImportHistoryCard } from "@/features/imports/ImportHistoryCard";
import { TransactionImportCard } from "@/features/imports/TransactionImportCard";
import { RecipientsImportCard } from "@/features/imports/RecipientsImportCard";
import { CategoriesImportCard } from "@/features/imports/CategoriesImportCard";
import { ExportCard } from "@/features/imports/ExportCard";
import { SupportedBanksCard } from "@/features/imports/SupportedBanksCard";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { PageShell } from "@/components/shared/PageShell";

interface ImportCommitReceipt {
    imported: number;
    duplicates: number;
    errors: number;
    /** Date span of the imported rows (YYYY-MM-DD), when the review page knew it. */
    dateFrom?: string;
    dateTo?: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function readCommitReceipt(state: unknown): ImportCommitReceipt | null {
    if (
        !state ||
        typeof state !== "object" ||
        !("importCommitReceipt" in state)
    )
        return null;
    const receipt = (state as { importCommitReceipt?: unknown })
        .importCommitReceipt;
    if (!receipt || typeof receipt !== "object") return null;
    const { imported, duplicates, errors, dateFrom, dateTo } =
        receipt as Partial<ImportCommitReceipt>;
    if (
        ![imported, duplicates, errors].every(
            (value) =>
                typeof value === "number" &&
                Number.isFinite(value) &&
                value >= 0,
        )
    )
        return null;
    return {
        imported: imported!,
        duplicates: duplicates!,
        errors: errors!,
        dateFrom:
            typeof dateFrom === "string" && YMD.test(dateFrom)
                ? dateFrom
                : undefined,
        dateTo:
            typeof dateTo === "string" && YMD.test(dateTo) ? dateTo : undefined,
    };
}

/**
 * Where the receipt's "Show imported transactions" link goes. There is no
 * per-batch filter on the Transactions page, so the link narrows the list to
 * the imported rows' date span (the `start_date`/`end_date` params it reads).
 */
function importedTransactionsHref(
    receipt: ImportCommitReceipt,
    label: string,
): string {
    const params = new URLSearchParams();
    if (receipt.dateFrom) params.set("start_date", receipt.dateFrom);
    if (receipt.dateTo) params.set("end_date", receipt.dateTo);
    if (receipt.dateFrom || receipt.dateTo) params.set("filter_label", label);
    const query = params.toString();
    return query ? `/transactions?${query}` : "/transactions";
}

export default function ImportPage() {
    const { t, tc } = useLanguage();
    const location = useLocation();
    const navigate = useNavigate();
    const [historyKey, setHistoryKey] = useState(0);
    const [setupOpen, setSetupOpen] = useState(false);
    const [commitReceipt, setCommitReceipt] =
        useState<ImportCommitReceipt | null>(() =>
            readCommitReceipt(location.state),
        );

    useEffect(() => {
        if (!readCommitReceipt(location.state)) return;
        navigate(location.pathname, { replace: true, state: null });
    }, [location.pathname, location.state, navigate]);

    return (
        <PageShell className="max-w-7xl mx-auto">
            <PageHeader
                title={t("importPage.title")}
                subtitle={t("importPage.subtitle")}
                icon={PAGE_ICONS["/import"]}
            />
            {commitReceipt && (
                <Card role="status" className="bg-success/5">
                    <CardContent
                        variant="headerless"
                        className="flex items-start gap-3"
                    >
                        <CheckCircle2
                            className="icon-success-bounce mt-0.5 h-5 w-5 shrink-0 text-success"
                            aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                            <h2 className="type-title-3 text-foreground">
                                {t("importPage.commitReceiptTitle")}
                            </h2>
                            <p className="mt-1 type-body text-label-secondary">
                                <span className="font-semibold text-foreground">
                                    <RollingNumber
                                        value={String(commitReceipt.imported)}
                                    />
                                </span>{" "}
                                {tc(
                                    "importPage.commitReceiptImported",
                                    commitReceipt.imported,
                                )}
                            </p>
                            <p className="mt-1 type-footnote text-label-secondary">
                                {tc(
                                    "importPage.commitReceiptDuplicates",
                                    commitReceipt.duplicates,
                                )}
                                {" · "}
                                {tc(
                                    "importPage.commitReceiptErrors",
                                    commitReceipt.errors,
                                )}
                            </p>
                            {commitReceipt.imported > 0 && (
                                <Button
                                    asChild
                                    variant="outline"
                                    size="sm"
                                    className="mt-3"
                                >
                                    <Link
                                        to={importedTransactionsHref(
                                            commitReceipt,
                                            t("importPage.importedFilterLabel"),
                                        )}
                                    >
                                        {tc(
                                            "importPage.showImported",
                                            commitReceipt.imported,
                                        )}
                                        <ArrowRight
                                            className="h-4 w-4"
                                            aria-hidden
                                        />
                                    </Link>
                                </Button>
                            )}
                        </div>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={t("importPage.dismissCommitReceipt")}
                            onClick={() => setCommitReceipt(null)}
                        >
                            <X className="h-4 w-4" aria-hidden />
                        </Button>
                    </CardContent>
                </Card>
            )}
            <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)] xl:items-start">
                <div className="min-w-0 space-y-6">
                    <TransactionImportCard
                        onImportSuccess={() => setHistoryKey((k) => k + 1)}
                    />
                    <ImportHistoryCard refreshKey={historyKey} />
                </div>
                <aside className="min-w-0 space-y-6">
                    <ExportCard />
                    <Collapsible open={setupOpen} onOpenChange={setSetupOpen}>
                        <Card>
                            <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
                                <div className="min-w-0 space-y-1.5">
                                    <CardTitle variant="sm">
                                        {t("importPage.setupReference")}
                                    </CardTitle>
                                    <CardDescription>
                                        {t("importPage.setupReferenceDesc")}
                                    </CardDescription>
                                </div>
                                <CollapsibleTrigger asChild>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="icon"
                                        className="shrink-0"
                                        aria-label={t(
                                            "importPage.toggleSetupReference",
                                        )}
                                    >
                                        <ChevronDown
                                            className={cn(
                                                "h-4 w-4 transition-transform duration-fast motion-reduce:transition-none",
                                                setupOpen && "rotate-180",
                                            )}
                                            aria-hidden
                                        />
                                    </Button>
                                </CollapsibleTrigger>
                            </CardHeader>
                            <CollapsibleContent>
                                <CardContent className="space-y-4">
                                    <RecipientsImportCard />
                                    <CategoriesImportCard />
                                    <SupportedBanksCard />
                                </CardContent>
                            </CollapsibleContent>
                        </Card>
                    </Collapsible>
                </aside>
            </div>
        </PageShell>
    );
}
