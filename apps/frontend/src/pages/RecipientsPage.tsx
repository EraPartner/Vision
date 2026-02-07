import {DataTable} from "@/components/shared/DataTable";
import {Badge} from "@/components/ui/badge";
import {Loader2} from "lucide-react";
import {useRecipients, useUpdateRecipient} from "@/hooks/useRecipients";

type TableRecipient = {
    id: number;
    name: string;
    account_number: string;
    is_active: boolean;
};

export default function RecipientsPage() {
  const { data, isLoading, error } = useRecipients({ limit: 50, active: true });
    const updateMutation = useUpdateRecipient();

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

    // Map backend data to table format
    const recipients: TableRecipient[] = data?.items.map((r) => ({
        id: r.id,
        name: r.name,
        account_number: r.account_number || 'N/A',
        is_active: r.is_active,
    })) || [];

    const columns = [
        {
            key: "name",
            header: "Recipient",
            editable: true,
            render: (row: TableRecipient) => (
                <span className="font-medium text-foreground">{row.name}</span>
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
            key: "is_active",
            header: "Status",
            editable: false,
            render: (row: TableRecipient) => (
                <Badge variant={row.is_active ? "default" : "secondary"} className="font-medium">
                    {row.is_active ? "Active" : "Inactive"}
                </Badge>
            ),
        },
    ];

    return (
        <div className="space-y-8 animate-in">
            <div>
                <h2 className="text-3xl font-bold text-foreground">Recipients</h2>
                <p className="text-muted-foreground mt-1">View and manage transaction recipients</p>
            </div>

            <DataTable
                title="All Recipients"
                subtitle={`${recipients.length} recipients`}
                columns={columns}
                data={recipients}
                onRowUpdate={handleUpdate}
                emptyMessage="No recipients found."
            />
        </div>
    );
}
