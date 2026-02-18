import {useState} from "react";
import {DataTable} from "@/components/shared/DataTable";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Loader2, Eye, EyeOff, ToggleLeft, ToggleRight, Trash2} from "lucide-react";
import {useCategories, useUpdateCategory, useDeleteCategory} from "@/hooks/useCategories";
import {AddCategoryDialog} from "@/components/forms/AddCategoryDialog";

const PAGE_SIZE = 50;

type TableCategory = {
    id: number;
    name: string;
    general: string;
    detail: string;
    is_active: boolean;
};

export default function CategoriesPage() {
    const [page, setPage] = useState(0);
    const [showAll, setShowAll] = useState(false);
    const { data, isLoading, error } = useCategories({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        active: !showAll,
    });
    const updateMutation = useUpdateCategory();
    const deleteMutation = useDeleteCategory();

    const handleUpdate = (idx: number, updated: TableCategory) => {
        const originalCategory = data?.items[idx];
        if (!originalCategory) return;

        updateMutation.mutate({
            id: originalCategory.id,
            data: {
                general: updated.general,
                detail: updated.detail,
            },
        });
    };

    const toggleActive = (id: number, currentActive: boolean) => {
        updateMutation.mutate({
            id,
            data: { is_active: !currentActive },
        });
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

    const categories: TableCategory[] = data?.items.map((c) => ({
        id: c.id,
        name: `${c.general} - ${c.detail}`,
        general: c.general,
        detail: c.detail,
        is_active: c.is_active ?? true,
    })) || [];

    const columns = [
        {
            key: "name",
            header: "Category",
            editable: false,
            render: (row: TableCategory) => (
                <span className={`font-medium whitespace-nowrap ${row.is_active ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                    {row.name}
                </span>
            ),
        },
        {
            key: "general",
            header: "General",
            editable: true,
            render: (row: TableCategory) => (
                <Badge variant="secondary" className={`font-medium ${!row.is_active ? 'opacity-50 line-through' : ''}`}>
                    {row.general}
                </Badge>
            ),
        },
        {
            key: "detail",
            header: "Detail",
            editable: true,
            render: (row: TableCategory) => (
                <Badge variant="outline" className={`font-medium ${!row.is_active ? 'opacity-50 line-through' : ''}`}>
                    {row.detail}
                </Badge>
            ),
        },
        {
            key: "is_active",
            header: "Status",
            editable: false,
            render: (row: TableCategory) => (
                <Button
                    variant="ghost"
                    size="sm"
                    className={`gap-1.5 ${row.is_active ? 'text-accent hover:text-accent' : 'text-muted-foreground hover:text-muted-foreground opacity-50'}`}
                    onClick={(e) => { e.stopPropagation(); toggleActive(row.id, row.is_active); }}
                    disabled={updateMutation.isPending}
                >
                    {row.is_active ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
                    {row.is_active ? 'Active' : 'Inactive'}
                </Button>
            ),
        },
        {
            key: "delete",
            header: "",
            className: "w-12",
            editable: false,
            render: (row: TableCategory) => (
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onClick={() => {
                        if (confirm(`Delete category "${row.general}:${row.detail}"?`)) {
                            deleteMutation.mutate(row.id);
                        }
                    }}
                    disabled={deleteMutation.isPending}
                >
                    <Trash2 className="h-4 w-4" />
                </Button>
            ),
        },
    ];

    const actions = (
        <div className="flex gap-2">
            <Button
                variant={showAll ? "secondary" : "outline"}
                size="sm"
                onClick={() => { setShowAll(!showAll); }}
                className="gap-1.5"
            >
                {showAll ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                {showAll ? "Showing All" : "Active Only"}
            </Button>
            <AddCategoryDialog />
        </div>
    );

    return (
        <div className="space-y-8 animate-in">
            <div>
                <h2 className="text-3xl font-bold text-foreground">Categories</h2>
                <p className="text-muted-foreground mt-1">Manage your transaction categories</p>
            </div>

            <DataTable
                title="All Categories"
                subtitle={`${totalItems} categories`}
                columns={columns}
                data={categories}
                onRowUpdate={handleUpdate}
                emptyMessage="No categories found."
                page={page}
                pageSize={PAGE_SIZE}
                totalItems={totalItems}
                onPageChange={setPage}
                actions={actions}
            />
        </div>
    );
}