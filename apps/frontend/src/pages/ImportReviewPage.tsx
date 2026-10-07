import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { ImportStagingRow, ImportPreviewGroup } from "@/lib/api";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAccounts } from "@/hooks/useAccounts";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import {
    useImportPreview,
    useImportReviewMutations,
} from "@/features/imports/useImportReviewData";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { List } from "@/components/ui/list";
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from "@/components/ui/accordion";
import {
    DeferredRecipientCombobox,
    useRecipientComboboxLabel,
} from "@/components/shared/RecipientCombobox";
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { Money } from "@/components/shared/Money";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { formatPercent } from "@/utils/currency";
import { numberFormatToLocale } from "@/utils/currency";
import { cn } from "@/lib/utils";
import { PageShell } from "@/components/shared/PageShell";

type MatchSource = "exact" | "fuzzy" | "pattern" | "new" | null;

/** The badge legend, in the order the summary lists them. */
const MATCH_KINDS = ["exact", "fuzzy", "pattern", "new", "unresolved"] as const;
type MatchKind = (typeof MATCH_KINDS)[number];

interface GroupState {
    recipientId: number | null;
    recipientName: string | null;
    categoryId: number | null;
    categoryLabel: string | null;
    persistAsDefault: boolean;
    recipientSaving: boolean;
    categorySaving: boolean;
}

function matchKindOf(source: MatchSource): MatchKind {
    return source ?? "unresolved";
}

function MatchBadge({
    kind,
    similarity,
    locale,
}: {
    kind: MatchKind;
    similarity?: number | null;
    locale: string;
}) {
    const { t } = useLanguage();
    const label = t(`importReview.match.${kind}`);
    switch (kind) {
        case "exact":
            return <Badge variant="secondary">{label}</Badge>;
        case "fuzzy":
            return (
                <Badge variant="warning">
                    {label}
                    {similarity != null
                        ? ` ${formatPercent(similarity * 100, { digits: 0, locale })}`
                        : ""}
                </Badge>
            );
        case "pattern":
            return (
                <Badge variant="outline" className="border-info/50 text-info">
                    {label}
                </Badge>
            );
        case "new":
            return <Badge variant="success">{label}</Badge>;
        default:
            return <Badge variant="destructive">{label}</Badge>;
    }
}

function dominantMatchSource(rows: ImportStagingRow[]): MatchSource {
    for (const src of ["new", "fuzzy", "pattern", "exact"] as MatchSource[]) {
        if (rows.some((r) => r.match_source === src)) return src;
    }
    return null;
}

/**
 * Account identity is case/whitespace-insensitive (D1: `lower(btrim(name))`).
 * Mirror that normalization when cross-referencing staged bank_account labels
 * against the existing accounts list.
 */
function normalizeAccountName(name: string): string {
    return name.trim().toLowerCase();
}

interface AccountDisclosureEntry {
    /** Normalized key ("" = rows without an account label). */
    key: string;
    /** Display label as it appeared in the CSV (first spelling seen). */
    label: string;
    count: number;
    /** No existing account matches this label — commit will create one. */
    isNew: boolean;
    /** Rows carried no bank_account label at all. */
    isUnspecified: boolean;
}

export default function ImportReviewPage() {
    const { batchId: batchIdParam } = useParams<{ batchId: string }>();
    const batchId = Number(batchIdParam);
    const navigate = useNavigate();
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings?.numberFormat ?? "us");
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const [groupOverrides, setGroupOverrides] = useState<
        Map<string, GroupState>
    >(new Map());

    // One recipients subscription for the whole page. Every group's combobox is
    // deferred (query + list mount with its popover), so this single observer —
    // reading the exact page a closed combobox reads — paints all of their
    // labels and warms the cache their popovers open against. A year of bank CSV
    // is 100-300 groups; before this it was that many observers, debounce timers
    // and per-render page scans.
    const recipientLabelFor = useRecipientComboboxLabel();

    const {
        data: preview,
        isLoading,
        error,
        refetch,
    } = useImportPreview(batchId);

    // WP-B6 import disclosure — which accounts will this batch write to, and
    // will any of them be created on commit? Read-only: computed purely from the
    // staged rows' bank_account labels cross-referenced against the accounts
    // list under the D1 identity (lower/trim). No override picker.
    const { data: accountsData } = useAccounts({ active: "all" });

    const accountDisclosure = useMemo<AccountDisclosureEntry[]>(() => {
        if (!preview) return [];
        const buckets = new Map<string, { label: string; count: number }>();
        for (const row of preview.groups.flatMap((g) => g.rows)) {
            const label = (row.bank_account ?? "").trim();
            const key = normalizeAccountName(label);
            const bucket = buckets.get(key);
            if (bucket) bucket.count += 1;
            else buckets.set(key, { label, count: 1 });
        }
        const existing = new Set(
            (accountsData?.items ?? []).map((a) =>
                normalizeAccountName(a.name),
            ),
        );
        return [...buckets.entries()]
            .map(([key, { label, count }]) => ({
                key,
                label,
                count,
                isUnspecified: key === "",
                // Only flag "new" once the accounts list has loaded — an empty Set
                // while loading would badge every account as new for a frame.
                isNew: key !== "" && accountsData != null && !existing.has(key),
            }))
            .sort(
                (a, b) => b.count - a.count || a.label.localeCompare(b.label),
            );
    }, [preview, accountsData]);

    // The imported rows' date span: the receipt on the Import page links to it.
    const dateRange = useMemo(() => {
        const dates = (preview?.groups ?? [])
            .flatMap((g) => g.rows)
            .map((r) => r.tx_date)
            .filter((d): d is string => typeof d === "string" && d.length > 0)
            .map((d) => d.slice(0, 10))
            .sort();
        return dates.length > 0
            ? { dateFrom: dates[0], dateTo: dates[dates.length - 1] }
            : {};
    }, [preview]);

    const newAccountCount = accountDisclosure.filter((e) => e.isNew).length;
    const {
        overrideRows,
        overrideCategories,
        persistDefaultCategory,
        commit,
        isCommitting,
        discard,
        isDiscarding,
    } = useImportReviewMutations(batchId, newAccountCount);

    const groupStateFor = (
        group: ImportPreviewGroup,
        key: string,
    ): GroupState => {
        const existing = groupOverrides.get(key);
        if (existing) return existing;
        return {
            recipientId: group.recipient_id,
            recipientName: group.recipient_name,
            categoryId: group.current_category_id,
            categoryLabel: group.current_category_label,
            // Default the persist checkbox ON when the recipient has no current
            // default — most common case where the user wants to set one.
            persistAsDefault: group.recipient_default_category_id == null,
            recipientSaving: false,
            categorySaving: false,
        };
    };

    const updateGroupState = (
        groupKey: string,
        patch: Partial<GroupState>,
        fallback: GroupState,
    ) => {
        setGroupOverrides((prev) => {
            const next = new Map(prev);
            const current = next.get(groupKey) ?? fallback;
            next.set(groupKey, { ...current, ...patch });
            return next;
        });
    };

    const handleGroupOverride = async (
        groupKey: string,
        fallback: GroupState,
        rows: ImportStagingRow[],
        recipientId: number | null,
        recipientName: string | null,
    ) => {
        updateGroupState(
            groupKey,
            { recipientId, recipientName, recipientSaving: true },
            fallback,
        );

        try {
            await overrideRows(
                rows.map((row) => row.id),
                recipientId,
            );
            updateGroupState(groupKey, { recipientSaving: false }, fallback);
        } catch (err) {
            toast.error(t("importReview.toast.overrideFailed"), {
                description: apiErrorToMessage(err, t),
            });
            setGroupOverrides((prev) => {
                const next = new Map(prev);
                next.delete(groupKey);
                return next;
            });
        }
    };

    const handleCategoryOverride = async (
        groupKey: string,
        fallback: GroupState,
        rows: ImportStagingRow[],
        categoryId: number | null,
        categoryLabel: string | null,
    ) => {
        updateGroupState(
            groupKey,
            { categoryId, categoryLabel, categorySaving: true },
            fallback,
        );

        try {
            await overrideCategories(
                rows.map((row) => row.id),
                categoryId,
            );
            updateGroupState(groupKey, { categorySaving: false }, fallback);

            const state = groupOverrides.get(groupKey) ?? fallback;
            const persist =
                groupOverrides.get(groupKey)?.persistAsDefault ??
                fallback.persistAsDefault;
            const targetRecipientId =
                groupOverrides.get(groupKey)?.recipientId ?? state.recipientId;

            if (persist && targetRecipientId != null && categoryId != null) {
                try {
                    await persistDefaultCategory(targetRecipientId, categoryId);
                } catch (persistErr) {
                    toast.error(t("importReview.toast.persistDefaultFailed"), {
                        description: apiErrorToMessage(persistErr, t),
                    });
                }
            }
        } catch (err) {
            toast.error(t("importReview.toast.categoryOverrideFailed"), {
                description: apiErrorToMessage(err, t),
            });
            updateGroupState(groupKey, { categorySaving: false }, fallback);
        }
    };

    const handlePersistDefaultToggle = (
        groupKey: string,
        fallback: GroupState,
        next: boolean,
    ) => {
        updateGroupState(groupKey, { persistAsDefault: next }, fallback);
    };

    const totalRows =
        preview?.groups.reduce((sum, g) => sum + g.row_count, 0) ?? 0;

    const handleDiscard = async () => {
        const ok = await confirm({
            title: t("importReview.discard.title"),
            description: t("importReview.discard.desc", { n: totalRows }),
            confirmLabel: t("importReview.discard.confirm"),
            variant: "destructive",
        });
        if (!ok) return;
        discard();
    };

    if (isLoading) {
        return <SectionLoader />;
    }

    const backButton = (
        <Button variant="ghost" size="sm" onClick={() => navigate("/import")}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {t("importReview.back")}
        </Button>
    );

    if (error || !preview) {
        return (
            <PageShell className="max-w-3xl mx-auto">
                <div>{backButton}</div>
                <PageError
                    message={apiErrorToMessage(error, t)}
                    onRetry={error ? () => void refetch() : undefined}
                />
            </PageShell>
        );
    }

    const busy = isCommitting || isDiscarding;

    return (
        <PageShell className="max-w-3xl mx-auto">
            <div>{backButton}</div>

            <PageHeader
                title={t("importReview.title")}
                subtitle={t("importReview.subtitle", { n: totalRows })}
            />

            {/* Legend: what each badge means, with this file's counts. */}
            <Card>
                <CardHeader>
                    <CardTitle variant="sm">
                        {t("importReview.legend.title")}
                    </CardTitle>
                </CardHeader>
                <CardContent variant="flush">
                    <List
                        aria-label={t("importReview.legend.title")}
                        className="rounded-none border-0 border-t border-border/50 bg-transparent"
                    >
                        {MATCH_KINDS.map((kind) => (
                            <li
                                key={kind}
                                className="flex min-h-11 items-center gap-3 px-6 py-2.5"
                            >
                                <span className="w-40 shrink-0">
                                    <MatchBadge kind={kind} locale={locale} />
                                </span>
                                <span className="min-w-0 flex-1 type-body text-label-secondary">
                                    {t(`importReview.legend.${kind}`)}
                                </span>
                                <span className="shrink-0 type-body tabular-nums text-foreground">
                                    {preview.totals[kind]}
                                </span>
                            </li>
                        ))}
                    </List>
                </CardContent>
            </Card>

            {/* WP-B6 — per-account disclosure: where will this batch land? Read-only. */}
            {accountDisclosure.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle variant="sm">
                            {t("importReview.accounts.title")}
                        </CardTitle>
                        <CardDescription>
                            {t("importReview.accounts.desc")}
                        </CardDescription>
                    </CardHeader>
                    <CardContent variant="flush">
                        <List className="rounded-none border-0 border-t border-border/50 bg-transparent">
                            {accountDisclosure.map((entry) => (
                                <li
                                    key={entry.key || "__unspecified__"}
                                    className="flex min-h-11 flex-wrap items-center gap-2 px-6 py-2.5 type-body text-label-secondary"
                                >
                                    <span>
                                        {t("importReview.accounts.line", {
                                            n: entry.count,
                                        })}
                                    </span>
                                    <span
                                        className={cn(
                                            entry.isUnspecified
                                                ? "italic"
                                                : "font-medium text-foreground",
                                        )}
                                    >
                                        {entry.isUnspecified
                                            ? t(
                                                  "importReview.accounts.unspecified",
                                              )
                                            : entry.label}
                                    </span>
                                    {entry.isNew && (
                                        <Badge variant="success">
                                            {t("importReview.accounts.newBadge")}
                                        </Badge>
                                    )}
                                </li>
                            ))}
                        </List>
                    </CardContent>
                </Card>
            )}

            {/* Payee groups */}
            <Card>
                <CardHeader>
                    <CardTitle variant="sm">
                        {t("importReview.groups.title")}
                    </CardTitle>
                    <CardDescription>
                        {t("importReview.groups.desc")}
                    </CardDescription>
                </CardHeader>
                <CardContent variant="flush">
                    <Accordion
                        type="multiple"
                        className="divide-y divide-border/50 border-t border-border/50"
                    >
                        {preview.groups.map((group) => {
                            const groupKey =
                                group.recipient_id != null
                                    ? String(group.recipient_id)
                                    : `__unresolved__:${group.recipient_name ?? ""}:${group.rows[0]?.memo ?? ""}`;
                            const fallbackState = groupStateFor(
                                group,
                                groupKey,
                            );
                            const state =
                                groupOverrides.get(groupKey) ?? fallbackState;
                            const effectiveName =
                                state.recipientName ?? group.recipient_name;
                            const effectiveRecipientId = state.recipientId;
                            const effectiveCategoryId = state.categoryId;
                            const dominant = dominantMatchSource(group.rows);
                            const isNew =
                                group.recipient_id == null ||
                                dominant === "new";
                            const persistCheckboxId = `persist-default-${groupKey}`;
                            const groupHeading =
                                isNew && !effectiveName
                                    ? t("importReview.newRecipient")
                                    : (effectiveName ??
                                      t("importReview.unresolved"));

                            return (
                                <AccordionItem
                                    key={groupKey}
                                    value={groupKey}
                                    className="border-b-0"
                                >
                                    {/* The recipient picker is a real <button>, so it rides in
                                        `trailing` — a sibling of the accordion trigger — instead of
                                        nested inside it (invalid HTML, and unreachable for AT). */}
                                    <AccordionTrigger
                                        headerClassName="px-6"
                                        className="hover:no-underline"
                                        trailing={
                                            <div className="flex shrink-0 items-center gap-2">
                                                {(state.recipientSaving ||
                                                    state.categorySaving) && (
                                                    <Loader2
                                                        className="h-3.5 w-3.5 animate-spin text-label-secondary"
                                                        aria-hidden
                                                    />
                                                )}
                                                <DeferredRecipientCombobox
                                                    value={effectiveRecipientId}
                                                    label={recipientLabelFor(
                                                        effectiveRecipientId,
                                                    )}
                                                    aria-label={t(
                                                        "importReview.recipientPickerLabel",
                                                        { name: groupHeading },
                                                    )}
                                                    onSelect={(id, name) =>
                                                        handleGroupOverride(
                                                            groupKey,
                                                            fallbackState,
                                                            group.rows,
                                                            id,
                                                            name,
                                                        )
                                                    }
                                                    className="h-8 max-w-[200px] type-footnote"
                                                    disabled={
                                                        state.recipientSaving
                                                    }
                                                />
                                            </div>
                                        }
                                    >
                                        <div className="flex min-w-0 flex-1 items-center gap-3">
                                            <MatchBadge
                                                kind={matchKindOf(dominant)}
                                                locale={locale}
                                            />
                                            <span className="truncate type-body font-medium text-foreground">
                                                {groupHeading}
                                            </span>
                                            <span className="shrink-0 type-footnote text-label-secondary">
                                                {t("importReview.rowCount", {
                                                    n: group.row_count,
                                                })}
                                            </span>
                                        </div>
                                    </AccordionTrigger>
                                    <AccordionContent className="px-6 pb-4">
                                        {group.matched_pattern_text && (
                                            <p className="mb-3 truncate type-footnote text-label-secondary">
                                                {t("importReview.pattern")}:{" "}
                                                <span className="font-mono">
                                                    {group.matched_pattern_text}
                                                </span>
                                            </p>
                                        )}

                                        {/* Category controls — apply to all rows in the group. */}
                                        <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-border/50 pb-3">
                                            <span className="shrink-0 type-footnote text-label-secondary">
                                                {t("importReview.category")}
                                            </span>
                                            <CategoryCombobox
                                                value={effectiveCategoryId}
                                                onSelect={(id, label) =>
                                                    handleCategoryOverride(
                                                        groupKey,
                                                        fallbackState,
                                                        group.rows,
                                                        id,
                                                        label,
                                                    )
                                                }
                                                className="h-8 max-w-[260px] type-footnote"
                                                disabled={
                                                    state.categorySaving ||
                                                    effectiveRecipientId == null
                                                }
                                            />
                                            {effectiveRecipientId != null && (
                                                <label
                                                    htmlFor={persistCheckboxId}
                                                    className="flex cursor-pointer select-none items-center gap-2 type-footnote text-label-secondary"
                                                >
                                                    <Checkbox
                                                        id={persistCheckboxId}
                                                        checked={
                                                            state.persistAsDefault
                                                        }
                                                        onCheckedChange={(
                                                            checked,
                                                        ) =>
                                                            handlePersistDefaultToggle(
                                                                groupKey,
                                                                fallbackState,
                                                                checked ===
                                                                    true,
                                                            )
                                                        }
                                                        disabled={
                                                            state.categorySaving
                                                        }
                                                    />
                                                    {t(
                                                        "importReview.persistDefault",
                                                    )}
                                                </label>
                                            )}
                                        </div>

                                        <ul className="m-0 list-none divide-y divide-border/40 p-0">
                                            {group.rows.map((row) => (
                                                <li
                                                    key={row.id}
                                                    className="flex items-center gap-3 py-2 type-footnote"
                                                >
                                                    <div className="shrink-0">
                                                        <MatchBadge
                                                            kind={matchKindOf(
                                                                row.match_source,
                                                            )}
                                                            similarity={
                                                                row.match_similarity
                                                            }
                                                            locale={locale}
                                                        />
                                                    </div>
                                                    <span className="shrink-0 tabular-nums text-label-secondary">
                                                        {formatDateStringWithAppSettings(
                                                            row.tx_date,
                                                            appSettings?.dateFormat ??
                                                                "YYYY-MM-DD",
                                                        )}
                                                    </span>
                                                    <span className="min-w-0 truncate text-foreground">
                                                        {row.recipient_raw}
                                                    </span>
                                                    {row.memo && (
                                                        <span className="hidden min-w-0 truncate text-label-tertiary sm:block">
                                                            {row.memo}
                                                        </span>
                                                    )}
                                                    <span
                                                        className={cn(
                                                            "ml-auto shrink-0 font-medium tabular-nums",
                                                            Number(row.amount) <
                                                                0
                                                                ? "text-foreground"
                                                                : "text-gain",
                                                        )}
                                                    >
                                                        <Money
                                                            amount={Number(
                                                                row.amount,
                                                            )}
                                                            currency={
                                                                row.currency ??
                                                                "EUR"
                                                            }
                                                            signed
                                                        />
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    </AccordionContent>
                                </AccordionItem>
                            );
                        })}
                    </Accordion>
                </CardContent>
            </Card>

            {/* Decide: discard the batch, or import it. */}
            <div className="flex flex-col gap-3 pb-8 sm:flex-row sm:items-center">
                <p className="min-w-0 flex-1 type-footnote text-label-secondary">
                    {t("importReview.readyHint")}
                </p>
                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        onClick={() => void handleDiscard()}
                        disabled={busy}
                    >
                        {isDiscarding
                            ? t("importReview.discarding")
                            : t("importReview.discard")}
                    </Button>
                    <Button
                        onClick={() => commit(dateRange)}
                        disabled={busy}
                    >
                        {isCommitting ? (
                            <>
                                <Loader2
                                    className="h-4 w-4 animate-spin"
                                    aria-hidden
                                />
                                {t("importReview.committing")}
                            </>
                        ) : (
                            t("importReview.approve", { n: totalRows })
                        )}
                    </Button>
                </div>
            </div>
            <ConfirmDialog />
        </PageShell>
    );
}
