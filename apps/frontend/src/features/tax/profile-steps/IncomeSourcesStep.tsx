import { useMemo, useState } from "react";
import { Info, ListChecks, Search } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { List, ListRow } from "@/components/ui/list";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/EmptyState";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { StepProps } from "./types";
import { useTaxIncomeCategories } from "../useTaxProfileQueries";
import { StepIntro } from "./ProfileRows";

/**
 * Tax income source step.
 *
 * Lets the user mark which transaction categories count as taxable income for the
 * Tax Overview graphs. Without this, the graphs would treat every positive-amount
 * transaction (refunds, transfers, gifts) as salary and run income tax on it.
 */
export function IncomeSourcesStep({ profile, updateProfile }: StepProps) {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const [filter, setFilter] = useState("");

    const categoriesQuery = useTaxIncomeCategories();

    const selected = profile.taxIncomeCategoryIds ?? [];

    const filtered = useMemo(() => {
        const categories = categoriesQuery.data ?? [];
        const q = filter.trim().toLowerCase();
        const list = categories
            .map((c) => ({
                id: c.id,
                label: c.path.join(" / "),
            }))
            .sort((a, b) => a.label.localeCompare(b.label));
        if (!q) return list;
        return list.filter((c) => c.label.toLowerCase().includes(q));
    }, [categoriesQuery.data, filter]);

    function toggle(id: number) {
        const next = selected.includes(id)
            ? selected.filter((x) => x !== id)
            : [...selected, id];
        updateProfile({ taxIncomeCategoryIds: next });
    }

    function clearAll() {
        updateProfile({ taxIncomeCategoryIds: [] });
    }

    return (
        <div className="space-y-5">
            <StepIntro
                title={t("tax.profile.section.incomeSources.title")}
                description={t("tax.profile.section.incomeSources.desc")}
            />
            <Alert>
                <Info className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>
                    {t("tax.profile.section.incomeSources.note")}
                </AlertDescription>
            </Alert>

            <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <p className="flex items-center gap-2 type-headline text-foreground">
                        {t("tax.profile.section.incomeSources.categoriesLabel")}
                        <Badge variant="outline" size="sm">
                            {selected.length}{" "}
                            {t("tax.profile.section.incomeSources.selected")}
                        </Badge>
                    </p>
                    {selected.length > 0 && (
                        <Button variant="ghost" size="sm" onClick={clearAll}>
                            {t("common.clear")}
                        </Button>
                    )}
                </div>

                <div className="relative">
                    <Search
                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-label-tertiary"
                        aria-hidden="true"
                    />
                    <Input
                        aria-label={t(
                            "tax.profile.section.incomeSources.searchPlaceholder",
                        )}
                        type="text"
                        placeholder={t(
                            "tax.profile.section.incomeSources.searchPlaceholder",
                        )}
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        className="pl-9"
                    />
                </div>

                {categoriesQuery.isLoading ? (
                    <div {...loadingSurfaceProps} className="space-y-2">
                        <Skeleton className="h-11 w-full" />
                        <Skeleton className="h-11 w-full" />
                        <Skeleton className="h-11 w-full" />
                    </div>
                ) : filtered.length === 0 ? (
                    <EmptyState
                        size="compact"
                        headingLevel={4}
                        icon={ListChecks}
                        title={t("tax.profile.section.incomeSources.empty")}
                    />
                ) : (
                    <ScrollArea className="h-[260px]">
                        <List>
                            {filtered.map((c) => (
                                <ListRow
                                    key={c.id}
                                    asChild
                                    leading={
                                        <Checkbox
                                            id={`tax-income-cat-${c.id}`}
                                            checked={selected.includes(c.id)}
                                            onCheckedChange={() => toggle(c.id)}
                                        />
                                    }
                                    title={c.label}
                                >
                                    <label htmlFor={`tax-income-cat-${c.id}`} />
                                </ListRow>
                            ))}
                        </List>
                    </ScrollArea>
                )}
            </div>
        </div>
    );
}
