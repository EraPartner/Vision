import {useState} from "react";
import {DataTable} from "@/components/shared/DataTable";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Loader2, Eye, EyeOff, ToggleLeft, ToggleRight, Trash2} from "lucide-react";
import {useCategories, useUpdateCategory, useDeleteCategory} from "@/hooks/useCategories";

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
        ...(showAll ? {} : { active: true }),
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

    const toggleActive = (idx: number) => {
        const category = data?.items[idx];
        if (!category) return;
        updateMutation.mutate({
            id: category.id,
            data: { is_active: !(category as any).is_active },
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
        is_active: (c as any).is_active ?? true,
    })) || [];

    const columns = [
        {
            key: "name",
            header: "Category",
            editable: false,
            render: (row: TableCategory) => (
                <span className={`font-medium ${row.is_active ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                    {row.name}
                </span>
            ),
        },
        {
            key: "general",
            header: "General",
            editable: true,
            render: (row: TableCategory) => (
                <Badge variant="secondary" className="font-medium">
                    {row.general}
                </Badge>
            ),
        },
        {
            key: "detail",
            header: "Detail",
            editable: true,
            render: (row: TableCategory) => (
                <Badge variant="outline" className="font-medium">
                    {row.detail}
                </Badge>
            ),
        },
        {
            key: "is_active",
            header: "Status",
            editable: false,
            render: (row: TableCategory, _isEditing: boolean, idx?: number) => (
                <Button
                    variant="ghost"
                    size="sm"
                    className={`gap-1.5 ${row.is_active ? 'text-accent hover:text-accent' : 'text-muted-foreground hover:text-foreground'}`}
                    onClick={() => idx !== undefined && toggleActive(idx)}
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
                    onClick={() => deleteMutation.mutate(row.id)}
                    disabled={deleteMutation.isPending}
                >
                    <Trash2 className="h-4 w-4" />
                </Button>
            ),
        },
    ];

    const filterToggle = (
        <Button
            variant={showAll ? "secondary" : "outline"}
            size="sm"
            onClick={() => { setShowAll(!showAll); setPage(0); }}
            className="gap-1.5"
        >
            {showAll ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            {showAll ? "Showing All" : "Active Only"}
        </Button>
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
                actions={filterToggle}
            />
        </div>
    );
}
