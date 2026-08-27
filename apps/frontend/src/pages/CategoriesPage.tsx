import { PAGE_ICONS } from "@/lib/pageIcons";
import { useMemo, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Eye,
    EyeOff,
    ToggleLeft,
    ToggleRight,
    Trash2,
    ChevronRight,
    ChevronDown,
    FolderOpen,
    Folder,
    Pencil,
} from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {
    useCategories,
    useUpdateCategory,
    useDeleteCategory,
} from "@/hooks/useCategories";
import { AddCategoryDialog } from "@/features/categories/AddCategoryDialog";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { PageShell } from "@/components/shared/PageShell";
import { TextLink } from "@/components/shared/TextLink";
import { TouchDisclosure } from "@/components/shared/TouchDisclosure";
import { useSearchParams } from "react-router";
import {
    booleanSearchParamCodec,
    useSearchParamState,
} from "@/hooks/useSearchParamState";

type CategoryItem = {
    id: number;
    general: string;
    detail: string;
    description?: string;
    is_active?: boolean;
};

type EditTarget = {
    id: number;
    general: string;
    detail: string;
    description: string;
};

export default function CategoriesPage() {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const [showAll, setShowAll] = useSearchParamState(
        "show_all",
        booleanSearchParamCodec,
    );
    const [searchParams, setSearchParams] = useSearchParams();
    const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

    const { data, isLoading, error } = useCategories({
        limit: 500,
        active: !showAll,
    });
    const updateMutation = useUpdateCategory();
    const deleteMutation = useDeleteCategory();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const grouped = useMemo(() => {
        if (!data?.items) return [];
        const map = new Map<string, typeof data.items>();
        for (const cat of data.items) {
            const g = cat.general;
            if (!map.has(g)) map.set(g, []);
            map.get(g)!.push(cat);
        }
        return Array.from(map.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([general, items]) => ({
                general,
                items: items.sort((a, b) => a.detail.localeCompare(b.detail)),
                activeCount: items.filter((i) => i.is_active !== false).length,
            }));
    }, [data]);

    const knownGroups = useMemo(
        () => new Set(grouped.map((group) => group.general)),
        [grouped],
    );
    const expandedGroups = useMemo(
        () =>
            new Set(
                searchParams
                    .getAll("expanded")
                    .filter((group) => knownGroups.has(group)),
            ),
        [knownGroups, searchParams],
    );

    const writeExpandedGroups = (groups: Set<string>) => {
        setSearchParams(
            (previous) => {
                const next = new URLSearchParams(previous);
                next.delete("expanded");
                for (const group of groups) next.append("expanded", group);
                return next;
            },
            { replace: true },
        );
    };

    const toggleGroup = (general: string) => {
        const next = new Set(expandedGroups);
        if (next.has(general)) next.delete(general);
        else next.add(general);
        writeExpandedGroups(next);
    };

    const expandAll = () =>
        writeExpandedGroups(new Set(grouped.map((g) => g.general)));
    const collapseAll = () => writeExpandedGroups(new Set());

    const toggleActive = (id: number, currentActive: boolean) => {
        updateMutation.mutate({ id, data: { is_active: !currentActive } });
    };

    const openEdit = (cat: CategoryItem) => {
        setEditTarget({
            id: cat.id,
            general: cat.general,
            detail: cat.detail,
            description: cat.description ?? "",
        });
    };

    const handleEditSave = (values: {
        general: string;
        detail: string;
        description: string;
    }) => {
        if (!editTarget) return;
        updateMutation.mutate(
            {
                id: editTarget.id,
                data: {
                    general: values.general,
                    detail: values.detail,
                    description: values.description || undefined,
                },
            },
            { onSuccess: () => setEditTarget(null) },
        );
    };

    if (isLoading) {
        return (
            <PageShell className="">
                <PageHeader
                    title={t("categories.title")}
                    icon={PAGE_ICONS["/categories"]}
                />
                <Card {...loadingSurfaceProps}>
                    <CardHeader className="pb-3">
                        <Skeleton className="h-6 w-44" />
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {[...Array(6)].map((_, i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    if (error) {
        return (
            <PageShell className="">
                <PageHeader
                    title={t("categories.title")}
                    icon={PAGE_ICONS["/categories"]}
                />
                <Card>
                    <CardContent variant="headerless">
                        <p className="text-destructive">
                            {t("categoriesPage.error", {
                                msg: apiErrorToMessage(error, t),
                            })}
                        </p>
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    const totalItems = data?.total ?? data?.items?.length ?? 0;
    const allExpanded =
        expandedGroups.size === grouped.length && grouped.length > 0;

    return (
        <>
            <PageShell className="">
                <div className="flex items-center justify-between">
                    <PageHeader
                        title={t("categories.title")}
                        subtitle={t("categoriesPage.subtitle", {
                            n: totalItems,
                            g: grouped.length,
                        })}
                        icon={PAGE_ICONS["/categories"]}
                    />
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={allExpanded ? collapseAll : expandAll}
                            className="gap-1.5"
                        >
                            {allExpanded ? (
                                <Folder className="h-4 w-4" />
                            ) : (
                                <FolderOpen className="h-4 w-4" />
                            )}
                            {allExpanded
                                ? t("categoriesPage.collapseAll")
                                : t("categoriesPage.expandAll")}
                        </Button>
                        <Button
                            variant={showAll ? "secondary" : "outline"}
                            size="sm"
                            onClick={() => setShowAll(!showAll)}
                            className="gap-1.5"
                        >
                            {showAll ? (
                                <Eye className="h-4 w-4" />
                            ) : (
                                <EyeOff className="h-4 w-4" />
                            )}
                            {showAll
                                ? t("categoriesPage.showingAll")
                                : t("categoriesPage.activeOnly")}
                        </Button>
                        <AddCategoryDialog />
                    </div>
                </div>

                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle variant="sm">
                            {t("categoriesPage.treeTitle")}
                        </CardTitle>
                    </CardHeader>
                    <CardContent variant="flush">
                        <div className="divide-y divide-border">
                            {grouped.length === 0 && (
                                <EmptyState
                                    headingLevel={3}
                                    icon={PAGE_ICONS["/categories"]}
                                    title={t("categoriesPage.empty")}
                                />
                            )}
                            {grouped.map(({ general, items, activeCount }) => {
                                const isExpanded = expandedGroups.has(general);
                                return (
                                    <div key={general}>
                                        {/* Group header */}
                                        <button
                                            onClick={() => toggleGroup(general)}
                                            className={cn(
                                                "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors",
                                                "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                            )}
                                        >
                                            {isExpanded ? (
                                                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                                            ) : (
                                                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                                            )}
                                            <span className="font-semibold text-foreground text-sm tracking-wide">
                                                {general}
                                            </span>
                                            <Badge
                                                variant="secondary"
                                                className="ml-auto text-xs font-normal"
                                            >
                                                {t(
                                                    activeCount === 1
                                                        ? "categoriesPage.badgeSingular"
                                                        : "categoriesPage.badgePlural",
                                                    { n: activeCount },
                                                )}
                                                {showAll &&
                                                activeCount !== items.length
                                                    ? ` / ${t("categoriesPage.badgePlural", { n: items.length })}`
                                                    : ""}
                                            </Badge>
                                        </button>

                                        {/* Detail rows */}
                                        {isExpanded && (
                                            <div className="bg-muted/30">
                                                {items.map((cat) => (
                                                    <div
                                                        key={cat.id}
                                                        className={cn(
                                                            "flex items-center gap-3 pl-11 pr-4 py-2.5 border-t border-border/50",
                                                            "transition-colors hover:bg-muted/50",
                                                            cat.is_active ===
                                                                false &&
                                                                "opacity-60",
                                                        )}
                                                    >
                                                        <TextLink
                                                            to={`/transactions?category_id=${cat.id}&filter_label=${encodeURIComponent(cat.general + ":" + cat.detail)}`}
                                                            className={cn(
                                                                "min-w-0 max-w-full truncate text-xs font-medium",
                                                                cat.is_active ===
                                                                    false &&
                                                                    "line-through",
                                                            )}
                                                        >
                                                            {cat.detail}
                                                        </TextLink>
                                                        <TouchDisclosure
                                                            label={cat.detail}
                                                            content={cat.detail}
                                                            className="shrink-0 px-1 text-xs text-muted-foreground"
                                                        >
                                                            …
                                                        </TouchDisclosure>

                                                        {cat.description && (
                                                            <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                                                                {
                                                                    cat.description
                                                                }
                                                            </span>
                                                        )}

                                                        <div className="ml-auto flex items-center gap-1">
                                                            <Button
                                                                variant="ghost"
                                                                size="sm"
                                                                className={cn(
                                                                    "gap-1 h-7 text-xs",
                                                                    cat.is_active !==
                                                                        false
                                                                        ? "text-accent hover:text-accent"
                                                                        : "text-muted-foreground",
                                                                )}
                                                                onClick={(
                                                                    e,
                                                                ) => {
                                                                    e.stopPropagation();
                                                                    toggleActive(
                                                                        cat.id,
                                                                        cat.is_active !==
                                                                            false,
                                                                    );
                                                                }}
                                                                disabled={
                                                                    updateMutation.isPending
                                                                }
                                                            >
                                                                {cat.is_active !==
                                                                false ? (
                                                                    <ToggleRight className="h-3.5 w-3.5" />
                                                                ) : (
                                                                    <ToggleLeft className="h-3.5 w-3.5" />
                                                                )}
                                                                {cat.is_active !==
                                                                false
                                                                    ? t(
                                                                          "categoriesPage.statusActive",
                                                                      )
                                                                    : t(
                                                                          "categoriesPage.statusInactive",
                                                                      )}
                                                            </Button>
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="icon-touch-target text-muted-foreground hover:text-foreground"
                                                                onClick={(
                                                                    e,
                                                                ) => {
                                                                    e.stopPropagation();
                                                                    openEdit(
                                                                        cat,
                                                                    );
                                                                }}
                                                                title={t(
                                                                    "common.edit",
                                                                )}
                                                            >
                                                                <Pencil className="h-3.5 w-3.5" />
                                                            </Button>
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="icon-touch-target text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                                                aria-label={t(
                                                                    "aria.deleteCategory",
                                                                )}
                                                                onClick={async (
                                                                    e,
                                                                ) => {
                                                                    e.stopPropagation();
                                                                    const ok =
                                                                        await confirm(
                                                                            {
                                                                                title: t(
                                                                                    "categoriesPage.delete.title",
                                                                                ),
                                                                                description:
                                                                                    t(
                                                                                        "categoriesPage.delete.desc",
                                                                                        {
                                                                                            name: `${cat.general}:${cat.detail}`,
                                                                                        },
                                                                                    ),
                                                                                confirmLabel:
                                                                                    t(
                                                                                        "categoriesPage.delete.confirm",
                                                                                    ),
                                                                                variant:
                                                                                    "destructive",
                                                                            },
                                                                        );
                                                                    if (ok)
                                                                        deleteMutation.mutate(
                                                                            cat.id,
                                                                        );
                                                                }}
                                                                disabled={
                                                                    deleteMutation.isPending
                                                                }
                                                            >
                                                                <Trash2 className="h-3.5 w-3.5" />
                                                            </Button>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </CardContent>
                </Card>
            </PageShell>

            <ConfirmDialog />

            {editTarget && (
                <AddCategoryDialog
                    key={editTarget.id}
                    mode="edit"
                    open={!!editTarget}
                    onOpenChange={(open) => {
                        if (!open) setEditTarget(null);
                    }}
                    initialValues={{
                        general: editTarget.general,
                        detail: editTarget.detail,
                        description: editTarget.description,
                    }}
                    onSave={handleEditSave}
                    isSaving={updateMutation.isPending}
                />
            )}
        </>
    );
}
