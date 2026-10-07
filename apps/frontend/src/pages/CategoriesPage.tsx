import { PageError } from "@/components/shared/PageError";
import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
    ChevronDown,
    ChevronRight,
    Eye,
    EyeOff,
    Folder,
    FolderOpen,
    GitMerge,
    MoreHorizontal,
    Pencil,
    SlidersHorizontal,
    Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageShell } from "@/components/shared/PageShell";
import { TextLink } from "@/components/shared/TextLink";
import { Skeleton } from "@/components/ui/skeleton";
import { CategoryNodeDialog } from "@/features/categories/CategoryNodeDialog";
import { CategoryMergeDialog } from "@/features/categories/CategoryMergeDialog";
import { useCategoryTree, useDeleteCategoryNode } from "@/hooks/useCategories";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import {
    booleanSearchParamCodec,
    useSearchParamState,
} from "@/hooks/useSearchParamState";
import { apiClient } from "@/lib/api";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { categoryKeys } from "@/lib/queryKeys";
import { undoToast } from "@/lib/undoToast";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { CategoryNode } from "@/types/api";

interface TreeRow {
    node: CategoryNode;
    level: number;
    descendants: CategoryNode[];
}

/**
 * Categories (completeness sweep): the tree is one list of rows with a
 * disclosure chevron, the name linking to its transactions and a row ••• menu
 * (Edit, Merge, Mark inactive/active, Delete). Marking a category inactive
 * happens at once and offers Undo; Delete keeps its confirmation because the
 * API has no restore. "Show inactive" and Expand/Collapse all live in a View
 * menu; Add category is the one primary action.
 */
export default function CategoriesPage() {
    const { t } = useLanguage();
    const queryClient = useQueryClient();
    const dialogOpener = useRef<HTMLButtonElement | null>(null);
    const treeControls = useRef<HTMLButtonElement | null>(null);
    const rowMenuTriggers = useRef(new Map<number, HTMLButtonElement>());
    const restoreDialogFocus = () => {
        const target = dialogOpener.current;
        (target?.isConnected ? target : treeControls.current)?.focus();
    };
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const [showAll, setShowAll] = useSearchParamState(
        "show_all",
        booleanSearchParamCodec,
    );
    const [searchParams, setSearchParams] = useSearchParams();
    const [editTarget, setEditTarget] = useState<CategoryNode | null>(null);
    const [mergeSource, setMergeSource] = useState<CategoryNode | null>(null);
    const { data, isLoading, error, refetch } = useCategoryTree();
    const remove = useDeleteCategoryNode();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    // Status flips are reversible, so they skip the hook's "Category updated"
    // toast and announce themselves through undoToast instead (ADR-179).
    const toggleStatus = useMutation({
        mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
            apiClient.updateCategoryNode(id, { is_active }),
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: categoryKeys.all }),
    });

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

    // The tree as one flat list of visible rows, so the dividers and the
    // keyboard order follow the rendered order.
    const rows = useMemo(() => {
        const result: TreeRow[] = [];
        const walk = (node: CategoryNode, level: number) => {
            const descendants = children.get(node.id) ?? [];
            result.push({ node, level, descendants });
            if (expanded.has(node.id))
                for (const child of descendants) walk(child, level + 1);
        };
        for (const root of roots) walk(root, 0);
        return result;
        // `expanded` is rebuilt from the URL on every render; its members
        // are what matters.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [children, roots, searchParams]);

    const pathLabel = (node: CategoryNode) => node.path.join(" / ");

    const openFromRow = (node: CategoryNode, open: () => void) => {
        dialogOpener.current = rowMenuTriggers.current.get(node.id) ?? null;
        open();
    };

    const handleToggleStatus = async (node: CategoryNode) => {
        const nextActive = !node.is_active;
        try {
            await toggleStatus.mutateAsync({
                id: node.id,
                is_active: nextActive,
            });
            undoToast({
                message: t(
                    nextActive
                        ? "categoriesPage.toast.active"
                        : "categoriesPage.toast.inactive",
                    { name: node.name },
                ),
                undoLabel: t("common.undo"),
                undo: async () => {
                    try {
                        await toggleStatus.mutateAsync({
                            id: node.id,
                            is_active: !nextActive,
                        });
                    } catch {
                        toast.error(t("categoriesPage.toggleFailed"));
                    }
                },
            });
        } catch {
            toast.error(t("categoriesPage.toggleFailed"));
        }
    };

    const requestDelete = async (node: CategoryNode) => {
        const ok = await confirm({
            onCloseAutoFocus: restoreDialogFocus,
            title: t("categoriesPage.delete.title"),
            description: t("categoriesPage.delete.desc", {
                name: pathLabel(node),
            }),
            confirmLabel: t("categoriesPage.delete.confirm"),
            variant: "destructive",
        });
        if (ok) remove.mutate(node.id);
    };

    const renderRow = ({ node, level, descendants }: TreeRow) => {
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
        const canMerge = allNodes.some(
            (target) =>
                target.is_active &&
                target.id !== node.id &&
                !target.pathIds.includes(node.id),
        );
        const label = pathLabel(node);
        return (
            <li
                key={node.id}
                className="flex min-h-11 min-w-0 items-center gap-2 py-1.5 pr-3"
                style={{ paddingLeft: `${level * 1.25 + 0.75}rem` }}
            >
                {descendants.length > 0 ? (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-label-secondary"
                        aria-label={`${isExpanded ? t("categoriesPage.collapseAll") : t("categoriesPage.expandAll")}: ${label}`}
                        aria-expanded={isExpanded}
                        onClick={() => toggleExpanded(node.id)}
                    >
                        {isExpanded ? (
                            <ChevronDown aria-hidden />
                        ) : (
                            <ChevronRight aria-hidden />
                        )}
                    </Button>
                ) : (
                    <span className="w-7 shrink-0" aria-hidden="true" />
                )}
                <TextLink
                    to={`/transactions?${categoryFilter}&filter_label=${encodeURIComponent(label)}`}
                    tone={node.is_active ? "primary" : "muted"}
                    className={cn(
                        "min-w-0 truncate type-body",
                        !node.is_active && "line-through",
                    )}
                    title={label}
                >
                    {node.name}
                </TextLink>
                {descendants.length > 0 && (
                    <Badge
                        variant="secondary"
                        size="sm"
                        className="font-normal"
                    >
                        {subtreeCount}
                    </Badge>
                )}
                {!node.is_active && (
                    <Badge variant="muted" size="sm">
                        {t("categoriesPage.statusInactive")}
                    </Badge>
                )}
                {node.description && (
                    <span className="hidden min-w-0 max-w-[200px] truncate type-footnote text-label-secondary sm:inline">
                        {node.description}
                    </span>
                )}
                <div className="ml-auto flex shrink-0 items-center">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                ref={(element) => {
                                    if (element)
                                        rowMenuTriggers.current.set(
                                            node.id,
                                            element,
                                        );
                                    else
                                        rowMenuTriggers.current.delete(node.id);
                                }}
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-label-secondary"
                                aria-label={t("categoriesPage.rowMenu", {
                                    name: label,
                                })}
                            >
                                <MoreHorizontal aria-hidden />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem
                                onSelect={() =>
                                    openFromRow(node, () => setEditTarget(node))
                                }
                            >
                                <Pencil
                                    className="mr-2 h-4 w-4 text-label-secondary"
                                    aria-hidden
                                />
                                {t("common.edit")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                disabled={!canMerge}
                                onSelect={() =>
                                    openFromRow(node, () =>
                                        setMergeSource(node),
                                    )
                                }
                            >
                                <GitMerge
                                    className="mr-2 h-4 w-4 text-label-secondary"
                                    aria-hidden
                                />
                                {t("categoriesPage.mergeTitle")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                disabled={toggleStatus.isPending}
                                onSelect={() => void handleToggleStatus(node)}
                            >
                                {node.is_active ? (
                                    <EyeOff
                                        className="mr-2 h-4 w-4 text-label-secondary"
                                        aria-hidden
                                    />
                                ) : (
                                    <Eye
                                        className="mr-2 h-4 w-4 text-label-secondary"
                                        aria-hidden
                                    />
                                )}
                                {node.is_active
                                    ? t("categoriesPage.markInactive")
                                    : t("categoriesPage.markActive")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                disabled={
                                    remove.isPending || descendants.length > 0
                                }
                                onSelect={() =>
                                    openFromRow(
                                        node,
                                        () => void requestDelete(node),
                                    )
                                }
                            >
                                <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                                <span className="flex flex-col">
                                    <span>{t("common.delete")}</span>
                                    {descendants.length > 0 && (
                                        <span className="type-footnote text-label-secondary">
                                            {t(
                                                "categoriesPage.deleteChildrenFirst",
                                            )}
                                        </span>
                                    )}
                                </span>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </li>
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
                            <Skeleton key={i} className="h-11 w-full" />
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
                <PageError
                    message={t("categoriesPage.error", {
                        msg: apiErrorToMessage(error, t),
                    })}
                    onRetry={() => void refetch()}
                />
            </PageShell>
        );

    return (
        <>
            <PageShell>
                <PageHeader
                    title={t("categories.title")}
                    subtitle={t("categoriesPage.subtitle", {
                        n: visible.length,
                        g: roots.length,
                    })}
                    icon={PAGE_ICONS["/categories"]}
                    actions={
                        <>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        ref={treeControls}
                                        variant="outline"
                                        aria-label={t("txPage.view.menu")}
                                    >
                                        <SlidersHorizontal
                                            className="h-4 w-4"
                                            aria-hidden
                                        />
                                        {t("txPage.view.menu")}
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="end"
                                    className="w-56"
                                >
                                    <DropdownMenuCheckboxItem
                                        checked={showAll}
                                        onCheckedChange={(checked) =>
                                            setShowAll(checked === true)
                                        }
                                    >
                                        {t("common.includeInactive")}
                                    </DropdownMenuCheckboxItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        disabled={branchIds.length === 0}
                                        onSelect={() =>
                                            writeExpanded(
                                                new Set(
                                                    allExpanded
                                                        ? []
                                                        : branchIds,
                                                ),
                                            )
                                        }
                                    >
                                        {allExpanded ? (
                                            <Folder
                                                className="mr-2 h-4 w-4 text-label-secondary"
                                                aria-hidden
                                            />
                                        ) : (
                                            <FolderOpen
                                                className="mr-2 h-4 w-4 text-label-secondary"
                                                aria-hidden
                                            />
                                        )}
                                        {allExpanded
                                            ? t("categoriesPage.collapseAll")
                                            : t("categoriesPage.expandAll")}
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                            <CategoryNodeDialog nodes={allNodes} />
                        </>
                    }
                />
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
                            <ul className="m-0 list-none divide-y divide-border/50 border-t border-border/50 p-0">
                                {rows.map(renderRow)}
                            </ul>
                        )}
                    </CardContent>
                </Card>
            </PageShell>
            <ConfirmDialog />
            {editTarget && (
                <CategoryNodeDialog
                    key={editTarget.id}
                    nodes={allNodes}
                    onCloseAutoFocus={restoreDialogFocus}
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
                    onCloseAutoFocus={restoreDialogFocus}
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
