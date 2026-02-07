import {DataTable} from "@/components/shared/DataTable";
import {Badge} from "@/components/ui/badge";
import {Loader2} from "lucide-react";
import {useCategories, useUpdateCategory} from "@/hooks/useCategories";

type TableCategory = {
    id: number;
    name: string;
    general: string;
    detail: string;
};

export default function CategoriesPage() {
  const { data, isLoading, error } = useCategories({ limit: 50, active: true });
    const updateMutation = useUpdateCategory();

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

    // Map backend data to table format
    const categories: TableCategory[] = data?.items.map((c) => ({
        id: c.id,
        name: `${c.general} - ${c.detail}`,
        general: c.general,
        detail: c.detail,
    })) || [];

    const columns = [
        {
            key: "name",
            header: "Category",
            editable: false,
            render: (row: TableCategory) => (
                <span className="font-medium text-foreground">{row.name}</span>
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
    ];

    return (
        <div className="space-y-8 animate-in">
            <div>
                <h2 className="text-3xl font-bold text-foreground">Categories</h2>
                <p className="text-muted-foreground mt-1">Manage your transaction categories</p>
            </div>

            <DataTable
                title="All Categories"
                subtitle={`${categories.length} categories`}
                columns={columns}
                data={categories}
                onRowUpdate={handleUpdate}
                emptyMessage="No categories found."
            />
        </div>
    );
}
