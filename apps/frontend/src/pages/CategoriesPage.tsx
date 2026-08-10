import {useMemo, useState} from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import {useNavigate} from "react-router";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Eye, EyeOff, ToggleLeft, ToggleRight, Trash2, ChevronRight, ChevronDown, FolderOpen, Folder, Pencil, Tags} from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {useCategories, useUpdateCategory, useDeleteCategory} from "@/hooks/useCategories";
import {AddCategoryDialog} from "@/features/categories/AddCategoryDialog";
import {cn} from "@/lib/utils";
import {onActivateKeyDown} from "@/utils/a11y";
import {useConfirmDialog} from "@/hooks/useConfirmDialog";
import { apiErrorToMessage } from "@/lib/api/errorMessage";

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
    const navigate = useNavigate();
    const [showAll, setShowAll] = useState(false);
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
    const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

    const {data, isLoading, error} = useCategories({
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
                activeCount: items.filter(i => i.is_active !== false).length,
            }));
    }, [data]);

    const toggleGroup = (general: string) => {
        setExpandedGroups(prev => {
            const next = new Set(prev);
            if (next.has(general)) next.delete(general);
            else next.add(general);
            return next;
        });
    };

    const expandAll = () => setExpandedGroups(new Set(grouped.map(g => g.general)));
    const collapseAll = () => setExpandedGroups(new Set());

    const toggleActive = (id: number, currentActive: boolean) => {
        updateMutation.mutate({id, data: {is_active: !currentActive}});
    };

    const openEdit = (cat: CategoryItem) => {
        setEditTarget({
            id: cat.id,
            general: cat.general,
            detail: cat.detail,
            description: cat.description ?? "",
        });
    };

    const handleEditSave = (values: { general: string; detail: string; description: string }) => {
        if (!editTarget) return;
        updateMutation.mutate(
            { id: editTarget.id, data: { general: values.general, detail: values.detail, description: values.description || undefined } },
            { onSuccess: () => setEditTarget(null) }
        );
    };

    if (isLoading) {
        return (
            <div className="space-y-6">
                <PageHeader title={t('categories.title')} icon={Tags} />
                <Card {...loadingSurfaceProps} className="glass-regular">
                    <CardHeader className="pb-3"><Skeleton className="h-6 w-44" /></CardHeader>
                    <CardContent className="space-y-2">
                        {[...Array(6)].map((_, i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (error) {
        return (
            <div className="space-y-6">
                <PageHeader title={t('categories.title')} icon={Tags} />
                <Card className="glass-regular"><CardContent className="pt-6"><p className="text-destructive">{t('categoriesPage.error', { msg: apiErrorToMessage(error, t) })}</p></CardContent></Card>
            </div>
        );
    }

    const totalItems = data?.total ?? data?.items?.length ?? 0;
    const allExpanded = expandedGroups.size === grouped.length && grouped.length > 0;

    return (
        <>
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <PageHeader
                    title={t('categories.title')}
                    subtitle={t('categoriesPage.subtitle', { n: totalItems, g: grouped.length })}
                    icon={Tags}
                />
                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={allExpanded ? collapseAll : expandAll}
                        className="gap-1.5"
                    >
                        {allExpanded ? <Folder className="h-4 w-4"/> : <FolderOpen className="h-4 w-4"/>}
                        {allExpanded ? t('categoriesPage.collapseAll') : t('categoriesPage.expandAll')}
                    </Button>
                    <Button
                        variant={showAll ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => setShowAll(!showAll)}
                        className="gap-1.5"
                    >
                        {showAll ? <Eye className="h-4 w-4"/> : <EyeOff className="h-4 w-4"/>}
                        {showAll ? t('categoriesPage.showingAll') : t('categoriesPage.activeOnly')}
                    </Button>
                    <AddCategoryDialog/>
                </div>
            </div>

            <Card className="glass-regular">
                    <CardHeader className="pb-3">
                    <CardTitle className="text-lg">{t('categoriesPage.treeTitle')}</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    <div className="divide-y divide-border">
                        {grouped.length === 0 && (
                            <EmptyState icon={Tags} title={t('categoriesPage.empty')} />
                        )}
                        {grouped.map(({general, items, activeCount}) => {
                            const isExpanded = expandedGroups.has(general);
                            return (
                                <div key={general}>
                                    {/* Group header */}
                                    <button
                                        onClick={() => toggleGroup(general)}
                                        className={cn(
                                            "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors",
                                            "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        )}
                                    >
                                        {isExpanded
                                            ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0"/>
                                            : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0"/>
                                        }
                                        <span className="font-semibold text-foreground text-sm tracking-wide">
                                            {general}
                                        </span>
                                            <Badge variant="secondary" className="ml-auto text-xs font-normal">
                                                {t(activeCount === 1 ? 'categoriesPage.badgeSingular' : 'categoriesPage.badgePlural', { n: activeCount })}
                                                {showAll && activeCount !== items.length ? ` / ${t('categoriesPage.badgePlural', { n: items.length })}` : ''}
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
                                                        "transition-colors hover:bg-muted/50 cursor-pointer",
                                                        cat.is_active === false && "opacity-60"
                                                    )}
                                                    role="button"
                                                    tabIndex={0}
                                                    onDoubleClick={() => {
                                                        navigate(`/transactions?category_id=${cat.id}&filter_label=${encodeURIComponent(cat.general + ':' + cat.detail)}`);
                                                    }}
                                                    onKeyDown={onActivateKeyDown(() =>
                                                        navigate(`/transactions?category_id=${cat.id}&filter_label=${encodeURIComponent(cat.general + ':' + cat.detail)}`)
                                                    )}
                                                >
                                                    <Badge
                                                        variant="outline"
                                                        className={cn(
                                                            "font-medium text-xs",
                                                            cat.is_active === false && "line-through"
                                                        )}
                                                    >
                                                        {cat.detail}
                                                    </Badge>

                                                    {cat.description && (
                                                        <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                                                            {cat.description}
                                                        </span>
                                                    )}

                                                    <div className="ml-auto flex items-center gap-1">
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className={cn(
                                                                "gap-1 h-7 text-xs",
                                                                cat.is_active !== false
                                                                    ? "text-accent hover:text-accent"
                                                                    : "text-muted-foreground"
                                                            )}
                                                            onClick={(e) => { e.stopPropagation(); toggleActive(cat.id, cat.is_active !== false); }}
                                                            disabled={updateMutation.isPending}
                                                        >
                                                            {cat.is_active !== false
                                                                ? <ToggleRight className="h-3.5 w-3.5"/>
                                                                : <ToggleLeft className="h-3.5 w-3.5"/>
                                                            }
                                                            {cat.is_active !== false ? t('categoriesPage.statusActive') : t('categoriesPage.statusInactive')}
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="icon-touch-target text-muted-foreground hover:text-foreground"
                                                            onClick={(e) => { e.stopPropagation(); openEdit(cat); }}
                                                            title={t('common.edit')}
                                                        >
                                                            <Pencil className="h-3.5 w-3.5"/>
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="icon-touch-target text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                                            aria-label={t('aria.deleteCategory')}
                                                            onClick={async (e) => {
                                                                e.stopPropagation();
                                                                const ok = await confirm({
                                                                    title: t('categoriesPage.delete.title'),
                                                                    description: t('categoriesPage.delete.desc'),
                                                                    confirmLabel: t('categoriesPage.delete.confirm'),
                                                                    variant: "destructive",
                                                                });
                                                                if (ok) deleteMutation.mutate(cat.id);
                                                            }}
                                                            disabled={deleteMutation.isPending}
                                                        >
                                                            <Trash2 className="h-3.5 w-3.5"/>
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
        </div>

        <ConfirmDialog />

        {editTarget && (
            <AddCategoryDialog
                key={editTarget.id}
                mode="edit"
                open={!!editTarget}
                onOpenChange={(open) => { if (!open) setEditTarget(null); }}
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
