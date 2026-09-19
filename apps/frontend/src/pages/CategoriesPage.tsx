import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import {
    ChevronDown,
    ChevronRight,
    Eye,
    EyeOff,
    Folder,
    FolderOpen,
    GitMerge,
    Pencil,
    ToggleLeft,
    ToggleRight,
    Trash2,
} from "lucide-react";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageShell } from "@/components/shared/PageShell";
import { TextLink } from "@/components/shared/TextLink";
import { Skeleton } from "@/components/ui/skeleton";
import { CategoryNodeDialog } from "@/features/categories/CategoryNodeDialog";
import { CategoryMergeDialog } from "@/features/categories/CategoryMergeDialog";
import {
    useCategoryTree,
    useDeleteCategoryNode,
    useUpdateCategoryNode,
} from "@/hooks/useCategories";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import {
    booleanSearchParamCodec,
    useSearchParamState,
} from "@/hooks/useSearchParamState";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { CategoryNode } from "@/types/api";

export default function CategoriesPage() {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const [showAll, setShowAll] = useSearchParamState(
        "show_all",
        booleanSearchParamCodec,
    );
    const [searchParams, setSearchParams] = useSearchParams();
    const [editTarget, setEditTarget] = useState<CategoryNode | null>(null);
    const [mergeSource, setMergeSource] = useState<CategoryNode | null>(null);
    const { data, isLoading, error } = useCategoryTree();
    const update = useUpdateCategoryNode();
    const remove = useDeleteCategoryNode();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const allNodes = useMemo(() => data?.items ?? [], [data?.items]);
    const visible = useMemo(() => {
        if (showAll) return allNodes;
        // Old data may have an inactive ancestor above an active descendant.
        // Keep that ancestor as tree context rather than orphaning the child.
        const visibleIds = new Set(
            allNodes
                .filter((node) => node.is_active)
                .flatMap((node) => node.pathIds),
        );
        return allNodes.filter((node) => visibleIds.has(node.id));
    }, [allNodes, showAll]);
    const children = useMemo(() => {
        const map = new Map<number | null, CategoryNode[]>();
        for (const node of visible) {
            const siblings = map.get(node.parentId) ?? [];
            siblings.push(node);
            map.set(node.parentId, siblings);
        }
        for (const siblings of map.values())
            siblings.sort(
                (a, b) => a.name.localeCompare(b.name) || a.id - b.id,
            );
        return map;
    }, [visible]);
    const roots = children.get(null) ?? [];
    const branchIds = visible
        .filter((node) => (children.get(node.id)?.length ?? 0) > 0)
        .map((node) => node.id);
    const expanded = new Set(searchParams.getAll("expanded").map(Number));
    const writeExpanded = (ids: Set<number>) =>
        setSearchParams(
            (previous) => {
                const next = new URLSearchParams(previous);
                next.delete("expanded");
                for (const id of ids) next.append("expanded", String(id));
                return next;
            },
            { replace: true },
        );
    const toggleExpanded = (id: number) => {
        const next = new Set(expanded);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        writeExpanded(next);
    };
    const allExpanded =
        branchIds.length > 0 && branchIds.every((id) => expanded.has(id));

    const renderNode = (node: CategoryNode, level: number): React.ReactNode => {
        const descendants = children.get(node.id) ?? [];
        const isExpanded = expanded.has(node.id);
        const subtreeCount = visible.filter((item) =>
            item.pathIds.includes(node.id),
        ).length;
        const subtreeIds = allNodes
            .filter((item) => item.pathIds.includes(node.id))
            .map((item) => item.id);
        const categoryFilter =
            subtreeIds.length === 1
                ? `category_id=${node.id}`
                : `category_ids=${encodeURIComponent(subtreeIds.join(","))}`;
        return (
            <div key={node.id}>
                <div
                    className={cn(
                        "flex min-w-0 items-center gap-2 border-t border-border/50 py-2 pr-4 hover:bg-muted/50",
                        !node.is_active && "opacity-60",
                    )}
                    style={{
                        paddingLeft: `${level * 1.25 + 1}rem`,
                    }}
                >
                    {descendants.length > 0 ? (
                        <button
                            type="button"
                            aria-label={`${isExpanded ? t("categoriesPage.collapseAll") : t("categoriesPage.expandAll")}: ${node.path.join(" / ")}`}
                            aria-expanded={isExpanded}
                            onClick={() => toggleExpanded(node.id)}
                            className="rounded p-1 focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            {isExpanded ? (
                                <ChevronDown className="h-4 w-4" />
                            ) : (
                                <ChevronRight className="h-4 w-4" />
                            )}
                        </button>
                    ) : (
                        <span className="w-6" />
                    )}
                    <TextLink
                        to={`/transactions?${categoryFilter}&filter_label=${encodeURIComponent(node.path.join(" / "))}`}
                        className={cn(
                            "min-w-0 truncate text-sm",
                            !node.is_active && "line-through",
                        )}
                        title={node.path.join(" / ")}
                    >
                        {node.name}
                    </TextLink>
                    {descendants.length > 0 && (
                        <Badge
                            variant="secondary"
                            className="text-xs font-normal"
                        >
                            {subtreeCount}
                        </Badge>
                    )}
                    {node.description && (
                        <span className="hidden max-w-[200px] truncate text-xs text-muted-foreground sm:inline">
                            {node.description}
                        </span>
                    )}
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            disabled={update.isPending}
                            onClick={() =>
                                update.mutate({
                                    id: node.id,
                                    data: { is_active: !node.is_active },
                                })
                            }
                        >
                            {node.is_active ? (
                                <ToggleRight className="h-3.5 w-3.5" />
                            ) : (
                                <ToggleLeft className="h-3.5 w-3.5" />
                            )}
                            {node.is_active
                                ? t("categoriesPage.statusActive")
                                : t("categoriesPage.statusInactive")}
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="icon-touch-target"
                            title={t("common.edit")}
                            aria-label={`${t("common.edit")} ${node.path.join(" / ")}`}
                            onClick={() => setEditTarget(node)}
                        >
                            <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="icon-touch-target"
                            aria-label={`${t("categoriesPage.mergeTitle")} ${node.path.join(" / ")}`}
                            onClick={() => setMergeSource(node)}
                            disabled={
                                !allNodes.some(
                                    (target) =>
                                        target.is_active &&
                                        target.id !== node.id &&
                                        !target.pathIds.includes(node.id),
                                )
                            }
                        >
                            <GitMerge className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="icon-touch-target hover:text-destructive"
                            aria-label={`${t("aria.deleteCategory")} ${node.path.join(" / ")}`}
                            disabled={
                                remove.isPending || descendants.length > 0
                            }
                            title={
                                descendants.length > 0
                                    ? t("categoriesPage.deleteChildrenFirst")
                                    : undefined
                            }
                            onClick={async () => {
                                const ok = await confirm({
                                    title: t("categoriesPage.delete.title"),
                                    description: t(
                                        "categoriesPage.delete.desc",
                                        { name: node.path.join(" / ") },
                                    ),
                                    confirmLabel: t(
                                        "categoriesPage.delete.confirm",
                                    ),
                                    variant: "destructive",
                                });
                                if (ok) remove.mutate(node.id);
                            }}
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                </div>
                {isExpanded &&
                    descendants.map((child) => renderNode(child, level + 1))}
            </div>
        );
    };

    if (isLoading)
        return (
            <PageShell>
                <PageHeader
                    title={t("categories.title")}
                    icon={PAGE_ICONS["/categories"]}
                />
                <Card {...loadingSurfaceProps}>
                    <CardHeader>
                        <Skeleton className="h-6 w-44" />
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {Array.from({ length: 6 }, (_, i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </CardContent>
                </Card>
            </PageShell>
        );
    if (error)
        return (
            <PageShell>
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

    return (
        <>
            <PageShell>
                <div className="flex items-center justify-between">
                    <PageHeader
                        title={t("categories.title")}
                        subtitle={t("categoriesPage.subtitle", {
                            n: visible.length,
                            g: roots.length,
                        })}
                        icon={PAGE_ICONS["/categories"]}
                    />
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                                writeExpanded(
                                    new Set(allExpanded ? [] : branchIds),
                                )
                            }
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
                        <CategoryNodeDialog nodes={allNodes} />
                    </div>
                </div>
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle variant="sm">
                            {t("categoriesPage.treeTitle")}
                        </CardTitle>
                    </CardHeader>
                    <CardContent variant="flush">
                        {roots.length === 0 ? (
                            <EmptyState
                                headingLevel={3}
                                icon={PAGE_ICONS["/categories"]}
                                title={t("categoriesPage.empty")}
                            />
                        ) : (
                            roots.map((root) => renderNode(root, 0))
                        )}
                    </CardContent>
                </Card>
            </PageShell>
            <ConfirmDialog />
            {editTarget && (
                <CategoryNodeDialog
                    key={editTarget.id}
                    nodes={allNodes}
                    editNode={editTarget}
                    open
                    onOpenChange={(open) => {
                        if (!open) setEditTarget(null);
                    }}
                />
            )}
            {mergeSource && (
                <CategoryMergeDialog
                    key={mergeSource.id}
                    source={mergeSource}
                    nodes={allNodes}
                    open
                    onOpenChange={(open) => {
                        if (!open) setMergeSource(null);
                    }}
                />
            )}
        </>
    );
}
