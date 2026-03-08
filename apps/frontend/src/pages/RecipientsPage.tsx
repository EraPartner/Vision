import {useState} from "react";
import {DataTable} from "@/components/shared/DataTable";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Loader2, Eye, EyeOff, ToggleLeft, ToggleRight, Trash2} from "lucide-react";
import {useRecipients, useUpdateRecipient, useDeleteRecipient} from "@/hooks/useRecipients";
import {AddRecipientDialog} from "@/components/forms/AddRecipientDialog";
import {CategoryCombobox} from "@/components/shared/CategoryCombobox";

const PAGE_SIZE = 50;

type TableRecipient = {
    id: number;
    name: string;
    primary_bank_account: string;
    default_category_name?: string;
    is_active: boolean;
    notes?: string;
};

export default function RecipientsPage() {
    const [page, setPage] = useState(0);
    const [showAll, setShowAll] = useState(false);
    const [search, setSearch] = useState("");
    const { data, isLoading, error } = useRecipients({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        active: !showAll,
        search: search || undefined,
    });
    const updateMutation = useUpdateRecipient();
    const deleteMutation = useDeleteRecipient();

    const handleUpdate = (idx: number, updated: TableRecipient) => {
        const originalRecipient = data?.items[idx];
        if (!originalRecipient) return;

        updateMutation.mutate({
            id: originalRecipient.id,
            data: {
                name: updated.name,
                notes: updated.notes,
                is_active: updated.is_active,
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
                    <h2 className="text-3xl font-bold text-foreground">Recipients</h2>
                    <p className="text-destructive mt-1">Error loading recipients: {error.message}</p>
                </div>
            </div>
        );
    }

    const totalItems = data?.total ?? data?.items?.length ?? 0;

    const recipients: TableRecipient[] = data?.items.map((r) => ({
        id: r.id,
        name: r.name,
        primary_bank_account: r.primary_bank_account || 'N/A',
        default_category_name: r.default_category_name,
        is_active: r.is_active,
        notes: r.notes || '',
    })) || [];

    const columns = [
        {
            key: "name",
            header: "Recipient",
            editable: true,
            render: (row: TableRecipient) => (
                <span className={`font-medium ${row.is_active ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                    {row.name}
                </span>
            ),
        },
        {
            key: "primary_bank_account",
            header: "Primary Account",
            editable: false,
            render: (row: TableRecipient) => (
                <span className={`text-muted-foreground font-mono text-sm ${!row.is_active ? 'line-through' : ''}`}>{row.primary_bank_account}</span>
            ),
        },
        {
            key: "default_category_name",
            header: "Default Category",
            editable: false,
            render: (row: TableRecipient, isEditing: boolean) => {
                if (isEditing) {
                    const originalRecipient = data?.items.find((r) => r.id === row.id);
                    return (
                        <CategoryCombobox
                            value={originalRecipient?.default_category_id ?? null}
                            onSelect={(catId) => {
                                if (!originalRecipient) return;
                                updateMutation.mutate({
                                    id: originalRecipient.id,
                                    data: {default_category_id: catId ?? undefined},
                                });
                            }}
                            className="w-full"
                        />
                    );
                }

                const formatCategoryName = (categoryName?: string): string => {
                    if (!categoryName) return 'None';
                    const parts = categoryName.split(':');
                    if (parts.length > 1) {
                        const detail = parts[1].trim();
                        return detail.charAt(0) + detail.slice(1).toLowerCase();
                    }
                    return categoryName.charAt(0) + categoryName.slice(1).toLowerCase();
                };
                
                const displayName = formatCategoryName(row.default_category_name);
                const isNone = displayName === 'None';
                
                return (
                    <Badge 
                        variant="outline" 
                        className={`font-medium ${isNone ? 'text-muted-foreground' : ''}`}
                    >
                        {displayName}
                    </Badge>
                );
            },
        },
        {
            key: "notes",
            header: "Notes",
            editable: true,
            render: (row: TableRecipient) => (
                <span className={`text-sm text-muted-foreground ${!row.is_active ? 'line-through' : ''}`}>{row.notes || '-'}</span>
            ),
        },
        {
            key: "is_active",
            header: "Status",
            editable: false,
            render: (row: TableRecipient) => (
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
            render: (row: TableRecipient) => (
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onClick={() => {
                        if (confirm(`Delete recipient "${row.name}"?`)) {
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
            <AddRecipientDialog />
        </div>
    );

    return (
        <div className="space-y-8 animate-in">
            <div>
                <h2 className="text-3xl font-bold text-foreground">Recipients</h2>
                <p className="text-muted-foreground mt-1">View and manage transaction recipients</p>
            </div>

            <DataTable
                title="All Recipients"
                subtitle={`${totalItems} recipients`}
                columns={columns}
                data={recipients}
                onRowUpdate={handleUpdate}
                emptyMessage="No recipients found."
                page={page}
                pageSize={PAGE_SIZE}
                totalItems={totalItems}
                onPageChange={setPage}
                onSearchChange={setSearch}
                actions={actions}
            />
        </div>
    );
}