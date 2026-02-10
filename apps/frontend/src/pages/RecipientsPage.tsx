import {useState} from "react";
import {DataTable} from "@/components/shared/DataTable";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Loader2, Eye, EyeOff, ToggleLeft, ToggleRight, Trash2} from "lucide-react";
import {useRecipients, useUpdateRecipient, useDeleteRecipient} from "@/hooks/useRecipients";

const PAGE_SIZE = 50;

type TableRecipient = {
    id: number;
    name: string;
    account_number: string;
    default_category_name?: string;
    is_active: boolean;
    notes?: string;
    address?: string;
};

export default function RecipientsPage() {
    const [page, setPage] = useState(0);
    const [showAll, setShowAll] = useState(false);
    const { data, isLoading, error } = useRecipients({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        ...(showAll ? {} : { active: true }),
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
                account_number: updated.account_number,
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
        account_number: r.account_number || 'N/A',
        default_category_name: r.default_category_name,
        is_active: r.is_active,
        notes: r.notes || '',
        address: r.address || '',
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
            key: "account_number",
            header: "Account Number",
            editable: true,
            render: (row: TableRecipient) => (
                <span className="text-muted-foreground font-mono text-sm">{row.account_number}</span>
            ),
        },
        {
            key: "default_category_name",
            header: "Default Category",
            editable: false,
            render: (row: TableRecipient) => {
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
                <span className="text-sm text-muted-foreground">{row.notes || '-'}</span>
            ),
        },
        {
            key: "address",
            header: "Address",
            editable: true,
            render: (row: TableRecipient) => (
                <span className="text-sm text-muted-foreground">{row.address || '-'}</span>
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
                    className={`gap-1.5 ${row.is_active ? 'text-accent hover:text-accent' : 'text-muted-foreground hover:text-foreground'}`}
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
                actions={filterToggle}
            />
        </div>
    );
}
