import { useState, memo, useMemo } from "react";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    useSettings,
    type ExclusionScope,
} from "@/stores/hydration/SettingsHydration";
import { apiClient } from "@/lib/api";
import { settingKeys } from "@/lib/queryKeys";
import { useCategoryTree } from "@/hooks/useCategories";
import {
    SettingsSection,
    SettingsGroup,
    SettingRow,
    SelectSettingRow,
} from "../SettingsPrimitives";
import {
    useSetting,
    useStatisticsRecipientOptions,
} from "../useSettingsQueries";

interface CategoryOption {
    id: number;
    name: string;
    path: string[];
    is_active: boolean;
}

interface RecipientOption {
    id: number;
    name: string;
    is_active: boolean;
}

const checkRowClass =
    "flex items-center gap-3 rounded-control px-3 py-2 transition-[background-color] duration-fast ease-glide hover:bg-foreground/[0.04]";

const emptyClass = "py-4 text-center type-callout text-label-secondary";

export const StatisticsSection = memo(function StatisticsSection() {
    const { t, tc } = useLanguage();
    const { settings, updateSettings } = useSettings();
    const queryClient = useQueryClient();
    const [categorySearch, setCategorySearch] = useState("");
    const [recipientSearch, setRecipientSearch] = useState("");

    const { data: categoriesData, isLoading: categoriesLoading } =
        useCategoryTree();
    const { data: recipientsData, isLoading: recipientsLoading } =
        useStatisticsRecipientOptions();
    const { data: includeTransfersSetting } = useSetting("includeTransfers");

    const categories = useMemo<CategoryOption[]>(
        () => categoriesData?.items ?? [],
        [categoriesData],
    );
    const recipients = useMemo<RecipientOption[]>(
        () => recipientsData?.items ?? [],
        [recipientsData],
    );
    const isLoading = categoriesLoading || recipientsLoading;

    const excludedCategories = settings.excludedCategoryIds;
    const excludedRecipients = settings.excludedRecipientIds;
    const includeTransfers = includeTransfersSetting?.value === true;

    const toggleCategory = (id: number) => {
        const next = excludedCategories.includes(id)
            ? excludedCategories.filter((c) => c !== id)
            : [...excludedCategories, id];
        updateSettings({ excludedCategoryIds: next });
    };

    const toggleRecipient = (id: number) => {
        const next = excludedRecipients.includes(id)
            ? excludedRecipients.filter((r) => r !== id)
            : [...excludedRecipients, id];
        updateSettings({ excludedRecipientIds: next });
    };

    // includeTransfers is a server-only aggregation setting with no client
    // reader — persist it directly, then refetch cash-flow/aggregation data.
    const handleIncludeTransfersChange = (v: boolean) => {
        queryClient.setQueryData(settingKeys.byKey("includeTransfers"), {
            key: "includeTransfers",
            value: v,
        });
        apiClient
            .saveSetting("includeTransfers", v)
            // includeTransfers only affects server-side aggregation / cash-flow
            // outputs, so scope the refetch to those families instead of blanket-
            // invalidating every cached query (portfolio, research quotes, etc.).
            .then(() =>
                queryClient.invalidateQueries({
                    predicate: (query) => {
                        const root = query.queryKey[0];
                        if (typeof root !== "string") return false;
                        return (
                            root === "aggregations" ||
                            root === "monthlySummary" ||
                            root === "filteredDashboardStats" ||
                            root === "dashboardRecentTransactions" ||
                            root.toLowerCase().startsWith("cashflow")
                        );
                    },
                }),
            )
            .catch(() => {
                /* non-fatal */
            });
    };

    // Categories grouped by their top-level ancestor, filtered by the search.
    const categoryGroups = useMemo(() => {
        const searchLower = categorySearch.toLowerCase();
        const grouped = new Map<string, CategoryOption[]>();
        for (const cat of categories) {
            const matchesSearch =
                !categorySearch ||
                cat.path.some((segment) =>
                    segment.toLowerCase().includes(searchLower),
                );
            if (!matchesSearch) continue;
            const key = cat.path[0] ?? cat.name;
            const group = grouped.get(key) ?? [];
            group.push(cat);
            grouped.set(key, group);
        }
        return Array.from(grouped.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([general, items]) => ({
                general,
                items: [...items].sort((a, b) =>
                    a.path.join(" / ").localeCompare(b.path.join(" / ")),
                ),
            }));
    }, [categories, categorySearch]);

    const toggleCategoryGroup = (items: CategoryOption[]) => {
        const allExcluded = items.every((c) =>
            excludedCategories.includes(c.id),
        );
        if (allExcluded) {
            updateSettings({
                excludedCategoryIds: excludedCategories.filter(
                    (id) => !items.some((c) => c.id === id),
                ),
            });
        } else {
            const newIds = items
                .map((c) => c.id)
                .filter((id) => !excludedCategories.includes(id));
            updateSettings({
                excludedCategoryIds: [...excludedCategories, ...newIds],
            });
        }
    };

    // Excluded payees first, then alphabetical.
    const visibleRecipients = useMemo(() => {
        const filtered = recipients.filter((r) =>
            r.name.toLowerCase().includes(recipientSearch.toLowerCase()),
        );
        return [...filtered].sort((a, b) => {
            const aExcl = excludedRecipients.includes(a.id) ? 0 : 1;
            const bExcl = excludedRecipients.includes(b.id) ? 0 : 1;
            if (aExcl !== bExcl) return aExcl - bExcl;
            return a.name.localeCompare(b.name);
        });
    }, [recipients, recipientSearch, excludedRecipients]);

    const hiddenBadge = (
        <Badge variant="outline" size="sm" className="ml-2">
            {t("settings.dashboard.hidden")}
        </Badge>
    );

    return (
        <SettingsSection title={t("settings.section.statistics")}>
            <SettingsGroup label={t("settings.dashboard.exclusionScope")}>
                <SelectSettingRow
                    title={t("settings.dashboard.exclusionScope")}
                    description={t("settings.dashboard.exclusionScopeHint")}
                    value={settings.exclusionScope}
                    onValueChange={(v) =>
                        updateSettings({ exclusionScope: v as ExclusionScope })
                    }
                    triggerAriaLabel={t("settings.dashboard.exclusionScope")}
                    options={[
                        {
                            value: "everywhere",
                            label: t("settings.dashboard.scope.everywhere"),
                        },
                        {
                            value: "dashboard",
                            label: t("settings.dashboard.scope.dashboard"),
                        },
                        {
                            value: "statistics",
                            label: t("settings.dashboard.scope.statistics"),
                        },
                    ]}
                />

                <SettingRow
                    title={t("settings.dashboard.excludeHidden")}
                    description={t("settings.dashboard.excludeHiddenHint")}
                    htmlFor="exclude-hidden"
                >
                    <Switch
                        id="exclude-hidden"
                        checked={settings.excludeHiddenCategories}
                        onCheckedChange={(v) =>
                            updateSettings({ excludeHiddenCategories: v })
                        }
                    />
                </SettingRow>

                <SettingRow
                    title={t("transfers.includeTransfers")}
                    description={t("transfers.includeTransfersHint")}
                    htmlFor="include-transfers"
                >
                    <Switch
                        id="include-transfers"
                        checked={includeTransfers}
                        onCheckedChange={handleIncludeTransfersChange}
                    />
                </SettingRow>
            </SettingsGroup>

            {isLoading ? (
                <SectionLoader />
            ) : (
                <>
                    <SettingsGroup
                        label={t("settings.dashboard.excludedCategories")}
                        description={t(
                            "settings.dashboard.excludedCategoriesHint",
                        )}
                        aside={
                            <Badge variant="secondary" size="sm">
                                {tc(
                                    "settings.dashboard.excludedCount",
                                    excludedCategories.length,
                                )}
                            </Badge>
                        }
                    >
                        <SettingRow
                            title={t("settings.dashboard.searchCategories")}
                            htmlFor="exclude-category-search"
                            layout="stack"
                            titleHidden
                        >
                            <Input
                                id="exclude-category-search"
                                placeholder={t(
                                    "settings.dashboard.searchCategories",
                                )}
                                value={categorySearch}
                                onChange={(e) =>
                                    setCategorySearch(e.target.value)
                                }
                            />
                            <ScrollArea className="mt-3 h-[230px]">
                                <div className="space-y-1 pr-3">
                                    {categories.length === 0 ? (
                                        <p className={emptyClass}>
                                            {t(
                                                "settings.dashboard.noCategories",
                                            )}
                                        </p>
                                    ) : categoryGroups.length === 0 ? (
                                        <p className={emptyClass}>
                                            {t(
                                                "settings.dashboard.noMatchingCategories",
                                            )}
                                        </p>
                                    ) : (
                                        categoryGroups.map(
                                            ({ general, items }) => {
                                                const allExcluded =
                                                    items.every((c) =>
                                                        excludedCategories.includes(
                                                            c.id,
                                                        ),
                                                    );
                                                const someExcluded =
                                                    items.some((c) =>
                                                        excludedCategories.includes(
                                                            c.id,
                                                        ),
                                                    );
                                                return (
                                                    <div
                                                        key={general}
                                                        className="space-y-0.5"
                                                    >
                                                        <Label
                                                            htmlFor={`category-group-${items[0].id}`}
                                                            className={`${checkRowClass} cursor-pointer bg-foreground/[0.04]`}
                                                        >
                                                            <Checkbox
                                                                id={`category-group-${items[0].id}`}
                                                                aria-label={
                                                                    general
                                                                }
                                                                checked={
                                                                    allExcluded
                                                                        ? true
                                                                        : someExcluded
                                                                          ? "indeterminate"
                                                                          : false
                                                                }
                                                                onCheckedChange={() =>
                                                                    toggleCategoryGroup(
                                                                        items,
                                                                    )
                                                                }
                                                            />
                                                            <span className="flex-1 type-headline text-foreground">
                                                                {general}
                                                            </span>
                                                            <span className="type-footnote tabular-nums text-label-tertiary">
                                                                {items.length}
                                                            </span>
                                                        </Label>
                                                        {items.map(
                                                            (category) => (
                                                                <div
                                                                    key={
                                                                        category.id
                                                                    }
                                                                    className={`${checkRowClass} ml-6`}
                                                                >
                                                                    <Checkbox
                                                                        id={`category-${category.id}`}
                                                                        checked={excludedCategories.includes(
                                                                            category.id,
                                                                        )}
                                                                        onCheckedChange={() =>
                                                                            toggleCategory(
                                                                                category.id,
                                                                            )
                                                                        }
                                                                    />
                                                                    <Label
                                                                        htmlFor={`category-${category.id}`}
                                                                        className="flex flex-1 cursor-pointer items-center justify-between font-normal"
                                                                    >
                                                                        <span>
                                                                            {category.path.join(
                                                                                " / ",
                                                                            )}
                                                                        </span>
                                                                        {!category.is_active &&
                                                                            hiddenBadge}
                                                                    </Label>
                                                                </div>
                                                            ),
                                                        )}
                                                    </div>
                                                );
                                            },
                                        )
                                    )}
                                </div>
                            </ScrollArea>
                        </SettingRow>
                    </SettingsGroup>

                    <SettingsGroup
                        label={t("settings.dashboard.excludedRecipients")}
                        description={t(
                            "settings.dashboard.excludedRecipientsHint",
                        )}
                        aside={
                            <Badge variant="secondary" size="sm">
                                {tc(
                                    "settings.dashboard.excludedCount",
                                    excludedRecipients.length,
                                )}
                            </Badge>
                        }
                    >
                        <SettingRow
                            title={t("settings.dashboard.searchRecipients")}
                            htmlFor="exclude-recipient-search"
                            layout="stack"
                            titleHidden
                        >
                            <Input
                                id="exclude-recipient-search"
                                placeholder={t(
                                    "settings.dashboard.searchRecipients",
                                )}
                                value={recipientSearch}
                                onChange={(e) =>
                                    setRecipientSearch(e.target.value)
                                }
                            />
                            <ScrollArea className="mt-3 h-[200px]">
                                <div className="space-y-1 pr-3">
                                    {visibleRecipients.length === 0 ? (
                                        <p className={emptyClass}>
                                            {recipientSearch
                                                ? t(
                                                      "settings.dashboard.noMatchingRecipients",
                                                  )
                                                : t(
                                                      "settings.dashboard.noRecipients",
                                                  )}
                                        </p>
                                    ) : (
                                        visibleRecipients.map((recipient) => (
                                            <div
                                                key={recipient.id}
                                                className={checkRowClass}
                                            >
                                                <Checkbox
                                                    id={`recipient-${recipient.id}`}
                                                    checked={excludedRecipients.includes(
                                                        recipient.id,
                                                    )}
                                                    onCheckedChange={() =>
                                                        toggleRecipient(
                                                            recipient.id,
                                                        )
                                                    }
                                                />
                                                <Label
                                                    htmlFor={`recipient-${recipient.id}`}
                                                    className="flex flex-1 cursor-pointer items-center justify-between font-normal"
                                                >
                                                    <span>
                                                        {recipient.name}
                                                    </span>
                                                    {!recipient.is_active &&
                                                        hiddenBadge}
                                                </Label>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </ScrollArea>
                        </SettingRow>
                    </SettingsGroup>
                </>
            )}
        </SettingsSection>
    );
});
