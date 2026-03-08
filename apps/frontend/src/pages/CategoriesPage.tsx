import {useMemo, useState} from "react";
import {useNavigate} from "react-router-dom";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Loader2, Eye, EyeOff, ToggleLeft, ToggleRight, Trash2, ChevronRight, ChevronDown, FolderOpen, Folder} from "lucide-react";
import {useCategories, useUpdateCategory, useDeleteCategory} from "@/hooks/useCategories";
import {AddCategoryDialog} from "@/components/forms/AddCategoryDialog";
import {cn} from "@/lib/utils";
import {useConfirmDialog} from "@/hooks/useConfirmDialog";

export default function CategoriesPage() {
    const navigate = useNavigate();
    const [showAll, setShowAll] = useState(false);
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

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
    }, [data?.items]);

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

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-96">
                <Loader2 className="h-8 w-8 animate-spin text-primary"/>
            </div>
        );
    }

    if (error) {
        return (
            <div className="space-y-8 animate-in">
                <div>
                    <h2 className="text-3xl font-bold text-foreground">Categories</h2>
                    <p className="text-destructive mt-1">Error loading categories: {error.message}</p>
                </div>
            </div>
        );
    }

    const totalItems = data?.total ?? data?.items?.length ?? 0;
    const allExpanded = expandedGroups.size === grouped.length && grouped.length > 0;

    return (
        <>
        <div className="space-y-6 animate-in">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold text-foreground">Categories</h2>
                    <p className="text-muted-foreground mt-1">
                        {totalItems} categories in {grouped.length} groups
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={allExpanded ? collapseAll : expandAll}
                        className="gap-1.5"
                    >
                        {allExpanded ? <Folder className="h-4 w-4"/> : <FolderOpen className="h-4 w-4"/>}
                        {allExpanded ? "Collapse All" : "Expand All"}
                    </Button>
                    <Button
                        variant={showAll ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => setShowAll(!showAll)}
                        className="gap-1.5"
                    >
                        {showAll ? <Eye className="h-4 w-4"/> : <EyeOff className="h-4 w-4"/>}
                        {showAll ? "Showing All" : "Active Only"}
                    </Button>
                    <AddCategoryDialog/>
                </div>
            </div>

            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-lg">Category Tree</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    <div className="divide-y divide-border">
                        {grouped.length === 0 && (
                            <p className="text-muted-foreground text-center py-8">No categories found.</p>
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
                                            {activeCount}{showAll && activeCount !== items.length ? `/${items.length}` : ""} {items.length === 1 ? "category" : "categories"}
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
                                                    onDoubleClick={() => {
                                                        navigate(`/transactions?category_id=${cat.id}&filter_label=${encodeURIComponent(cat.general + ':' + cat.detail)}`);
                                                    }}
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
                                                            onClick={() => toggleActive(cat.id, cat.is_active !== false)}
                                                            disabled={updateMutation.isPending}
                                                        >
                                                            {cat.is_active !== false
                                                                ? <ToggleRight className="h-3.5 w-3.5"/>
                                                                : <ToggleLeft className="h-3.5 w-3.5"/>
                                                            }
                                                            {cat.is_active !== false ? "Active" : "Inactive"}
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                                            onClick={async () => {
                                                                const ok = await confirm({
                                                                    title: "Delete Category",
                                                                    description: `Are you sure you want to delete "${general}:${cat.detail}"? This action cannot be undone.`,
                                                                    confirmLabel: "Delete",
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
    </>
    );
}
