import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useLanguage } from "@/contexts/LanguageContext";
import { CheckCircle2, ChevronDown, X } from "lucide-react";
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
import { Card, CardContent } from "@/components/ui/card";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { PageShell } from "@/components/shared/PageShell";

interface ImportCommitReceipt {
    imported: number;
    duplicates: number;
    errors: number;
}

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
    const { imported, duplicates, errors } =
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
    return { imported: imported!, duplicates: duplicates!, errors: errors! };
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
        <PageShell className="max-w-4xl mx-auto">
            <PageHeader
                title={t("importPage.title")}
                subtitle={t("importPage.subtitle")}
                icon={PAGE_ICONS["/import"]}
            />
            {commitReceipt && (
                <Card role="status" className="border-success/30 bg-success/5">
                    <CardContent
                        variant="state"
                        className="flex items-start gap-3"
                    >
                        <CheckCircle2
                            className="icon-success-bounce mt-0.5 h-5 w-5 shrink-0 text-success"
                            aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                            <h2 className="font-display text-lg font-semibold text-foreground">
                                {t("importPage.commitReceiptTitle")}
                            </h2>
                            <p className="mt-1 text-sm text-muted-foreground">
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
                            <p className="mt-1 text-xs text-muted-foreground">
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
            <TransactionImportCard
                onImportSuccess={() => setHistoryKey((k) => k + 1)}
            />
            <ImportHistoryCard refreshKey={historyKey} />
            <ExportCard />
            <Collapsible
                open={setupOpen}
                onOpenChange={setSetupOpen}
                className="rounded-xl border border-border/60 bg-card/40 p-4"
            >
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2 className="font-display text-lg font-semibold">
                            {t("importPage.setupReference")}
                        </h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t("importPage.setupReferenceDesc")}
                        </p>
                    </div>
                    <CollapsibleTrigger asChild>
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            aria-label={t("importPage.toggleSetupReference")}
                        >
                            <ChevronDown
                                className={cn(
                                    "h-4 w-4 transition-transform duration-[var(--duration-fast)] motion-reduce:transition-none",
                                    setupOpen && "rotate-180",
                                )}
                            />
                        </Button>
                    </CollapsibleTrigger>
                </div>
                <CollapsibleContent className="space-y-4 pt-4">
                    <RecipientsImportCard />
                    <CategoriesImportCard />
                    <SupportedBanksCard />
                </CollapsibleContent>
            </Collapsible>
        </PageShell>
    );
}
