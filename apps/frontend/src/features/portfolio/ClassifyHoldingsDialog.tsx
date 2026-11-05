import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import type { ClassifiableHolding } from "@/lib/api/portfolioExposure";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
    useExposureClassificationsQuery,
    useSaveExposureClassifications,
} from "@/hooks/portfolio/usePortfolioExposure";
import {
    classificationChanges,
    draftOf,
    isEmptyDraft,
    sameDraft,
    type Draft,
} from "./classificationChanges";
import { CountryCombobox } from "./CountryCombobox";
import type { InvestmentId } from "@vision/types/brands";
import type { TranslationKey } from "@/locales/keys";

/** GICS sector names offered as suggestions next to the sectors already in use. */
const STANDARD_SECTORS = [
    "Communication Services",
    "Consumer Discretionary",
    "Consumer Staples",
    "Energy",
    "Financials",
    "Health Care",
    "Industrials",
    "Information Technology",
    "Materials",
    "Real Estate",
    "Utilities",
];

interface ClassifyHoldingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Limit the sheet to these holdings (the row menu passes one). */
    investmentIds?: readonly InvestmentId[] | undefined;
}

/**
 * Edit sector, issuer country and issuer for one holding or many at once
 * (ADR-267). Saved values are manual: source imports no longer overwrite them.
 */
export function ClassifyHoldingsDialog({
    open,
    onOpenChange,
    investmentIds,
}: ClassifyHoldingsDialogProps) {
    const { t, tc, language } = useLanguage();
    const query = useExposureClassificationsQuery(open);
    const [drafts, setDrafts] = useState(new Map<InvestmentId, Draft>());
    const [selected, setSelected] = useState(new Set<InvestmentId>());
    const [search, setSearch] = useState("");
    const [bulkSector, setBulkSector] = useState("");
    const [bulkCountry, setBulkCountry] = useState("");

    const holdings = useMemo(() => {
        const all = query.data?.items ?? [];
        return investmentIds
            ? all.filter((item) => investmentIds.includes(item.investmentId))
            : all;
    }, [query.data?.items, investmentIds]);
    const single = investmentIds?.length === 1;
    const visible = useMemo(() => {
        const needle = search.trim().toLocaleLowerCase(language);
        if (!needle) return holdings;
        return holdings.filter((item) =>
            [item.name, item.symbol ?? "", draftOf(item).sector]
                .join(" ")
                .toLocaleLowerCase(language)
                .includes(needle),
        );
    }, [holdings, search, language]);

    const changes = useMemo(
        () => classificationChanges(holdings, drafts),
        [holdings, drafts],
    );
    const changeCount = changes.set.length + changes.clear.length;
    useUnsavedChanges(open && changeCount > 0);

    useEffect(() => {
        if (!open) {
            setDrafts(new Map());
            setSelected(new Set());
            setSearch("");
            setBulkSector("");
            setBulkCountry("");
        }
    }, [open]);

    const sectorSuggestions = useMemo(
        () =>
            [
                ...new Set([
                    ...(query.data?.sectors ?? []),
                    ...STANDARD_SECTORS,
                ]),
            ].sort((a, b) => a.localeCompare(b, language)),
        [query.data?.sectors, language],
    );

    const draftFor = (holding: ClassifiableHolding) =>
        drafts.get(holding.investmentId) ?? draftOf(holding);
    const updateDraft = (holding: ClassifiableHolding, patch: Partial<Draft>) =>
        setDrafts((current) => {
            const next = new Map(current);
            next.set(holding.investmentId, {
                ...(current.get(holding.investmentId) ?? draftOf(holding)),
                ...patch,
            });
            return next;
        });
    const applyToSelected = () =>
        setDrafts((current) => {
            const next = new Map(current);
            for (const holding of holdings) {
                if (!selected.has(holding.investmentId)) continue;
                const draft =
                    next.get(holding.investmentId) ?? draftOf(holding);
                next.set(holding.investmentId, {
                    ...draft,
                    ...(bulkSector.trim() ? { sector: bulkSector.trim() } : {}),
                    ...(bulkCountry ? { country: bulkCountry } : {}),
                });
            }
            return next;
        });

    const save = useSaveExposureClassifications(() => {
        toast.success(tc("portfolio.classify.saved", changeCount));
        onOpenChange(false);
    });

    const allVisibleSelected =
        visible.length > 0 &&
        visible.every((item) => selected.has(item.investmentId));
    const toggleAllVisible = (checked: boolean) =>
        setSelected((current) => {
            const next = new Set(current);
            for (const item of visible)
                if (checked) next.add(item.investmentId);
                else next.delete(item.investmentId);
            return next;
        });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-4xl">
                <DialogHeader>
                    <DialogTitle>
                        {single && holdings[0]
                            ? t("portfolio.classify.titleOne", {
                                  name: holdings[0].name,
                              })
                            : t("portfolio.classify.title")}
                    </DialogTitle>
                    <DialogDescription>
                        {t("portfolio.classify.description")}
                    </DialogDescription>
                </DialogHeader>

                {query.isLoading && (
                    <p
                        role="status"
                        className="type-footnote text-label-secondary"
                    >
                        {t("common.loading")}
                    </p>
                )}
                {query.isError && (
                    <Alert variant="destructive">
                        <AlertDescription>
                            {apiErrorToMessage(query.error, t)}
                        </AlertDescription>
                    </Alert>
                )}
                {save.isError && (
                    <Alert variant="destructive">
                        <AlertDescription>
                            {apiErrorToMessage(save.error, t)}
                        </AlertDescription>
                    </Alert>
                )}

                {query.data && !single && (
                    <div className="space-y-3">
                        <div className="relative">
                            <Search
                                aria-hidden="true"
                                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-label-tertiary"
                            />
                            <Input
                                type="search"
                                value={search}
                                onChange={(event) =>
                                    setSearch(event.target.value)
                                }
                                placeholder={t("portfolio.classify.search")}
                                aria-label={t("portfolio.classify.search")}
                                className="pl-9"
                            />
                        </div>
                        {selected.size > 0 && (
                            <div
                                role="group"
                                aria-label={t("portfolio.classify.bulkLabel")}
                                className="flex flex-wrap items-center gap-2 rounded-card corner-continuous bg-foreground/[0.04] p-3"
                            >
                                <span className="type-footnote font-medium tabular-nums">
                                    {tc(
                                        "portfolio.classify.selected",
                                        selected.size,
                                    )}
                                </span>
                                <Input
                                    value={bulkSector}
                                    onChange={(event) =>
                                        setBulkSector(event.target.value)
                                    }
                                    list="classify-sector-options"
                                    maxLength={128}
                                    placeholder={t("portfolio.exposure.sector")}
                                    aria-label={t(
                                        "portfolio.classify.bulkSector",
                                    )}
                                    className="h-9 w-48"
                                />
                                <div className="w-48">
                                    <CountryCombobox
                                        value={bulkCountry}
                                        onChange={setBulkCountry}
                                        aria-label={t(
                                            "portfolio.classify.bulkCountry",
                                        )}
                                    />
                                </div>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    disabled={
                                        !bulkSector.trim() && !bulkCountry
                                    }
                                    onClick={applyToSelected}
                                >
                                    {t("portfolio.classify.apply")}
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setSelected(new Set())}
                                >
                                    {t("portfolio.classify.deselect")}
                                </Button>
                            </div>
                        )}
                    </div>
                )}

                <datalist id="classify-sector-options">
                    {sectorSuggestions.map((sector) => (
                        <option key={sector} value={sector} />
                    ))}
                </datalist>

                {query.data && (
                    <div className="min-h-0 flex-1 overflow-y-auto rounded-card corner-continuous border border-border/60">
                        <table className="w-full border-collapse text-left">
                            <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
                                <tr className="type-caption text-label-secondary">
                                    {!single && (
                                        <th
                                            scope="col"
                                            className="w-10 px-3 py-2"
                                        >
                                            <Checkbox
                                                checked={allVisibleSelected}
                                                onCheckedChange={(checked) =>
                                                    toggleAllVisible(
                                                        checked === true,
                                                    )
                                                }
                                                aria-label={t(
                                                    "portfolio.classify.selectAll",
                                                )}
                                            />
                                        </th>
                                    )}
                                    <th
                                        scope="col"
                                        className="px-3 py-2 font-medium"
                                    >
                                        {t("portfolio.classify.holding")}
                                    </th>
                                    <th
                                        scope="col"
                                        className="px-3 py-2 font-medium"
                                    >
                                        {t("portfolio.exposure.sector")}
                                    </th>
                                    <th
                                        scope="col"
                                        className="px-3 py-2 font-medium"
                                    >
                                        {t("portfolio.exposure.issuerCountry")}
                                    </th>
                                    <th
                                        scope="col"
                                        className="px-3 py-2 font-medium"
                                    >
                                        {t("portfolio.exposure.issuer")}
                                    </th>
                                    <th scope="col" className="w-10 px-2 py-2">
                                        <span className="sr-only">
                                            {t("common.clear")}
                                        </span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border/60">
                                {visible.map((holding) => {
                                    const draft = draftFor(holding);
                                    const changed = !sameDraft(
                                        draft,
                                        draftOf(holding),
                                    );
                                    const label = holding.symbol
                                        ? `${holding.name} (${holding.symbol})`
                                        : holding.name;
                                    return (
                                        <tr
                                            key={holding.investmentId}
                                            className={
                                                changed
                                                    ? "bg-primary/[0.04]"
                                                    : undefined
                                            }
                                        >
                                            {!single && (
                                                <td className="px-3 py-2 align-middle">
                                                    <Checkbox
                                                        checked={selected.has(
                                                            holding.investmentId,
                                                        )}
                                                        onCheckedChange={(
                                                            checked,
                                                        ) =>
                                                            setSelected(
                                                                (current) => {
                                                                    const next =
                                                                        new Set(
                                                                            current,
                                                                        );
                                                                    if (
                                                                        checked ===
                                                                        true
                                                                    )
                                                                        next.add(
                                                                            holding.investmentId,
                                                                        );
                                                                    else
                                                                        next.delete(
                                                                            holding.investmentId,
                                                                        );
                                                                    return next;
                                                                },
                                                            )
                                                        }
                                                        aria-label={t(
                                                            "portfolio.classify.select",
                                                            { name: label },
                                                        )}
                                                    />
                                                </td>
                                            )}
                                            <th
                                                scope="row"
                                                className="min-w-[10rem] px-3 py-2 text-left align-middle font-normal"
                                            >
                                                <span className="block truncate type-subheadline">
                                                    {label}
                                                </span>
                                                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 type-caption text-label-secondary">
                                                    {t(
                                                        `portfolio.assetClass.${holding.assetClass}` as TranslationKey,
                                                    )}
                                                    {holding.classification && (
                                                        <Badge
                                                            size="sm"
                                                            variant="secondary"
                                                        >
                                                            {t(
                                                                holding
                                                                    .classification
                                                                    .origin ===
                                                                    "manual"
                                                                    ? "portfolio.classify.originManual"
                                                                    : "portfolio.classify.originImport",
                                                            )}
                                                        </Badge>
                                                    )}
                                                    {holding.hasFundDocument && (
                                                        <Badge
                                                            size="sm"
                                                            variant="outline"
                                                        >
                                                            {t(
                                                                "portfolio.classify.lookThrough",
                                                            )}
                                                        </Badge>
                                                    )}
                                                </span>
                                            </th>
                                            <td className="px-3 py-2 align-middle">
                                                <Input
                                                    value={draft.sector}
                                                    onChange={(event) =>
                                                        updateDraft(holding, {
                                                            sector: event.target
                                                                .value,
                                                        })
                                                    }
                                                    list="classify-sector-options"
                                                    maxLength={128}
                                                    placeholder={t(
                                                        "portfolio.classify.sectorPlaceholder",
                                                    )}
                                                    aria-label={t(
                                                        "portfolio.classify.sectorFor",
                                                        { name: label },
                                                    )}
                                                    className="h-9 min-w-[10rem]"
                                                />
                                            </td>
                                            <td className="px-3 py-2 align-middle">
                                                <CountryCombobox
                                                    value={draft.country}
                                                    onChange={(country) =>
                                                        updateDraft(holding, {
                                                            country,
                                                        })
                                                    }
                                                    aria-label={t(
                                                        "portfolio.classify.countryFor",
                                                        { name: label },
                                                    )}
                                                    className="min-w-[9rem]"
                                                />
                                            </td>
                                            <td className="px-3 py-2 align-middle">
                                                <Input
                                                    value={draft.issuerName}
                                                    onChange={(event) =>
                                                        updateDraft(holding, {
                                                            issuerName:
                                                                event.target
                                                                    .value,
                                                        })
                                                    }
                                                    maxLength={256}
                                                    placeholder={holding.name}
                                                    aria-label={t(
                                                        "portfolio.classify.issuerFor",
                                                        { name: label },
                                                    )}
                                                    className="h-9 min-w-[9rem]"
                                                />
                                            </td>
                                            <td className="px-2 py-2 align-middle">
                                                {!isEmptyDraft(draft) && (
                                                    <Button
                                                        type="button"
                                                        size="icon"
                                                        variant="ghost"
                                                        className="h-8 w-8"
                                                        onClick={() =>
                                                            updateDraft(
                                                                holding,
                                                                {
                                                                    issuerName:
                                                                        "",
                                                                    sector: "",
                                                                    country: "",
                                                                },
                                                            )
                                                        }
                                                        aria-label={t(
                                                            "portfolio.classify.clearFor",
                                                            { name: label },
                                                        )}
                                                    >
                                                        <X
                                                            aria-hidden="true"
                                                            className="h-4 w-4"
                                                        />
                                                    </Button>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                                {visible.length === 0 && (
                                    <tr>
                                        <td
                                            colSpan={single ? 5 : 6}
                                            className="p-4 type-footnote text-label-secondary"
                                        >
                                            {t("portfolio.classify.empty")}
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                )}

                <p className="type-caption text-label-secondary">
                    {t("portfolio.classify.manualWins")}
                </p>

                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {t("common.cancel")}
                    </Button>
                    <Button
                        type="button"
                        disabled={changeCount === 0 || save.isPending}
                        onClick={() => save.mutate(changes)}
                    >
                        {save.isPending && (
                            <Loader2
                                aria-hidden="true"
                                className="animate-spin"
                            />
                        )}
                        {t("common.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
